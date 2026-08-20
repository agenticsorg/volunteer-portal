# ADR-0003: tRPC for Internal Calls, Versioned REST for External Integrations

## Status
Accepted — 2026-08-10

## Context
The portal has two structurally different classes of API consumer. The first is the Next.js frontend itself (ADR-0002): server components and client islands calling into the eight bounded-context modules (ADR-0001) for reads and writes — feed queries, hour-entry submission, kudos, course-progress updates. This traffic is 100% first-party, TypeScript-to-TypeScript, within the same deployable, and changes in lockstep with the UI, so there is no versioning concern and no need for a wire format designed for unknown third-party consumers.

The second class is explicitly named in the canonical stack and implied by the domain research: exports (grant-reporting CSV/PDF of approved hours, per `05-domain-and-compliance.md`'s "grant-ready export" requirement), integrations (a future Discord bridge — the research flags "is there an existing Discord workflow this needs to integrate with" as an open question — or partner-org SSO/reporting), and webhooks (inbound, from Cloudflare Stream's encode-complete notifications; outbound, if a partner system wants to be notified of e.g. a new certificate). These consumers are not the Next.js frontend: they are external systems, scripts, or the Foundation's own future tooling, which need a stable, documented, independently-versioned contract that does not break when an internal module's TypeScript types change shape.

Using one paradigm for both would force a bad trade: a REST-only internal API loses end-to-end type safety between frontend and backend (exactly the kind of drift ADR-0001's "one code path per operation" goal is trying to avoid), while a tRPC-only public API is unusable by anything that isn't a TypeScript client with access to the server's router types — unacceptable for grant-reporting exports consumed by finance tooling, or webhooks that must speak plain HTTP/JSON to Cloudflare's infrastructure.

## Decision
Run **two coexisting API surfaces from the same Next.js deployable**, both calling into the same module application-layer use cases (ADR-0001) so there is no duplicated business logic:

1. **tRPC** for all internal frontend↔backend calls. One `appRouter` composed from one sub-router per bounded-context module (`identity`, `volunteering`, `training`, `gamification`, `community`, `moderation`, `notifications`, `admin`), mounted at `/api/trpc/[trpc]`. This is the *only* way the Next.js frontend talks to the backend — no internal fetches to the REST API from within the app itself.
2. **A versioned public REST API under `/api/v1/*`**, OpenAPI-documented, for everything external: data exports, third-party integrations, and webhooks (both inbound receivers, e.g. `/api/v1/webhooks/cloudflare-stream`, and outbound delivery of events to registered partner endpoints). REST resources are versioned via the URL path (`/api/v1/...`); a breaking change ships as `/api/v2/...` while `/api/v1/...` continues to be served until a documented deprecation window closes — never a breaking change made in place under `v1`.

Both surfaces are **thin adapters** over the same module application-layer functions (the use cases defined in each module's `application/` layer per ADR-0001's folder structure). A tRPC procedure and a REST handler that both "submit an hour entry" call the same `volunteering.submitHourEntry(cmd)` use case; they differ only in transport (tRPC's RPC-over-HTTP-batch vs. REST's resource/verb shape), input validation surface (both use the same Zod schema, see Implementation Notes), and response shape (tRPC returns the TS-typed object directly; REST serializes to the OpenAPI-documented JSON shape). Neither surface re-implements authorization, validation, or persistence — `can(subject, action, resource)` and the module's Zod input schema are called from both.

## Consequences

### Positive
- **End-to-end type safety where it earns its keep.** The frontend (ADR-0002) gets full TypeScript inference from router to component with zero code generation and zero hand-maintained API client — a change to a tRPC procedure's input/output type is a compile error in the consuming component, catching drift before runtime, for the highest-churn, first-party surface.
- **A real contract for external consumers.** `/api/v1/*` is documented via generated OpenAPI, meaning a grant-reporting script, a future Discord bridge, or Cloudflare's webhook sender have a stable, language-agnostic interface — none of them need to know this is a TypeScript/tRPC-internally system at all.
- **No duplicated business logic.** Because both surfaces call the same application-layer use cases, the two-step "approve hours → award points → post feed item → notify" workflow (an outbox-driven, multi-context sequence per ADR-0001) is implemented exactly once, regardless of whether it was triggered by a mentor clicking "Approve" in the UI (tRPC) or a partner system calling `POST /api/v1/hour-entries/{id}/approve` (REST, if that endpoint is ever exposed).
- **Independent evolution speed.** The tRPC surface can change shape every sprint alongside UI work with no external consumer to break (nothing outside this Next.js deployable calls it). The REST surface changes deliberately and rarely, gated by the versioning policy — which matches the actual different change-tolerance of "our own frontend" vs. "a grant officer's CSV import script."
- **Webhooks fit naturally into the REST surface's existing auth/logging/rate-limiting middleware** rather than needing a bespoke handler pattern, since inbound webhooks (Cloudflare Stream) and outbound integrations both live under the same `/api/v1` request pipeline.

### Negative / Trade-offs
- **Two adapter layers to maintain per externally-relevant use case.** Any use case that needs to be reachable both internally and externally (e.g., hour-entry submission, if a partner ever needs to submit on a volunteer's behalf) needs both a tRPC procedure and a REST handler written, even though they share the underlying use case — roughly double the routing/adapter boilerplate for that specific operation. Mitigated by keeping the REST surface intentionally small (exports, integrations, webhooks only) rather than mirroring every tRPC procedure.
- **OpenAPI generation adds a build step.** `trpc-openapi` (or hand-written REST handlers with `zod-to-openapi`) must be kept in sync with the Zod schemas; a schema change that isn't re-run through the generator produces a stale spec, which is worse than no spec for external consumers who trust it. CI must fail if the checked-in `openapi.json` is out of date relative to the schemas (see Implementation Notes).
- **Two auth/session-validation code paths.** tRPC context reads the Supabase session cookie (browser-originated); REST `/api/v1` must support both the cookie (for same-origin admin-triggered exports) and API-key/bearer-token auth (for external integrations) — meaning the REST middleware is strictly more complex than the tRPC context builder, and both need independent test coverage.
- **Two versioning philosophies to keep straight.** tRPC has no version number and is expected to move in lockstep with the frontend build (a mismatched client is impossible since they deploy together); REST is explicitly versioned and long-lived. A contributor moving fast could mistakenly treat a REST endpoint like a tRPC procedure and change its shape in place — style guides and PR review must catch this explicitly.

### Not chosen: exposing tRPC procedures directly as the public API via `trpc-openapi` for everything
Considered folding REST into "just tRPC procedures tagged for OpenAPI export" to avoid writing two adapters. Rejected as the default because REST resource semantics (idempotent `PUT`, `Location` headers on `POST`, standard HTTP caching, `Content-Type: text/csv` for exports) map awkwardly onto RPC-shaped procedures, and because the versioning/deprecation lifecycle for anything external needs to be a first-class decision, not an incidental side effect of how an internal procedure happens to be named. `trpc-openapi` *is still used*, but only to generate the REST layer's spec from REST-shaped procedure definitions (see Implementation Notes) — it is tooling inside the REST adapter, not a replacement for having one.

## Alternatives Considered
- **REST everywhere (no tRPC) — a single conventional REST/OpenAPI API consumed by both the Next.js frontend and external integrations.** Rejected: loses compile-time type safety between frontend and backend for the highest-churn surface in the system, forcing either hand-written API client types (drift risk) or a codegen step (`openapi-typescript`) that adds a build round-trip for every internal change — meaningful friction for a small team iterating on UI daily, for zero benefit since the frontend is never consumed by anyone but itself.
- **GraphQL for the internal API (e.g., Apollo Server / Yoga) instead of tRPC.** Rejected: GraphQL's value (flexible client-specified queries, single endpoint for heterogeneous clients) doesn't apply here — there is exactly one internal client (this Next.js app) and it is TypeScript, so tRPC's direct type inference gives the same "no over/under-fetching, one round trip" benefit with far less infrastructure (no schema language, no resolver layer, no N+1 concerns beyond what Prisma already requires care for) and a much smaller learning curve for a team already writing TypeScript everywhere (ADR canonical decision).
- **tRPC for everything, including external consumers, via a published TypeScript client package.** Rejected: this only works for consumers willing to add a TypeScript/npm dependency and pin to this repo's router types — a non-starter for a grant officer's Python export script, a webhook sender (Cloudflare doesn't speak tRPC), or any Discord-bridge integration built outside this codebase. Public/external surfaces need a transport (plain JSON over HTTP) and a contract (OpenAPI) that make no assumption about the caller's language or tooling.
- **Separate deployable for the public REST API (its own Next.js API-only app or a small Fastify service).** Rejected for v1 on the same grounds as ADR-0001: a second deployable is disproportionate operational overhead for a REST surface that's currently three use cases (exports, one inbound webhook, and a future integration slot) — this can be split out later using the same extraction path documented in ADR-0001 if `/api/v1` traffic or team ownership ever justifies it.

## Implementation Notes

### tRPC setup
```
/src/server/api
  root.ts              # appRouter = router({ identity, volunteering, training, gamification, community, moderation, notifications, admin })
  trpc.ts              # initTRPC, context (Supabase session → subject), middleware (auth required / can() check)
  /routers
    identity.ts
    volunteering.ts     # e.g. submitHourEntry, approveHourEntry, listMyHours
    training.ts
    gamification.ts
    community.ts
    moderation.ts
    notifications.ts
    admin.ts
```
- `@trpc/server@^11`, `@trpc/react-query@^11`, `@trpc/next@^11` (App Router adapter), `zod@^3` for every procedure's `.input()`.
- Every mutation procedure calls `can(ctx.subject, action, resource)` from `platform/policy` before invoking the module use case — this is a `middleware()` applied per-router, not duplicated per-procedure:
```ts
export const volunteeringRouter = router({
  approveHourEntry: protectedProcedure
    .input(z.object({ hourEntryId: z.string(), }))
    .mutation(async ({ ctx, input }) => {
      await can(ctx.subject, "hour_entry:approve", { id: input.hourEntryId, scope: "chapter" });
      return volunteeringModule.approveHourEntry({ ...input, approverId: ctx.subject.id });
    }),
});
```

### REST setup (`/api/v1`)
```
/src/app/api/v1
  /hour-entries/export/route.ts        # GET, returns CSV/PDF, calls volunteeringModule.exportApprovedHours(...)
  /webhooks/cloudflare-stream/route.ts # POST, verifies Cloudflare signature, calls trainingModule.markEncodeComplete(...)
  /certificates/[id]/route.ts          # GET, returns signed R2 URL
  openapi.json                          # generated, committed, checked in CI
```
- Input validation: the same Zod schemas used by tRPC procedures where the operation overlaps (e.g., `hourEntryExportInput` schema imported by both the tRPC `admin.exportHours` procedure and the REST `GET /api/v1/hour-entries/export` handler) — defined once in `modules/volunteering/application/schemas.ts`, imported by both adapters. This is the concrete mechanism that keeps validation from drifting between surfaces.
- Auth middleware for `/api/v1`: accepts either (a) the Supabase session cookie for same-origin/admin-triggered calls, or (b) an `Authorization: Bearer <api_key>` header for external integrations, where API keys are issued per-integration in `admin.*` with scoped permissions mapped through the same `can()` policy module.
- OpenAPI generation: `zod-to-openapi` (or `trpc-openapi` used purely as a spec generator against REST-shaped route definitions) produces `openapi.json` at build time; a CI step (`npm run openapi:check`) regenerates and diffs against the committed file, failing the build on drift.
- Rate limiting and webhook-signature verification live in REST middleware only (`src/app/api/v1/_middleware`) — not needed on the tRPC surface, which is same-origin/session-authenticated only.

### Versioning policy
- `v1` is additive-only: new optional fields and new endpoints are fine within `v1`. Any breaking change (removed field, changed field type, changed auth model) requires a new `/api/v2` path.
- Deprecation: a `Deprecation` and `Sunset` HTTP header (RFC 8594) is added to `v1` responses once `v2` ships for that resource, with a minimum 90-day overlap window before `v1` is removed, documented in the OpenAPI spec's `deprecated: true` flag on the affected operation.
