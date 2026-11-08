import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 240_000,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "../../.local-artifacts/qa/visual-results",
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000" },
});
