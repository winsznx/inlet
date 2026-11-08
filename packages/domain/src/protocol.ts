import { z } from "zod";

export const fieldMapSchema = z.object({
  name: z.string().min(1).max(300),
  email: z.string().min(1).max(300),
  subject: z.string().max(300).optional(),
  message: z.string().min(1).max(300),
  submit: z.string().min(1).max(300),
  successIndicator: z.string().max(300).optional(),
  consent: z.string().max(300).optional(),
});
export type FieldMap = z.infer<typeof fieldMapSchema>;

export const syntheticIdentitySchema = z.object({
  name: z.string().min(1).max(80),
  email: z.email().max(200),
  subject: z.string().max(120),
  messagePrefix: z.string().max(500),
});
export type SyntheticIdentity = z.infer<typeof syntheticIdentitySchema>;

export const browserJobSchema = z.object({
  mode: z.enum(["submit", "discover", "containment"]),
  targetUrl: z.url(),
  proxyServer: z.string().optional(),
  fieldMap: fieldMapSchema.optional(),
  identity: syntheticIdentitySchema.optional(),
  token: z.string().optional(),
  navigationTimeoutMs: z.number().int().positive().default(25_000),
  containment: z
    .object({
      attemptNavigation: z.string().url().optional(),
    })
    .optional(),
});
export type BrowserJob = z.infer<typeof browserJobSchema>;

export const runnerArtifactSchema = z.object({
  t: z.literal("artifact"),
  kind: z.enum(["screenshot-before", "screenshot-after", "network-log", "console-log", "dom-summary", "log", "diff"]),
  name: z.string().regex(/^[\w.-]{1,80}$/),
  mime: z.enum(["image/png", "application/json", "text/plain"]),
  b64: z.string(),
});
export type RunnerArtifact = z.infer<typeof runnerArtifactSchema>;

export const runnerStageSchema = z.object({
  t: z.literal("stage"),
  stage: z.enum(["opening_form", "mapping_fields", "submitting"]),
  at: z.string(),
});

export const runnerSubmitRequestSchema = z.object({ t: z.literal("submit_request"), at: z.string() });

export const networkSummarySchema = z.object({
  method: z.string().max(10),
  url: z.string().max(400),
  status: z.number().int().nullable(),
  failed: z.boolean(),
});
export type NetworkSummary = z.infer<typeof networkSummarySchema>;

export const browserOutcomeSchema = z.object({
  t: z.literal("result"),
  navigated: z.boolean(),
  httpStatus: z.number().int().nullable(),
  fieldsFilled: z.boolean(),
  submitClicked: z.boolean(),
  submitObserved: z.boolean(),
  successUiObserved: z.boolean(),
  successUiText: z.string().max(240).nullable(),
  captchaDetected: z.boolean(),
  failure: z
    .enum([
      "navigation_failed",
      "blocked_by_policy",
      "field_not_found",
      "submit_not_found",
      "submit_failed",
      "captcha_detected",
      "ambiguous_fields",
      "unexpected_error",
    ])
    .nullable(),
  failureDetail: z.string().max(400).nullable(),
  network: z.array(networkSummarySchema).max(200),
  discovered: z.unknown().optional(),
  containment: z
    .array(
      z.object({
        probe: z.string().max(80),
        attempted: z.string().max(300),
        outcome: z.enum(["denied", "allowed", "error"]),
        detail: z.string().max(400),
        exitStatus: z.string().max(120).optional(),
      }),
    )
    .max(40)
    .optional(),
});
export type BrowserOutcome = z.infer<typeof browserOutcomeSchema>;

export const runnerMessageSchema = z.discriminatedUnion("t", [
  runnerStageSchema,
  runnerSubmitRequestSchema,
  runnerArtifactSchema,
  browserOutcomeSchema,
]);
export type RunnerMessage = z.infer<typeof runnerMessageSchema>;

export const REPAIR_PROFILES = ["typecheck", "lint", "unit", "build", "preview_start", "preview_stop"] as const;
export type RepairProfile = (typeof REPAIR_PROFILES)[number];

export const CHECK_NAMES = ["typecheck", "lint", "unit", "build", "fixture-delivery"] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

export const repairHelloSchema = z.object({
  t: z.literal("ready"),
  sourceFiles: z.number().int(),
  nodeVersion: z.string(),
});

export const repairResultSchema = z.object({
  t: z.literal("profile_result"),
  id: z.string(),
  profile: z.enum(REPAIR_PROFILES),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().int(),
  stdout: z.string().max(40_000),
  stderr: z.string().max(40_000),
});
export type RepairResult = z.infer<typeof repairResultSchema>;

export const repairMessageSchema = z.discriminatedUnion("t", [repairHelloSchema, repairResultSchema]);
export type RepairMessage = z.infer<typeof repairMessageSchema>;

export const labProbeSchema = z.object({
  t: z.literal("probe_result"),
  probe: z.string().max(80),
  attempted: z.string().max(300),
  outcome: z.enum(["denied", "allowed", "error"]),
  detail: z.string().max(600),
  exitStatus: z.string().max(120).optional(),
});
export type LabProbe = z.infer<typeof labProbeSchema>;
