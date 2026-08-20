# Research Report: Agentics Foundation Volunteer Portal — Technical Architecture

## 1. Ruvnet Project Audit

- **claude-flow / ruflo** (renamed; same repo) — TypeScript, MIT, 67.5k★. An "agent meta-harness" for orchestrating multi-agent AI coding swarms via Claude Code/Codex, with SQLite memory, hooks, and MCP tool suite. Purpose-built for **AI-assisted software development workflows**, not for serving end users of a web app. ([github.com/ruvnet/ruflo](https://github.com/ruvnet/ruflo))
- **ruv-swarm** (subdirectory of ruv-FANN) — Rust/WASM distributed agent-orchestration framework with "cognitive diversity" agent patterns. Also a dev-tooling/agent-coordination layer, not an application runtime. ([github.com/ruvnet/ruv-FANN/tree/main/ruv-swarm](https://github.com/ruvnet/ruv-FANN/tree/main/ruv-swarm))
- **agentic-flow** — TypeScript, **790★, license field returns null on GitHub's API** (verify actual LICENSE file before any use — do not assume permissive terms). Lets you swap AI model providers in Claude Code and "deploy fully hosted agents." Still an AI-agent deployment tool, not a web-app framework. ([github.com/ruvnet/agentic-flow](https://github.com/ruvnet/agentic-flow))
- **ruv-FANN** — Rust, MIT, 372★. A genuine from-scratch neural-network library (FANN rewrite) plus forecasting models (LSTM/N-BEATS/Transformers). A real ML library, but general-purpose numerical/forecasting, not aimed at web-app concerns like auth, video, or points ledgers. ([github.com/ruvnet/ruv-FANN](https://github.com/ruvnet/ruv-FANN))
- **RuVector** — Rust, MIT, 4.4k★. A legitimate high-performance embedded vector DB (HNSW, SIMD, sub-ms search, "self-learning" ranking). This is the most plausibly reusable piece: an embeddable vector search engine. ([github.com/ruvnet/RuVector](https://github.com/ruvnet/RuVector))
- **AgentDB** — TypeScript, MIT, 87★, built on RuVector. Explicitly framed as memory for AI agents (tracks which retrieved results an agent "used," retrains ranking) — a niche fit for agent-context retrieval, not a general app vector-search API. ([github.com/ruvnet/agentdb](https://github.com/ruvnet/agentdb))

The `ruvector.db`, `.claude-flow/`, `.swarm/`, `.agents/` artifacts in this repo are **scaffolding byproducts of using the ruflo CLI to develop this project**, not application dependencies — they came along because the repo was bootstrapped with that dev-tooling.

## 2. Honest Fit Assessment

- **No compelling case for claude-flow/ruv-swarm/agentic-flow as runtime dependencies.** They're AI-coding-agent orchestrators aimed at *how developers build software*, unrelated to serving volunteers, points, or video. Keep using ruflo purely as dev-tooling for building this project — don't wire it into the product itself.
- **RuVector is a legitimate, narrow "maybe."** If the portal wants semantic search (matching volunteers to opportunities by free-text skills/interests, or searching training-video transcripts), an embedded Rust vector DB is architecturally interesting — but it's young (4.4k★, no enterprise track record), Rust-native (integration overhead for a small team likely on Node/Python), and this is a very-early-stage need for an MVP. A managed pgvector extension on your primary Postgres is far lower-risk for a small team and avoids running a second data store.
- **ruv-FANN's forecasting models** could theoretically power volunteer-attrition/no-show prediction later, but that's a stretch goal, not MVP scope.
- **Verdict**: treat all ruvnet projects as dev tooling only for now. Revisit RuVector/pgvector for semantic search post-MVP if search quality becomes a real pain point.

## 3. Recommended Stack (2025-2026, small-team, low-ops)

- **Frontend**: Next.js (React) — SSR/SEO for public opportunity listings, app-router for the member portal, large hiring pool.
- **Backend/API**: Next.js API routes or a lightweight Node (Fastify/NestJS) service; avoid a separate microservices split until scale demands it.
- **Database**: Managed Postgres (Supabase or Neon) — relational integrity for points/badges/hours ledgers, plus `pgvector` if/when semantic search is needed, avoiding a second DB.
- **Auth/SSO**: Supabase Auth or Clerk for baseline email/social login; add Google Workspace / Microsoft Entra SSO via WorkOS or Entra External ID (free to 50k MAU) if partner orgs need enterprise SSO. ([workos.com](https://workos.com/blog/the-best-5-sso-providers-to-power-your-saas-app-in-2025), [ssojet.com](https://ssojet.com/blog/best-enterprise-authentication-solutions-2026-ranked))
- **Hosting**: Vercel (frontend) + Supabase/Neon (DB) or Render/Fly.io for backend — usage-based, no dedicated ops staff needed; scales to zero-ish cost at nonprofit traffic levels.
- **Gamification/points engine**: a dedicated Postgres schema (event log → points ledger → badge rules engine), not a separate service; event-driven design like the open-source Oasis PBML pattern (points/badges/milestones/leaderboards) is a good reference model. ([github.com/isuru89/oasis](https://github.com/isuru89/oasis))
- **Training-video module**: don't self-host video. Use Cloudflare Stream or Mux (~$5/1000 min stored + $1/1000 min delivered, no egress fees) for adaptive streaming; store only metadata/progress in Postgres. Vimeo is a pricier but lower-code alternative if an API-first integration is too much lift initially. ([mux.com](https://www.mux.com/articles/the-best-video-apis-right-now), [buildmvpfast.com](https://www.buildmvpfast.com/api-costs/video))
