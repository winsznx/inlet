import { env } from "@inlet/config";
import { closeDb } from "@inlet/database";
import { buildApp } from "./app";

const app = await buildApp();
await app.listen({ port: env().API_PORT, host: "0.0.0.0" });

async function shutdown(): Promise<void> {
  await app.close();
  await closeDb();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
