import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkRuns, closeDb, db, eq, investigations, patches } from "@inlet/database";
import { newId } from "@inlet/domain";
import type { ApiClient, RunDetail } from "../support/api";
import { createSite, inviteAndRegister, mailpitSearch, mapForm, randomId, readSse, registerOwner, startRun, waitForRun } from "../support/api";

type Owner = Awaited<ReturnType<typeof registerOwner>>;

let owner: Owner;
let otherOwner: Owner;
let viewer: { client: ApiClient };

beforeAll(async () => {
  owner = await registerOwner("runs-owner");
  otherOwner = await registerOwner("runs-other");
  viewer = await inviteAndRegister(owner, "viewer", "runs-viewer");
});

afterAll(async () => {
  await closeDb();
});

describe("idempotent POST /sites/:id/runs", () => {
  const key = `idem-${randomUUID()}`;
  let siteId: string;
  let runId: string;
  let run: RunDetail;
  let responses: { status: number; runId: string; statusUrl: string; eventsUrl: string }[];

  beforeAll(async () => {
    siteId = await createSite(owner, "Idempotent site");
    await owner.client.ok("POST", `/sites/${siteId}/destinations`, { body: { type: "mailpit" } });
    await mapForm(owner, siteId);
    const pair = await Promise.all([startRun(owner.client, siteId, key), startRun(owner.client, siteId, key)]);
    responses = pair.map((response) => ({ status: response.status, ...response.json<{ runId: string; statusUrl: string; eventsUrl: string }>() }));
    runId = responses[0]?.runId ?? "";
    run = await waitForRun(owner.client, runId);
  });

  it("answers both concurrent requests with 202 and the same run", () => {
    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    expect(responses[1]?.runId).toBe(runId);
    expect(responses[0]?.statusUrl).toBe(`/api/v1/runs/${runId}`);
    expect(responses[0]?.eventsUrl).toBe(`/api/v1/runs/${runId}/events`);
  });

  it("returns the same run for a later retry with the same key", async () => {
    const replay = await startRun(owner.client, siteId, key);
    expect(replay.status).toBe(202);
    expect(replay.json<{ runId: string }>().runId).toBe(runId);
  });

  it("created exactly one run for the site", async () => {
    const list = await owner.client.ok<{ runs: { runId: string }[] }>("GET", `/runs?siteId=${siteId}`);
    expect(list.runs.map((item) => item.runId)).toEqual([runId]);
  });

  it("delivered a real, single message to the inbox", async () => {
    expect(run.result).toBe("received");
    expect(run.delivery).toMatchObject({ status: "found", correlatedReceiptFound: true });
    expect(run.testToken).toMatch(/^INLET-TEST-[0-9a-f]{32}$/);
    expect((await mailpitSearch(`"${run.testToken}"`)).count).toBe(1);
  });

  it("submitted the form once", () => {
    expect(run.events.filter((event) => event.type === "form.submitted")).toHaveLength(1);
    expect(run.browser).toMatchObject({ submitClicked: true, submissionObserved: true, successUiObserved: true });
  });

  it("stores no secret material in the run response", async () => {
    const response = await owner.client.request("GET", `/runs/${runId}`);
    const [stored] = await db().select().from(checkRuns).where(eq(checkRuns.id, runId));
    expect(response.text).not.toContain("testTokenEncrypted");
    expect(response.text).not.toContain("testTokenHash");
    expect(response.text).not.toContain(stored?.testTokenEncrypted);
    expect(response.text).not.toContain(stored?.testTokenHash);
  });

  describe("SSE replay", () => {
    const eventsPath = () => `/runs/${runId}/events`;
    const data = (frames: Awaited<ReturnType<typeof readSse>>) => frames.filter((frame) => frame.event === null).map((frame) => JSON.parse(frame.data) as { sequence: number; eventId: string });

    it("replays every event in order and then ends", async () => {
      const frames = await readSse(owner.client, eventsPath());
      const sequences = data(frames).map((event) => event.sequence);
      expect(sequences).toEqual(run.events.map((event) => event.sequence));
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
      expect(new Set(sequences).size).toBe(sequences.length);
      expect(frames.at(-1)?.event).toBe("end");
      expect(frames.filter((frame) => frame.event === null).every((frame) => frame.id === JSON.parse(frame.data).sequence)).toBe(true);
    });

    it("resumes after Last-Event-ID without repeating anything", async () => {
      const cutoff = run.events[Math.floor(run.events.length / 2)]?.sequence ?? 0;
      const resumed = data(await readSse(owner.client, eventsPath(), { "last-event-id": String(cutoff) }));
      expect(resumed.map((event) => event.sequence)).toEqual(run.events.filter((event) => event.sequence > cutoff).map((event) => event.sequence));
    });

    it("joins a disconnected reader back up with no gaps or duplicates", async () => {
      const firstFrames = data(await readSse(owner.client, eventsPath()));
      const cutoff = firstFrames[2]?.sequence ?? 0;
      const before = firstFrames.filter((event) => event.sequence <= cutoff);
      const after = data(await readSse(owner.client, eventsPath(), { "last-event-id": String(cutoff) }));
      expect([...before, ...after].map((event) => event.eventId)).toEqual(run.events.map((event) => event.eventId));
    });

    it("sends only the end frame when already caught up", async () => {
      const last = run.events.at(-1)?.sequence ?? 0;
      const frames = await readSse(owner.client, eventsPath(), { "last-event-id": String(last) });
      expect(frames.map((frame) => frame.event)).toEqual(["end"]);
    });
  });
});

describe("destination down", () => {
  let run: RunDetail;
  let siteId: string;

  // Stopping the shared Mailpit container would break other tests and processes. An IMAP destination on a port nothing
  // listens on puts the verifier in the same state as the PRD's "stop Mailpit API" case: the form really submits, and
  // the destination cannot be queried.
  beforeAll(async () => {
    siteId = await createSite(owner, "Destination down site");
    await owner.client.ok("POST", `/sites/${siteId}/destinations`, { body: { type: "imap", displayName: "Unreachable mailbox", host: "127.0.0.1", port: 1, user: "nobody@example.test", password: "not-a-real-password" } });
    await mapForm(owner, siteId);
    const { runId } = (await startRun(owner.client, siteId)).json<{ runId: string }>();
    run = await waitForRun(owner.client, runId);
  });

  it("is unverified, neither a false failure nor a false pass", () => {
    expect(run.result).toBe("unverified");
    expect(run.browser?.submissionObserved).toBe(true);
    expect(run.delivery).toMatchObject({ status: "unavailable", correlatedReceiptFound: false, accessible: false, errorCode: "destination_unreachable" });
  });

  it("records the outage and opens no incident", async () => {
    expect(run.events.map((event) => event.type)).toContain("destination.unavailable");
    expect(run.events.map((event) => event.type)).not.toContain("destination.timed_out");
    expect(run.incidentId).toBeNull();
    const { incidents } = await owner.client.ok<{ incidents: unknown[] }>("GET", `/incidents?siteId=${siteId}`);
    expect(incidents).toEqual([]);
  });
});

describe("bad selector", () => {
  let run: RunDetail;
  let siteId: string;

  beforeAll(async () => {
    siteId = await createSite(owner, "Bad selector site");
    await owner.client.ok("POST", `/sites/${siteId}/destinations`, { body: { type: "mailpit" } });
    await mapForm(owner, siteId, { name: "#this-field-does-not-exist" });
    const { runId } = (await startRun(owner.client, siteId)).json<{ runId: string }>();
    run = await waitForRun(owner.client, runId);
  });

  it("ends as browser_failed with the selector problem", () => {
    expect(run.result).toBe("browser_failed");
    expect(run.browser).toMatchObject({ submitClicked: false, failure: "field_not_found" });
    expect(run.browser?.failureDetail).toContain("#this-field-does-not-exist");
  });

  it("never claims a delivery or starts looking for one", () => {
    expect(run.delivery).toMatchObject({ status: null, correlatedReceiptFound: false });
    expect(run.events.map((event) => event.type)).not.toContain("form.submitted");
    expect(run.events.map((event) => event.type)).not.toContain("destination.matched");
  });

  it("opens no incident", async () => {
    expect(run.incidentId).toBeNull();
    const { incidents } = await owner.client.ok<{ incidents: unknown[] }>("GET", `/incidents?siteId=${siteId}`);
    expect(incidents).toEqual([]);
  });
});

describe("silent non-delivery", () => {
  let run: RunDetail;
  let siteId: string;
  let incidentId: string;
  let patchId: string;
  let investigationId: string;
  let artifactId: string;
  let downloadUrl: string;

  // The webhook destination never receives anything, which gives a real not_received incident on the healthy fixture
  // without depending on whether another process has repaired the broken sample site.
  beforeAll(async () => {
    siteId = await createSite(owner, "Silent failure site");
    await owner.client.ok("POST", `/sites/${siteId}/destinations`, { body: { type: "webhook", displayName: "Quiet webhook" } });
    await mapForm(owner, siteId);
    const { runId } = (await startRun(owner.client, siteId)).json<{ runId: string }>();
    run = await waitForRun(owner.client, runId);
    incidentId = run.incidentId ?? "";

    // A real patch takes a multi-minute repair run. These rows only give the access-control tests below an ID that
    // exists in the other organization; nothing here asserts on a pre-populated success.
    investigationId = newId();
    patchId = newId();
    await db().insert(investigations).values({ id: investigationId, organizationId: owner.organizationId, incidentId, origin: "non_ai_harness", promptVersion: "access-control-test-row" });
    await db().insert(patches).values({ id: patchId, organizationId: owner.organizationId, incidentId, investigationId, attempt: 1, origin: "non_ai_harness", baseCommitSha: "0".repeat(40), diffText: "", changedFiles: [], changedFileCount: 0, changedLineCount: 0, sha256: "0".repeat(64) });

    const { artifacts } = await owner.client.ok<{ artifacts: { id: string; downloadUrl: string }[] }>("GET", `/runs/${run.runId}/artifacts`);
    artifactId = artifacts[0]?.id ?? "";
    downloadUrl = artifacts[0]?.downloadUrl ?? "";
  });

  it("is not_received and opens an incident", async () => {
    expect(run.result).toBe("not_received");
    expect(run.delivery).toMatchObject({ status: "not_found", correlatedReceiptFound: false, accessible: true });
    expect(run.browser).toMatchObject({ submissionObserved: true, successUiObserved: true });
    expect(run.events.map((event) => event.type)).toContain("destination.timed_out");
    expect(incidentId).not.toBe("");
    const incident = await owner.client.ok<{ state: string; siteId: string; openedByRun: { id: string } }>("GET", `/incidents/${incidentId}`);
    expect(incident).toMatchObject({ state: "open", siteId, openedByRun: { id: run.runId } });
  });

  describe("viewer role", () => {
    it("sees the run with the token masked", async () => {
      const seen = await viewer.client.ok<RunDetail>("GET", `/runs/${run.runId}`);
      expect(seen.testToken).toMatch(/^INLET-TEST-••••[0-9a-f]{4}$/);
      expect(seen.result).toBe("not_received");
    });

    it("cannot start a check", async () => {
      const response = await startRun(viewer.client, siteId);
      expect(response.status).toBe(403);
      expect(response.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
      const list = await owner.client.ok<{ runs: unknown[] }>("GET", `/runs?siteId=${siteId}`);
      expect(list.runs).toHaveLength(1);
    });

    it("cannot approve or reject a patch", async () => {
      const decision = { body: { reason: "viewer should not be able to do this", riskAcknowledged: true } };
      for (const action of ["approve", "reject"]) {
        const response = await viewer.client.request("POST", `/patches/${patchId}/${action}`, decision);
        expect(response.status).toBe(403);
      }
      const patch = await owner.client.ok<{ status: string; approvals: unknown[] }>("GET", `/patches/${patchId}`);
      expect(patch).toMatchObject({ status: "proposed", approvals: [] });
    });

    it("cannot start an investigation", async () => {
      expect((await viewer.client.request("POST", `/incidents/${incidentId}/investigations`, { body: { mode: "non_ai_harness" } })).status).toBe(403);
    });

    it("cannot edit sites or destinations", async () => {
      expect((await viewer.client.request("PATCH", `/sites/${siteId}`, { body: { name: "Renamed by viewer" } })).status).toBe(403);
      expect((await viewer.client.request("POST", `/sites/${siteId}/destinations`, { body: { type: "mailpit" } })).status).toBe(403);
    });
  });

  describe("cross-organization access", () => {
    const paths = () => [
      ["GET", `/runs/${run.runId}`],
      ["GET", `/runs/${run.runId}/artifacts`],
      ["GET", `/runs/${run.runId}/evidence.zip`],
      ["GET", `/runs/${run.runId}/events`],
      ["GET", `/artifacts/${artifactId}/download`],
      ["GET", `/incidents/${incidentId}`],
      ["GET", `/incidents/${incidentId}/patches`],
      ["GET", `/investigations/${investigationId}`],
      ["GET", `/investigations/${investigationId}/events`],
      ["GET", `/patches/${patchId}`],
      ["GET", `/patches/${patchId}/diff`],
      ["GET", `/sites/${siteId}`],
      ["GET", `/sites/${siteId}/destinations`],
      ["GET", `/sites/${siteId}/form-config`],
      ["GET", `/organizations/${owner.organizationId}`],
    ] as const;

    it("the owning organization can read every target", async () => {
      for (const [method, path] of paths()) {
        if (path.endsWith("/events")) continue;
        const response = await owner.client.request(method, path);
        expect([path, response.status]).toEqual([path, 200]);
      }
    });

    it("another organization gets 404 on every read", async () => {
      for (const [method, path] of paths()) {
        const response = await otherOwner.client.request(method, path);
        expect([path, response.status]).toEqual([path, 404]);
        expect(response.text).not.toContain(run.testToken);
      }
    });

    it("another organization gets 404 on the artifact even with a genuine download link", async () => {
      expect(downloadUrl).toContain("token=");
      const response = await otherOwner.client.request("GET", downloadUrl.replace("/api/v1", ""));
      expect(response.status).toBe(404);
    });

    it("the owning organization can use the link and a tampered token is refused", async () => {
      expect((await owner.client.request("GET", downloadUrl.replace("/api/v1", ""))).status).toBe(200);
      expect((await owner.client.request("GET", `/artifacts/${artifactId}/download?token=0.forged`)).status).toBe(403);
    });

    it("another organization gets 404 on every write", async () => {
      const writes = [
        ["POST", `/sites/${siteId}/runs`, {}],
        ["POST", `/sites/${siteId}/destinations`, { type: "mailpit" }],
        ["PATCH", `/sites/${siteId}`, { name: "Hijacked" }],
        ["DELETE", `/sites/${siteId}`, undefined],
        ["POST", `/runs/${run.runId}/cancel`, undefined],
        ["POST", `/incidents/${incidentId}/investigations`, { mode: "non_ai_harness" }],
        ["POST", `/incidents/${incidentId}/close`, { reason: "closing someone else's incident" }],
        ["POST", `/patches/${patchId}/approve`, { reason: "approving someone else's patch", riskAcknowledged: true }],
        ["POST", `/patches/${patchId}/reject`, { reason: "rejecting someone else's patch" }],
        ["POST", `/patches/${patchId}/download`, undefined],
      ] as const;
      for (const [method, path, body] of writes) {
        const response = await otherOwner.client.request(method, path, { body });
        expect([path, response.status]).toEqual([path, 404]);
      }
    });

    it("list filters do not leak another organization's rows", async () => {
      expect((await otherOwner.client.ok<{ runs: unknown[] }>("GET", `/runs?siteId=${siteId}`)).runs).toEqual([]);
      expect((await otherOwner.client.ok<{ incidents: unknown[] }>("GET", `/incidents?siteId=${siteId}`)).incidents).toEqual([]);
    });

    it("cannot switch into an organization it does not belong to", async () => {
      expect((await otherOwner.client.request("POST", "/me/active-organization", { body: { organizationId: owner.organizationId } })).status).toBe(404);
    });

    it("an unknown id is indistinguishable from a foreign id", async () => {
      const foreign = await otherOwner.client.request("GET", `/runs/${run.runId}`);
      const missing = await otherOwner.client.request("GET", `/runs/${randomId()}`);
      expect(missing.status).toBe(foreign.status);
      expect(missing.json<{ error: { code: string; message: string } }>().error.message).toBe(foreign.json<{ error: { code: string; message: string } }>().error.message);
    });
  });
});
