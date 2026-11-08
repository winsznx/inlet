import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const envFile = resolve(repoRoot, ".env.local");
if (existsSync(envFile) && process.env.INLET_SKIP_ENV_FILE !== "1") {
  process.loadEnvFile(envFile);
}

const blankToUndefined = (value: unknown) => (value === "" ? undefined : value);
const optionalString = z.preprocess(blankToUndefined, z.string().optional());

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    NEXT_PUBLIC_APP_URL: z.url().default("http://localhost:3000"),
    API_BASE_URL: z.url().default("http://localhost:4000"),
    API_PORT: z.coerce.number().default(4000),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    SESSION_SECRET: z.string().min(32),
    MASTER_ENCRYPTION_KEY: z.string().min(32),
    ARTIFACT_STORE_PATH: z.string().default("./.local-artifacts"),

    MAILPIT_API_URL: z.url().default("http://localhost:8025"),

    FIXTURE_SITE_URL: z.url().default("http://localhost:3110"),
    FIXTURE_BROKEN_SITE_URL: z.url().default("http://localhost:3111"),
    FIXTURE_DEMO_BROKEN_SITE_URL: z.url().default("http://localhost:3112"),
    FIXTURE_ATTACK_SITE_URL: z.url().default("http://localhost:3113"),
    FIXTURE_CONTROL_URL: z.url().default("http://localhost:3190"),
    FIXTURE_CONTROL_TOKEN: optionalString,

    SANDBOX_BACKEND: z.enum(["local-oci", "vultr-gvisor"]).default("local-oci"),
    SANDBOX_OCI_RUNTIME: z.enum(["runc", "runsc"]).default("runc"),
    SANDBOX_EGRESS_PROFILE: z.enum(["fixture-only", "verified-public"]).default("fixture-only"),
    SANDBOX_NETWORK: z.string().default("inlet-sandbox"),
    SANDBOX_FIXTURES_NETWORK: z.string().default("inlet-fixtures"),
    SANDBOX_BROWSER_IMAGE: z.string().default("inlet-runner-browser:local"),
    SANDBOX_REPAIR_IMAGE: z.string().default("inlet-runner-repair:local"),
    SANDBOX_SINK_IMAGE: z.string().default("axllent/mailpit:v1.27"),
    SANDBOX_SINK_ACCESS: z.enum(["published-port", "fixtures-network"]).default("published-port"),
    EGRESS_CONTROL_URL: z.url().default("http://localhost:3191"),
    EGRESS_CONTROL_TOKEN: optionalString,
    EGRESS_PROXY_HOST: z.string().default("172.30.0.2"),
    EGRESS_PROXY_PORT: z.coerce.number().default(3128),

    VULTR_INFERENCE_BASE_URL: z.url().default("https://api.vultrinference.com/v1"),
    VULTR_INFERENCE_API_KEY: optionalString,
    VULTR_INFERENCE_MODEL: optionalString,
    VULTR_VISION_MODEL: optionalString,

    GITHUB_APP_ID: optionalString,
    GITHUB_APP_PRIVATE_KEY: optionalString,
    GITHUB_WEBHOOK_SECRET: optionalString,
    GITHUB_API_URL: z.url().default("https://api.github.com"),
    DEPLOY_WEBHOOK_SECRET: optionalString,

    NOTIFY_SMTP_HOST: z.string().default("127.0.0.1"),
    NOTIFY_SMTP_PORT: z.coerce.number().default(1025),
    NOTIFY_SMTP_USER: optionalString,
    NOTIFY_SMTP_PASSWORD: optionalString,
    NOTIFY_FROM: z.string().default("Inlet <alerts@inlet.test>"),

    DEMO_PUBLIC_MODE: z.stringbool().default(false),
    AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
    OBSERVATION_WINDOW_SECONDS: z.coerce.number().int().min(5).max(900).default(30),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  })
  .superRefine((env, ctx) => {
    if (Buffer.from(env.MASTER_ENCRYPTION_KEY, "base64").length !== 32) {
      ctx.addIssue({
        code: "custom",
        path: ["MASTER_ENCRYPTION_KEY"],
        message: "must be 32 bytes, base64 encoded",
      });
    }
    if (env.NODE_ENV === "production" && env.NEXT_PUBLIC_APP_URL.startsWith("http://")) {
      ctx.addIssue({ code: "custom", path: ["NEXT_PUBLIC_APP_URL"], message: "must be https in production" });
    }
  });

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid environment. Run \`pnpm setup:env\` for local defaults.\n${problems}`);
  }
  cached = parsed.data;
  return cached;
}

export function artifactRoot(): string {
  return resolve(repoRoot, env().ARTIFACT_STORE_PATH);
}

export function inferenceConfigured(): boolean {
  return Boolean(env().VULTR_INFERENCE_API_KEY);
}

export function fixturesEnabled(): boolean {
  return env().NODE_ENV !== "production" || env().DEMO_PUBLIC_MODE;
}

export function isProduction(): boolean {
  return env().NODE_ENV === "production";
}

export function githubConfigured(): boolean {
  return Boolean(env().GITHUB_APP_ID && env().GITHUB_APP_PRIVATE_KEY);
}
