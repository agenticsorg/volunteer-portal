# Agentics Foundation Volunteer Portal — Initial Deep Research

Six parallel research threads, run 2026-08-10. Each linked file is the full report; this page synthesizes them into implications and an initial scope.

- [01 — Organization & Comparable Orgs](01-organization-and-comparables.md)
- [02 — Gamification & Social Patterns](02-gamification-and-social.md)
- [03 — Training Video / LMS Patterns](03-training-video-lms.md)
- [04 — Technical Architecture & the ruvnet Ecosystem](04-technical-architecture.md)
- [05 — Domain & Compliance](05-domain-and-compliance.md)
- [06 — UX & Information Architecture](06-ux-and-ia.md)

## Key finding: who we're building this for

The **Agentics Foundation** (agentics.org) is a real nonprofit founded by **Reuven Cohen ("ruvnet")** — the same author behind the claude-flow/ruv-swarm/AgentDB tooling this repo was scaffolded with. It's modeled explicitly on Apache Foundation principles, already runs city chapters (London, Silicon Valley), hackathons, weekly "AI Hackerspace" live events, and an education arm (Agentic Engineering Academy) with badges, coaching, and certificates. Volunteers are largely AI engineers, open-source contributors, and educators. No formal public volunteer-program page exists yet — **this should be validated directly with the Foundation** before locking scope. See [01](01-organization-and-comparables.md) for sources and disambiguation from the unrelated Linux Foundation "Agentic AI Foundation."

## Should we build on ruvnet's existing OSS projects?

Mostly no, per [04](04-technical-architecture.md): claude-flow, ruv-swarm, and agentic-flow are AI coding-agent orchestration tools for *building software*, not runtime dependencies for *serving a web app* — keep using them as dev tooling only, don't wire them into the product. The one plausible exception is **RuVector** (ruvnet's embedded vector DB) for semantic search of opportunities/training content, but it's early and Rust-native; a `pgvector` extension on the primary Postgres database is the lower-risk MVP choice, with RuVector revisited later if search quality becomes a real pain point.

## Recommended MVP direction

**Stack:** Next.js frontend, Postgres (Supabase/Neon) for the data model including the points/badges ledger, Supabase Auth or Clerk for login (+ SSO via WorkOS if partner orgs need it later), Vercel/Render hosting. Training video: **embed-first** — unlisted YouTube or low-tier Vimeo behind a lightweight progress-tracking layer, with human-corrected captions from day one (WCAG requirement, not optional); revisit Cloudflare Stream/Mux once access control or analytics needs grow. See [03](03-training-video-lms.md) and [04](04-technical-architecture.md).

**Gamification:** points/badges as a byproduct of real actions (training completion, logged hours), not a separate game layer — permanent shareable profile badges (GitHub/Trailhead model), skill-tree training paths gating volunteer roles, team/guild structures for accountability, activity feed with kudos, and *scoped* (not global) leaderboards. Keep points secondary to meaningful recognition — this audience skews high-intrinsic-motivation, where heavy-handed gamification measurably backfires. See [02](02-gamification-and-social.md).

**Data model / compliance day-one requirements** (see [05](05-domain-and-compliance.md)):
- Person-centric identity with pluggable roles (volunteer/mentor/content-admin/org-admin), not duplicate accounts per role
- Hour entries as immutable-once-approved records (submitted → approved → approver ID/timestamp), exportable for grant reporting
- Per-purpose consent tracking (newsletters, photo/name publication, leaderboard participation) — build to GDPR as the strictest applicable standard given a likely-international volunteer base
- Moderation primitives (report/block/mute/suspend + audit log) from day one for social features
- WCAG 2.1 AA accessibility, with captioning as a publish gate for training video

**IA:** Home/Feed, Opportunities, Training Library, My Progress, Community (leaderboard/teams), Admin — one flexible container model rather than three bolted-together apps. See [06](06-ux-and-ia.md).

## Open questions to validate with the Foundation before scoping further

1. What volunteer activities actually need tracking today (chapter organizing, code contributions, event support, content creation)?
2. Is there an existing Discord/community workflow this needs to integrate with or migrate from?
3. Expected volunteer population size and geographic distribution (drives GDPR/compliance priority and hosting region choices)?
4. Any existing training content/recordings to migrate, or starting from zero?
5. Budget/ops capacity — does the Foundation want to self-host anything, or fully favor managed/low-ops services?
