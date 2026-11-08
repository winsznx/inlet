import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { redisConnection } from "@inlet/control";

type Listener = () => void;

let subscriber: Redis | undefined;
const listeners = new Map<string, Set<Listener>>();

function getSubscriber(): Redis {
  if (subscriber) return subscriber;
  subscriber = redisConnection();
  subscriber.on("message", (channel: string) => {
    listeners.get(channel)?.forEach((listener) => listener());
  });
  return subscriber;
}

function subscribe(channel: string, listener: Listener): () => void {
  const existing = listeners.get(channel);
  if (existing) {
    existing.add(listener);
  } else {
    listeners.set(channel, new Set([listener]));
    void getSubscriber().subscribe(channel);
  }
  return () => {
    const set = listeners.get(channel);
    set?.delete(listener);
    if (set?.size === 0) {
      listeners.delete(channel);
      void getSubscriber().unsubscribe(channel);
    }
  };
}

export type SseSource<T extends { sequence: number }> = {
  channel: string;
  load: (afterSequence: number) => Promise<T[]>;
  isFinished: () => Promise<boolean>;
};

export function lastEventId(request: FastifyRequest): number {
  const header = request.headers["last-event-id"];
  const query = (request.query as { after?: string }).after;
  const value = Number(Array.isArray(header) ? header[0] : (header ?? query ?? 0));
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export async function streamEvents<T extends { sequence: number }>(request: FastifyRequest, reply: FastifyReply, source: SseSource<T>): Promise<void> {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "x-request-id": request.id,
  });
  raw.flushHeaders();

  let cursor = lastEventId(request);
  let closed = false;
  let pumping = false;
  let again = false;

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    clearInterval(poll);
    unsubscribe();
    raw.end();
  };

  const pump = async () => {
    if (closed) return;
    if (pumping) {
      again = true;
      return;
    }
    pumping = true;
    try {
      const events = await source.load(cursor);
      for (const event of events) {
        raw.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
        cursor = event.sequence;
      }
      if (events.length === 0 && (await source.isFinished())) {
        raw.write("event: end\ndata: {}\n\n");
        close();
      }
    } catch (error) {
      request.log.error({ err: error }, "sse pump failed");
      close();
    } finally {
      pumping = false;
      if (again) {
        again = false;
        void pump();
      }
    }
  };

  const unsubscribe = subscribe(source.channel, () => void pump());
  const keepAlive = setInterval(() => raw.write(": keep-alive\n\n"), 15_000);
  const poll = setInterval(() => void pump(), 2_000);
  request.raw.on("close", close);
  await pump();
}
