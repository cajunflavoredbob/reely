# Running reely behind a reverse proxy

Many people choose to run services behind a reverse proxy. This page aims to provide some documentation to spare lots of duplicated effort (and bug tickets).

## WebSocket Origin check (read this first)

reely rejects a WebSocket upgrade whose `Origin` header doesn't match the
request `Host` -- a guard against cross-site WebSocket hijacking. Behind a
reverse proxy this means **the proxy must forward the original `Host`
header** (`proxy_set_header Host $host;` in nginx). If it forwards its own
`Host` instead, the browser's `Origin` won't match and the upgrade fails
with `403 Forbidden`.

If your proxy can't forward `Host`, or serves reely under an origin that
differs from the `Host` reely receives, set the `ALLOWED_ORIGINS` env var to
the external origin(s) instead (comma-separated), e.g.
`ALLOWED_ORIGINS=https://reely.example.com`.

Each example below preserves the original `Host`, but the way it does so
differs per proxy: nginx needs the `proxy_set_header Host $host;` directive
shown, HAProxy forwards the client's `Host` unchanged by default, and Apache
needs `ProxyPreserveHost On` because its default is `Off` (it would otherwise
send `Host: localhost:8000` and every upgrade would be rejected).

## Nginx

### Behind a subdomain

```nginx.conf
events {
  worker_connections 4096;
}

http {
  server {
    listen 9000;
    server_name reely.example.com;

    location ^~ / {
        proxy_pass http://localhost:8000/;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
  }
}
```

### Behind a subpath

Run reely normally, and use the following `nginx.conf`.

```nginx.conf
events {
  worker_connections 4096;
}

http {
  server {
    listen 9000;

    location ^~ /reely/ {
        proxy_pass http://localhost:8000/;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Forwarded-Prefix /reely;
    }

    location ^~ / {
        proxy_pass http://localhost:8000/;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
  }
}
```

## HAProxy

### Behind a subdomain

```haproxy.cfg
frontend https
  mode http
  bind 0.0.0.0:443 name bind_1 crt /etc/haproxy/certs ssl alpn h2,http/1.1
  http-request set-header X-Forwarded-Proto https if { ssl_fc }
  use_backend reely-http if { req.hdr(host),field(1,:) -i reely.example.com } { path_beg / }

backend reely-http
  mode http
  balance roundrobin
  option forwardfor
  server reely localhost:8000
```

## Apache2

Make sure to enable Apache2 mods first: a2enmod mod_proxy mod_proxy_wstunnel mod_rewrite

```xml
<VirtualHost *:80>
  ServerName reely.example.com
  ServerAlias reely.example.com
  ProxyPreserveHost On
  ProxyPass / http://localhost:8000/
  RewriteEngine on
  RewriteCond %{HTTP:Upgrade} websocket [NC]
  RewriteCond %{HTTP:Connection} upgrade [NC]
  RewriteRule ^/?(.*) "ws://localhost:8000/$1" [P,L]
</VirtualHost>
```
