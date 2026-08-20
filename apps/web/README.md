# apps/web

The Next.js app for the Agentics Foundation Volunteer Portal — see the repo root [`docs/`](../../docs) for the research, ADRs, domain model, and implementation plan this app is built from.

```bash
pnpm db:up          # start local Postgres (docker compose)
pnpm db:migrate:deploy
pnpm dev             # http://localhost:3000
```

Other useful scripts (run from the repo root): `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm test:integration`, `pnpm e2e:smoke`.
