# ADR 0015: PIPEDA Breach Notification Process and Privacy Officer Designation

## Status

Accepted — 2026-08-19

## Context

`concept.md` section 9 states "PIPEDA applies (Ontario)" and requires a
privacy policy, stated retention period, and deletion request path, but
`research-findings.md` identifies this compliance floor as incomplete: it
omits a designated privacy officer, a documented breach-response plan,
and — most critically — PIPEDA's (2024-amended) **mandatory breach
notification** requirement to the Office of the Privacy Commissioner
(OPC) and affected individuals when a breach meets the "real risk of
significant harm" (RROSH) threshold. This is a binding legal requirement,
not optional, and research-findings.md notes the specification has no
mechanism for it. This is primarily a process/ops decision, not a schema
or code decision, but it has one direct schema consequence (below) and
must be resolved with an accepted ADR per build-roadmap.md's Phase 0
gate.

## Decision

**Designate a named Privacy Officer role within the Foundation**,
accountable for:
- Receiving and triaging any suspected data incident.
- Making the RROSH ("real risk of significant harm") determination for
  any confirmed breach, using PIPEDA's documented assessment factors
  (sensitivity of the information involved, probability the information
  has been/will be misused, and any other relevant factor).
- Filing the OPC breach report when RROSH is met, and notifying affected
  individuals directly, within the legally required timeframe.
- Maintaining a breach record for every incident, including those judged
  not to meet RROSH (PIPEDA requires organizations to keep records of
  **all** breaches of security safeguards, not only reportable ones, for
  a minimum retention period — this record-keeping obligation is
  separate from and in addition to the notification obligation).
- Owning the GDPR Art. 27 trigger-monitoring responsibility assigned in
  [[0014-gdpr-article-27-representative]].

This is an organizational/role designation the Foundation must make (a
specific person or position, e.g. an existing admin/board member), not
something resolved purely by writing code — recorded here as a process
ADR per build-roadmap.md's framing of this item as "a process/ops ADR,
not just schema."

**Documented breach-response runbook** (authored as part of Phase 10,
owned by the Privacy Officer, referenced by this ADR): a short, concrete
procedure covering (a) how a suspected breach is reported internally
(e.g. a dedicated internal contact/email), (b) the RROSH assessment step,
(c) the OPC notification and affected-individual notification steps and
their required content, (d) the breach record entry, (e) post-incident
review. This ADR establishes that the runbook must exist and who owns it;
the runbook's full text is a Phase 10 deliverable, not duplicated here.

**Schema consequence:** the `audit_log` table
([[0005-audit-log-and-co-leads]]) is the natural, already-designed home
for admin-action records that a breach investigation would need to
reconstruct (who accessed/changed what, when) — no separate incident-
tracking table is added at v1. If breach-record-keeping volume or
structure needs eventually outgrow what `audit_log` naturally supports, a
dedicated `breach_record` table can be added later without schema
conflict; not pre-built now on the "don't build for hypothetical
requirements" principle, since PIPEDA's breach-record retention
requirement can reasonably be satisfied by written incident reports
maintained by the Privacy Officer outside the application database for
v1's expected incident volume (ideally zero, but must be planned for).

## Consequences

**Positive:**
- Closes the concrete legal-compliance gap research-findings.md
  identified: a binding notification requirement with previously no
  named owner and no process now has both.
- Naming a specific accountable role (not "the team" generically) is what
  makes a breach-response runbook actually executable under time
  pressure — ambiguity about who decides is the most common failure mode
  in real incident response.
- Reuses the existing `audit_log` table rather than adding new schema
  surface for a v1-expected-rare event, keeping the core schema lean per
  the project's stated preference (concept.md's "four objects," now five
  with `audit_log`, per [[0005-audit-log-and-co-leads]]) without ignoring
  the real compliance requirement.

**Negative / accepted risk:**
- This ADR designates the *role* and the *process obligation*; it does
  not itself name the specific person, which is an organizational
  decision the Foundation must make outside this codebase (flagged here
  so it is not lost — Phase 10 cannot be marked done without a named
  individual, not just a documented role).
- Relying on `audit_log` plus Privacy-Officer-maintained written incident
  reports (rather than a dedicated in-app incident-tracking table) means
  breach records are partly outside the application's own database —
  acceptable for expected v1 incident volume, but should be revisited if
  the Foundation's risk profile or incident frequency changes materially.
- PIPEDA's specific notification-timing and content requirements are
  subject to regulatory guidance that can be updated; the runbook (Phase
  10 deliverable, not this ADR) is the artifact responsible for staying
  current, and this ADR does not freeze the exact procedural details,
  only the ownership and the obligation to have them.

## Alternatives Considered

- **No named privacy officer; breach response handled ad hoc by
  whichever admin is available.** Rejected — directly contradicts
  research-findings.md's identified gap and is a known failure mode for
  real incident response (diffused accountability leads to delayed or
  missed statutory notification deadlines).
- **Build a dedicated `breach_record` / incident-tracking table now.**
  Considered; deferred rather than rejected outright — reasonable given
  expected v1 incident volume, but explicitly not ruled out for later if
  volume or structural needs grow. Not built now to avoid speculative
  schema for a hopefully-rare event.
- **Treat PIPEDA as inapplicable** given research-findings.md's note that
  a nonprofit with no commercial revenue may technically fall outside
  PIPEDA's "commercial activity" scope. Rejected — research-findings.md
  itself recommends treating PIPEDA as applicable regardless, as best
  practice, and this ADR follows that recommendation rather than betting
  on a narrow statutory-scope argument.

## Phase Gate

Unblocks Phase 10 (Compliance hardening) — "breach notification runbook
documented, with a named privacy officer accountable for PIPEDA's 'real
risk of significant harm' reporting obligation," per build-roadmap.md's
explicit Phase 10 exit criterion. The Privacy Officer role should be
named by the Foundation before Phase 10 begins, ideally earlier, since
[[0014-gdpr-article-27-representative]]'s trigger-monitoring
responsibility also depends on this role existing.
