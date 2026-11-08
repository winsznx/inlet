import { auditEvents, db } from "@inlet/database";
import type { DbExecutor } from "@inlet/database";
import { newId } from "@inlet/domain";

export type AuditInput = {
  organizationId: string | null;
  actorUserId?: string | null;
  entityType: string;
  entityId: string;
  action: string;
  safeMetadata?: Record<string, unknown>;
  ipHash?: string;
};

export async function audit(input: AuditInput, executor: DbExecutor = db()): Promise<void> {
  await executor.insert(auditEvents).values({
    id: newId(),
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? null,
    actorKind: input.actorUserId ? "user" : "system",
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    safeMetadata: input.safeMetadata,
    ipHash: input.ipHash,
  });
}
