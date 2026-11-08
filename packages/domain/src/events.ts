export const RUN_EVENT_TYPES = [
  "run.queued",
  "sandbox.started",
  "browser.opened",
  "form.mapped",
  "form.submitting",
  "form.submitted",
  "form.success_ui",
  "destination.polling",
  "destination.matched",
  "destination.timed_out",
  "destination.unavailable",
  "run.inconclusive",
  "run.browser_failed",
  "run.canceled",
  "run.interrupted",
  "policy.denied",
  "policy.allowed",
  "containment.probe",
  "sandbox.limit",
  "sandbox.destroyed",
  "sandbox.cleanup_failed",
  "run.completed",
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export type RunEventView = {
  eventId: string;
  runId: string;
  sequence: number;
  timestamp: string;
  type: RunEventType;
  stage: string;
  summary: string;
  artifactIds?: string[];
  safeMetadata?: Record<string, string | number | boolean>;
};

export const INVESTIGATION_EVENT_TYPES = [
  "investigation.started",
  "tool.read_submission",
  "tool.checked_destination",
  "tool.searched_repository",
  "tool.read_file",
  "tool.denied",
  "patch.candidate_created",
  "patch.candidate_rejected",
  "check.started",
  "check.finished",
  "preview.started",
  "preview.finished",
  "attempt.failed",
  "attempt.retry",
  "investigation.non_code_cause",
  "investigation.patch_ready",
  "investigation.failed",
  "sandbox.started",
  "sandbox.destroyed",
  "model.call",
] as const;
export type InvestigationEventType = (typeof INVESTIGATION_EVENT_TYPES)[number];

export type InvestigationEventView = {
  eventId: string;
  investigationId: string;
  sequence: number;
  timestamp: string;
  type: InvestigationEventType;
  summary: string;
  attempt: number | null;
  safeMetadata?: Record<string, string | number | boolean>;
};
