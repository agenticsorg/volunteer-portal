import { render } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { ProjectDirectory } from "./project-directory";

/**
 * Prompt 3.3's WCAG 2.1 AA exit criterion, automated half -- see
 * ACCESSIBILITY_AUDIT.md for the manual half this doesn't
 * cover. `ProjectDirectory` doesn't fetch on mount (search results only
 * appear after a skill is submitted), so this suite renders it with no
 * network mocking required.
 */
describe("ProjectDirectory accessibility", () => {
  it("has no axe-detectable violations in its initial (no results) state", async () => {
    const { container } = render(<ProjectDirectory />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("associates the skill search input with a visible, programmatic label", () => {
    const { getByLabelText } = render(<ProjectDirectory />);
    expect(getByLabelText(/search by skill/i)).toBeInTheDocument();
  });

  it("disables search until a skill is entered", () => {
    const { getByRole } = render(<ProjectDirectory />);
    const search = getByRole("button", { name: /search/i });
    expect(search).toBeDisabled();
  });
});
