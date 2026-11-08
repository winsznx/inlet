import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 600_000,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "../../.local-artifacts/qa/e2e-results",
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000", trace: "retain-on-failure", screenshot: "only-on-failure", viewport: { width: 1440, height: 900 } },
});
