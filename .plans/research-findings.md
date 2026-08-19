# Research Findings: Agentics Foundation Volunteer Portal

## Introduction

This document presents findings from a pre-implementation deep-research pass validating the technical stack choices, compliance claims, and ruvnet/ruflo ecosystem dependencies documented in concept.md. The research confirms the viability of the specification's core approach while surfacing concrete decisions that must be resolved before Build Sequence step 1 begins. All findings include confidence grades (confirmed/likely/uncertain/contradicted) and citations to enable verification and future reference.

---

## Decisions Needed Before Implementation

The following decisions block Build Sequence step 1 and must be resolved before any schema or application code is written:

- [ ] **Database provider and access control layer.** Choose between Supabase or Neon. If Supabase, leverage Row-Level Security (RLS) for role-scoped access; if Neon, role-scoped access moves into the application and Data Access Layer. This choice affects schema design and authorization boundaries.

- [ ] **Account linking policy for Discord and Google.** Decide whether simultaneous Discord+Google login to the same volunteer account is automatic (email-based linking) or manual (explicit user choice). Auth.js's allowDangerousEmailAccountLinking is unsafe by default and requires documented email-verification guarantees.

- [ ] **Email provider selection.** Choose Resend or Postmark. Resend offers better Next.js/React Email integration; Postmark offers stronger transactional deliverability guarantees.

- [ ] **PDF library and PDF/UA tagging support.** Recommend @react-pdf/renderer (no cold-start penalty, JSX/Flexbox layout). Verify whether it supports PDF/UA (ISO 14289) tagging for accessible verification letters.

- [ ] **Discord bot deployment model for v1.** Explicitly confirm that the Discord role-sync job runs as Vercel Cron + HTTP interactions for /link commands, with no persistent always-on bot process. This design is feasible and the concept.md already specifies it, but the technical rationale should be stated in the spec to prevent future architecture re-scoping.

- [ ] **Schema additions: AuditLog table.** Concept.md section 9 requires an audit log on all admin actions and hour adjustments, but the data model lists only four objects. Add AuditLog as a 5th table minimum (actor, action, entity, before/after, timestamp). If co-leads on a single project are ever needed, add a 6th table (ProjectLead join table).

- [ ] **Event-to-HourEntry semantics.** Clarify whether events accrue verification-letter-eligible hours. If yes, the system needs a clear approval model for event hours. If no, the application must prevent HourEntry.assignment_id from targeting event-type assignments.

- [ ] **GDPR Art. 27 EU representative.** Decide whether to designate an EU representative (Art. 27 requirement) or document why the narrow "occasional, small-scale, low-risk" exemption applies. This choice affects compliance scope.

- [ ] **Breach notification process and privacy officer.** Add documented procedures for PIPEDA mandatory breach reporting to the Office of the Privacy Commissioner and affected individuals when a breach meets the "real risk of significant harm" threshold. Designate a privacy officer responsible for incident response.

- [ ] **Correct ruvnet plugin installation mechanism.** The ruflo-* plugins (ruflo-sparc, ruflo-migrations, ruflo-aidefence, etc.) are distributed via the Claude Code plugin marketplace, not npm. Update the spec or build documentation to clarify: install via `claude plugin add ruvnet/ruflo` and then use (e.g., `ruflo-sparc@ruflo`), not `npm install`.

---

## Technical Stack Validation

### 1. Next.js App Router and Server Actions on Vercel
**Confidence: confirmed, with architectural caveat.**

Server Actions are viable and ship with baseline CSRF protection via Origin/Host header validation and encrypted action references. However, each Server Action is a directly-reachable public POST endpoint. Authorization and role checks must live inside the action itself or a Data Access Layer; do not rely on UI-only gating or middleware-only authorization.

Relevant caution: CVE-2025-29927 (CVSS 9.1) demonstrated that Next.js middleware-based auth can be bypassed via spoofed headers. This reinforces that role-based access control must be enforced inside Server Actions or a DAL, never in middleware alone.

Sources:
- nextjs.org/docs/app/guides/server-actions
- TurboStarter 2026 Security Guide (turbostarter.dev/blog/complete-nextjs-security-guide-2026-authentication-api-protection-and-best-practices)

### 2. Supabase vs Neon for PostgreSQL
**Confidence: likely sufficient either way, but architectural choice is unresolved.**

Both databases encrypt data at rest and provide automated backups with point-in-time recovery. The key difference is where role-scoped access control lives:

- **Supabase:** Row-Level Security (RLS) policies let you write JWT-claim-based access policies directly in the database (e.g., `WHERE projects.lead_id = current_user.id`). Minimal application code required.
- **Neon:** Pushes role scoping into the application and ORM layer. More code at the boundary, but familiar for teams accustomed to application-layer authorization.

This is not a technical blocker either way, but it is an architectural decision that affects schema design, query patterns, and the security boundary model. The spec should pick one explicitly rather than leaving "Supabase or Neon" open.

Source: leanware.co/insights/supabase-vs-neon

### 3. Auth.js with Discord and Google OAuth
**Confidence: confirmed, with account-linking caveat.**

Discord OAuth is fully supported by Auth.js. Discord user ID is easily extracted into JWT/session via Auth.js callbacks and is required for the role-sync job anyway.

Caution: Auth.js's allowDangerousEmailAccountLinking setting auto-links accounts by email across providers. The Auth.js documentation explicitly flags this as unsafe unless email verification is guaranteed. Concept.md does not specify whether Discord and Google accounts with the same email should link automatically or require explicit user confirmation. This is an account-takeover risk if done carelessly and must be decided before signup flow implementation.

Sources:
- next-auth.js.org/providers/discord
- next-auth GitHub Discussion #2808

### 4. discord.js Bot and Vercel Deployment
**Confidence: confirmed; concept.md already avoids the blocker, but should state it explicitly.**

A real-time Gateway-connected discord.js bot cannot run on Vercel serverless (WebSocket connections are not persistent on Vercel's function layer). However, the concept.md design already sidesteps this:

- Role sync runs as a **scheduled reconcile job** (Vercel Cron), not real-time event listeners. This only requires REST API calls.
- `/link` command runs as an HTTP interaction endpoint on Vercel, handling the initial request and replying via interaction response.

Neither requires a persistent bot process. This design is simpler and self-healing after downtime.

Only if real-time Gateway event listening (e.g., message events) is added in a future version would a separate always-on host (Railway, Fly.io, Render) be needed.

**Recommendation:** The spec should explicitly state that v1 requires no persistent Discord bot process, only Vercel Cron and HTTP interaction handling. This prevents future scope creep and clarifies the deployment model.

Source: Vercel Knowledge Base (vercel.com/kb/guide/can-i-deploy-discord-bots-to-vercel)

### 5. Email: Resend vs Postmark
**Confidence: likely sufficient either way, undecided in spec.**

- **Resend:** Better Next.js/React Email integration and DX, larger free tier, but sends via AWS SES (deliverability bounded by AWS SES reputation).
- **Postmark:** Dedicated transactional email infrastructure, ~98.7% inbox placement guarantee, more mature transactional focus, smaller free tier.

For v1's five low-volume transactional triggers (signup confirmation, assignment approved, hours approved, meeting reminder, verification letter ready), either works. Choose Postmark if guaranteed inbox placement for "verification letter ready" is a priority; choose Resend if Next.js integration and developer experience are the primary drivers.

Source: Courier 2026 comparison (courier.com/integrations/compare/postmark-vs-resend)

### 6. PDF Generation for Verification Letters
**Confidence: confirmed; recommend @react-pdf/renderer, but tagging is unverified.**

Puppeteer/Chromium-based PDF generation introduces cold-start latency and (historically) bundle-size constraints. Vercel raised the bundle limit to 5GB in June 2026, but cold-start risk remains for a serverless function.

@react-pdf/renderer generates PDFs in <500ms with no headless browser. It uses JSX and Flexbox-only layout, suitable for fixed letterhead layouts. No external dependencies or bundle bloat.

**Caveat:** Concept.md section 9 requires WCAG 2.1 AA accessibility compliance. WCAG applies to the web application's HTML; PDFs require separate PDF/UA (ISO 14289) tagging for screen-reader accessibility. Not all serverless PDF renderers support PDF/UA tagging by default. @react-pdf/renderer's PDF/UA support should be verified before selection.

Recommendation: Use @react-pdf/renderer for verification letter generation. Before implementation, confirm whether it supports PDF/UA tagged output or if a secondary pass is needed.

---

## Compliance Research

### 1. PIPEDA (Personal Information Protection and Electronic Documents Act)
**Confidence: likely applicable, with scope and implementation gaps.**

The specification states flatly "PIPEDA applies (Ontario)," but this requires nuance. PIPEDA applies to organizations in commercial activity; a nonprofit with no commercial revenue may technically fall outside PIPEDA's scope. However, best practice is to treat PIPEDA as applicable regardless.

More critically, the specification's compliance floor is incomplete. Section 9 requires a privacy policy, stated retention period, and deletion request path, but omits:

- A designated privacy officer or incident response lead accountable for PIPEDA obligations.
- A documented breach response plan.
- **Mandatory breach notification procedures.** PIPEDA (as amended in 2024) requires notification to the Office of the Privacy Commissioner (OPC) and affected individuals when a breach meets the "real risk of significant harm" threshold. This is a binding legal requirement, not optional. No mechanism for this exists in the concept.md compliance section.

These gaps must be filled in a separate compliance implementation task (beyond the scope of the volunteer portal build itself).

Sources:
- Charity Law Group "Privacy Guide for Canadian Charities" (charitylawgroup.ca/charity-law-questions/privacy-guide-for-canadian-charities)
- IAPP "The new PIPEDA data breach notification requirements" (iapp.org/news/a/the-new-pipeda-data-breach-notification-requirements-twelve-years-in-the-making)

### 2. GDPR (General Data Protection Regulation)
**Confidence: confirmed applicable, with unresolved binary choice.**

GDPR Article 3(2) triggers on targeting or monitoring EU residents, not mere presence. A EU volunteer actively signing up and being accepted is generally read as sufficient targeting. The spec's statement "GDPR applies to any EU volunteer" is a reasonable practical simplification, though not strictly precise.

Beyond PIPEDA, GDPR imposes additional obligations:

- Lawful-basis documentation for processing.
- Broader data subject rights (erasure/portability beyond PIPEDA's scope).
- **Article 27 EU Representative Requirement.** Organizations not established in the EU but offering services to EU residents must designate an EU representative. A narrow exemption exists for "occasional, small-scale, low-risk" processing, but it is interpreted strictly and rarely applies to an ongoing web service.

The specification does not address this binary: designate an EU representative or document why the occasional-processing exemption applies. This choice affects legal scope and must be made before launch.

Sources:
- EDPB Guidelines 3/2018 on territorial scope (edpb.europa.eu)
- gdpr-info.eu Art. 27

### 3. WCAG 2.1 AA (Web Content Accessibility Guidelines)
**Confidence: confirmed required, with tooling and PDF gaps.**

The specification correctly requires WCAG 2.1 AA compliance. However, the implementation approach is incomplete:

- **Automated testing:** axe-core integrated into Playwright/Cypress can catch ~30% of WCAG success criteria. Automated tools find structural issues (alt text, contrast, ARIA attributes) but miss context-dependent failures (focus management, keyboard-only navigation, screen-reader semantics).
- **Manual testing required:** Keyboard-only navigation and screen-reader testing (NVDA, JAWS, VoiceOver) are mandatory for the remaining 70%. Form-specific failures to watch for: label association, color-only contrast, missing aria-live for inline validation errors.
- **PDF Accessibility Gap:** WCAG 2.1 AA covers the web application. Verification letters are PDFs, and WCAG does not apply to PDFs. PDFs require PDF/UA (ISO 14289) tagging (tags, alt text for images, logical reading order). Not all PDF renderers support PDF/UA by default. This gap is currently unaddressed in the specification.

Recommendation: The build plan should include manual accessibility testing and verification that the selected PDF renderer supports PDF/UA tagged output.

Source: Grackle Docs "WCAG vs PDF/UA" (grackledocs.com)

---

## ruvnet Ecosystem Verification

### 1. ruvector (RuVector)
**Confidence: confirmed real; application is likely but not confirmed.**

ruvector is a real, MIT-licensed npm package (v0.2.41, "vector database for Node.js... semantic-search, embeddings, hnsw, rag"). It is actively maintained and available at registry.npmjs.org/ruvector.

The specification proposes using ruvector for dynamic skill matching: a volunteer writes free-text skills ("I know React and I've done some Figma work") and the portal surfaces matching projects. This use case is plausible and ruvector's capabilities (semantic search, embeddings, HNSW indexing) directly support it.

However, the application-specific implementation (volunteer free-text to project matching via ruvector) is not out-of-the-box. It must be built on top of ruvector as a custom matching layer. The specification's framing is accurate but should clarify that ruvector is the foundation, not the complete solution.

Source: registry.npmjs.org/ruvector

### 2. ruflo (Ruflo Build Harness)
**Confidence: confirmed real, active, MIT-licensed.**

ruflo is a real, MIT-licensed npm package maintained by ruvnet (v3.5.21, ~238k downloads/month). It is actively developed and matches the session's installed CLAUDE.md content for Ruflo configuration. It is a development-time harness, not a runtime dependency.

Source: registry.npmjs.org/ruflo

### 3. ruflo-* Plugins
**Confidence: real, but distribution mechanism conflates two patterns; spec requires correction.**

The specification lists ruflo-sparc, ruflo-migrations, ruflo-aidefence, and ruflo-adr as build-harness plugins. These packages do exist and do roughly what is claimed (GitHub issue ruvnet/ruflo#2004 confirms that aidefence provides PII/prompt-injection detection; migrations provide DB schema management).

**Critical gap:** These are not available as standalone npm packages on the npm registry. A literal `npm install ruflo-sparc` will 404. Instead, ruflo-* plugins are distributed as Claude Code plugin-marketplace entries. Installation is via the Claude Code UI (`/plugin marketplace add ruvnet/ruflo`) or CLI, then invoked as (e.g.) `ruflo-sparc@ruflo`.

Recommendation: The specification or build documentation should clarify that ruflo-* plugins install via the Claude Code plugin marketplace, not npm. This prevents build-time errors for developers following the spec literally.

Source: GitHub ruvnet/ruflo issue #2004 and observation of npm registry 404s

### 4. Optional, Low-Confidence ruvnet Packages
**Confidence: mixed, some uncertain.**

- **agentic-flow:** Confirmed real, MIT-licensed npm package by ruvnet. Plausible fit for LLM cost routing if the portal adds production LLM calls in a future version.
- **flow-nexus:** Confirmed real npm package, but proprietary license (not MIT). The spec correctly describes it as "a platform not a library," but does not flag the proprietary license. This matters if ever pulled in as a dependency.
- **agentics-meetup, yyz-agentics-june:** Uncertain. A real Toronto Agentics Foundation community and meetup exist, but neither name was directly confirmed as a live GitHub repository in this pass. Worth a direct lookup before planning data migration.

### 5. Confirmed Exclusions and 404 Packages
**Confidence: largely confirmed, one gap.**

**Confirmed 404 (correctly excluded):** agentic-tribe and easygig-ai genuinely 404 on npm and have no matching ruvnet GitHub repositories, as the spec states.

**Confirmed exclusions (correctly excluded):** QuDAG, Synaptic-Mesh, RuVix, rvm, ruv-FANN, and sublinear-time-solver are all real, actively maintained ruvnet repositories focused on agent/neural/distributed-systems infrastructure. Their exclusion from a CRUD volunteer portal is justified.

**Uncertain:** EXO-AI and RuQu could not be located under those exact names on npm or in ruvnet GitHub searches. They may be renamed, deprecated, or misremembered. Worth a direct follow-up lookup before treating this exclusion list as fully accurate for future reference.

Source: npm registry and ruvnet GitHub organization search

---

## Architecture Soundness

### 1. Role Scoping and Project Lead FK
**Confidence: likely sufficient for MVP, with one common retrofit gap.**

The model Volunteer.role + Project.lead foreign key cleanly supports the requirement "leads approve hours only for projects they lead" via a query filter: `WHERE Project.lead_id = current_user.id`. This scales to role-based access and is simple to implement.

Gap: This model supports only one lead per project. If the Agentics Foundation ever wants co-leads on a single project (shared leadership, distributed approval), Project.lead needs to become a join table (e.g., ProjectLead with volunteer_id, project_id, role). This is cheap to implement now as a pre-freeze decision but expensive to retrofit once production data exists.

Recommendation: If co-leadership is even a possibility, add the ProjectLead join table during foundation step. If strictly single-lead-per-project for the foreseeable future, the current FK is sufficient.

### 2. Polymorphic Assignment: Project vs Event
**Confidence: under-specified; concrete resolution recommended before schema freeze.**

The specification says "volunteer to project or event" but does not specify the implementation. This implies either:
- Nullable dual foreign keys (Assignment.project_id, Assignment.event_id, exactly one non-null).
- A discriminator column (Assignment.assignment_type = 'project'|'event').

**Recommendation:** Collapse to a single model: treat Event as a typed row inside Project (Project.type = 'project'|'event'). This keeps HourEntry to Assignment to Project as one join path for both browsing and reporting, avoiding duplicate queries and application logic.

More critically, there is an unresolved product decision: the spec says events need "signup and attendance tracking," not hours logging. But nothing in the schema prevents an HourEntry from targeting an event-Assignment. **Does meetup attendance accrue verification-letter-eligible hours, or not?** This is a binary product choice with real schema consequences:

- If yes: events must have an approval model (who approves event hours?).
- If no: the application must prevent HourEntry creation against event Assignments, or use a feature flag.

This decision must be made before schema design is frozen.

### 3. Audit Log Table
**Confidence: confirmed gap.**

Concept.md section 9 explicitly requires "audit log on all admin actions and hour adjustments." The four-object data model (Volunteer, Project, Assignment, HourEntry) does not include an AuditLog table. This is a contradiction.

**Required addition:** Add an AuditLog table with at minimum:
- actor (Volunteer FK, the admin/lead making the change)
- action (enum: 'created', 'updated', 'deleted', 'hour_approved', etc.)
- entity_type (enum: 'Volunteer', 'Project', 'Assignment', 'HourEntry')
- entity_id (the PK of the affected entity)
- before (JSON snapshot of old values)
- after (JSON snapshot of new values)
- timestamp (UTC)

The specification's claim that "four objects carry the entire system" is inaccurate once section 9's audit requirements are accounted for. The core schema is five tables at minimum.

### 4. Verification Letter Rollups and Admin Reporting
**Confidence: sound, contingent on resolving polymorphic-assignment semantics.**

The ability to query cumulative hours per volunteer and per project, and to filter by date range for verification letter generation, is straightforward with the core schema. The rollup logic is sound.

Contingency: If events do not accrue hours, queries must filter out event-type Assignments. If events do accrue hours, the letter template must clearly distinguish project hours from event hours (or not, per design choice).

### 5. Prior Art: CiviCRM and Hour-Tracking Systems
**Confidence: confirmed; no close analog exists.**

CiviCRM includes a volunteer/hours module but uses dozens of entities to support general-purpose CRM needs (contacts, cases, custom fields, relationships). It does not contradict the lean 4-object MVP schema.

More broadly, hour-tracking-plus-verification systems (e.g., Volgistics, Better Impact) tend to accrete auxiliary tables beyond a bare core:
- Audit trails (required for compliance).
- Role and permission joins (required for flexible governance).
- Custom fields and metadata (required for domain-specific data).

The volunteer portal's core is lean (4 objects) but will likely need auxiliary tables (audit, role joins) before release. This is expected and does not invalidate the core design.

---

## Summary

The specification's technical stack choices are confirmed viable. Next.js App Router on Vercel with Server Actions, Postgres (Supabase or Neon), Auth.js with Discord OAuth, and a Vercel Cron-based Discord reconcile job are all sound. The ruvnet and ruflo dependencies are real and active.

However, several architectural and compliance decisions are deferred in the specification and must be resolved before Build Sequence step 1. The most critical gaps are:

1. Database provider and access control layer (RLS vs app layer).
2. Event-to-hour semantics (do events accrue verification-letter-eligible hours?).
3. AuditLog table and co-lead support (how many tables, really?).
4. Breach notification process and privacy officer designation (PIPEDA compliance).
5. Plugin installation mechanism documentation (npm vs Claude Code marketplace).

With these decisions made, the portal can proceed to foundation implementation with confidence.
