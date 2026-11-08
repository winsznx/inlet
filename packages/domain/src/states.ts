export const RUN_STATES = [
  "queued",
  "provisioning",
  "opening_form",
  "mapping_fields",
  "submitting",
  "observing_destination",
  "complete",
  "cleanup_complete",
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const RUN_RESULTS = [
  "received",
  "not_received",
  "unverified",
  "browser_failed",
  "canceled",
  "expired",
  "blocked",
  "containment_failed",
] as const;
export type RunResult = (typeof RUN_RESULTS)[number];

export const RUN_TRIGGERS = ["manual", "schedule", "first_check", "recheck", "demo", "lab"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const RUN_KINDS = ["delivery", "containment"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

const runFlow: Record<RunState, RunState[]> = {
  queued: ["provisioning", "complete"],
  provisioning: ["opening_form", "complete"],
  opening_form: ["mapping_fields", "complete"],
  mapping_fields: ["submitting", "complete"],
  submitting: ["observing_destination", "complete"],
  observing_destination: ["complete"],
  complete: ["cleanup_complete"],
  cleanup_complete: [],
};

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return runFlow[from].includes(to);
}

export function isRunTerminal(state: RunState): boolean {
  return state === "cleanup_complete";
}

export const INCIDENT_STATES = [
  "open",
  "investigating",
  "needs_configuration",
  "repair_unavailable",
  "patch_proposed",
  "investigation_failed",
  "patch_testing",
  "patch_ready",
  "patch_failed",
  "awaiting_approval",
  "approved",
  "rejected",
  "awaiting_deployment",
  "rechecking",
  "verified_recovered",
  "still_failing",
  "closed",
] as const;
export type IncidentState = (typeof INCIDENT_STATES)[number];

const investigationRetryable: IncidentState[] = [
  "needs_configuration",
  "repair_unavailable",
  "investigation_failed",
  "patch_failed",
  "rejected",
  "still_failing",
  "open",
];

const incidentFlow: Record<IncidentState, IncidentState[]> = {
  open: ["investigating", "closed"],
  investigating: [
    "needs_configuration",
    "repair_unavailable",
    "patch_proposed",
    "investigation_failed",
    "patch_ready",
    "closed",
  ],
  needs_configuration: ["investigating", "closed"],
  repair_unavailable: ["investigating", "closed"],
  patch_proposed: ["patch_testing", "investigation_failed", "closed"],
  investigation_failed: ["investigating", "closed"],
  patch_testing: ["patch_ready", "patch_failed", "investigation_failed", "closed"],
  patch_ready: ["awaiting_approval", "closed"],
  patch_failed: ["investigating", "patch_proposed", "investigation_failed", "closed"],
  awaiting_approval: ["approved", "rejected", "closed"],
  approved: ["awaiting_deployment", "closed"],
  rejected: ["investigating", "closed"],
  awaiting_deployment: ["rechecking", "closed"],
  rechecking: ["verified_recovered", "still_failing", "closed"],
  verified_recovered: ["closed"],
  still_failing: ["investigating", "rechecking", "awaiting_deployment", "closed"],
  closed: ["open"],
};

export function canTransitionIncident(from: IncidentState, to: IncidentState): boolean {
  return incidentFlow[from].includes(to);
}

export function canStartInvestigation(state: IncidentState): boolean {
  return investigationRetryable.includes(state);
}

export const INCIDENT_STATE_LABELS: Record<IncidentState, string> = {
  open: "Open",
  investigating: "Investigating",
  needs_configuration: "Needs configuration",
  repair_unavailable: "No code repair available",
  patch_proposed: "Investigating",
  investigation_failed: "Investigation interrupted",
  patch_testing: "Investigating",
  patch_ready: "Patch ready",
  patch_failed: "Patch did not pass checks",
  awaiting_approval: "Awaiting approval",
  approved: "Awaiting deployment",
  rejected: "Patch rejected",
  awaiting_deployment: "Awaiting deployment",
  rechecking: "Rechecking",
  verified_recovered: "Verified recovered",
  still_failing: "Still failing",
  closed: "Closed without repair",
};

export const RUN_RESULT_LABELS: Record<RunResult, string> = {
  received: "Received",
  not_received: "Not received",
  unverified: "Unverified",
  browser_failed: "Browser failed",
  canceled: "Canceled",
  expired: "Expired",
  blocked: "Blocked",
  containment_failed: "Containment failed",
};

export const ROLES = ["owner", "admin", "maintainer", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | "evidence:view"
  | "site:edit"
  | "run:start"
  | "investigation:start"
  | "patch:decide"
  | "secret:manage"
  | "member:manage"
  | "workspace:delete"
  | "policy:view";

const grants: Record<Role, Permission[]> = {
  owner: [
    "evidence:view",
    "site:edit",
    "run:start",
    "investigation:start",
    "patch:decide",
    "secret:manage",
    "member:manage",
    "workspace:delete",
    "policy:view",
  ],
  admin: [
    "evidence:view",
    "site:edit",
    "run:start",
    "investigation:start",
    "patch:decide",
    "secret:manage",
    "member:manage",
    "policy:view",
  ],
  maintainer: ["evidence:view", "site:edit", "run:start", "investigation:start"],
  viewer: ["evidence:view"],
};

export function can(role: Role, permission: Permission, options?: { maintainerMayApprove?: boolean }): boolean {
  if (permission === "patch:decide" && role === "maintainer") {
    return options?.maintainerMayApprove === true;
  }
  return grants[role].includes(permission);
}
