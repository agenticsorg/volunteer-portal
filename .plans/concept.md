# Agentics Foundation Volunteer Portal

## Specification Summary

**Build decision:** custom build, not an off-the-shelf volunteer platform. **Non-negotiable requirements:** hours tracking with verification letters, project-based assignments (not just event shifts), Discord integration. **Explicitly out of scope for v1:** Slack, under-18 volunteers, badges/gamification, engagement analytics.

---

## 1. Data Model

Four objects carry the entire system.

| Object | Fields |
|---|---|
| **Volunteer** | identity, Discord ID, email, skills, timezone, availability, status, agreement timestamps |
| **Project** | name, lead, description, needed skills, open/closed state |
| **Assignment** | volunteer → project or event, role, start date, status |
| **HourEntry** | volunteer, assignment, date, hours, description, approval status, approver |

Verification letters are **rendered on demand** from `HourEntry` rollups. Do not store generated letters as documents.

Events are a lightweight second assignment type. The weekly volunteer meetup and the volunteer marketing meeting need signup and attendance tracking, but not a full project record. Seed the initial `lead` accounts from the current meeting hosts.

---

## 2. Authentication and Roles

- **Discord OAuth as primary login**, Google as fallback. Discord OAuth returns the Discord user ID, which the role-sync job needs anyway.
- No password-based signup.
- Three roles: `volunteer`, `lead`, `admin`.
- Leads approve hours only for projects they lead. Admins have global scope.

---

## 3. Onboarding

- Signup form: name, email, Discord handle, timezone, skills, availability.
- **Code of conduct** acceptance, stored with timestamp. Required for enforcement.
- **Contribution / IP agreement.** Volunteers touch code and content, so this is mandatory, not optional.
- **Age attestation checkbox (18+).** Adults only, stated in the terms. Under-18 volunteers require parental consent flows and a separate data policy, roughly doubling the compliance surface. Not in v1.

---

## 4. Projects and Assignments

- Project directory, filterable by skill.
- Apply-to-project flow with lead approval.
- Lead view: applicants, current roster, remove and reassign.
- Event signup and attendance as the secondary assignment path.

---

## 5. Hours and Verification

- Self-logged entry against an assignment: date, hours, short description.
- Lead approval queue with bulk approve.
- Cumulative totals per volunteer and per project.
- **Verification letter:** **PDF** generated from approved hours only. Foundation letterhead, date range, total hours, project names, admin signature. Volunteer triggers generation themselves.

---

## 6. Discord Integration

- **Role sync bot.** Approved volunteer gets a base role; project members get a project role. Run as a **scheduled reconcile job**, not real-time webhooks. Simpler, and it self-heals after downtime.
- **Notifications** to DM or channel: assignment approved, hours approved, meeting reminders.
- **Account linking** via OAuth at signup, plus a `/link` command for people who joined Discord first.

---

## 7. Email

Transactional only:
- signup confirmation
- assignment approved
- hours approved
- meeting reminder
- verification letter ready

Templates reuse the existing Agentics brand system: cream background (`#faf8f3`), orange CTAs (`#ff5a1f`), navy cards (`#1a2a3a`) with cyan accent labels (`#5cb8e8`). No palette substitutions. No em dashes or en dashes in copy.

---

## 8. Admin and Reporting

- Roster with filters and **CSV** export.
- Hours report by project and date range.
- Manual hour adjustment with a visible audit trail.

---

## 9. Compliance Floor

- Privacy policy, stated retention period, deletion request path. **PIPEDA** applies (Ontario); **GDPR** applies to any EU volunteer.
- ****WCAG** 2.1 AA** accessibility.
- Audit log on all admin actions and hour adjustments.
- Encryption at rest, automated backups.
- Terms of service and code of conduct with a reporting and enforcement mechanism.

---

## 10. Technical Stack

### Application dependencies

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js on Vercel | App Router, server actions |
| Database | Postgres (Supabase or Neon) | Four-table core schema |
| Auth | Auth.js with Discord provider | Google as fallback provider |
| Discord bot | `discord.js` | Nothing in the ruvnet catalog covers Discord |
| Transactional email | Resend or Postmark | Brand templates from the Agentics system |
| PDF generation | Server-side renderer for verification letters | Rendered from data, never stored |

### ruvnet runtime dependency

**`ruvector` (npm) — RuVector / AgentDB.** The single ruvnet package that earns a place in the running application, and only for the dynamic matching layer:

- A volunteer writes free-text skills (*I know React and I've done some Figma work*) and the portal surfaces the projects that fit, rather than making them scroll a directory.
- Same mechanism suggests which open project a returning volunteer should log hours against.

Everything else in the portal is deterministic **SQL** and must not be routed through a vector store.

### ruvnet build harness

**`ruflo`** — `npx ruflo@latest init wizard`. **MIT** licensed, actively maintained, and Cognitum One's own stack, so there is an organizational argument alongside the technical one. This is a development-time harness, not a runtime dependency.

Plugins that map to this build:

| Plugin | Use here |
|---|---|
| `ruflo-sparc` | Five-phase spec-to-code with quality gates. Feed it this document. |
| `ruflo-ddd` | Scaffolds bounded contexts and aggregates onto the four-object model |
| `ruflo-migrations` | Schema change management |
| `ruflo-testgen` | Test coverage generation |
| `ruflo-browser` | Playwright E2E on signup and hours-logging flows |
| `ruflo-aidefence` | PII detection, relevant under PIPEDA |
| `ruflo-adr` | Architecture decision records for rotating contributors |

### Optional, low confidence

- **`agentic-flow`** — model routing to cut cost if the portal makes **LLM** calls in production.
- **`flow-nexus`** — reference architecture for accounts and recognition layers. A platform, not a library.
- **`agentics-meetup`, `yyz-agentics-june`** — check for existing Agentics member or event data worth migrating rather than starting empty.

### Explicitly excluded from the ruvnet catalog

QuDAG, Synaptic-Mesh, RuVix, `rvm`, ruv-**FANN**, sublinear-time-solver, **EXO**-AI, RuQu. Agent and neural infrastructure with no bearing on a **CRUD** portal. Building on them would be serious over-engineering.

**Caution:** the ruvnet catalog has a long tail of repositories that no longer resolve (`agentic-tribe` and `easygig-ai` both **404** as of this writing). Do not plan around anything outside the actively-pushed flagship set.

---

## 11. Build Sequence

1. **Foundation** — Next.js scaffold, Postgres schema for the four objects, Discord OAuth, role model.
2. **Onboarding** — signup form, agreement capture, age attestation, admin approval.
3. **Projects** — directory, apply flow, lead roster management.
4. **Hours** — entry, approval queue, totals.
5. **Discord bot** — role reconcile job, then notifications, then `/link`.
6. **Verification letters** — **PDF** rendering from approved hours.
7. **Email** — brand-system templates wired to the five transactional triggers.
8. **Admin** — roster export, hours report, audit trail.
9. **Semantic matching** — RuVector layer over skills and project descriptions.
10. **Compliance hardening** — accessibility audit, privacy policy, retention and deletion paths.

Steps 1 through 4 constitute a usable portal. Step 9 is the differentiator and should not be attempted before the deterministic core is stable.