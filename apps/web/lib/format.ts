import { RUN_RESULT_LABELS } from "@inlet/domain/states";
import type { RunResult, RunState } from "@inlet/domain/states";
import type { StatusTone } from "@inlet/ui";

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "Not yet";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function formatClock(value: string | Date | null | undefined): string {
  if (!value) return "";
  return `${new Date(value).toISOString().slice(11, 19)} UTC`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "Not finished";
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 90) return `${seconds.toFixed(1)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

export function resultTone(result: RunResult | null | undefined): StatusTone {
  switch (result) {
    case "received":
    case "blocked":
      return "success";
    case "not_received":
    case "containment_failed":
      return "danger";
    case "unverified":
    case "browser_failed":
    case "expired":
      return "warning";
    default:
      return "neutral";
  }
}

export function resultLabel(result: RunResult | null | undefined, state?: RunState): string {
  if (result) return RUN_RESULT_LABELS[result];
  return state && state !== "cleanup_complete" ? "Running" : "Not yet checked";
}

export const INCIDENT_TONES: Record<string, StatusTone> = {
  verified_recovered: "success",
  patch_ready: "success",
  awaiting_approval: "warning",
  awaiting_deployment: "warning",
  approved: "warning",
  rechecking: "running",
  investigating: "running",
  patch_proposed: "running",
  patch_testing: "running",
  needs_configuration: "warning",
  repair_unavailable: "warning",
  investigation_failed: "warning",
  patch_failed: "danger",
  still_failing: "danger",
  open: "danger",
  rejected: "neutral",
  closed: "neutral",
};

export function shortId(id: string): string {
  return id.slice(-8);
}
