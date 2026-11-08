import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

const FAKE_32_BYTE_KEY = Buffer.alloc(32, 7).toString("base64");

const HERMETIC_ENV = {
  INLET_SKIP_ENV_FILE: "1",
  NODE_ENV: "test",
  DATABASE_URL: "postgres://unit-tests-never-connect:unused@127.0.0.1:1/none",
  REDIS_URL: "redis://127.0.0.1:1",
  SESSION_SECRET: "unit-test-session-secret-not-used-anywhere-else",
  MASTER_ENCRYPTION_KEY: FAKE_32_BYTE_KEY,
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
          env: HERMETIC_ENV,
          testTimeout: 15_000,
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          fileParallelism: false,
          testTimeout: 180_000,
          hookTimeout: 420_000,
        },
      },
      {
        test: {
          name: "security",
          include: ["tests/security/**/*.test.ts"],
          environment: "node",
          fileParallelism: false,
          // Evidence and repository stores must not mix with the running worker's real artifacts.
          env: { ARTIFACT_STORE_PATH: join(tmpdir(), `inlet-security-store-${process.pid}`) },
          testTimeout: 60_000,
          hookTimeout: 360_000,
        },
      },
    ],
  },
});
