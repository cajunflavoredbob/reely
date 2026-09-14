# Exact patch pin keeps production builds reproducible; CI floors to `26`
# so upstream Node 26.x breakage surfaces in PR CI, not in the image.
# Bump in lockstep with `engines.node` in package.json.
FROM node:26.8.2-slim AS builder
WORKDIR /app

# Node 25+ images no longer ship corepack, so install pnpm via npm.
# Keep this pin in sync with `packageManager` in package.json.
RUN npm install -g pnpm@10.33.2

# Install deps before copying source for better layer caching
COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY package.json ./
COPY web/app/package.json ./web/app/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# Write a flat, prod-only dep tree the runtime stage can just COPY.
# A second `pnpm install --prod` there would re-fetch every prod dep the
# builder already resolved, and would drag pnpm into the runtime image.
# `--legacy` restores pre-v10 deploy behavior; v10 otherwise demands
# inject-workspace-packages=true, which this workspace does not use.
RUN pnpm --filter=reely deploy --prod --legacy /deploy

# Runtime image: same exact patch pin as the builder.
FROM node:26.8.2-slim
ENV NODE_ENV=production
WORKDIR /app

LABEL org.opencontainers.image.title="reely" \
      org.opencontainers.image.description="Social movie-picking app for Plex" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/cajunflavoredbob/reely"

# Node's official images refresh Debian packages on their own cadence and
# lag security publishes, so a pinned base ships known base-package CVEs.
# Upgrading at build time trades OS-layer reproducibility for freshness;
# the Node and pnpm pins still fix the application layer. clean + rm keep
# the layer small.
#
# APT_REFRESH is what makes that freshness real. BuildKit keys this RUN on
# the parent image digest plus the command string, and both are pinned, so
# a CI layer cache would otherwise replay the same upgrade forever and ship
# the package state from the day the cache entry was first written. The
# workflows pass the build date; a plain `docker build` keeps the default
# and stays cached.
ARG APT_REFRESH=unset
RUN echo "apt refresh: ${APT_REFRESH}" \
    && apt-get update \
    && apt-get upgrade -y \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Prod-only node_modules + package.json from the deploy output. pnpm is
# deliberately not installed here: runtime only invokes `node`.
COPY --from=builder /deploy/node_modules ./node_modules
COPY --from=builder /deploy/package.json ./

# Server JS + bundled frontend (dist/web/)
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/configs ./configs
COPY --from=builder /app/VERSION ./

# The image is a binary redistribution, so Apache-2.0 section 4 requires the
# license text and the NOTICE attribution to travel with it. Without these the
# upstream author's copyright notice is stripped from everything Docker Hub
# serves. (The bundled fonts' OFL text already rides along inside dist/web/.)
COPY --from=builder /app/LICENSE /app/NOTICE ./

# Drop root: run as the image's unprivileged 'node' user (UID 1000).
# data/ must exist and be owned before the volume mounts, since Docker seeds
# a new named volume's ownership from the image directory at that path.
# Otherwise /app/data mounts root-owned and room writes fail with EACCES.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

# node -e rather than curl/wget, which node:26-slim doesn't ship. The probe
# resolves port and protocol the same way the app does ($PORT or config.yaml
# `port:`, else 8000; https when TLS_CERT/TLS_KEY or `tlsConfig` is set), or a
# TLS-enabled container gets probed over http and reads as unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const fs=require('fs');let port=process.env.PORT;let tls=!!(process.env.TLS_CERT||process.env.TLS_KEY);try{const c=require('js-yaml').load(fs.readFileSync(process.env.CONFIG_PATH||'/app/config.yaml','utf8'));port=port||c.port;tls=tls||!!c.tlsConfig;}catch{}port=port||8000;const proto=tls?'https':'http';require(proto).get(proto+'://127.0.0.1:'+port+'/health',tls?{rejectUnauthorized:false}:{},(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Metadata only; EXPOSE can't read runtime env. Changing PORT means remapping
# on the host side (-p host:container).
EXPOSE 8000

ENTRYPOINT ["node", "dist/cmd/reely/main.js"]
