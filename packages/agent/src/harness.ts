import type { ToolHost } from "./loop";
import type { LoopResult } from "./loop";

export const NON_AI_HARNESS_ID = "non-ai-test-harness";

const REQUIRED = ["typecheck", "lint", "unit", "build"] as const;

export async function runNonAiHarness(host: ToolHost): Promise<LoopResult> {
  await host.execute("inspect_run", {});
  await host.execute("search_repository_paths", { query: "ENQUIRY_NOTIFY" });
  await host.execute("inspect_repository_file", { path: "src/lib/settings.ts" });

  const proposal = await host.execute("propose_patch", {
    hypothesis: "Non-AI test harness: applies the known correction for the controlled fault-injection fixture. No model was used.",
    supportingEvidence: [],
    suspectedFiles: ["src/lib/settings.ts"],
    patchIntent: "Read the recipient from the setting the deployment provides.",
    edits: [{ path: "src/lib/settings.ts", oldText: "env.ENQUIRY_NOTIFY_EMAIL", newText: "env.ENQUIRY_NOTIFY_ADDRESS" }],
  });
  if (!proposal.ok) return { status: "model_stopped", detail: "The harness patch was rejected by the guard." };

  for (const check of REQUIRED) {
    const result = await host.execute("run_allowed_check", { check });
    if (!result.ok) return { status: "model_stopped", detail: `${check} failed under the harness.` };
  }
  const preview = await host.execute("request_browser_preview", {});
  if (!preview.ok) return { status: "model_stopped", detail: "The preview did not deliver under the harness." };

  const final = await host.execute("finalize_proposal", {
    summary: "Non-AI test harness result. The known correction passed every required check and the preview delivered.",
    riskNotes: ["Produced by the non-AI test harness for the controlled fixture. No model was used."],
  });
  return final.terminal ? { status: final.terminal.kind } : { status: "model_stopped", detail: "The harness could not finalize." };
}
