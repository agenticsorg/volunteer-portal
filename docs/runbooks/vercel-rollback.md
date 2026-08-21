# Runbook: Roll back a bad Vercel deploy

**Symptom this addresses**: a deploy to `main` (production) or `staging` is causing
elevated errors, a failed `/healthz`/`/readyz` check, or a regressed SLO (ADR-0013),
and needs to be reverted faster than a forward-fix can land.

## Background (per ADR-0015 and ADR-0016)

- `main` always maps to the production Vercel environment; `staging` maps to a
  persistent staging Vercel environment (ADR-0015 §"Branch/environment topology").
  Every merge to either branch triggers an automatic Vercel deploy via Vercel's
  GitHub integration.
- Every deploy is tagged as a Sentry release using the deploy's git SHA
  (`apps/web/src/server/observability/sentry.ts`: `release: process.env.SENTRY_RELEASE
  ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown"` — `VERCEL_GIT_COMMIT_SHA` is a
  Vercel-provided build-time env var, populated automatically on a real Vercel deploy).
  This is what lets an error spike be correlated to the exact deploy that caused it.

**Honesty note**: this environment has no live Vercel project/deploy history to roll
back and no `SENTRY_DSN` configured, so none of the commands below have been executed
here — this documents the real, correct procedure against a real Vercel
project/Sentry account once those exist.

## Step 1: Confirm it's actually the most recent deploy at fault

Before rolling back, correlate: check `/readyz`
(`apps/web/src/app/readyz/route.ts`) for which specific check is failing (database?
a configured downstream?), and — once a real Sentry project exists — filter Sentry's
issue stream by the `release` tag matching the current deploy's git SHA. If the
error predates this deploy (same errors present on the prior release tag too), a
rollback won't fix it — treat it as an ordinary bug instead.

## Step 2: Roll back via the Vercel CLI (fastest path)

```bash
# List recent deployments for the project, newest first.
vercel ls volunteer-portal --prod

# Instantly re-promotes a specific prior deployment to production traffic —
# this does NOT redeploy/rebuild; it repoints production at an already-built,
# already-verified deployment, which is why it's fast (seconds, not a full build).
vercel rollback <deployment-url-or-id> --prod
```

For staging, drop `--prod` and target the staging deployment/alias instead, or use
`vercel promote <deployment-url> --scope=<team>` against the staging alias.

## Step 3: Roll back via the Vercel dashboard (if CLI access isn't available)

Project → Deployments → find the last known-good deployment (cross-reference its git
SHA against Sentry's release tags per Step 1) → "..." menu → **Promote to
Production**. Functionally identical to the CLI path.

## Step 4: Roll back the git history too (so the next merge doesn't reintroduce it)

A Vercel rollback only repoints traffic — it does not touch `main`'s git history, so
the next merge to `main` will redeploy the bad commit again unless it's reverted:

```bash
git revert <bad commit sha> --no-edit
git push origin main
```

This produces a *new* deploy (a real rebuild), which will also get its own Sentry
release tag — confirm the error clears on this new release, not just on the
CLI-rolled-back deployment, since the CLI rollback (Step 2) and this revert are two
separate mechanisms that both need to agree.

## Step 5: Database migrations — the one case a Vercel rollback alone cannot fix

If the bad deploy included a Prisma migration (`apps/web/prisma/migrations/`), rolling
back the *application code* via Steps 2–4 does not undo the *schema* change — Neon's
database is shared state, not something `vercel rollback` touches at all. If the
migration itself is the problem (not just the app code that assumed it):
- Prefer a new forward migration that safely reverses the change, rather than
  attempting `prisma migrate down` against a database other services may already be
  reading/writing against with the new schema.
- If data loss or corruption already occurred, this becomes a disaster-recovery
  scenario, not a simple rollback — see ADR-0016's DR/backup policy (Neon PITR,
  7-day retention in production) and the (separately authored) DR-drill workflow
  rather than improvising a manual fix.

## Step 6: Verify and communicate

- Confirm `/healthz` and `/readyz` are both healthy again on the rolled-back
  deployment.
- Once a real Sentry project exists, confirm the error rate on the new/rolled-back
  release has returned to baseline.
- Note the incident and the rollback action taken per
  `docs/runbooks/on-call-and-alerting.md`'s escalation/communication expectations.
