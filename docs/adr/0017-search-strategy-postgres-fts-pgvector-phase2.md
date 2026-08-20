# ADR-0017: Search Strategy — Postgres Full-Text Search Now, pgvector Phase 2

## Status
Accepted — 2026-08-10

## Context
The platform needs search/discovery across three bounded contexts that each have free-text content: **volunteering** (opportunity title/description, location, skills-needed tags), **training** (video titles, descriptions, transcripts), and **community** (post bodies, comments). Users need to find opportunities by keyword, search training content by topic, and search community discussion — none of these are large-scale, adversarial search problems (this is not e-commerce product search at millions-of-SKUs scale); it's a nonprofit platform with a bounded, moderate content volume.

The technical research (`docs/research/04-technical-architecture.md`) directly evaluated ruvnet's **RuVector** — a legitimate, high-performance embedded vector database (HNSW, SIMD, sub-millisecond search, 4.4k GitHub stars) — as a candidate and concluded it is "a legitimate, narrow 'maybe'" but ultimately not a good fit for this project specifically: it is **young (no enterprise track record)**, **Rust-native**, which means real integration overhead for a team building entirely in TypeScript/Node per the canonical stack, and semantic search is **not a validated MVP need** — it's a speculative future capability, not a launch requirement. The research's explicit verdict: "a managed pgvector extension on your primary Postgres is far lower-risk for a small team and avoids running a second data store," and RuVector should be revisited only "post-MVP if search quality becomes a real pain point."

This ADR translates that research conclusion into a concrete architectural decision and a genuinely actionable phase-2 path, rather than leaving pgvector as a vague "maybe later."

## Decision
**Phase 1 (v1, at launch): Postgres native full-text search** (`tsvector`/`tsquery` with GIN indexes) is the search implementation for opportunities, training content, and community posts, running in the same Postgres instance (Neon, per ADR-0016) already hosting all application data — no new infrastructure, no new data store, no new vendor.

**Phase 2 (documented, not built at launch): `pgvector`** is the pre-approved semantic-search upgrade path, added as a Postgres extension on the *same* Neon instance if and when keyword search proves insufficient. **RuVector is explicitly rejected** as a candidate for this project — not because it is a bad project, but because it is the wrong tool for this team's stack and this platform's actual (currently non-semantic) search needs: it would require running and operating a second, Rust-native data store outside the team's primary language, for a capability (semantic/similarity search) that isn't validated as needed yet. `pgvector` gets the same job done inside infrastructure that already exists, already has Terraform-managed backups (ADR-0016), and already has the team's Prisma/TypeScript tooling pointed at it.

### Phase 1 schema and index approach
Each schema that needs search owns its own `tsvector` column and GIN index — consistent with the no-cross-schema-FK, schema-owns-its-data architecture. There is no shared cross-schema "search index" table; search is federated per-context and the UI composes results from parallel per-schema queries where a unified search experience (e.g., a global search bar) is needed.

```sql
-- volunteering schema
alter table volunteering.opportunities
  add column search_vector tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(location_name, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(skills_tags_text, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'C')
  ) stored;

create index opportunities_search_idx
  on volunteering.opportunities using gin (search_vector);
```
```sql
-- training schema
alter table training.videos
  add column search_vector tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(transcript_text, '')), 'C')
  ) stored;

create index videos_search_idx
  on training.videos using gin (search_vector);
```
```sql
-- community schema
alter table community.posts
  add column search_vector tsvector
  generated always as (to_tsvector('english', coalesce(body, ''))) stored;

create index posts_search_idx
  on community.posts using gin (search_vector);
```

`generated always as ... stored` columns keep the `tsvector` automatically in sync with source content on every insert/update — no separate trigger or application-level reindex step to maintain, and no drift risk between content and index. `setweight` tiers (A/B/C) let title matches rank above body-text matches without a separate ranking service.

Query pattern uses `websearch_to_tsquery` (not raw `to_tsquery`), because it accepts natural, Google-like user input (quoted phrases, `-exclude`, bare keywords) without requiring the frontend to construct tsquery boolean syntax:

```sql
select id, title, ts_rank(search_vector, query) as rank
from volunteering.opportunities, websearch_to_tsquery('english', $1) query
where search_vector @@ query
  and chapter_id = $2  -- scope filtering composes naturally with FTS
order by rank desc
limit 20;
```

Chapter-scoping, opportunity-status filtering, and other structured `WHERE` predicates compose directly with the FTS `@@` match in the same query — full-text search here is a predicate, not a separate retrieval system requiring result-set intersection logic in the application layer.

For transcript search specifically (training videos), `transcript_text` is populated from the caption/transcript file already required for WCAG 2.1 AA compliance (captions are a compliance requirement per the research, independent of search) — so transcript search is a free byproduct of the accessibility work, not additional content-authoring burden.

### Phase 2 trigger and path (pgvector)
Phase 2 is **not scheduled** — it is a documented, pre-approved response to a specific, observable trigger condition, so that if/when the trigger fires, the team executes a known plan rather than re-litigating the search stack under time pressure. Trigger conditions (any one is sufficient to open the phase-2 work):
- Support/feedback signal that keyword search is failing on synonym/intent mismatches a volunteer would reasonably expect to work (e.g., searching "helping kids read" doesn't surface a "literacy tutoring" opportunity) — tracked via a lightweight "search didn't find what I wanted" feedback affordance on the search results page, logged to `volunteering.search_feedback_events`.
- Product decision to add AI-assisted opportunity-matching ("recommended for you" based on a volunteer's stated interests in free text) — a feature that inherently requires embedding similarity, not keyword match.
- Training content library growing large enough (hundreds of hours of video) that transcript keyword search demonstrably under-performs semantic "find the video that explains X concept" queries in user testing.

When triggered, the phase-2 path is:
1. Enable the `pgvector` extension on the existing Neon Postgres instance: `create extension if not exists vector;` — Neon supports `pgvector` natively as a first-class extension, requiring no new provider relationship (validated as part of the ADR-0016 hosting decision).
2. Add an `embedding vector(1536)` column (dimension matches the chosen embedding model, e.g. OpenAI `text-embedding-3-small` or an equivalent) alongside the existing `search_vector tsvector` column — additive, not a replacement, so keyword search continues working as a fallback/component even after semantic search ships.
3. Add an HNSW index (`create index ... using hnsw (embedding vector_cosine_ops)`) — pgvector has supported HNSW since v0.5.0, giving comparable index-structure characteristics to what RuVector would have offered, without leaving Postgres.
4. Embedding generation runs as a graphile-worker job (`generate_embedding`) triggered off each schema's `domain_events` outbox on content create/update — consistent with the existing outbox-driven integration pattern already used throughout the architecture, rather than introducing a new synchronous embedding-on-write call in the request path.
5. Hybrid ranking (combining `ts_rank` keyword relevance and cosine similarity) is implemented as a weighted-sum re-ranking in the application query layer, a well-established pattern with `pgvector` + native FTS — no additional infrastructure required for hybrid search either.

## Consequences
### Positive
- Zero new infrastructure or vendor relationship at launch — search runs in the same Postgres transaction/backup/DR envelope as everything else in ADR-0016, inheriting PITR, the DR drill process, and the existing Prisma/TypeScript tooling for free.
- `generated always as ... stored` columns eliminate an entire class of "search index went stale" bugs common to systems with a separately-maintained search index (e.g., Elasticsearch reindex jobs falling behind).
- Transcript search is a free consequence of WCAG caption compliance work already required by ADR (accessibility), not incremental scope.
- The phase-2 path avoids a second data store even after adding semantic search — `pgvector` lives in the already-chosen, already-operated Postgres instance, so the DR/backup/Terraform story from ADR-0016 requires no changes when phase 2 ships.
- Explicitly rejecting RuVector now, with reasons on record, prevents future re-litigation of "why not use ruvnet's own vector DB" from developers unfamiliar with the original research — the team-fit and maturity reasoning is preserved here.

### Negative / Trade-offs
- Postgres FTS has no built-in synonym/semantic understanding — a search for "coding" will not surface content tagged only "programming" unless a synonym dictionary is configured (Postgres supports `ts_thesaurus`/`ts_dict`-based synonym mapping, which is a real but manually-curated mitigation, not a substitute for true semantic search). This is the exact gap phase 2 exists to close if it becomes a real problem.
- Federated per-schema search (no shared search index table) means a true cross-context "search everything" experience requires the application layer to fan out to three schemas' queries and merge/rank results client-side or in a composing service — more application code than a single unified search index would need. Accepted as consistent with, and a direct consequence of, the no-cross-schema-coupling architecture already chosen for the whole platform.
- `ts_rank`'s relevance model is simpler than a dedicated search engine's (no BM25, no learned-relevance signals) — acceptable at this platform's content volume (hundreds to low thousands of opportunities/videos/posts, not millions), but would need revisiting (likely as part of the same phase-2 trigger evaluation) if content volume grows by orders of magnitude.
- Generated-column `tsvector` on `transcript_text` means transcript edits re-trigger the generated-column computation on every update — negligible cost at expected video-library scale, but worth knowing if transcripts are ever bulk-edited by a migration script.

## Alternatives Considered
- **RuVector (ruvnet's embedded vector DB).** Rejected per the research's explicit assessment: Rust-native (the team is TypeScript/Node end-to-end per the canonical stack — this would be the only Rust component in the entire system, a real operational and hiring-pool cost), early-stage with no enterprise track record (4.4k stars, MIT-licensed, but unproven at production scale for a team that cannot afford to be an early adopter's debugging partner), and solves a semantic-search problem this platform has not yet validated it needs. Running it would also mean operating a second data store outside the Postgres-centric backup/DR/Terraform story built in ADR-0016, for no capability keyword search doesn't already provide at launch.
- **A dedicated search engine (Elasticsearch/OpenSearch or a hosted equivalent like Algolia/Typesense) from day one.** Rejected: introduces a second data store that must be kept in sync with Postgres (via CDC or dual-writes, both real engineering and operational cost), for a nonprofit platform at a content scale where Postgres FTS's GIN-indexed performance (sub-10ms on tables in the tens-of-thousands-of-rows range, far beyond this platform's realistic v1 scale) is not a bottleneck. The added infrastructure and sync-consistency burden isn't justified by a search-quality gain the team hasn't validated is needed.
- **Managed semantic search API (e.g., a hosted embeddings + vector search SaaS) instead of self-hosted pgvector for phase 2.** Rejected as the phase-2 default (though not ruled out permanently): introduces a new vendor and a new data-residency/DPA (Data Processing Agreement) consideration under GDPR (ADR-0014) for content that includes user-generated community posts — every new processor is a new entry in the sub-processor inventory the research flags as a GDPR obligation. `pgvector` on the already-approved, already-DPA'd Neon instance avoids that expansion entirely. A managed SaaS could still be reconsidered if `pgvector` at scale proves genuinely insufficient, but it is not the pre-approved default path the way `pgvector` is.

## Implementation Notes
- Prisma schema: `tsvector` generated columns are not natively representable in Prisma's schema language as of the canonical Prisma version in use, so they are added via a `prisma migrate dev --create-only` hand-edited SQL migration rather than the declarative `schema.prisma` file — documented with a comment block in the migration file explaining why (`-- MANUAL: Prisma does not support GENERATED ALWAYS AS columns natively; this migration is hand-authored.`). The column is marked `@map` + `Unsupported("tsvector")` in `schema.prisma` so Prisma is aware of it for introspection without trying to manage its generation logic.
- Search API surface: exposed via tRPC procedures per schema — `volunteering.search.opportunities({ query, chapterId, limit })`, `training.search.videos({ query, limit })`, `community.search.posts({ query, chapterId, limit })` — plus a composing `search.global({ query })` tRPC procedure in a thin cross-cutting `apps/web/src/server/search` module that calls all three in parallel (`Promise.all`) and merges/labels results by type for a unified search-bar UI, without any schema importing another schema's Prisma client directly.
- `english` text search configuration is used uniformly at launch (matches the primary operating language of Agentics Foundation's volunteer base); if meaningful non-English content volume emerges, a `language` column per content row plus `to_tsvector(language::regconfig, ...)` is the documented extension point — not built at launch since it's speculative.
- `skills_tags_text` on `opportunities` is a denormalized flattened string (e.g., `'python javascript mentoring'`) maintained alongside a proper normalized `opportunity_skills` join table used for structured filtering — the flattened text column exists solely to feed the generated `tsvector` column, since Postgres generated columns cannot reference other tables.
- Search feedback logging (`volunteering.search_feedback_events`: `id, subject_id, query_text, result_count, clicked_result_id, created_at`) is the concrete instrumentation that informs the phase-2 trigger decision — reviewed quarterly by whoever owns product decisions, not automatically actioned.
- Monitoring: OpenTelemetry spans wrap each search tRPC procedure (`search.opportunities`, etc.) with `db.statement` and result-count attributes, and Sentry performance monitoring flags any search query exceeding a 200ms p95 threshold — the earliest concrete signal that Postgres FTS is becoming a bottleneck worth investigating before it becomes a user-facing complaint.
