import { expect, test } from "@playwright/test";

// Phase 0 smoke test: no user-facing flows exist yet to cover (no domain
// logic), so this only proves the Playwright harness runs end-to-end
// against a real built-and-started Next.js server — browser launch, page
// navigation, DOM assertion, and the `/api/v1/health` route all wired
// together. Real named flows (ADR-0015 §"E2E smoke") replace this once
// `identity` and `volunteering` exist.
test("home page renders the platform scaffold", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Agentics Foundation Volunteer Portal" }),
  ).toBeVisible();
});

test("versioned REST health check responds", async ({ request }) => {
  const response = await request.get("/api/v1/health");
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});
