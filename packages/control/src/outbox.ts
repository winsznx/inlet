import { db, outboxEvents } from "@inlet/database";
import type { DbExecutor } from "@inlet/database";
import { newId } from "@inlet/domain";

export const JOB_TYPES = [
  "site-check",
  "delivery-verify",
  "investigation",
  "notifications",
  "field-discovery",
  "fixture-deploy",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export async function enqueue(
  type: JobType,
  aggregateId: string,
  payload: Record<string, unknown>,
  executor: DbExecutor = db(),
  readyAt?: Date,
): Promise<void> {
  await executor.insert(outboxEvents).values({ id: newId(), aggregateId, type, payload, readyAt: readyAt ?? new Date() });
}
