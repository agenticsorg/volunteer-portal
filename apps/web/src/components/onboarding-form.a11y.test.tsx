import { render } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { OnboardingForm } from "./onboarding-form";

/**
 * Prompt 2.3's WCAG 2.1 AA exit criterion, automated half: axe-core
 * against the signup form specifically. Per build-roadmap.md's explicit
 * note, this covers roughly 30% of WCAG success criteria (structural
 * issues -- label association, missing ARIA, contrast) and is not a
 * substitute for the manual half (keyboard-only navigation, a screen
 * reader pass) -- see MANUAL_ACCESSIBILITY_TESTING.md for that gap,
 * which requires an actual human and cannot be performed by this agent.
 */
describe("OnboardingForm accessibility", () => {
  it("has no axe-detectable violations", async () => {
    const { container } = render(<OnboardingForm />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("associates every input with a visible, programmatic label", () => {
    const { getByLabelText } = render(<OnboardingForm />);
    expect(getByLabelText(/^name$/i)).toBeInTheDocument();
    expect(getByLabelText(/timezone/i)).toBeInTheDocument();
    expect(getByLabelText(/skills/i)).toBeInTheDocument();
    expect(getByLabelText(/country \/ region/i)).toBeInTheDocument();
    expect(getByLabelText(/code of conduct/i)).toBeInTheDocument();
    expect(getByLabelText(/contribution \/ ip agreement/i)).toBeInTheDocument();
    expect(getByLabelText(/18 years of age/i)).toBeInTheDocument();
  });

  it("groups the three agreements under a labelled fieldset", () => {
    const { getByRole } = render(<OnboardingForm />);
    const group = getByRole("group", { name: /agreements/i });
    expect(group).toBeInTheDocument();
  });

  it("disables submission until all three agreements are accepted", () => {
    const { getByRole } = render(<OnboardingForm />);
    const submit = getByRole("button", { name: /complete signup/i });
    expect(submit).toBeDisabled();
  });
});
