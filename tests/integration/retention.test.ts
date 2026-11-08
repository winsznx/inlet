import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { artifactRoot } from "@inlet/config";
import { checkRuns, closeDb, db, eq, runArtifacts } from "@inlet/database";
import { newId } from "@inlet/domain";
import { objectKey, putObject } from "@inlet/evidence";
import { retentionTick } from "../../apps/worker/src/processors/maintenance";
import { createSite, mapForm, registerOwner, startRun, waitForRun } from "../support/api";

afterAll(async () => {
  await closeDb();
});

describe("evidence retention", () => {
  it("deletes expired evidence and keeps the record of deletion", async () => {
    // #given
    const owner = await registerOwner("retention-owner");
    const siteId = await createSite(owner, "Retention site");
    await owner.client.ok("POST", `/sites/${siteId}/destinations`, { body: { type: "mailpit" } });
    await mapForm(owner, siteId);
    const { runId } = (await startRun(owner.client, siteId)).json<{ runId: string }>();
    await waitForRun(owner.client, runId);
    const [run] = await db().select().from(checkRuns).where(eq(checkRuns.id, runId));
    const id = newId();
    const key = objectKey(run?.organizationId ?? "", runId, `${id}-expired.txt`);
    const stored = await putObject(key, "expired evidence");
    await db().insert(runArtifacts).values({ id, organizationId: run?.organizationId ?? "", runId, kind: "log", objectKey: key, sha256: stored.sha256, sizeBytes: stored.sizeBytes, mime: "text/plain", expiresAt: new Date(Date.now() - 1000) });
    // #when
    await retentionTick();
    const [row] = await db().select().from(runArtifacts).where(eq(runArtifacts.id, id));
    // #then
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect(existsSync(join(artifactRoot(), key))).toBe(false);
  }, 120_000);
});
