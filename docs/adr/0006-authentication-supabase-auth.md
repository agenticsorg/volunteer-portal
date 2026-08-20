# ADR-0006: Authentication — Supabase Auth for Identity and Session Management

## Status
Accepted — 2026-08-10

## Context
The portal serves a genuinely diverse, international volunteer base (research 01: city chapters, hackathon participants, workshop instructors, open-source contributors) with a person-centric identity model where the same human may hold multiple roles (volunteer, mentor, chapter lead, content admin — see ADR-0007). Authentication needs to satisfy several concrete constraints already established by other decisions and by the domain research:

- **GDPR is the compliance floor** (research 05, §2): the org must have a documented lawful basis for processing account data, support DSAR export/erasure, and handle EU volunteers' credentials with the security rigor GDPR implies (breach notification exposure attaches directly to how credentials/passwords are stored). This argues against hand-rolled password storage and toward a provider with an established security posture and compliance documentation.
- **Low-ops, small-team reality** (research 04, §3 recommended stack): the org has no dedicated security/identity engineering staff. The recommended stack explicitly calls out Supabase Auth or Clerk as the baseline choice, with WorkOS/Entra as an escalation path only if partner-org enterprise SSO becomes a real requirement.
- **Social login and low-friction onboarding matter for volunteer conversion**: an AI/OSS community audience (research 01) already lives on GitHub, Google, and similar identity providers; requiring a fresh username/password for a volunteer signing up to watch one training video or RSVP to one meetup is unnecessary friction that comparable orgs (PSF, ASF, Wikimedia — research 01) don't impose.
- **Passwordless/magic-link fits a low-frequency-visit usage pattern**: many volunteers interact with the portal in bursts (event RSVP, one training module, one hackathon) rather than daily, so a persistent password is a support burden (reset requests) without a security benefit proportional to the sensitivity of the data behind it (volunteer profile, hours, badges — not financial data, since monetization/billing is explicitly out of scope).
- **The system already commits to Next.js 14+ App Router and a modular-monolith Node/TypeScript service** (canonical decisions) — auth must integrate cleanly with Next.js middleware for route protection and with tRPC procedures for per-call authorization context, and must not require standing up a separate identity microservice that would break the "one deployable service" architecture style.
- **Postgres is already the single source of truth** for every bounded context (identity, volunteering, training, gamification, community, moderation, notifications, admin) as one instance with per-context schemas — an auth provider that itself runs on Postgres (rather than a proprietary opaque store) keeps the operational surface area (one DB) and cost model coherent, and simplifies the "identity" bounded context's `persons` table relationship to the auth system's user table.

## Decision
Use **Supabase Auth** as the system of record for credentials, session issuance, and social/passwordless login. Supabase Auth issues **JWTs**; the Next.js app converts that into a **session held in a secure, httpOnly cookie**, validated on every request by **Next.js middleware** before any protected route or tRPC procedure executes.

Concretely:
- Supabase Auth's own `auth.users` table (in the Supabase-managed Postgres instance, or a self-hosted GoTrue instance pointed at the project's Postgres — see Implementation Notes for which) is the **credential store** — it owns password hashes, OAuth provider links, and MFA factors. It is explicitly **not** the identity bounded context's domain table.
- The application's `identity.persons` table (in the app's own Postgres schema, per the canonical per-schema architecture) holds the domain-relevant person record — profile, roles, chapter membership — and is linked to Supabase's `auth.users.id` by a stored foreign reference (`persons.auth_user_id`), **not** by reusing Supabase's UUID as the person's own primary key, to keep the ULID identifier strategy (ADR-0005) consistent across the identity schema and to avoid coupling the domain model's PK format to a third-party system's ID format.
- **Social login**: GitHub and Google OAuth are enabled at minimum (GitHub given the audience is AI/OSS engineers per research 01; Google as the broadest-reach fallback). Additional providers can be toggled in Supabase project config with no code change.
- **Passwordless magic-link** is enabled as a first-class sign-in path alongside password + social, specifically for low-frequency volunteers who don't want to manage a password.
- **Session handling**: on successful auth, the Supabase JWT (short-lived access token + refresh token) is exchanged server-side for a session cookie via `@supabase/ssr`'s Next.js helpers, set as `httpOnly`, `secure`, `sameSite=lax`. Next.js middleware (`middleware.ts`) runs on every request to protected routes, validates/refreshes the session, and attaches the resolved `person` (via `auth_user_id` lookup) to the request context consumed by tRPC procedures and the `can(subject, action, resource)` policy module (ADR-0007).
- **MFA** (TOTP) is supported via Supabase Auth's built-in factor enrollment and is required for the `org_admin` and `content_admin` roles at minimum (privileged roles with org-wide scope), optional for everyone else.

## Consequences

### Positive
- **No custom credential storage**: password hashing (bcrypt/argon2), reset-token generation, rate-limiting on auth endpoints, and breach-detection integrations are Supabase's operational responsibility, not the volunteer-portal team's — directly addressing the "no dedicated security staff" constraint.
- **Fast path to social + passwordless**: both are configuration, not custom code, meeting the low-friction-onboarding need identified from the comparable-org research without building an OAuth broker or a magic-link email/token system from scratch.
- **Coherent with the single-Postgres architecture**: Supabase Auth's schema lives in the same Postgres family the rest of the system already depends on (whether using Supabase-hosted Postgres directly per the canonical hosting decision, or a self-hosted GoTrue instance against the same Neon/Supabase instance) — no second database technology enters the stack purely for auth.
- **JWT + middleware pattern is a well-trodden Next.js App Router path**: `@supabase/ssr` has first-class support for exactly this pattern (server components, middleware, route handlers), minimizing integration risk against the canonical Next.js 14+ App Router decision.
- **GDPR posture**: Supabase publishes SOC 2 Type II and GDPR-relevant documentation and offers EU data residency (Supabase project region selection), which materially helps the "build to GDPR" stance (research 05, §2) without the org needing to author its own credential-security compliance narrative from scratch.

### Negative / Trade-offs
- **Vendor dependency for a security-critical path**: if Supabase has an outage or a breaking API change, authentication for the entire portal is affected. Mitigated by: (a) the session cookie pattern means an outage during Supabase's *token refresh* only affects users whose session is expiring at that moment, not everyone instantly; (b) JWTs are self-verifiable (signature check against Supabase's public JWKS) so authorization checks on already-issued, unexpired tokens do not require a live call to Supabase for every request.
- **Two "identity" concepts to keep straight**: Supabase's `auth.users` and the domain's `identity.persons` are deliberately separate tables, which is the correct pattern (per research 05's "person-centric identity, never duplicate accounts per role" finding, applied one level up — auth identity vs. domain identity), but it is an extra join/lookup on every authenticated request and a bootstrapping concern: a `persons` row must be created (via a Supabase Auth webhook or a first-request lazy-create) whenever a new `auth.users` row appears, or the two can drift.
- **JWT revocation latency**: JWTs are valid until expiry even if the underlying Supabase session is revoked server-side (e.g., admin force-logout, account suspension). Mitigated by short access-token lifetimes (default ~1 hour) and by checking a `persons.status` (active/suspended) flag inside the `can()` policy module on every privileged action, so a suspended account's still-valid JWT cannot execute privileged mutations even before the token expires.
- **Not free at scale**: Supabase Auth's free/pro tiers cap monthly active users; a large volunteer base could eventually cross into paid-tier auth costs. Acceptable now given the org's current scale (research 01: chapters of tens to low hundreds of active members) and revisited only if MAU growth is substantial.

## Alternatives Considered

- **Roll custom auth (bcrypt/argon2 + hand-built session management)**: rejected. This is a not-for-profit with no dedicated security engineering staff (research 04's low-ops framing); custom credential storage is exactly the kind of security-critical, easy-to-get-subtly-wrong surface (timing attacks on password comparison, weak reset-token entropy, missing rate-limiting) that a small team should not own when a well-audited managed alternative exists. It also means building social login and passwordless from zero, duplicating work a provider already solved.
- **Auth0 or Clerk**: both are legitimate, more feature-rich identity platforms (Auth0 especially strong on enterprise SSO/SAML, Clerk strong on polished pre-built UI components). Rejected for v1 specifically because: (1) they introduce a second vendor and a second data plane outside the Postgres-centric architecture the rest of the system commits to, with no offsetting benefit at current scale; (2) their pricing models bill per MAU at rates that get expensive faster than Supabase's for a growing free-tier nonprofit user base; (3) research 04 explicitly frames Supabase Auth/Clerk as the baseline pair and reserves heavier providers (WorkOS, Entra External ID) for a *future* enterprise-SSO trigger — Auth0/Clerk don't meet a need Supabase doesn't already meet today. Clerk in particular is reconsidered below as the concrete migration target if outgrown.
- **NextAuth.js / Auth.js with a custom Postgres adapter**: a credible middle ground (open-source, no vendor lock-in, integrates natively with Next.js). Rejected because it still requires the team to own credential storage decisions (which adapter, which hashing library, session-table schema design) and doesn't reduce operational surface area versus Supabase Auth, while giving up Supabase's managed MFA, breach-password checking, and hosted OAuth-app management. Worth revisiting only if the migration-path trigger below is hit and the org wants to avoid a second vendor entirely rather than moving to Clerk/Auth0.

## Implementation Notes

**Package choice**: `@supabase/ssr` (the current supported package for Next.js App Router SSR auth flows, superseding the older `@supabase/auth-helpers-nextjs`). Do not use the deprecated helpers package.

**Middleware sketch** (`middleware.ts`):
```typescript
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, {
              ...options,
              httpOnly: true,
              secure: true,
              sameSite: "lax",
            })
          );
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser(); // validates + refreshes
  if (!user && isProtectedRoute(request.nextUrl.pathname)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return response;
}
```

**Person bootstrap on first login**: a Supabase Auth webhook (`user.created` event, configured in the Supabase dashboard to POST to an internal `/api/webhooks/supabase-auth` route) creates the corresponding `identity.persons` row with a fresh ULID (ADR-0005) and `auth_user_id` set to the Supabase user's UUID. This keeps `persons.id` independent of Supabase's ID format, and lets the identity bounded context own the domain-relevant creation event (e.g., emitting a `Person.Registered` domain event into its own outbox for other modules to react to — ADR-0009).

**tRPC context**: the resolved `person` (looked up by `auth_user_id` from the validated Supabase session) is attached to tRPC context, so every procedure has `ctx.person` available for the `can(subject, action, resource)` check (ADR-0007) without re-querying Supabase per call.

**Environment/config**: Supabase project region pinned to an EU region if the org's primary volunteer base skews EU (validate with the org — research 05 flags GDPR as the design floor regardless), OAuth apps (GitHub, Google) registered under the `agentics.org` domain, redirect URLs locked to the production and preview Vercel domains only.

**Concrete migration path if outgrown**: the trigger condition is a confirmed enterprise-SSO requirement from a partner organization (SAML/OIDC federation) that Supabase Auth does not support natively, or MAU-driven cost crossing a threshold the org finds unacceptable. In that case, migrate to **Clerk** (closest feature parity, similarly fast Next.js integration) or add **WorkOS** in front of Supabase Auth specifically for the SSO connections (WorkOS can federate into an existing user base without a full auth-system rip-out). Because the domain model already treats `auth_user_id` as an opaque foreign reference rather than the person's primary key (ADR-0005's identifier strategy), swapping the auth provider means re-pointing that one column and re-running the OAuth/webhook wiring — it does not require renumbering or migrating the `identity.persons` table or anything downstream that references `persons.id`.
