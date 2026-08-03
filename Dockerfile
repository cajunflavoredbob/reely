# Node base image pinned to an exact patch for reproducible production
# builds (audit 9 #122). The matching CI workflow floors to `24` so an
# upstream Node 24.x compat issue surfaces in PR CI before it hits the
# image. Bump in lockstep with `engines.node` in package.json.
FROM node:26.5.1-slim AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

# Install deps before copying source for better layer caching
COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY package.json ./
COPY web/app/package.json ./web/app/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# Carve out a runtime-only dep tree for the reely workspace package
# (audit 14 #335). `pnpm deploy` walks the workspace, hoists only
# production deps for the named filter, and writes them to a target
# directory with a flat node_modules. The runtime stage then COPY-s
# this output instead of running a second `pnpm install --prod` --
# which previously re-fetched every prod dep from the network even
# though the builder had already resolved them. Saves the network
# round-trip on every cold image build and drops corepack/pnpm from
# the runtime image entirely.
#
# `--legacy` is required on pnpm v10+ for non-injected workspaces:
# v10 changed deploy's default to require inject-workspace-packages=true.
# reely's workspace doesn't use injected packages; --legacy keeps the
# pre-v10 behavior (the only working option without a wider workspace
# config change). The 0.4.25 initial attempt omitted this flag and
# Docker build failed with ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE; the
# flag is the fix pnpm's own error message recommends.
RUN pnpm --filter=reely deploy --prod --legacy /deploy

# ──────────────────────────────────────
# Runtime image pinned to the same exact patch as the builder above.
FROM node:26.5.1-slim
ENV NODE_ENV=production
WORKDIR /app

LABEL org.opencontainers.image.title="reely" \
      org.opencontainers.image.description="Social movie-picking app for Plex"

# Apply all available Debian security updates on top of the pinned base
# image. The Node official images on Docker Hub refresh their Debian
# package list on their own cadence, which often lags behind Debian's
# security publishes by days-to-weeks. Without this step, Trivy flags
# CVEs in base packages (libgnutls30, libc6, etc.) even on the latest
# Node image tag, because the fix is *available* upstream but *not yet
# baked* into the Node image we pin. apt-get upgrade pulls whatever
# fixes are current at build time -- so the published image carries
# the freshest Debian security state regardless of upstream cadence.
#
# This trades a small amount of reproducibility (the package list a
# rebuild picks up will drift over time) for security freshness. For a
# user-facing service that ships an image to Docker Hub, freshness wins.
# The Node and pnpm pins above still control the *application* layer's
# reproducibility -- this only freshens the OS layer.
#
# Originally added in 0.4.18 to clear five libgnutls30 CVEs (CVE-2026-
# 33845 + -42010 CRITICAL; -33846 + -3833 + -42009 HIGH) that the
# upstream node:24.16.0-slim still carried. apt-get clean + rm of the
# lists cache keep the layer small.
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Bring in the prod-only node_modules + package.json from the builder's
# pnpm deploy output. corepack/pnpm are NOT installed in this stage
# (audit 14 #335) -- runtime only invokes `node`, so the pnpm CLI is
# pure overhead.
COPY --from=builder /deploy/node_modules ./node_modules
COPY --from=builder /deploy/package.json ./

# Server JS + bundled frontend (dist/web/) from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/configs ./configs
COPY --from=builder /app/VERSION ./

# Drop root: chown /app and switch to the unprivileged 'node' user that ships
# with node:24-slim (UID 1000). Reduces blast radius if the process is
# compromised; the server only needs read access to its own bundle and write
# access to data/.
#
# data/ must exist in the image before the chown: when the reely_data named
# volume first mounts at /app/data, Docker seeds the volume's ownership from
# the image's directory at that path. Without this mkdir the volume mounts
# root-owned and the unprivileged 'node' user can't write room files
# (saveRoom/cleanupExpiredRooms then swallow EACCES and rooms never persist).
RUN mkdir -p /app/data && chown -R node:node /app
USER node

# Hit /health every 30s to mark container health. node -e is used instead of
# wget/curl since those aren't installed in node:24-slim. The probe mirrors
# how the app resolves config: port from $PORT, else a `port:` in config.yaml,
# else 8000; and protocol = https when TLS is configured (TLS_CERT/TLS_KEY env
# or a `tlsConfig` block in config.yaml), else http. Without the TLS check a
# TLS-enabled container would be probed over http and falsely marked unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const fs=require('fs');let port=process.env.PORT;let tls=!!(process.env.TLS_CERT||process.env.TLS_KEY);try{const c=require('js-yaml').load(fs.readFileSync(process.env.CONFIG_PATH||'/app/config.yaml','utf8'));port=port||c.port;tls=tls||!!c.tlsConfig;}catch{}port=port||8000;const proto=tls?'https':'http';require(proto).get(proto+'://127.0.0.1:'+port+'/health',tls?{rejectUnauthorized:false}:{},(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# EXPOSE is image metadata only -- it can't read runtime env. If you change
# PORT, remap on the host side (-p host:container).
EXPOSE 8000

ENTRYPOINT ["node", "dist/cmd/reely/main.js"]
