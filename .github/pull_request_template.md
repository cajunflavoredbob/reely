<!--
PR template added 0.4.21 (audit 13 #341). Adjust as the contributor
base grows; today this is a thin scaffold.
-->

## What

<!-- Brief description of the change. Reference any related issue or
audit finding (e.g. "closes #279" / "audit 13 #294"). -->

## Why

<!-- Motivation. If this came from an audit, link the finding. -->

## How to verify

<!-- Steps to confirm the change works end-to-end. If tests cover it,
which ones? If a manual reproduction is involved, list the setup. -->

## Checklist

- [ ] `pnpm typecheck` clean (server + tests + ui)
- [ ] `pnpm test` passes; new tests added for behavior changes where
      reasonable
- [ ] `pnpm audit --audit-level=high` clean (or new finding addressed)
- [ ] CHANGELOG entry added under the next version
- [ ] If the version bumped: VERSION + package.json + docker-compose.yml
      + CHANGELOG all updated (4-file rule, added 0.4.8)
- [ ] No personal info in commit messages or content (use the
      `cajunflavoredbob` identity)
