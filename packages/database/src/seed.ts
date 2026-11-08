import { hash } from "@node-rs/argon2";
import { env } from "@inlet/config";
import { newId } from "@inlet/domain";
import { closeDb, db, eq, memberships, organizations, users } from "./index";

export const DEV_ACCOUNT = { email: "dev@inlet.test", password: "inlet-local-dev", name: "Local Developer" };
export const DEMO_OWNER_EMAIL = "demo-system@inlet.invalid";

async function ensureUser(email: string, name: string, password: string): Promise<string> {
  const [existing] = await db().select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) return existing.id;
  const id = newId();
  await db().insert(users).values({ id, email, name, passwordHash: await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 }), emailVerifiedAt: new Date() });
  return id;
}

async function ensureDemoOrganization(ownerId: string): Promise<void> {
  const [existing] = await db().select({ id: organizations.id }).from(organizations).where(eq(organizations.isDemo, true));
  if (existing) return;
  const id = newId();
  await db().insert(organizations).values({ id, name: "Inlet controlled demo", ownerUserId: ownerId, isDemo: true, retentionDays: 7 });
  await db().insert(memberships).values({ id: newId(), organizationId: id, userId: ownerId, role: "owner", inviteAcceptedAt: new Date() });
}

const demoOwner = await ensureUser(DEMO_OWNER_EMAIL, "Controlled demo", newId() + newId());
await ensureDemoOrganization(demoOwner);

if (env().NODE_ENV === "development") {
  await ensureUser(DEV_ACCOUNT.email, DEV_ACCOUNT.name, DEV_ACCOUNT.password);
  console.log(`Local account: ${DEV_ACCOUNT.email} / ${DEV_ACCOUNT.password} (development only)`);
}
console.log("Seed complete. Fixture records are created from real connections, not pre-populated results.");
await closeDb();
