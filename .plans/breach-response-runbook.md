# Breach Response Runbook

Owned by the Foundation's designated Privacy Officer, per
[ADR-0015](adrs/0015-pipeda-breach-notification-and-privacy-officer.md).
This is the Phase 10 deliverable that ADR establishes must exist; the ADR
itself establishes *that* the role and this runbook exist, not their
full procedural text, which lives here.

> **Outstanding organizational action, not resolved by this document:**
> ADR-0015 requires a **named** Privacy Officer -- a specific person or
> board/admin position at the Agentics Foundation -- not a description of
> the role. This runbook cannot itself name that person; that is the
> Foundation's decision to make, and build-roadmap.md's Phase 10 exit
> criterion is explicit that Phase 10 is not complete until it is made.
> Fill in the table below once decided.

| Role | Name | Contact |
|---|---|---|
| Privacy Officer | *to be designated by the Foundation* | *to be published once designated* |
| Backup / delegate (in case the Privacy Officer is unreachable) | *to be designated* | *to be designated* |

Once named, this table (and the matching placeholder in
`apps/web/src/app/privacy/page.tsx`'s "Data breach notification"
section) should be updated together, since the privacy policy is where
GDPR/PIPEDA expect this to be publicly demonstrable, not only internally
documented.

## 1. How a suspected breach is reported internally

Any Foundation staff member, volunteer, or admin who suspects a data
incident (unauthorized access, accidental exposure, lost/stolen device
with portal access, a report from a volunteer that their data appears
compromised, a suspicious pattern in `audit_log`) reports it immediately
to the Privacy Officer via the dedicated contact above. Do not wait for
confirmation that a breach actually occurred -- the triage step below is
the Privacy Officer's job, not the reporter's.

What to include in the initial report: what was observed, when, who
noticed it, and whether it is still ongoing (e.g. an attacker session
still active) -- if still ongoing, also notify whoever holds
infrastructure access (Neon project owner, Fly.io account owner) so
containment (rotating credentials, revoking sessions) can start in
parallel with the assessment below, not after it.

## 2. RROSH assessment (PIPEDA's "real risk of significant harm")

The Privacy Officer determines, using PIPEDA's documented factors,
whether the incident meets the RROSH threshold:

- **Sensitivity of the information involved.** This system's personal
  information includes name, email, Discord identity, timezone,
  self-reported country/region, skills, and volunteer hour history --
  no payment data, government ID numbers, or health information is
  collected (per `identity-access.md`'s data model), which lowers
  baseline sensitivity relative to a financial or health-data breach,
  but an exposed email/name pairing combined with volunteer
  participation history is still personal information whose exposure
  can cause harm (e.g. unwanted contact, profiling).
- **Probability the information has been or will be misused.** Consider
  who had access, whether the exposure was public (e.g. a
  misconfigured, internet-reachable database) versus contained (e.g. a
  single compromised admin account, since revoked), and whether there
  is any evidence of actual misuse (unusual login activity, data
  appearing elsewhere).
- **Any other relevant factor** -- e.g. whether affected individuals
  are especially vulnerable, or whether the incident is part of a
  broader pattern.

Document the assessment and its reasoning in the breach record (step 4)
regardless of the RROSH conclusion -- PIPEDA requires a record of every
incident, not only reportable ones.

## 3. OPC and affected-individual notification (only if RROSH is met)

If the Privacy Officer determines RROSH is met:

1. **Notify the Office of the Privacy Commissioner of Canada (OPC)** as
   soon as feasible after the determination, via the OPC's breach
   report form (opc.gc.ca). Required content: a description of the
   breach's circumstances and cause (if known), the date/period it
   occurred, a description of the personal information involved, an
   estimate of the number of individuals affected, a description of
   steps taken to reduce the risk of harm, and a description of steps
   taken or planned to notify affected individuals.
2. **Notify affected individuals directly**, in language a volunteer
   can act on: what happened, what information was involved, what the
   Foundation has done and is doing about it, and what the individual
   can do to protect themselves (e.g. be alert for phishing referencing
   their volunteer status). Use the individual's contact information on
   file (`volunteer.email`) unless that channel is itself compromised,
   in which case use an alternate channel (e.g. Discord DM, if the
   Discord account is not implicated).
3. If the breach could plausibly affect an EU-resident volunteer,
   separately assess GDPR notification obligations (72-hour
   supervisory-authority notification) -- this is a distinct legal
   regime from PIPEDA's OPC process, not satisfied by the same filing;
   consult [ADR-0014](adrs/0014-gdpr-article-27-representative.md)'s
   EU-volunteer-count monitoring (surfaced on the admin roster) to
   confirm scope.

## 4. Breach record

Every incident -- reportable or not -- is logged by the Privacy Officer
as a written record including: date discovered, date(s) occurred (if
different), how it was discovered, systems/data involved, the RROSH
assessment and its conclusion, containment actions taken, notification
actions taken (if any) and to whom, and the post-incident review's
findings (step 5). Per ADR-0015, this record is maintained by the
Privacy Officer outside the application database (no dedicated
`breach_record` table exists at v1) -- `audit_log`
([ADR-0005](adrs/0005-audit-log-and-co-leads.md)) remains the
authoritative source for *what admin actions occurred*, which the
Privacy Officer should cross-reference when reconstructing an incident
involving account access or data changes, but the breach record itself
(the narrative, the RROSH reasoning, the notification record) is a
document the Privacy Officer keeps, not an application feature.

## 5. Post-incident review

After any confirmed incident (RROSH-reportable or not), the Privacy
Officer leads a short review: what allowed the incident to happen, what
contained it (or why containment was slow), and what concrete change
-- technical (e.g. an access-control gap) or procedural (e.g. this
runbook needed a step it didn't have) -- would reduce recurrence.
Findings that require code changes are filed as issues against this
repository; findings that require process changes are folded back into
this runbook.
