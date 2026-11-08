import { Redis } from "ioredis";
import { env } from "@inlet/config";

let publisher: Redis | undefined;

export function redisConnection(): Redis {
  return new Redis(env().REDIS_URL, { maxRetriesPerRequest: null });
}

function client(): Redis {
  publisher ??= redisConnection();
  return publisher;
}

export function runChannel(runId: string): string {
  return `inlet:run:${runId}`;
}

export function investigationChannel(id: string): string {
  return `inlet:investigation:${id}`;
}

export function publish(channel: string, sequence: number): void {
  client()
    .publish(channel, String(sequence))
    .catch(() => undefined);
}

export async function redisHealthy(): Promise<boolean> {
  try {
    return (await client().ping()) === "PONG";
  } catch {
    return false;
  }
}

export async function closeRealtime(): Promise<void> {
  await publisher?.quit().catch(() => undefined);
  publisher = undefined;
}
