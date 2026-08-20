# Architecture Decision Records

Production-architecture decisions for the Agentics Foundation Volunteer Portal, following from [`docs/research/`](../research/README.md). Format: MADR-style (Status / Context / Decision / Consequences / Alternatives Considered / Implementation Notes).

| ADR | Decision |
|---|---|
| [0001](0001-modular-monolith-with-schema-per-bounded-context.md) | Modular monolith, one Postgres schema per DDD bounded context, no cross-schema FKs |
| [0002](0002-frontend-nextjs-app-router.md) | Next.js 14+ App Router, TypeScript, React Server Components |
| [0003](0003-api-layer-trpc-and-versioned-rest.md) | tRPC internally; versioned public REST under `/api/v1` for exports/integrations |
| [0004](0004-primary-datastore-postgres-prisma.md) | Single managed Postgres instance, Prisma multi-schema mode |
| [0005](0005-identifier-strategy-ulids.md) | ULIDs as primary keys, application-generated |
| [0006](0006-authentication-supabase-auth.md) | Supabase Auth, JWT + httpOnly cookie sessions |
| [0007](0007-authorization-scoped-rbac.md) | Scoped RBAC via `role_assignments` + a central `can()` policy module |
| [0008](0008-tenancy-model-single-tenant-chapter-scoped.md) | Single-tenant, Chapter as a first-class scoping entity |
| [0009](0009-domain-event-integration-transactional-outbox.md) | Transactional outbox + graphile-worker for cross-context integration |
| [0010](0010-video-hosting-cloudflare-stream.md) | Cloudflare Stream, signed playback URLs, mandatory human-corrected captions |
| [0011](0011-object-storage-cloudflare-r2.md) | Cloudflare R2 for certificates, attachments, and exports |
| [0012](0012-notifications-resend-and-in-app-center.md) | Resend for transactional email + an in-app notification center |
| [0013](0013-observability-and-slos.md) | Sentry + OpenTelemetry + structured logging, with concrete SLOs |
| [0014](0014-data-privacy-and-compliance-architecture.md) | GDPR-first compliance architecture: consent ledger, DSAR pipeline, retention sweeps |
| [0015](0015-testing-and-cicd-strategy.md) | Vitest + Playwright + contract tests, gated CI/CD |
| [0016](0016-hosting-and-infrastructure-topology.md) | Vercel + managed Postgres + Cloudflare, Terraform IaC |
| [0017](0017-search-strategy-postgres-fts-pgvector-phase2.md) | Postgres full-text search now; `pgvector` (not RuVector) as the phase-2 path |

See [`docs/ddd/`](../ddd/README.md) for the domain model these decisions support.
