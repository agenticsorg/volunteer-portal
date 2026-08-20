import { defineConfig, devices } from "@playwright/test";

// ADR-0015's e2e-smoke layer runs against a deployed Vercel preview once
// preview deployments exist. Phase 0 has no deployment pipeline yet (and no
// flows worth testing — no domain logic), so this config drives a locally
// built-and-started `next start` server instead; the `webServer` block below
// is the only thing that will need to change when CI starts pointing this at
// a real preview URL.
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
  },
  webServer: {
    command: "pnpm run build && pnpm run start",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
