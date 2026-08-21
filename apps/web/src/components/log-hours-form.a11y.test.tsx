import { render } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { LogHoursForm } from "./log-hours-form";

/**
 * Prompt 4.2's WCAG 2.1 AA exit criterion, automated half -- see
 * ACCESSIBILITY_AUDIT.md for the manual half this doesn't
 * cover.
 */
describe("LogHoursForm accessibility", () => {
  it("has no axe-detectable violations", async () => {
    const { container } = render(<LogHoursForm assignmentId="assignment-1" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("associates every input with a visible, programmatic label", () => {
    const { getByLabelText } = render(<LogHoursForm assignmentId="assignment-1" />);
    expect(getByLabelText(/^date$/i)).toBeInTheDocument();
    expect(getByLabelText(/^hours$/i)).toBeInTheDocument();
    expect(getByLabelText(/what did you do/i)).toBeInTheDocument();
  });

  it("disables submission until all fields are filled", () => {
    const { getByRole } = render(<LogHoursForm assignmentId="assignment-1" />);
    const submit = getByRole("button", { name: /log hours/i });
    expect(submit).toBeDisabled();
  });
});
