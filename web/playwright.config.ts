import { defineConfig, devices } from "@playwright/test";

// Browser smoke tests: sign in as the people `npm run seed` creates and walk
// each role's main screens against the real dev conductor.
//
//   npm run dev:reset      # fresh conductor on the current DNA, seeded
//   npm run test:e2e
//
// They read from (and add a little to) the seeded world, so a run leaves an
// order or two behind; `npm run dev:reset` starts clean again.
const PORT = Number(process.env.E2E_PORT ?? 5199);

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  // Every test drives the same conductor; one at a time keeps them honest.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    ...devices["Pixel 7"],
  },
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
