import type { RunResult, RunState } from "@inlet/domain/states";

export type Permission = "evidence:view" | "site:edit" | "run:start" | "investigation:start" | "patch:decide" | "secret:manage" | "member:manage" | "workspace:delete" | "policy:view";

export type Me = {
  user: { id: string; email: string; name: string; emailVerified: boolean };
  organizations: { id: string; name: string; role: string }[];
  activeOrganizationId: string | null;
  role: string | null;
  permissions: Permission[];
  capabilities: { inference: boolean; github: boolean; production: boolean };
};

export type RunEvent = {
  eventId: string;
  runId: string;
  sequence: number;
  timestamp: string;
  type: string;
  stage: string;
  summary: string;
  artifactIds?: string[];
  safeMetadata?: Record<string, string | number | boolean>;
};

export type SandboxView = {
  id: string;
  role: string;
  provider: string;
  ociRuntime: string | null;
  containerName: string | null;
  containerId: string | null;
  imageDigest: string | null;
  cpuLimit: number;
  memoryLimitMb: number;
  pidsLimit: number;
  wallLimitSeconds: number;
  networkPolicy: Record<string, unknown>;
  networkPolicyHash: string;
  hardening: string[];
  startedAt: string | null;
  stoppedAt: string | null;
  exitCode: number | null;
  exitReason: string | null;
  oomKilled: boolean | null;
  cleanupVerified: boolean;
  cleanupVerifiedAt: string | null;
  denialCount: number;
};

export type RunDetail = {
  runId: string;
  siteId: string | null;
  siteName: string | null;
  siteOrigin: string | null;
  isControlledFixture: boolean;
  kind: "delivery" | "containment";
  scenario: string | null;
  trigger: string;
  state: RunState;
  result: RunResult | null;
  summary: string | null;
  incidentId: string | null;
  testToken: string;
  browser: {
    navigated: boolean;
    httpStatus: number | null;
    fieldsFilled: boolean;
    submissionObserved: boolean;
    submitClicked: boolean;
    successUiObserved: boolean;
    successUiText: string | null;
    captchaDetected: boolean;
    failure: string | null;
    failureDetail: string | null;
    network: { method: string; url: string; status: number | null; failed: boolean }[];
  } | null;
  delivery: {
    destinationName: string | null;
    destinationType: string | null;
    accessible: boolean | null;
    correlatedReceiptFound: boolean;
    status: string | null;
    matchedAt: string | null;
    matchSource: string | null;
    recipient: string | null;
    subject: string | null;
    remoteMessageIdHash: string | null;
    pollCount: number;
    searchStartedAt: string | null;
    searchEndedAt: string | null;
    errorCode: string | null;
    verifierVersion: string | null;
    observationSeconds: number;
    deadlineAt: string | null;
  };
  evidence: { id: string; kind: string; mime: string; sizeBytes: number; sha256: string; createdAt: string }[];
  events: RunEvent[];
  sandboxes: SandboxView[];
  policyDecisions: { id: string; layer: string; actionType: string; target: string; allowed: boolean; reasonCode: string; timestamp: string }[];
  startedAt: string | null;
  submittedAt: string | null;
  completedAt: string | null;
  cleanupAt: string | null;
  durationMs: number | null;
  createdAt: string;
  canCancel: boolean;
};

export type SiteListItem = {
  id: string;
  name: string;
  formUrl: string;
  verificationStatus: string;
  isControlledFixture: boolean;
  fixtureLabel: string | null;
  ownerName: string | null;
  latestRun: { id: string; state: RunState; result: RunResult | null; startedAt: string | null; completedAt: string | null } | null;
  nextRunAt: string | null;
  openIncidentId: string | null;
};

export type DestinationView = { id: string; type: "mailpit" | "imap" | "webhook"; displayName: string; host: string | null; port: number | null; status: string; lastVerifiedAt: string | null; lastError: string | null; folder?: string; user?: string; expectedRecipient?: string; hasCredential: boolean; inboundPath?: string };

export type RepositoryView = { id: string; provider: string; repoSlug: string; baseBranch: string; baseCommitSha: string | null; approvedPaths: string[]; packageManager: string; buildProfile: string; isControlledFixture: boolean; status: string; lastValidatedAt: string | null; lastError: string | null };

export type ScheduleView = { mode: "off" | "hourly" | "six_hours" | "daily" | "custom"; intervalMinutes: number | null; timezone: string; enabled: boolean; paused: boolean; nextRunAt: string | null; lastRunAt: string | null; maxDailyRuns: number; dailyRunEstimate: number };

export type FieldMap = { name: string; email: string; subject?: string; message: string; submit: string; successIndicator?: string; consent?: string };

export type SyntheticIdentity = { name: string; email: string; subject: string; messagePrefix: string };

export type SiteDetail = {
  id: string;
  name: string;
  formUrl: string;
  formPurpose: string;
  verificationStatus: string;
  verificationMethod: string | null;
  verificationExpiresAt: string | null;
  verificationLastError: string | null;
  verificationToken: string | null;
  setupStep: number;
  setupCompletedAt: string | null;
  isControlledFixture: boolean;
  fixtureLabel: string | null;
  formConfig: { version: number; fieldMap: FieldMap; syntheticIdentity: SyntheticIdentity; consentMode: string; maxSubmissionFrequencyMinutes: number } | null;
  destination: DestinationView | null;
  repository: RepositoryView | null;
  schedule: ScheduleView | null;
  recentRuns: { id: string; state: RunState; result: RunResult | null; trigger: string; startedAt: string | null; completedAt: string | null; durationMs: number | null; summary: string | null }[];
  incidents: { id: string; title: string; state: string; createdAt: string; updatedAt: string }[];
};

export type PatchCheck = { id: string; name: string; variant: "baseline" | "patched"; commandProfile: string; pass: boolean; exitCode: number | null; detail: string | null; startedAt: string; endedAt: string | null; logArtifactId: string | null };

export type PatchSummary = { id: string; attempt: number; origin: "vultr_inference" | "non_ai_harness"; status: string; baseCommitSha: string; changedFiles: string[]; changedFileCount: number; changedLineCount: number; riskLevel: string; riskNotes: string[]; rationale: string | null; guardFailures: string[] | null; sha256: string; previewEvidence: { baseline?: { detail: string }; patched?: { detail: string }; reproduced?: boolean } | null; createdAt: string };

export type RunBrief = { id: string; state: RunState; result: RunResult | null; resultLabel: string | null; summary: string | null; startedAt: string | null; completedAt: string | null; tokenSuffix: string } | null;

export type InvestigationSummary = { id: string; origin: "vultr_inference" | "non_ai_harness"; modelId: string | null; state: string; attempts: number; maxAttempts: number; hypothesis: { hypothesis: string; suspectedFiles: string[]; patchIntent: string; supportingEvidence: { artifactId: string; observation: string }[] } | null; nonCodeCause: string | null; errorCode: string | null; startedAt: string | null; completedAt: string | null; promptTokens: number; completionTokens: number; costEstimateUsd: string | null };

export type IncidentDetail = {
  id: string;
  title: string;
  state: string;
  stateLabel: string;
  version: number;
  siteId: string;
  siteName?: string;
  isControlledFixture: boolean;
  fixtureRepairable: boolean;
  destinationName: string | null;
  causeCategory: string | null;
  humanDiagnosis: { cause: string; whatToCheck: string[] } | null;
  closeReason: string | null;
  publicTrace: boolean;
  repositoryConnected: boolean;
  inferenceConfigured: boolean;
  harnessAvailable: boolean;
  openedByRun: RunBrief;
  recoveryRun: RunBrief;
  relatedRuns: RunBrief[];
  investigations: InvestigationSummary[];
  patches: PatchSummary[];
  currentPatch: (PatchSummary & { checks: PatchCheck[] }) | null;
  transitions: { from: string; to: string; actor: string; reason: string | null; at: string }[];
  deployments: { id: string; trigger: string; environment: string; deploymentRef: string | null; deployedAt: string; webhookVerified: boolean }[];
  createdAt: string;
  updatedAt: string;
};

export type InvestigationEvent = { eventId: string; investigationId: string; sequence: number; timestamp: string; type: string; summary: string; attempt: number | null; safeMetadata?: Record<string, string | number | boolean> };

export type InvestigationDetail = InvestigationSummary & {
  incidentId: string;
  baseCommitSha: string | null;
  events: InvestigationEvent[];
  modelCalls: { id: string; provider: string; modelId: string; requestId: string | null; responseId: string | null; startedAt: string; durationMs: number; promptTokens: number; completionTokens: number; finishReason: string | null; tools: string[] | null; httpStatus: number | null; errorCode: string | null }[];
  toolCalls: { id: string; attempt: number; tool: string; allowed: boolean; reasonCode: string | null; durationMs: number; resultSha256: string | null; at: string }[];
};

export type PatchDetail = PatchSummary & {
  diff: string;
  incidentId: string;
  incidentState?: string;
  checks: PatchCheck[];
  approvals: { id: string; decision: string; reason: string; actorName: string; at: string }[];
  comments: { id: string; body: string; authorName: string | null; at: string }[];
  pullRequests: { url: string; number: number; branch: string; state: string }[];
  canCreatePullRequest: boolean;
  decisionAllowed: boolean;
};
