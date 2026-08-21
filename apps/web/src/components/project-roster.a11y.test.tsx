import { render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AssignmentDto } from "@/generated/Assignment";
import { ProjectRoster } from "./project-roster";

/**
 * Prompt 3.3's WCAG 2.1 AA exit criterion, automated half -- see
 * ACCESSIBILITY_AUDIT.md for the manual half this doesn't
 * cover. `ProjectRoster` fetches on mount, so `fetch` is stubbed here
 * rather than hitting a real API.
 */
function mockFetchOnce(assignments: AssignmentDto[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => assignments,
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const sampleAssignment: AssignmentDto = {
  id: "11111111-1111-1111-1111-111111111111",
  volunteer_id: "22222222-2222-2222-2222-222222222222",
  project_id: "33333333-3333-3333-3333-333333333333",
  role: "Carpenter",
  participation_mode: "contributor",
  status: "applied",
};

describe("ProjectRoster accessibility", () => {
  it("has no axe-detectable violations with an empty roster", async () => {
    mockFetchOnce([]);
    const { container } = render(<ProjectRoster projectId="project-1" />);
    await waitFor(() => screen.getByText(/no one has applied/i));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has no axe-detectable violations with a populated roster", async () => {
    mockFetchOnce([sampleAssignment]);
    const { container } = render(<ProjectRoster projectId="project-1" />);
    await waitFor(() => screen.getByText("Carpenter"));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("gives each action button an accessible name distinguishing which application it acts on", async () => {
    mockFetchOnce([sampleAssignment]);
    render(<ProjectRoster projectId="project-1" />);
    await waitFor(() => screen.getByText("Carpenter"));

    expect(
      screen.getByRole("button", { name: /approve carpenter application/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /remove carpenter from project/i }),
    ).toBeInTheDocument();
  });
});
