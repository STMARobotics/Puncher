import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://localhost:5173", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npm run dev:api",
      url: "http://127.0.0.1:3000/api/health",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "npm run dev:ui",
      url: "http://localhost:5173",
      reuseExistingServer: !process.env.CI,
    },
  ],
});
