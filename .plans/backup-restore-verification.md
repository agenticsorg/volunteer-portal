# Backup and Encryption-at-Rest: Restore Verification

build-roadmap.md's Phase 10 exit criterion: "Encryption-at-rest and
automated backups are not just configured but **restore-tested** (a
backup has been restored at least once and verified)."

## Status: not yet performed -- blocked on production Neon access

This criterion requires restoring an actual backup of the Foundation's
**production** Neon project and verifying the restored data, per
[ADR-0003](adrs/0003-database-provider.md)'s choice of Neon as the
managed Postgres provider. No production Neon project has been
provisioned as part of this Rust rewrite as of Phase 10 -- every phase
so far has run migrations and tests against ephemeral local/CI Postgres
containers (`testcontainers`, or the CI workflow's `postgres:17-alpine`
service), never a real Neon deployment. Performing this test requires:

- An actual Neon project for this application, with production or
  production-equivalent data in it.
- Console or API access to that Neon project (a Neon account with the
  appropriate role), which this session does not have and cannot
  provision for itself -- this is Foundation infrastructure, not
  something a coding agent should create or gain access to
  unilaterally.

This is the same category of gap as
[the breach-response runbook](breach-response-runbook.md)'s unnamed
Privacy Officer: an organizational/infrastructure action outside this
codebase's ability to complete, flagged explicitly rather than assumed
satisfied. **Phase 10 is not complete until this test has actually been
run and its result recorded below.**

## Procedure, for whoever has Neon project access

Neon provides two relevant mechanisms:

1. **Encryption at rest** is enabled by default for all Neon projects
   (storage-level encryption, managed by Neon/AWS) -- confirm this in
   the Neon console under the project's Settings, and record the
   confirmation date below. This half of the criterion requires no
   restore test, only confirmation it is actually on for this specific
   project (not merely "Neon supports it").
2. **Point-in-time recovery / branch restore**: Neon retains a
   history window (length depends on plan) that lets you create a new
   branch as of any point in that window, or restore a branch to an
   earlier point.
   - In the Neon console, open the production project's branch, choose
     "Restore," and either create a new branch at a recent point in
     time, or use "Instant restore" to roll the branch back.
   - Verify against the restored branch: connect to it (a distinct
     connection string from production) and confirm a known table's
     row count and a specific, previously-recorded row's content match
     what was expected at that point in time -- e.g. compare
     `select count(*) from volunteer` and one specific volunteer's
     `name`/`created_at` against a value recorded before the test.
   - Discard the restore branch afterward (Neon branches are
     copy-on-write and cheap, but a stale restore branch should not be
     left lying around holding a point-in-time copy of personal data
     indefinitely).
3. Record the result below, including the date, who performed it, the
   branch/point restored to, and what was verified.

## Result log

| Date | Performed by | What was restored | Verification performed | Outcome |
|---|---|---|---|---|
| *pending* | *pending* | *pending* | *pending* | *pending* |
