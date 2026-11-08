import { describe, expect, it } from "vitest";
import { canStartInvestigation, canTransitionIncident, canTransitionRun, INCIDENT_STATE_LABELS, INCIDENT_STATES, isRunTerminal, RUN_STATES } from "@inlet/domain";
import type { IncidentState, RunState } from "@inlet/domain";

const RUN_ALLOWED: Record<RunState, RunState[]> = {
  queued: ["provisioning", "complete"],
  provisioning: ["opening_form", "complete"],
  opening_form: ["mapping_fields", "complete"],
  mapping_fields: ["submitting", "complete"],
  submitting: ["observing_destination", "complete"],
  observing_destination: ["complete"],
  complete: ["cleanup_complete"],
  cleanup_complete: [],
};

const INCIDENT_ALLOWED: Record<IncidentState, IncidentState[]> = {
  open: ["investigating", "closed"],
  investigating: ["needs_configuration", "repair_unavailable", "patch_proposed", "investigation_failed", "patch_ready", "closed"],
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

describe("run state machine", () => {
  const pairs = RUN_STATES.flatMap((from) => RUN_STATES.map((to) => [from, to, RUN_ALLOWED[from].includes(to)] as const));

  it.each(pairs)("%s -> %s allowed=%s", (from, to, allowed) => {
    expect(canTransitionRun(from, to)).toBe(allowed);
  });

  it("only cleanup_complete is terminal", () => {
    expect(RUN_STATES.filter(isRunTerminal)).toEqual(["cleanup_complete"]);
  });

  it("cannot go back to submitting once observing, so a submission can't repeat", () => {
    expect(canTransitionRun("observing_destination", "submitting")).toBe(false);
    expect(canTransitionRun("complete", "submitting")).toBe(false);
  });
});

describe("incident state machine", () => {
  const pairs = INCIDENT_STATES.flatMap((from) => INCIDENT_STATES.map((to) => [from, to, INCIDENT_ALLOWED[from].includes(to)] as const));

  it.each(pairs)("%s -> %s allowed=%s", (from, to, allowed) => {
    expect(canTransitionIncident(from, to)).toBe(allowed);
  });

  it("no route reaches approved except through awaiting_approval", () => {
    expect(INCIDENT_STATES.filter((state) => canTransitionIncident(state, "approved"))).toEqual(["awaiting_approval"]);
  });

  it("only a recheck can verify recovery", () => {
    expect(INCIDENT_STATES.filter((state) => canTransitionIncident(state, "verified_recovered"))).toEqual(["rechecking"]);
  });

  it("every state has a human label", () => {
    for (const state of INCIDENT_STATES) expect(INCIDENT_STATE_LABELS[state]).toBeTruthy();
  });
});

describe("investigation retry", () => {
  const RETRYABLE: IncidentState[] = ["open", "needs_configuration", "repair_unavailable", "investigation_failed", "patch_failed", "rejected", "still_failing"];

  it.each(INCIDENT_STATES.map((state) => [state, RETRYABLE.includes(state)] as const))("%s can start investigation=%s", (state, expected) => {
    expect(canStartInvestigation(state)).toBe(expected);
  });

  it("every retryable state has a real transition into investigating", () => {
    for (const state of RETRYABLE) expect(canTransitionIncident(state, "investigating")).toBe(true);
  });

  it("refuses a concurrent retry while an investigation is already running", () => {
    expect(canStartInvestigation("investigating")).toBe(false);
    expect(canTransitionIncident("investigating", "investigating")).toBe(false);
  });
});
