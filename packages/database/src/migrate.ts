import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, db } from "./index";

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle");

await migrate(db(), { migrationsFolder });
console.log("Migrations applied.");
await closeDb();
