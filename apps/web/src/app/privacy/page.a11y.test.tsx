import { render } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import PrivacyPolicyPage from "./page";

/**
 * Prompt 10.1's full-site WCAG 2.1 AA audit, automated half, applied to
 * the new privacy policy page (Prompt 10.2). Same caveat as every other
 * `.a11y.test.tsx` in this codebase: this covers axe-core's ~30% of
 * success criteria (heading structure, link accessible names, contrast)
 * and is not a substitute for a human keyboard-only/screen-reader pass
 * -- see MANUAL_ACCESSIBILITY_TESTING.md.
 */
describe("PrivacyPolicyPage accessibility", () => {
  it("has no axe-detectable violations", async () => {
    const { container } = render(<PrivacyPolicyPage />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("uses a single top-level heading followed by section headings", () => {
    const { getByRole } = render(<PrivacyPolicyPage />);
    expect(getByRole("heading", { level: 1, name: /privacy policy/i })).toBeInTheDocument();
    expect(getByRole("heading", { level: 2, name: /retention period/i })).toBeInTheDocument();
  });

  it("has an accessible link back to the portal", () => {
    const { getByRole } = render(<PrivacyPolicyPage />);
    expect(getByRole("link", { name: /back to the volunteer portal/i })).toBeInTheDocument();
  });
});
