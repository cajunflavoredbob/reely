# Docker Compose

A `docker-compose.yml` is included at the root of the repository. It uses [Docker secrets](https://docs.docker.com/compose/use-secrets/) to keep sensitive values out of environment variables.

## Setup

1. Create a `secrets/` directory next to `docker-compose.yml`:
   ```
   secrets/plex_token.txt      ← your Plex token (one line, no quotes)
   ```

2. Set `PLEX_URL` in `docker-compose.yml` to your Plex server URL.

3. Start:
   ```
   docker compose up -d
   ```

## Environment variables instead of secrets

If you prefer to pass values via environment variables rather than secret files, remove the `secrets:` blocks from `docker-compose.yml` and add the values directly:

```yaml
environment:
  PLEX_URL: "http://your-plex:32400"
  PLEX_TOKEN: "your-token"
```

See the [configuration reference](../README.markdown#configuration) for all available options.
