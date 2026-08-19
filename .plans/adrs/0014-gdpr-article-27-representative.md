# ADR 0014: GDPR Article 27 — EU Representative Decision

## Status

Accepted — 2026-08-19

## Context

`concept.md` section 9 states "GDPR applies to any EU volunteer."
`research-findings.md` confirms this is a reasonable practical
simplification (GDPR Art. 3(2) triggers on targeting/monitoring EU
residents, and an EU volunteer actively signing up and being accepted is
generally read as sufficient targeting), but flags an unresolved binary:
organizations not established in the EU but offering services to EU
residents must designate an **EU representative** under Art. 27, unless
the narrow "occasional, small-scale, low-risk" processing exemption
applies — an exemption research-findings.md notes is interpreted strictly
and rarely applies to an ongoing web service. This choice was explicitly
left open and must be resolved before launch, per both
research-findings.md and build-roadmap.md's Phase 0 gate.

## Decision

**Do not designate a standing EU representative at v1 launch. Document
and rely on the "occasional, small-scale, low-risk" processing exemption,
with an explicit, monitored trigger for revisiting this decision.**

Rationale: the Agentics Foundation's volunteer base and processing
purpose (recruiting and coordinating volunteers for a specific
foundation's projects, tracking their hours, issuing verification
letters) is not EU-targeted marketing or an EU-facing product — any EU
volunteer involvement is expected to be incidental (e.g. a remote
volunteer who happens to reside in the EU), not the result of the
Foundation actively offering services into the EU market. This is the
profile the "occasional, small-scale, low-risk" exemption is meant to
cover, though research-findings.md is right that this exemption is
interpreted strictly and is not free of risk.

**The trigger for revisiting this decision** (i.e., for designating an
EU representative) is any one of:
- EU-resident volunteers exceed **10 individuals** at any point (a
  concrete, monitorable threshold chosen to stay well inside "small-
  scale" under any reasonable reading, revisited if guidance suggests
  otherwise), **or**
- the Foundation begins any deliberate EU-directed activity (e.g. an
  EU-specific recruitment push, EU-based project work, or EU-targeted
  marketing of the volunteer program), **or**
- the Foundation processes any EU volunteer's special-category data
  (GDPR Art. 9) beyond what onboarding already collects.

This is tracked as an operational check, not a one-time decision: the
admin roster (Phase 8) must be able to report volunteer country/region so
this threshold is actually monitorable, not just theoretically defined.
The privacy officer designated in
[[0015-pipeda-breach-notification-and-privacy-officer]] owns checking
this trigger periodically (e.g. quarterly, or triggered by roster growth
alerts) and owns escalating to designate a representative if it fires.

This rationale — the exemption basis and the trigger conditions — is
published in the Foundation's privacy policy (Phase 10 deliverable), not
kept as an internal-only decision, since GDPR's exemption is meant to be
demonstrable, not merely asserted internally.

## Consequences

**Positive:**
- Avoids the cost and operational overhead of designating and paying an
  EU representative (a real, ongoing cost, typically an annual retainer
  with a representative firm) for a nonprofit whose EU processing is
  genuinely incidental at expected v1 scale.
- The concrete, monitorable trigger (10 EU volunteers, or deliberate
  EU-directed activity) means this is a live decision with a defined
  re-evaluation point, not a "decide never" default that quietly becomes
  wrong as the volunteer base grows.
- Publishing the rationale in the privacy policy makes the exemption
  claim demonstrable to a regulator or an EU volunteer who asks, rather
  than an undocumented internal assumption.

**Negative / accepted risk:**
- The "occasional, small-scale, low-risk" exemption is, per
  research-findings.md, interpreted strictly by EU data protection
  authorities, and there is inherent residual legal risk in relying on it
  rather than designating a representative preemptively. This ADR
  accepts that risk as proportionate to the Foundation's actual expected
  processing profile, but it is not a risk-free choice, and this document
  does not overstate the certainty of the exemption applying.
- The 10-volunteer threshold is a reasonable, defensible number chosen by
  this ADR, not a number stated anywhere in GDPR itself — a stricter
  regulatory interpretation could in principle apply the exemption more
  narrowly than this ADR assumes. If the Foundation later obtains formal
  legal counsel on this point, that guidance supersedes this ADR's
  threshold.
- Monitoring depends on volunteers accurately self-reporting location at
  onboarding (concept.md's signup form does not currently include a
  country field) — this ADR implicitly requires adding one, which is a
  small Phase 2 scope addition, noted here so it is not missed.

## Alternatives Considered

- **Designate an EU representative preemptively.** Rejected for v1 as
  disproportionate to expected scale and processing purpose — an ongoing
  cost for a risk this ADR judges low at current and near-term expected
  volunteer counts. Explicitly not rejected forever — the trigger
  conditions above exist precisely to revisit this if the Foundation's
  reality changes.
- **Simply not address the question (status quo).** Rejected — this is
  the exact ambiguity research-findings.md and build-roadmap.md both
  flag as unresolved and blocking; leaving it open fails the Phase 0
  exit criterion that every listed decision has an accepted ADR.
- **Block EU signups entirely to sidestep GDPR's territorial scope.**
  Rejected — contrary to concept.md's evident intent to accept any
  qualified volunteer, and not clearly effective at avoiding GDPR
  applicability in any case (Art. 3(2)'s targeting test is not solely
  about geographic signup restrictions).

## Phase Gate

Unblocks Phase 10 (Compliance hardening) — "GDPR Art. 27 decision from
Phase 0 is executed: EU representative designated, or the occasional-
processing exemption rationale is published," per build-roadmap.md's
explicit Phase 10 exit criterion. Also requires a small Phase 2 addition
(country/region field on the signup form) to make the monitoring trigger
enforceable.
