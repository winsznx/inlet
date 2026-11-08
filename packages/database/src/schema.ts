import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { INCIDENT_STATES, ROLES, RUN_KINDS, RUN_RESULTS, RUN_STATES, RUN_TRIGGERS } from "@inlet/domain";
import type { FieldMap, SyntheticIdentity } from "@inlet/domain";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () => ts("updated_at").notNull().defaultNow();
const id = () => uuid("id").primaryKey();

export const roleEnum = pgEnum("role", ROLES);
export const runStateEnum = pgEnum("run_state", RUN_STATES);
export const runResultEnum = pgEnum("run_result", RUN_RESULTS);
export const runTriggerEnum = pgEnum("run_trigger", RUN_TRIGGERS);
export const runKindEnum = pgEnum("run_kind", RUN_KINDS);
export const incidentStateEnum = pgEnum("incident_state", INCIDENT_STATES);
export const destinationTypeEnum = pgEnum("destination_type", ["mailpit", "imap", "webhook"]);
export const connectionStatusEnum = pgEnum("connection_status", ["connected", "needs_setup", "expired", "error"]);
export const sourceProviderEnum = pgEnum("source_provider", ["github", "local_upload"]);
export const verificationStatusEnum = pgEnum("verification_status", ["pending", "verified", "failed", "expired"]);
export const verificationMethodEnum = pgEnum("verification_method", ["dns_txt", "html_meta", "controlled_fixture"]);
export const patchStatusEnum = pgEnum("patch_status", [
  "proposed",
  "testing",
  "ready",
  "failed",
  "guard_rejected",
  "approved",
  "rejected",
]);
export const investigationStateEnum = pgEnum("investigation_state", [
  "queued",
  "running",
  "patch_ready",
  "no_code_cause",
  "needs_configuration",
  "failed",
  "interrupted",
]);
export const investigationOriginEnum = pgEnum("investigation_origin", ["vultr_inference", "non_ai_harness"]);
export const approvalDecisionEnum = pgEnum("approval_decision", ["approved", "rejected"]);
export const deploymentTriggerEnum = pgEnum("deployment_trigger", ["manual", "webhook", "fixture_apply"]);

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  emailVerifiedAt: ts("email_verified_at"),
  createdAt: createdAt(),
  disabledAt: ts("disabled_at"),
});

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    activeOrganizationId: uuid("active_organization_id"),
    expiresAt: ts("expires_at").notNull(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    revokedAt: ts("revoked_at"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const authTokens = pgTable(
  "auth_tokens",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: text("purpose", { enum: ["password_reset", "email_verification"] }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    createdAt: createdAt(),
  },
  (t) => [index("auth_tokens_user_idx").on(t.userId, t.purpose)],
);

export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .references(() => users.id),
  timezone: text("timezone").notNull().default("UTC"),
  retentionDays: integer("retention_days").notNull().default(30),
  maintainersMayApprove: boolean("maintainers_may_approve").notNull().default(false),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull(),
    createdAt: createdAt(),
    inviteAcceptedAt: ts("invite_accepted_at"),
  },
  (t) => [uniqueIndex("memberships_org_user_idx").on(t.organizationId, t.userId)],
);

export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: roleEnum("role").notNull(),
    inviteTokenHash: text("invite_token_hash").notNull().unique(),
    expiresAt: ts("expires_at").notNull(),
    acceptedAt: ts("accepted_at"),
    revokedAt: ts("revoked_at"),
    invitedBy: uuid("invited_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("invitations_org_idx").on(t.organizationId)],
);

export const sites = pgTable(
  "sites",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    verifiedOrigin: text("verified_origin").notNull(),
    formUrl: text("form_url").notNull(),
    formPurpose: text("form_purpose", { enum: ["contact", "quote", "booking", "custom"] })
      .notNull()
      .default("contact"),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    authorizationAcceptedAt: ts("authorization_accepted_at").notNull(),
    authorizationAcceptedBy: uuid("authorization_accepted_by").references(() => users.id, { onDelete: "set null" }),
    verificationStatus: verificationStatusEnum("verification_status").notNull().default("pending"),
    verificationMethod: verificationMethodEnum("verification_method"),
    verificationToken: text("verification_token"),
    verificationExpiresAt: ts("verification_expires_at"),
    verificationLastError: text("verification_last_error"),
    verifiedAt: ts("verified_at"),
    setupStep: integer("setup_step").notNull().default(1),
    setupCompletedAt: ts("setup_completed_at"),
    fixtureSlot: text("fixture_slot"),
    active: boolean("active").notNull().default(true),
    archivedAt: ts("archived_at"),
    lastRunId: uuid("last_run_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("sites_org_idx").on(t.organizationId, t.archivedAt)],
);

export const formConfigs = pgTable(
  "form_configs",
  {
    id: id(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    fieldMap: jsonb("field_map").$type<FieldMap>().notNull(),
    syntheticIdentity: jsonb("synthetic_identity").$type<SyntheticIdentity>().notNull(),
    consentMode: text("consent_mode", { enum: ["none", "controlled_test_account"] })
      .notNull()
      .default("none"),
    maxSubmissionFrequencyMinutes: integer("max_submission_frequency_minutes").notNull().default(15),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("form_configs_site_version_idx").on(t.siteId, t.version)],
);

export const secrets = pgTable("secrets", {
  id: id(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  keyAlias: text("key_alias").notNull(),
  ciphertext: text("ciphertext").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  createdAt: createdAt(),
  rotatedAt: ts("rotated_at"),
});

export const destinations = pgTable(
  "destinations",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    type: destinationTypeEnum("type").notNull(),
    displayName: text("display_name").notNull(),
    host: text("host"),
    port: integer("port"),
    settings: jsonb("settings").$type<Record<string, string | number | boolean>>().notNull().default({}),
    encryptedCredentialId: uuid("encrypted_credential_id").references(() => secrets.id, { onDelete: "set null" }),
    status: connectionStatusEnum("status").notNull().default("needs_setup"),
    lastVerifiedAt: ts("last_verified_at"),
    lastError: text("last_error"),
    deletedAt: ts("deleted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("destinations_site_idx").on(t.siteId, t.deletedAt)],
);

export const inboundReceipts = pgTable(
  "inbound_receipts",
  {
    id: id(),
    destinationId: uuid("destination_id")
      .notNull()
      .references(() => destinations.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    remoteIdHash: text("remote_id_hash").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
  },
  (t) => [
    index("inbound_receipts_lookup_idx").on(t.destinationId, t.tokenHash),
    uniqueIndex("inbound_receipts_remote_idx").on(t.destinationId, t.remoteIdHash),
  ],
);

export const sourceConnections = pgTable("source_connections", {
  id: id(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  siteId: uuid("site_id")
    .notNull()
    .references(() => sites.id, { onDelete: "cascade" }),
  provider: sourceProviderEnum("provider").notNull(),
  repoSlug: text("repo_slug").notNull(),
  baseBranch: text("base_branch").notNull().default("main"),
  baseCommitSha: text("base_commit_sha"),
  installationId: text("installation_id"),
  approvedPaths: jsonb("approved_paths").$type<string[]>().notNull().default(["src"]),
  packageManager: text("package_manager", { enum: ["pnpm", "npm"] })
    .notNull()
    .default("pnpm"),
  buildProfile: text("build_profile").notNull().default("next-pnpm"),
  previewEnv: jsonb("preview_env").$type<Record<string, string>>().notNull().default({}),
  storageRef: text("storage_ref"),
  isControlledFixture: boolean("is_controlled_fixture").notNull().default(false),
  status: connectionStatusEnum("status").notNull().default("needs_setup"),
  lastValidatedAt: ts("last_validated_at"),
  lastError: text("last_error"),
  deletedAt: ts("deleted_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const schedules = pgTable(
  "schedules",
  {
    id: id(),
    siteId: uuid("site_id")
      .notNull()
      .unique()
      .references(() => sites.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    mode: text("mode", { enum: ["off", "hourly", "six_hours", "daily", "custom"] })
      .notNull()
      .default("off"),
    intervalMinutes: integer("interval_minutes"),
    timezone: text("timezone").notNull().default("UTC"),
    nextRunAt: ts("next_run_at"),
    lastRunAt: ts("last_run_at"),
    maxDailyRuns: integer("max_daily_runs").notNull().default(24),
    paused: boolean("paused").notNull().default(false),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: updatedAt(),
  },
  (t) => [index("schedules_due_idx").on(t.enabled, t.nextRunAt)],
);

export const formDiscoveries = pgTable(
  "form_discoveries",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["pending", "complete", "failed"] })
      .notNull()
      .default("pending"),
    proposal: jsonb("proposal").$type<Record<string, unknown>>(),
    errorDetail: text("error_detail"),
    createdAt: createdAt(),
  },
  (t) => [index("form_discoveries_site_idx").on(t.siteId)],
);

export const demoSessions = pgTable("demo_sessions", {
  id: id(),
  tokenHash: text("token_hash").notNull().unique(),
  ipHash: text("ip_hash").notNull(),
  createdAt: createdAt(),
  expiresAt: ts("expires_at").notNull(),
});

export const checkRuns = pgTable(
  "check_runs",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "cascade" }),
    kind: runKindEnum("kind").notNull().default("delivery"),
    scenario: text("scenario"),
    demoSessionId: uuid("demo_session_id").references(() => demoSessions.id, { onDelete: "set null" }),
    incidentId: uuid("incident_id"),
    trigger: runTriggerEnum("trigger").notNull(),
    reason: text("reason"),
    state: runStateEnum("state").notNull().default("queued"),
    result: runResultEnum("result"),
    idempotencyKey: text("idempotency_key"),
    testTokenHash: text("test_token_hash").notNull(),
    testTokenEncrypted: text("test_token_encrypted").notNull(),
    tokenSuffix: text("token_suffix").notNull(),
    destinationId: uuid("destination_id").references(() => destinations.id, { onDelete: "set null" }),
    formConfigId: uuid("form_config_id").references(() => formConfigs.id, { onDelete: "set null" }),
    sandboxId: uuid("sandbox_id"),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    leaseExpiresAt: ts("lease_expires_at"),
    submissionIntentAt: ts("submission_intent_at"),
    submittedAt: ts("submitted_at"),
    browserOutcome: jsonb("browser_outcome").$type<Record<string, unknown>>(),
    observationDeadlineAt: ts("observation_deadline_at"),
    observationWindowSeconds: integer("observation_window_seconds").notNull().default(30),
    resultSummary: text("result_summary"),
    startedAt: ts("started_at"),
    completedAt: ts("completed_at"),
    cleanupAt: ts("cleanup_at"),
    durationMs: integer("duration_ms"),
    stageVersion: integer("stage_version").notNull().default(0),
    cancelRequestedAt: ts("cancel_requested_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("check_runs_site_started_idx").on(t.siteId, t.startedAt.desc()),
    index("check_runs_org_result_started_idx").on(t.organizationId, t.result, t.startedAt.desc()),
    uniqueIndex("check_runs_site_idempotency_idx")
      .on(t.siteId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    index("check_runs_lease_idx").on(t.state, t.leaseExpiresAt),
  ],
);

export const runEvents = pgTable(
  "run_events",
  {
    id: id(),
    runId: uuid("run_id")
      .notNull()
      .references(() => checkRuns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    eventType: text("event_type").notNull(),
    stage: text("stage").notNull(),
    safePublicSummary: text("safe_public_summary").notNull(),
    redactedPayload: jsonb("redacted_payload").$type<Record<string, string | number | boolean>>(),
    artifactIds: jsonb("artifact_ids").$type<string[]>(),
    timestamp: ts("timestamp").notNull().defaultNow(),
    correlationTraceId: text("correlation_trace_id"),
  },
  (t) => [uniqueIndex("run_events_run_sequence_idx").on(t.runId, t.sequence)],
);

export const runArtifacts = pgTable(
  "run_artifacts",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => checkRuns.id, { onDelete: "cascade" }),
    investigationId: uuid("investigation_id"),
    kind: text("kind").notNull(),
    objectKey: text("object_key").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    mime: text("mime").notNull(),
    redactionVersion: integer("redaction_version").notNull().default(1),
    createdAt: createdAt(),
    expiresAt: ts("expires_at"),
    deletedAt: ts("deleted_at"),
  },
  (t) => [index("run_artifacts_run_idx").on(t.runId), index("run_artifacts_expiry_idx").on(t.expiresAt)],
);

export const deliveryObservations = pgTable(
  "delivery_observations",
  {
    id: id(),
    runId: uuid("run_id")
      .notNull()
      .references(() => checkRuns.id, { onDelete: "cascade" }),
    destinationId: uuid("destination_id").references(() => destinations.id, { onDelete: "set null" }),
    searchStartedAt: ts("search_started_at").notNull(),
    searchEndedAt: ts("search_ended_at"),
    pollCount: integer("poll_count").notNull().default(0),
    status: text("status", { enum: ["found", "not_found", "unavailable"] }),
    matchFound: boolean("match_found").notNull().default(false),
    matchSource: text("match_source"),
    remoteMessageIdHash: text("remote_message_id_hash"),
    matchedAt: ts("matched_at"),
    matchedRecipient: text("matched_recipient"),
    matchedSubject: text("matched_subject"),
    verifierVersion: text("verifier_version").notNull(),
    errorCode: text("error_code"),
  },
  (t) => [uniqueIndex("delivery_observations_run_idx").on(t.runId)],
);

export const incidents = pgTable(
  "incidents",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    openedByRunId: uuid("opened_by_run_id")
      .notNull()
      .references(() => checkRuns.id),
    recoveryRunId: uuid("recovery_run_id"),
    title: text("title").notNull(),
    causeCategory: text("cause_category"),
    state: incidentStateEnum("state").notNull().default("open"),
    severity: text("severity", { enum: ["high", "medium"] })
      .notNull()
      .default("high"),
    currentPatchId: uuid("current_patch_id"),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    closedAt: ts("closed_at"),
    closeReason: text("close_reason"),
    publicTrace: boolean("public_trace").notNull().default(false),
    humanDiagnosis: jsonb("human_diagnosis").$type<{ cause: string; whatToCheck: string[] }>(),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("incidents_org_state_updated_idx").on(t.organizationId, t.state, t.updatedAt),
    index("incidents_site_idx").on(t.siteId),
  ],
);

export const incidentTransitions = pgTable(
  "incident_transitions",
  {
    id: id(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    fromState: incidentStateEnum("from_state").notNull(),
    toState: incidentStateEnum("to_state").notNull(),
    actor: text("actor").notNull(),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [index("incident_transitions_incident_idx").on(t.incidentId, t.createdAt)],
);

export type RepairHypothesis = {
  hypothesis: string;
  supportingEvidence: { artifactId: string; observation: string }[];
  suspectedFiles: string[];
  patchIntent: string;
};

export const investigations = pgTable(
  "investigations",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    origin: investigationOriginEnum("origin").notNull(),
    modelId: text("model_id"),
    promptVersion: text("prompt_version").notNull(),
    inputArtifactManifestId: uuid("input_artifact_manifest_id"),
    baseCommitSha: text("base_commit_sha"),
    state: investigationStateEnum("state").notNull().default("queued"),
    eventSequence: integer("event_sequence").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    leaseExpiresAt: ts("lease_expires_at"),
    startedAt: ts("started_at"),
    completedAt: ts("completed_at"),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    costEstimateUsd: numeric("cost_estimate_usd", { precision: 12, scale: 6 }),
    errorCode: text("error_code"),
    errorDetail: text("error_detail"),
    hypothesis: jsonb("hypothesis").$type<RepairHypothesis>(),
    nonCodeCause: text("non_code_cause"),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("investigations_incident_idx").on(t.incidentId)],
);

export const investigationEvents = pgTable(
  "investigation_events",
  {
    id: id(),
    investigationId: uuid("investigation_id")
      .notNull()
      .references(() => investigations.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    eventType: text("event_type").notNull(),
    summary: text("summary").notNull(),
    attempt: integer("attempt"),
    payload: jsonb("payload").$type<Record<string, string | number | boolean>>(),
    timestamp: ts("timestamp").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("investigation_events_seq_idx").on(t.investigationId, t.sequence)],
);

export const modelCalls = pgTable(
  "model_calls",
  {
    id: id(),
    investigationId: uuid("investigation_id")
      .notNull()
      .references(() => investigations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("vultr-serverless-inference"),
    modelId: text("model_id").notNull(),
    requestId: text("request_id"),
    responseId: text("response_id"),
    startedAt: ts("started_at").notNull(),
    durationMs: integer("duration_ms").notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    finishReason: text("finish_reason"),
    toolNames: jsonb("tool_names").$type<string[]>(),
    httpStatus: integer("http_status"),
    errorCode: text("error_code"),
  },
  (t) => [index("model_calls_investigation_idx").on(t.investigationId)],
);

export const toolCalls = pgTable(
  "tool_calls",
  {
    id: id(),
    investigationId: uuid("investigation_id")
      .notNull()
      .references(() => investigations.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    toolName: text("tool_name").notNull(),
    redactedArgs: jsonb("redacted_args").$type<Record<string, unknown>>(),
    allowed: boolean("allowed").notNull(),
    reasonCode: text("reason_code"),
    durationMs: integer("duration_ms").notNull(),
    resultSha256: text("result_sha256"),
    createdAt: createdAt(),
  },
  (t) => [index("tool_calls_investigation_idx").on(t.investigationId)],
);

export const patches = pgTable(
  "patches",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    investigationId: uuid("investigation_id")
      .notNull()
      .references(() => investigations.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    origin: investigationOriginEnum("origin").notNull(),
    baseCommitSha: text("base_commit_sha").notNull(),
    candidateCommitSha: text("candidate_commit_sha"),
    diffText: text("diff_text").notNull(),
    diffArtifactId: uuid("diff_artifact_id").references(() => runArtifacts.id, { onDelete: "set null" }),
    changedFiles: jsonb("changed_files").$type<string[]>().notNull(),
    changedFileCount: integer("changed_file_count").notNull(),
    changedLineCount: integer("changed_line_count").notNull(),
    riskLevel: text("risk_level", { enum: ["low", "medium", "high"] })
      .notNull()
      .default("medium"),
    riskNotes: jsonb("risk_notes").$type<string[]>().notNull().default([]),
    rationale: text("rationale"),
    status: patchStatusEnum("status").notNull().default("proposed"),
    guardFailures: jsonb("guard_failures").$type<string[]>(),
    sha256: text("sha256").notNull(),
    previewRunEvidence: jsonb("preview_run_evidence").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("patches_incident_idx").on(t.incidentId)],
);

export const patchChecks = pgTable(
  "patch_checks",
  {
    id: id(),
    patchId: uuid("patch_id")
      .notNull()
      .references(() => patches.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    commandProfile: text("command_profile").notNull(),
    variant: text("variant", { enum: ["baseline", "patched"] })
      .notNull()
      .default("patched"),
    exitCode: integer("exit_code"),
    startedAt: ts("started_at").notNull(),
    endedAt: ts("ended_at"),
    logArtifactId: uuid("log_artifact_id").references(() => runArtifacts.id, { onDelete: "set null" }),
    pass: boolean("pass").notNull(),
    detail: text("detail"),
    runId: uuid("run_id").references(() => checkRuns.id, { onDelete: "set null" }),
  },
  (t) => [index("patch_checks_patch_idx").on(t.patchId)],
);

export const patchComments = pgTable("patch_comments", {
  id: id(),
  patchId: uuid("patch_id")
    .notNull()
    .references(() => patches.id, { onDelete: "cascade" }),
  authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
  body: text("body").notNull(),
  createdAt: createdAt(),
});

export const approvals = pgTable("approvals", {
  id: id(),
  patchId: uuid("patch_id")
    .notNull()
    .references(() => patches.id, { onDelete: "cascade" }),
  actorUserId: uuid("actor_user_id")
    .notNull()
    .references(() => users.id),
  decision: approvalDecisionEnum("decision").notNull(),
  decisionReason: text("decision_reason").notNull(),
  riskAcknowledgedAt: ts("risk_acknowledged_at"),
  createdAt: createdAt(),
});

export const deployments = pgTable("deployments", {
  id: id(),
  incidentId: uuid("incident_id")
    .notNull()
    .references(() => incidents.id, { onDelete: "cascade" }),
  patchId: uuid("patch_id")
    .notNull()
    .references(() => patches.id, { onDelete: "cascade" }),
  environment: text("environment").notNull(),
  trigger: deploymentTriggerEnum("trigger").notNull(),
  deploymentRef: text("deployment_ref"),
  deployedAt: ts("deployed_at").notNull(),
  attestedByUserId: uuid("attested_by_user_id").references(() => users.id, { onDelete: "set null" }),
  webhookVerified: boolean("webhook_verified").notNull().default(false),
  recheckRunId: uuid("recheck_run_id"),
  createdAt: createdAt(),
});

export const gitPullRequests = pgTable("git_pull_requests", {
  id: id(),
  patchId: uuid("patch_id")
    .notNull()
    .references(() => patches.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  repoRef: text("repo_ref").notNull(),
  branch: text("branch").notNull(),
  prNumber: integer("pr_number").notNull(),
  prUrl: text("pr_url").notNull(),
  currentState: text("current_state").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

export const notificationPreferences = pgTable("notification_preferences", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  email: text("email"),
  notifyFailure: boolean("notify_failure").notNull().default(true),
  notifyRecovery: boolean("notify_recovery").notNull().default(true),
  notifyActionRequired: boolean("notify_action_required").notNull().default(true),
  notifyConnectionExpired: boolean("notify_connection_expired").notNull().default(true),
  dailyDigest: boolean("daily_digest").notNull().default(false),
  dedupWindowMinutes: integer("dedup_window_minutes").notNull().default(360),
  quietHoursStart: integer("quiet_hours_start"),
  quietHoursEnd: integer("quiet_hours_end"),
  updatedAt: updatedAt(),
});

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "cascade" }),
    incidentId: uuid("incident_id").references(() => incidents.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    recipient: text("recipient").notNull(),
    subject: text("subject").notNull(),
    deliveryStatus: text("delivery_status", { enum: ["pending", "sent", "failed", "suppressed"] })
      .notNull()
      .default("pending"),
    dedupKey: text("dedup_key").notNull(),
    groupedCount: integer("grouped_count").notNull().default(1),
    sentAt: ts("sent_at"),
    errorCode: text("error_code"),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_dedup_idx").on(t.dedupKey),
    index("notifications_org_idx").on(t.organizationId, t.createdAt.desc()),
  ],
);

export const sandboxSessions = pgTable(
  "sandbox_sessions",
  {
    id: id(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => checkRuns.id, { onDelete: "cascade" }),
    investigationId: uuid("investigation_id").references(() => investigations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    provider: text("provider").notNull(),
    ociRuntime: text("oci_runtime"),
    containerId: text("container_id"),
    containerName: text("container_name"),
    runtimeImageDigest: text("runtime_image_digest"),
    cpuLimit: numeric("cpu_limit", { precision: 6, scale: 2 }).notNull(),
    memoryLimitMb: integer("memory_limit_mb").notNull(),
    pidsLimit: integer("pids_limit").notNull(),
    wallLimitSeconds: integer("wall_limit_seconds").notNull(),
    networkPolicyHash: text("network_policy_hash").notNull(),
    networkPolicy: jsonb("network_policy").$type<Record<string, unknown>>().notNull(),
    hardening: jsonb("hardening").$type<string[]>().notNull().default([]),
    startedAt: ts("started_at"),
    stoppedAt: ts("stopped_at"),
    exitCode: integer("exit_code"),
    exitReason: text("exit_reason"),
    oomKilled: boolean("oom_killed"),
    cleanupVerified: boolean("cleanup_verified").notNull().default(false),
    cleanupVerifiedAt: ts("cleanup_verified_at"),
    cleanupAttempts: integer("cleanup_attempts").notNull().default(0),
    cleanupError: text("cleanup_error"),
    denialCount: integer("denial_count").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index("sandbox_sessions_run_idx").on(t.runId),
    index("sandbox_sessions_investigation_idx").on(t.investigationId),
    index("sandbox_sessions_cleanup_idx").on(t.cleanupVerified, t.stoppedAt),
  ],
);

export const policyDecisions = pgTable(
  "policy_decisions",
  {
    id: id(),
    sandboxId: uuid("sandbox_id").references(() => sandboxSessions.id, { onDelete: "cascade" }),
    investigationId: uuid("investigation_id").references(() => investigations.id, { onDelete: "cascade" }),
    layer: text("layer", { enum: ["egress_gateway", "controller", "runtime"] }).notNull(),
    actionType: text("action_type").notNull(),
    actionTargetRedacted: text("action_target_redacted").notNull(),
    allowed: boolean("allowed").notNull(),
    reasonCode: text("reason_code").notNull(),
    timestamp: ts("timestamp").notNull().defaultNow(),
    traceId: text("trace_id"),
  },
  (t) => [index("policy_decisions_sandbox_ts_idx").on(t.sandboxId, t.timestamp)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorKind: text("actor_kind", { enum: ["user", "system"] })
      .notNull()
      .default("user"),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    safeMetadata: jsonb("safe_metadata").$type<Record<string, unknown>>(),
    ipHash: text("ip_hash"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_events_org_created_idx").on(t.organizationId, t.createdAt.desc())],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: id(),
    aggregateId: text("aggregate_id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    readyAt: ts("ready_at").notNull().defaultNow(),
    dispatchedAt: ts("dispatched_at"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("outbox_pending_idx").on(t.dispatchedAt, t.readyAt)],
);

export const apiIdempotency = pgTable(
  "api_idempotency",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    action: text("action").notNull(),
    resourceId: text("resource_id").notNull(),
    createdAt: createdAt(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.key, t.action] })],
);
