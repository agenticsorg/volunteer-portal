# volunteer-portal

Agentics Foundation Volunteer Portal — a gamified, social volunteer-management
platform with a training-video library. See [`docs/adr/`](docs/adr/README.md)
for architecture decisions and [`docs/ddd/`](docs/ddd/README.md) for the
bounded-context domain design.

## Local development

Prerequisites: Node 20+, pnpm 10, Docker.

```bash
pnpm install
pnpm db:up          # app's own Postgres (docker-compose), port 5432
pnpm db:migrate:deploy
pnpm dev
```

## Local Supabase Auth stack

Authentication is Supabase Auth (ADR-0006). No real Supabase cloud project
exists for this app yet — federating with hire.agentics.org's SSO is
explicitly deferred. Locally, the app runs against the **Supabase CLI's own
local development stack**: a separate, Docker-based Postgres + GoTrue (Auth)
+ Kong (API gateway) instance, entirely independent of the app's own
docker-compose Postgres above (different containers, different ports —
Supabase's local Postgres listens on `54322`, the app's on `5432`).

### Setup (one-time)

Already done in this repo (`supabase/config.toml` is checked in) — reproduce
only if setting up from scratch elsewhere:

```bash
pnpm add -D supabase          # already a root devDependency
pnpm exec supabase init       # creates supabase/config.toml
```

`supabase/config.toml` has been trimmed from the CLI's defaults to disable
services this app doesn't use yet (Realtime, Storage, Edge Functions,
Analytics) — keeping the stack to Postgres + Auth + Kong + Mailpit (a local
inbox for magic-link/confirmation emails, at `pnpm supabase:status`'s
`MAILPIT_URL`) + Studio.

### Running it

```bash
pnpm supabase:start    # pulls images on first run, then starts the stack
pnpm supabase:status   # prints API_URL, ANON_KEY, DB_URL, STUDIO_URL, ...
pnpm supabase:stop     # stops the stack (data persists in a Docker volume)
```

`pnpm supabase:start` prints the same connection info `supabase:status`
does. Copy `API_URL` → `NEXT_PUBLIC_SUPABASE_URL` and `ANON_KEY` →
`NEXT_PUBLIC_SUPABASE_ANON_KEY` into `.env` if they ever differ from the
checked-in defaults in `.env.example` (they won't, unless
`supabase/config.toml`'s `[api].port` changes — the anon key is a fixed
public demo value every local Supabase CLI stack issues, not a secret).

Supabase Studio (a local admin UI for the Auth stack — users, providers,
logs) is at `STUDIO_URL` (`http://127.0.0.1:54323` by default).

### Proving it actually works: real JWTs, really verified

```bash
pnpm supabase:start        # if not already running
pnpm verify:local-jwt
```

This signs up a throwaway user against the real local GoTrue, fetches the
stack's real JWKS document (`/auth/v1/.well-known/jwks.json`), verifies the
issued access token's signature against it locally (via `jose`, independent
of the `@supabase/ssr` code path the app itself uses at runtime), and
confirms a tampered signature is rejected. Sample output:

```
1. Signing up a throwaway user against the real local GoTrue (http://127.0.0.1:54321)...
   Issued a real access_token for auth.users.id = afc5ef2a-ffc8-4690-8bae-478c2d4eed08
2. Fetching the stack's real JWKS document...
   {"keys":[{"alg":"ES256","crv":"P-256", ... "kid":"b81269f1-...","kty":"EC", ...}]}
3. Verifying the access_token's signature locally against that JWKS (via jose)...
   header:      {"alg":"ES256","kid":"b81269f1-...","typ":"JWT"}
   claims.sub:  afc5ef2a-ffc8-4690-8bae-478c2d4eed08
   claims.email:verify-jwt-1786395693885@example.com
   OK — signature, issuer, audience, and expiry all verified.
4. Negative control: a tampered signature must be rejected...
   OK — rejected as expected (ERR_JWS_SIGNATURE_VERIFICATION_FAILED).

All checks passed: the local Supabase Auth stack issues real, verifiable JWTs.
```

The app's own JWT verification (`apps/web/src/proxy.ts`, the tRPC context
in `apps/web/src/server/api/trpc.ts`) does the equivalent check via
`@supabase/ssr`'s `getClaims()`, which — confirmed by reading
`@supabase/auth-js`'s source — fetches the same real JWKS endpoint and
verifies the signature locally via the WebCrypto API for exactly this kind
of asymmetric (ES256) signing key; see the doc comment on
`apps/web/src/server/auth/verified-session.ts`'s `getVerifiedSession()` for
the full explanation.

### Swapping to a real (hosted) Supabase project later

Only `.env`'s `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
change — every value the real project's dashboard gives you under Project
Settings → API. No file under `apps/web/src/` reads a Supabase URL/key any
other way: every one of them calls `getSupabaseAuthEnv()`
(`apps/web/src/server/auth/env.ts`), which reads exactly those two
environment variables and nothing else. See `.env.example` for the same
note next to the variables themselves.

## Tests

```bash
pnpm test:unit          # Vitest, no database
pnpm test:integration   # Vitest, real Postgres via testcontainers (Docker required)
pnpm e2e:smoke          # Playwright
```

`test:integration` does **not** depend on the local Supabase Auth stack
above — it uses its own disposable `postgres:16` testcontainer
(`apps/web/tests/integration/setup.ts`) and fakes the *verified session*
shape (`{ supabaseAuthId, email }`) directly, since that's the only
Supabase-derived input `registerPerson` ever sees. CI never runs
`supabase start`. The local-stack proof above (`pnpm verify:local-jwt`) is
a separate, manually-run reproducibility script for exactly that reason.
