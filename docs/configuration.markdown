# Configuration

reely is configured via environment variables or a `config.yaml` file;
environment variables take precedence. There is no in-browser setup -- an
unconfigured server shows a static notice telling you to set the
configuration (env vars or `config.yaml`) and restart.

## Via YAML

reely can be configured with a simple YAML document, which allows connecting to multiple Plex servers.

Here's a simple example:

```YAML
hostname: 0.0.0.0
port: 8000
servers:
  - url: https://plex.example.com
    token: abcdef12346
```

reely will read the config from `config.yaml` by default.

## Reverse proxy and root path

If reely is served under a subpath (e.g. `https://example.com/reely/`), set
`rootPath` in your config:

```YAML
rootPath: /reely
```

**Important:** `rootPath` is not handled by reely itself. It is injected into
the frontend so the browser constructs correct API URLs. Your reverse proxy
must strip the prefix before forwarding requests to reely. If the proxy does
not strip the prefix, WebSocket connections and API calls will fail.

Example nginx location block that strips `/reely`:

```nginx
location /reely/ {
    proxy_pass http://localhost:8000/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-Prefix /reely;
}
```

**`proxy_set_header Host $host;` matters:** reely rejects WebSocket upgrades
whose `Origin` doesn't match the request `Host` (a cross-site-hijacking
guard). If the proxy forwards its own `Host` instead of the browser's, the
upgrade is rejected with 403. If you can't forward `Host`, set the
`ALLOWED_ORIGINS` env var to the external origin instead, e.g.
`ALLOWED_ORIGINS=https://example.com`.

If you access reely directly (no reverse proxy), leave `rootPath` unset.
