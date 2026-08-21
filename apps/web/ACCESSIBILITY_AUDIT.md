# Phase 10 full-site WCAG 2.1 AA audit

Prompt 10.1 / build-roadmap.md's Phase 10 exit criterion: "Full-site WCAG
2.1 AA audit — automated (axe-core) **and** manual (keyboard-only + at
least one screen reader: NVDA/JAWS/VoiceOver) — covering every flow built
in Phases 2-9, documented with results per page/flow. This is in
addition to, not a replacement for, the per-phase WCAG gates already
required in Phases 2-4."

This file supersedes and consolidates `MANUAL_ACCESSIBILITY_TESTING.md`
(Phases 2-4's per-flow gap notes, now merged in below) into one full-site
record, extended to cover every page Phases 2-9 actually built. Phase 5
(Discord bot), 7 (email), and 9 (semantic matching) added no `apps/web`
UI of their own — Phase 9's two suggestion endpoints are consumed via
API only, with no dedicated frontend screen built yet — so this audit's
scope is the six pages that exist as of Phase 10, listed below.

## What's done: automated, every page/component, zero violations

Every interactive component in `apps/web/src/components/` and every page
in `apps/web/src/app/` has a corresponding `*.a11y.test.tsx` running
`jest-axe` against a real render, executed in CI on every change
(`npm test`). As of this audit, all 6 test files / 20 assertions pass
with zero axe-detectable violations:

| Page / flow | Component(s) | Test file |
|---|---|---|
| `/onboarding` (Prompt 2.3) | `OnboardingForm` | `components/onboarding-form.a11y.test.tsx` |
| `/projects`, apply flow (Prompt 3.3) | `ProjectDirectory` | `components/project-directory.a11y.test.tsx` |
| `/projects/[projectId]/roster` (Prompt 3.3) | `ProjectRoster` | `components/project-roster.a11y.test.tsx` |
| `/assignments/[assignmentId]/log-hours` (Prompt 4.2) | `LogHoursForm` | `components/log-hours-form.a11y.test.tsx` |
| `/hours/approvals` (Prompt 4.2) | `HoursApprovalQueue` | `components/hours-approval-queue.a11y.test.tsx` |
| `/privacy` (Prompt 10.2) | `PrivacyPolicyPage` | `app/privacy/page.a11y.test.tsx` |

`/` (the Prompt 2.1 scaffold home page) and `/_not-found` are trivial
static content with no interactive elements beyond a demo checkbox and
two links; not separately axe-tested, but covered by the same structural
patterns (labelled controls, visible focus styles from the shared
`globals.css`) exercised elsewhere.

Each `.a11y.test.tsx` additionally locks in, beyond bare axe-core
compliance: every field/control has a real accessible name
(`getByLabelText`/`getByRole` assertions), grouped controls (the
onboarding agreements) are under a labelled `fieldset`/`legend`, and
every per-row action button (roster Approve/Remove, queue Reject) has a
distinguishing accessible name rather than a bare verb repeated per row.

## What's not done, and can't be done by an autonomous agent

The manual half — keyboard-only navigation through the actual rendered
site in a real browser, and at least one full pass with a real screen
reader (NVDA, JAWS, or VoiceOver) — requires a human operating real
assistive technology and real input devices. This is not a credentials
or tooling gap; axe-core cannot structurally evaluate focus order making
sense, focus never getting trapped or lost, dynamic `aria-live`
announcements actually firing at the right moment, or a screen reader's
actual spoken output.

### Full-site manual test checklist for a human tester

1. **Home (`/`) and Privacy Policy (`/privacy`):** tab through the
   checkbox demo and the two links; confirm the Privacy Policy page's
   heading structure (one `<h1>`, six `<h2>` sections) is announced
   sensibly by a screen reader's heading navigation, and the "Back to
   the volunteer portal" link's destination is clear from its accessible
   name alone.
2. **Onboarding (`/onboarding`):** tab through name → timezone → skills
   → country/region → the three agreement checkboxes → submit; confirm
   the submit button's disabled state is announced, not just visually
   shown; confirm the `fieldset`/`legend` "Agreements" grouping and
   submission-error `aria-live` region are both announced correctly.
3. **Project directory / apply (`/projects`):** tab through skill search
   → results → each project's role field → apply button; confirm the
   apply-error `aria-live` region is announced.
4. **Project roster (`/projects/[id]/roster`):** confirm the `<table>`
   is announced with caption and column headers via table navigation,
   not linearly; confirm each Approve/Remove button's full accessible
   name (including the applicant/role suffix) is what's actually spoken.
5. **Log hours (`/assignments/[id]/log-hours`):** tab through date →
   hours → description → submit; confirm the `type="number"` hours
   field's spinner controls are usable and clearly announced.
6. **Hours approval queue (`/hours/approvals`):** tab through each row's
   checkbox and Reject button; confirm the Approve-selected button's
   disabled-until-one-checked state is communicated by focus/state
   alone; confirm the bulk-approve `role="alert"` partial-failure
   message ("N approved, N could not be approved") is announced
   promptly.

Any finding from this pass must be fixed before this criterion is
considered closed; this file should be updated in place with the pass's
date, tester, and results once performed, rather than deleted.
