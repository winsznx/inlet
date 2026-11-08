import { z } from "zod";

export const AGENT_TOOL_NAMES = [
  "inspect_run",
  "search_repository_paths",
  "inspect_repository_file",
  "propose_patch",
  "run_allowed_check",
  "request_browser_preview",
  "read_check_result",
  "finalize_proposal",
] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export function isAllowedTool(name: string): name is AgentToolName {
  return (AGENT_TOOL_NAMES as readonly string[]).includes(name);
}

export type NavigationDecision = { allowed: true } | { allowed: false; reasonCode: "origin_not_verified" | "invalid_url" };

export function evaluateNavigation(target: string, verifiedOrigins: readonly string[]): NavigationDecision {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { allowed: false, reasonCode: "invalid_url" };
  }
  return verifiedOrigins.includes(url.origin) ? { allowed: true } : { allowed: false, reasonCode: "origin_not_verified" };
}

export const TOOL_CALL_BUDGET = { perAttempt: 24, modelCallsPerInvestigation: 40, maxPromptTokens: 400_000 } as const;
export const TOOL_RESULT_LIMIT_BYTES = 24_000;

export const nonCodeCauseSchema = z.enum(["smtp_credentials", "dns", "provider_rule", "missing_access", "unknown"]);
export type NonCodeCause = z.infer<typeof nonCodeCauseSchema>;
