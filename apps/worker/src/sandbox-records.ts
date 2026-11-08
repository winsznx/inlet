import { db, eq, policyDecisions, sandboxSessions, sql } from "@inlet/database";
import { newId } from "@inlet/domain";
import { sha256 } from "@inlet/evidence";
import type { EgressDecision, ExitInfo, SandboxHandle, SandboxSpec } from "@inlet/sandbox";
import { sandboxProvider } from "./context";

export type SandboxOwner = { organizationId: string; runId?: string; investigationId?: string };

export async function reserveSandboxSession(owner: SandboxOwner, spec: Omit<SandboxSpec, "sessionId">): Promise<string> {
  const id = newId();
  const policy = spec.network.mode === "egress" ? { mode: "egress-gateway", allow: spec.network.allow } : { mode: spec.network.mode };
  await db().insert(sandboxSessions).values({
    id,
    organizationId: owner.organizationId,
    runId: owner.runId,
    investigationId: owner.investigationId,
    role: spec.role,
    provider: sandboxProvider().name,
    ociRuntime: sandboxProvider().ociRuntime,
    containerName: `inlet-sbx-${id}`,
    cpuLimit: String(spec.cpus),
    memoryLimitMb: spec.memoryMb,
    pidsLimit: spec.pids,
    wallLimitSeconds: spec.wallSeconds,
    networkPolicyHash: sha256(JSON.stringify(policy)),
    networkPolicy: policy,
  });
  return id;
}

export async function recordSandboxStarted(handle: SandboxHandle): Promise<void> {
  await db()
    .update(sandboxSessions)
    .set({
      containerId: handle.containerId,
      runtimeImageDigest: handle.imageDigest,
      hardening: [...handle.hardening],
      networkPolicy: handle.policy,
      networkPolicyHash: handle.policyHash,
      startedAt: new Date(),
    })
    .where(eq(sandboxSessions.id, handle.sessionId));
}

export async function recordSandboxExit(sessionId: string, exit: ExitInfo): Promise<void> {
  await db()
    .update(sandboxSessions)
    .set({ stoppedAt: new Date(), exitCode: exit.exitCode, exitReason: exit.reason, oomKilled: exit.oomKilled })
    .where(eq(sandboxSessions.id, sessionId));
}

export async function recordEgressDecisions(sessionId: string, decisions: EgressDecision[]): Promise<number> {
  if (decisions.length === 0) return 0;
  await db().insert(policyDecisions).values(
    decisions.map((decision) => ({
      id: newId(),
      sandboxId: sessionId,
      layer: "egress_gateway" as const,
      actionType: decision.action === "connect" ? "network.connect" : "network.http",
      actionTargetRedacted: `${decision.target}${decision.path ?? ""}`,
      allowed: decision.allowed,
      reasonCode: decision.reason,
      timestamp: new Date(decision.at),
    })),
  );
  const denied = decisions.filter((decision) => !decision.allowed).length;
  if (denied > 0) {
    await db()
      .update(sandboxSessions)
      .set({ denialCount: sql`${sandboxSessions.denialCount} + ${denied}` })
      .where(eq(sandboxSessions.id, sessionId));
  }
  return denied;
}

export async function destroySandboxByName(sessionId: string, containerName: string): Promise<boolean> {
  const verified = await sandboxProvider()
    .forceRemove(containerName)
    .catch(() => false);
  await db()
    .update(sandboxSessions)
    .set({
      cleanupVerified: verified,
      cleanupVerifiedAt: verified ? new Date() : null,
      cleanupAttempts: sql`${sandboxSessions.cleanupAttempts} + 1`,
      cleanupError: verified ? null : "Container still present after removal",
      stoppedAt: sql`coalesce(${sandboxSessions.stoppedAt}, now())`,
    })
    .where(eq(sandboxSessions.id, sessionId));
  return verified;
}

export async function destroySandbox(handle: SandboxHandle): Promise<boolean> {
  const decisions = await handle.drainEgressDecisions().catch(() => []);
  await recordEgressDecisions(handle.sessionId, decisions);
  const outcome = await handle.destroy();
  await db()
    .update(sandboxSessions)
    .set({
      cleanupVerified: outcome.verified,
      cleanupVerifiedAt: outcome.verified ? new Date() : null,
      cleanupAttempts: sql`${sandboxSessions.cleanupAttempts} + ${outcome.attempts}`,
      cleanupError: outcome.error ?? null,
      stoppedAt: sql`coalesce(${sandboxSessions.stoppedAt}, now())`,
    })
    .where(eq(sandboxSessions.id, handle.sessionId));
  return outcome.verified;
}
