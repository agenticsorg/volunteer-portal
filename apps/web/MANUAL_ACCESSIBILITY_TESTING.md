# Manual accessibility testing — signup flow (Prompt 2.3)

build-roadmap.md's Phase 2 exit criterion requires **both** automated and
manual WCAG 2.1 AA testing on the signup flow, explicitly noting that
automated tooling alone (axe-core, ~30% of success criteria) is not
sufficient to call the phase done.

**What's done:** automated axe-core testing (`npm test`,
`src/components/onboarding-form.a11y.test.tsx`) runs in CI on every
change and passes with zero violations against the onboarding form —
label association, ARIA roles/attributes, and other structural/DOM-level
checks. `getByLabelText`/`getByRole` assertions additionally lock in that
every field has a real accessible name and the three agreement checkboxes
are grouped under a labelled `fieldset`/`legend`.

**What's not done, and can't be done by an autonomous agent:** the manual
half — keyboard-only navigation through the actual rendered page in a
real browser, and at least one pass with a real screen reader (NVDA,
JAWS, or VoiceOver) — requires a human operating real assistive
technology and real input devices. This is not a credentials gap (no API
key or account would unblock it); it requires human sensory judgment
about things axe-core structurally cannot evaluate: focus order making
sense, focus never getting trapped or lost, checkbox/label associations
actually being announced correctly by a screen reader, error messages
being announced when they appear (the `aria-live="polite"` region on
submission errors should be verified this way, not just asserted to
exist in the DOM).

## What a human tester should verify

1. **Keyboard only** (unplug the mouse, or don't touch it): Tab through
   every field in a sensible order (name → timezone → skills → country/
   region → the three checkboxes → submit button). Each checkbox should
   toggle with Space. The submit button should be reachable and should
   correctly report as disabled (and not activatable) until all three
   checkboxes are checked. Focus should always be visible.
2. **Screen reader** (NVDA or JAWS on Windows, VoiceOver on macOS): each
   field's label should be announced when it receives focus. Each
   checkbox should announce its checked/unchecked state and its label.
   The `fieldset`/`legend` grouping should be announced as a group named
   "Agreements". If a submission is rejected (e.g. incomplete
   agreements), the error text should be announced without the user
   needing to manually navigate to find it.

This file should be deleted (or its results merged into a broader Phase
10 full-site audit record) once a human has actually performed this pass
and any findings are fixed.
