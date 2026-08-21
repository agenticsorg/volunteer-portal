import { render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HourEntryDto } from "@/generated/HourEntry";
import { HoursApprovalQueue } from "./hours-approval-queue";

/**
 * Prompt 4.2's WCAG 2.1 AA exit criterion, automated half -- see
 * ACCESSIBILITY_AUDIT.md for the manual half this doesn't
 * cover. `HoursApprovalQueue` fetches on mount, so `fetch` is stubbed
 * here rather than hitting a real API, matching `ProjectRoster`'s test
 * pattern.
 */
function mockFetchOnce(entries: HourEntryDto[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => entries,
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const sampleEntry: HourEntryDto = {
  id: "11111111-1111-1111-1111-111111111111",
  volunteer_id: "22222222-2222-2222-2222-222222222222",
  assignment_id: "33333333-3333-3333-3333-333333333333",
  date: "2026-01-15",
  hours: "2.50",
  description: "Cleared brush along the east trail",
  status: "pending",
  approver_id: null,
  decided_at: null,
  adjustment: null,
};

describe("HoursApprovalQueue accessibility", () => {
  it("has no axe-detectable violations with an empty queue", async () => {
    mockFetchOnce([]);
    const { container } = render(<HoursApprovalQueue />);
    await waitFor(() => screen.getByText(/no pending hours/i));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has no axe-detectable violations with a populated queue", async () => {
    mockFetchOnce([sampleEntry]);
    const { container } = render(<HoursApprovalQueue />);
    await waitFor(() => screen.getByText(/cleared brush/i));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("gives each row's checkbox and reject button an accessible name distinguishing the entry", async () => {
    mockFetchOnce([sampleEntry]);
    render(<HoursApprovalQueue />);
    await waitFor(() => screen.getByText(/cleared brush/i));

    expect(
      screen.getByRole("checkbox", { name: /select entry for 2026-01-15, 2\.50 hours/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /reject entry for 2026-01-15, 2\.50 hours/i }),
    ).toBeInTheDocument();
  });

  it("disables bulk approve until at least one entry is selected", async () => {
    mockFetchOnce([sampleEntry]);
    render(<HoursApprovalQueue />);
    await waitFor(() => screen.getByText(/cleared brush/i));

    const approveButton = screen.getByRole("button", { name: /approve selected/i });
    expect(approveButton).toBeDisabled();
  });
});
