# ADR-0008: Tenancy Model — Single-Tenant with Chapter as a First-Class Scoping Entity

## Status
Accepted — 2026-08-10

## Context
The Agentics Foundation is one organization (research 01: agentics.org, founded by Reuven Cohen, ~100K+ global community claim, active city chapters like Agentics London and a Silicon Valley chapter) deploying one volunteer portal for its own use. There is no stated requirement, funded plan, or comparable-org pattern (PSF, ASF, Mozilla, Wikimedia, LFX — research 01) indicating the platform will be resold, white-labeled, or operated on behalf of multiple independent foundations. At the same time, the org's actual operating structure is **not flat**: volunteers self-organize into city chapters that run their own meetups, workshops, and hackathons largely independently, and any given chapter lead's authority is bounded to their chapter (ADR-0007's scoped RBAC decision exists precisely because of this).

This creates a real design fork that has to be resolved deliberately, not left implicit:

- **Full multi-tenant SaaS architecture** (tenant-isolated rows via a `tenant_id` on every table, tenant-aware connection routing, tenant-scoped subdomains, per-tenant billing/config) is the standard answer when a platform serves *multiple, mutually untrusting organizations* that must never see each other's data even in the event of an application bug — the isolation guarantee is the whole point, and it is usually enforced with Postgres Row-Level Security (RLS) or fully separate databases per tenant.
- **Agentics Foundation's chapters are not mutually untrusting separate organizations** — they're organizational sub-units of the same nonprofit, and cross-chapter visibility is often *desirable*: a global activity feed, an org-wide leaderboard, org-wide training content, and org-wide reporting for grant packets (research 05, checklist item 3: "grant-ready export of approved hours filtered by date/program") all require querying across chapters, which a hard multi-tenant isolation boundary would actively work against.
- **The canonical architecture already commits to one Postgres instance with one schema per bounded context** (identity, volunteering, training, gamification, community, moderation, notifications, admin) — this is a *bounded-context* schema split, not a *tenant* schema split; there is exactly one `volunteering` schema, holding all chapters' opportunities together, not one schema per chapter.
- **Scoped RBAC (ADR-0007) already needs a "chapter" scope concept** to express "this chapter lead's authority stops at their chapter's boundary" — so the question this ADR resolves is specifically: is that scope boundary a *tenancy* boundary (hard row-level isolation, potentially different databases/schemas per chapter) or a *domain* boundary (an ordinary foreign-key-by-ID attribute that authorization and queries respect, but which doesn't imply separate infrastructure or hard isolation)?

## Decision
The platform is **single-tenant**: one deployed instance, one Postgres database, serving exactly one organization (Agentics Foundation) end-to-end. **Chapter is a first-class domain entity within the `volunteering` schema**, not a tenancy mechanism. Every chapter-scoped row (opportunities, chapter rosters, chapter-specific events) carries a plain `chapter_id text` attribute — an ordinary application-level reference by ID, consistent with the no-cross-schema-FK rule — and chapter-boundary enforcement happens exclusively through the `can(subject, action, resource)` policy module (ADR-0007), not through Postgres Row-Level Security, not through per-chapter schemas, and not through per-chapter databases.

Concretely:
- `volunteering.chapters` is a table like any other: `id` (ULID, ADR-0005), `name`, `city`, `region`, `status` (active/inactive), `created_at`, etc. There is exactly one `volunteering` schema for the whole platform; chapters are rows in it, not schemas or databases.
- Every entity that logically belongs to a chapter (an `opportunity`, a chapter-specific `event`) has a `chapter_id` column referencing `chapters.id` by value only.
- Cross-chapter, org-wide views (global activity feed, org-wide leaderboard, org-wide admin reporting) are **ordinary queries with no `chapter_id` filter** — there is no isolation mechanism to bypass, because there was never a hard isolation boundary in the first place. This is the direct benefit of choosing chapter-as-domain-entity over chapter-as-tenant.
- Chapter-scoped **authorization** (can this chapter lead approve this hour entry, can this chapter lead edit this opportunity) is enforced entirely in the `can()` policy module by comparing the resource's `chapter_id` against the subject's chapter-scoped `role_assignments` rows (ADR-0007) — a data-layer permission check performed in application code on every mutation, not a database-enforced row-security policy.
- There is no per-chapter subdomain, no per-chapter deployment, no per-chapter config, and no per-chapter connection string. All chapters share the same Next.js deployment, the same Postgres instance, the same Supabase Auth project (ADR-0006), and the same Cloudflare Stream/R2 buckets.

## Consequences

### Positive
- **Cross-chapter features are trivial, not an isolation-escape-hatch**: org-wide leaderboards, a unified activity feed, org-wide training content visible to every chapter, and consolidated grant-ready reporting (research 05, checklist item 3) are plain SQL queries without a tenant-scoping filter to deliberately bypass — which is exactly what the org's actual usage pattern needs, since Agentics operates as one community with local chapters, not as federated separate organizations.
- **No RLS complexity for a boundary that doesn't need cryptographic-grade isolation**: chapter leads and chapter members are all members of the same trusted nonprofit, screened by the same org-level processes; the "chapter" boundary exists for *organizational scoping of authority and content relevance*, not for protecting mutually distrusting parties from each other. Enforcing it in the application policy layer (already required for role scoping, ADR-0007) avoids maintaining a parallel, harder-to-test-and-reason-about RLS policy set in Postgres for the same boundary.
- **Matches the canonical architecture with zero new infrastructure**: no per-tenant schema provisioning pipeline, no per-tenant connection pool management, no tenant-router middleware — the "one deployable service, one Postgres instance, schema per bounded context" decision is honored exactly as stated elsewhere, and this ADR doesn't have to invent an exception to it.
- **New chapters are just rows**: launching a new city chapter is `INSERT INTO volunteering.chapters ...` plus granting a `chapter_lead` role assignment — no infrastructure provisioning, no deployment, no migration. This directly supports organic chapter growth (research 01 shows chapters forming independently — London founded May 2025, a Silicon Valley chapter, likely more over time) without an operational bottleneck.
- **Simpler operational surface for a low-ops small team** (research 04): one thing to back up, one thing to monitor, one thing to scale, one Vercel/Neon/Cloudflare bill — consistent with the org's stated low-ops constraint.

### Negative / Trade-offs
- **A single Prisma/application-layer authorization bug can leak cross-chapter data** in a way that hard RLS-enforced multi-tenancy would have caught at the database layer even if the application forgot a check. This is a real, accepted risk, mitigated by: (1) `can()` being the single, tested, exhaustiveness-checked chokepoint for every mutation and sensitive read (ADR-0007), not scattered ad hoc checks; (2) the relatively low sensitivity of chapter-to-chapter data compared to, say, financial records — a volunteer's chapter membership or an opportunity listing leaking across chapters is a privacy/embarrassment concern, not the kind of catastrophic breach hard tenant isolation exists to prevent for e.g. competing businesses sharing a SaaS platform.
- **No infrastructure-level blast-radius containment**: a severe incident (data corruption, a runaway query, a security compromise) affects the whole platform at once, since there's one database and one deployment — there's no "only chapter X's data was affected" containment a per-tenant database would provide. Accepted because the org is one legal entity and one trust domain; containment-by-tenant isn't a meaningful mitigation for a single-organization platform.
- **If a genuinely separate, mutually distrusting organization ever needs to use this platform, this decision must be revisited from the ground up** — see below. This is a known, deliberate scope limitation, not an oversight.
- **Chapter-scoped "soft" isolation depends on disciplined `chapter_id` propagation**: every new chapter-scoped table added in the future must remember to include `chapter_id` and every new query/mutation must remember to run through `can()`. There's no schema-level or RLS-level backstop that automatically enforces this for a table a developer forgets to wire up correctly. Mitigated by code review discipline and the `can()` exhaustiveness CI check (ADR-0007), not by database mechanics.

## Alternatives Considered

- **Full multi-tenant SaaS architecture (per-tenant `tenant_id` + Postgres Row-Level Security enforcing it at the database layer, or fully separate databases/schemas per chapter)**: rejected for v1. This is the correct architecture *if and only if* the platform serves multiple mutually distrusting organizations — chapters are not that; they're sub-units of one nonprofit that actively want cross-chapter visibility (shared leaderboards, shared training library, org-wide reporting). Building RLS policies or per-chapter schema provisioning for a boundary that needs to be *porous* for legitimate org-wide features, then punching holes through that isolation for every cross-chapter feature, is more complex than modeling chapter as a domain attribute in the first place and would fight the canonical "one schema per bounded context" decision (a per-chapter schema split would compete with, not complement, the per-bounded-context schema split already chosen). Reconsidered only under the trigger condition described below.
- **Postgres Row-Level Security (RLS) scoped to chapter, layered on top of the existing schema, without full multi-tenancy**: a middle-ground option — keep one schema, but add RLS policies keyed on `chapter_id` and a session-level "current chapter scope" variable, giving a database-enforced backstop in addition to the application-layer `can()` check. Rejected for v1, not because it's a bad idea in the abstract, but because: (1) it duplicates policy logic in two places (RLS policies in SQL and `can()` rules in TypeScript) that must be kept in sync, doubling the maintenance surface for a boundary that (per the Positive/Negative analysis above) doesn't carry the same stakes as true multi-tenant isolation; (2) RLS session-variable plumbing interacts awkwardly with Prisma's connection pooling model (Prisma doesn't set per-query session variables cleanly without a middleware workaround) and with `graphile-worker`'s background-job connections (ADR-0009), which don't naturally carry a "current chapter" request context the way an HTTP request does; (3) org-wide cross-chapter queries (leaderboards, reporting) would need to explicitly bypass RLS via a privileged role anyway, undercutting the safety-net argument for the majority of the platform's most-used queries. Worth revisiting as a defense-in-depth layer later if a security review specifically flags the lack of a DB-level backstop as unacceptable, but not required for launch.
- **Treat each chapter as a fully separate deployment (separate Vercel project + separate Postgres instance per chapter)**: rejected outright — this is the SaaS-per-tenant pattern taken to its extreme, multiplying operational burden by the number of chapters (currently at least two, likely growing) for an org with no dedicated ops staff (research 04), and it makes every cross-chapter feature (the org-wide leaderboard and activity feed the gamification research calls for) require cross-database aggregation instead of a single query. There is no stated business reason (no per-chapter data-residency law, no per-chapter separate legal entity) that would justify this cost.

## Implementation Notes

**Schema fragment** (`volunteering` schema):
```prisma
model Chapter {
  id        String   @id @db.Text          // ULID, ADR-0005
  name      String
  city      String
  region    String?
  status    ChapterStatus @default(ACTIVE)
  createdAt DateTime @default(now()) @map("created_at")
  @@schema("volunteering")
  @@map("chapters")
}

model Opportunity {
  id         String   @id @db.Text
  chapterId  String   @map("chapter_id")    // plain attribute, no DB-level FK enforcement required
                                              // across bounded contexts, but Chapter lives in the
                                              // SAME schema here so an ordinary Postgres FK IS used
                                              // (this is an intra-schema reference, not cross-context)
  chapter    Chapter  @relation(fields: [chapterId], references: [id])
  title      String
  // ...
  @@schema("volunteering")
  @@map("opportunities")
}
```
Note the nuance: `chapter_id` on `Opportunity` *is* allowed a real Postgres FK constraint, because `Chapter` and `Opportunity` live in the same `volunteering` schema — the canonical "no cross-schema FK" rule applies to references crossing *bounded-context schema boundaries* (e.g., `volunteering.opportunities.created_by` pointing at `identity.persons.id`, which is by-ID-only, no FK), not to references within one schema. Chapter-as-domain-entity means most chapter references are intra-`volunteering`-schema and can use real FKs; only references from *other* schemas (e.g., `gamification.leaderboard_entries.chapter_id`, `moderation.reports.chapter_id`) are cross-schema, by-ID-only, app-enforced references, exactly like a person or opportunity reference from those schemas would be.

**Query pattern for chapter-scoped vs. org-wide views**:
```typescript
// Chapter-scoped: explicit filter, gated by can() at the procedure boundary
const chapterOpportunities = await db.opportunity.findMany({
  where: { chapterId: input.chapterId },
});

// Org-wide: no filter at all — not a bypassed restriction, there was never one
const globalLeaderboard = await db.leaderboardEntry.findMany({
  orderBy: { points: "desc" },
  take: 50,
});
```

**Chapter status lifecycle**: `active | inactive` (not `deleted` — chapters are not hard-deleted given their opportunities/hour-history must survive for grant reporting; an inactive chapter's opportunities simply stop accepting new sign-ups, enforced in the `volunteering` module's business logic, not by removing rows).

**Trigger conditions for revisiting this ADR** (what would need to change if the platform were ever licensed to other foundations): if the Agentics Foundation, or a successor initiative, decides to offer this platform to a second, legally and organizationally separate nonprofit, this decision must be re-opened before onboarding that second organization — do not attempt to retrofit multi-tenancy incrementally under delivery pressure. The concrete migration path at that point: promote "Foundation" (not "Chapter") to the tenant boundary, add a `foundation_id` at the top of the scope hierarchy above `chapter` in ADR-0007's RBAC model, introduce Postgres RLS or schema-per-foundation isolation at that new top level (chapters remain domain entities *within* a foundation, unchanged), and audit every existing query for an implicit "all chapters" assumption (the org-wide leaderboard, org-wide reporting, and global activity feed queries specifically) that would need an explicit foundation filter added. This is a substantial, deliberate migration, not a config flag — flagged here so it is not assumed to be a small change later.
