## What

<!-- What changed. Link any related issue. -->

## Why

<!-- Why it changed. -->

## How to verify

<!-- How to confirm it works end-to-end: covering tests, or manual repro
steps and their setup. -->

## Checklist

- [ ] `pnpm typecheck` clean (server + tests + ui)
- [ ] `pnpm test` passes; new tests added for behavior changes where
      reasonable
- [ ] `pnpm audit --audit-level=high` clean (or new finding addressed)
- [ ] CHANGELOG entry added under the next version
- [ ] If the version bumped: VERSION + package.json + docker-compose.yml
      + CHANGELOG all updated (4-file rule)
- [ ] No personal info in commit messages or content (use the
      `cajunflavoredbob` identity)
