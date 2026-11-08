import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkRuns, closeDb, db, desc, eq, schedules } from "@inlet/database";
import { apiRequest, ApiClient, mailpitSearch, mapForm, PASSWORD, registerOwner, waitForRun } from "../support/api";

type Owner = Awaited<ReturnType<typeof registerOwner>>;

let owner: Owner;

async function fixtureSite(formUrl: string, name: string): Promise<string> {
  const { id } = await owner.client.ok<{ id: string }>("POST", "/sites", { body: { name, formUrl, authorized: true } });
  await owner.client.ok("POST", `/sites/${id}/destinations`, { body: { type: "mailpit", displayName: "Test inbox" } });
  await mapForm(owner, id);
  return id;
}

async function waitForMail(query: string, minimum = 1, timeoutMs = 20_000): Promise<{ ID: string }[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { messages } = await mailpitSearch(query);
    if (messages.length >= minimum || Date.now() > deadline) return messages;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

beforeAll(async () => {
  owner = await registerOwner("operations-owner");
});

afterAll(async () => {
  await closeDb();
});

describe("failure alerts", () => {
  it("emails once on a first failure and groups the repeat", async () => {
    // #given
    const siteId = await fixtureSite("http://localhost:3112/contact", "Alert site");
    // #when
    const first = await owner.client.ok<{ runId: string }>("POST", `/sites/${siteId}/runs`, { body: { trigger: "manual" }, headers: { "idempotency-key": randomUUID() } });
    await waitForRun(owner.client, first.runId);
    const afterFirst = await waitForMail(`to:"${owner.email}" subject:"Enquiry not received"`);
    const second = await owner.client.ok<{ runId: string }>("POST", `/sites/${siteId}/runs`, { body: { trigger: "manual" }, headers: { "idempotency-key": randomUUID() } });
    await waitForRun(owner.client, second.runId);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const repeats = await mailpitSearch(`to:"${owner.email}" subject:"Still not receiving"`);
    const history = await owner.client.ok<{ notifications: { kind: string; groupedCount: number; deliveryStatus: string }[] }>("GET", "/notifications");
    // #then
    expect(afterFirst).toHaveLength(1);
    expect(repeats.messages.length).toBeLessThanOrEqual(1);
    expect(history.notifications.find((item) => item.kind === "failure")?.deliveryStatus).toBe("sent");
  }, 180_000);
});

describe("scheduled checks", () => {
  it("runs a due schedule and moves the next run forward", async () => {
    // #given
    const siteId = await fixtureSite("http://localhost:3110/contact", "Scheduled site");
    await owner.client.ok("PATCH", `/sites/${siteId}/schedule`, { body: { mode: "custom", intervalMinutes: 15 } });
    const past = new Date(Date.now() - 5_000);
    await db().update(schedules).set({ nextRunAt: past }).where(eq(schedules.siteId, siteId));
    // #when
    const deadline = Date.now() + 90_000;
    let runId: string | undefined;
    while (!runId && Date.now() < deadline) {
      const [row] = await db().select().from(checkRuns).where(eq(checkRuns.siteId, siteId)).orderBy(desc(checkRuns.createdAt)).limit(1);
      if (row?.trigger === "schedule") runId = row.id;
      else await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const run = await waitForRun(owner.client, runId ?? "");
    const [schedule] = await db().select().from(schedules).where(eq(schedules.siteId, siteId));
    // #then
    expect(run.result).toBe("received");
    expect(schedule?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
  }, 180_000);

  it("rejects an interval under the 15 minute minimum", async () => {
    // #given
    const siteId = await fixtureSite("http://localhost:3110/contact", "Fast schedule site");
    // #when
    const response = await owner.client.request("PATCH", `/sites/${siteId}/schedule`, { body: { mode: "custom", intervalMinutes: 5 } });
    // #then
    expect(response.status).toBe(400);
  });
});

describe("password reset", () => {
  it("emails a link that changes the password once", async () => {
    // #given
    const newPassword = "a-different-long-password";
    await apiRequest("POST", "/auth/forgot-password", { body: { email: owner.email } });
    const [mail] = await waitForMail(`to:"${owner.email}" subject:"Reset your Inlet password"`);
    const body = (await (await fetch(`http://localhost:8025/api/v1/message/${mail?.ID}`)).json()) as { Text: string };
    const token = /token=([\w-]+)/.exec(body.Text)?.[1];
    // #when
    const reset = await apiRequest("POST", "/auth/reset-password", { body: { token, password: newPassword } });
    const replay = await apiRequest("POST", "/auth/reset-password", { body: { token, password: PASSWORD } });
    const oldLogin = await apiRequest("POST", "/auth/login", { body: { email: owner.email, password: PASSWORD } });
    const newLogin = await apiRequest("POST", "/auth/login", { body: { email: owner.email, password: newPassword } });
    owner.client = new ApiClient();
    owner.client.capture(newLogin);
    // #then
    expect([reset.status, replay.status, oldLogin.status, newLogin.status]).toEqual([200, 400, 401, 200]);
  });
});

describe("public demo", () => {
  it("runs a real check and hides it from other sessions", async () => {
    // #when
    const start = await apiRequest("POST", "/demo/scenarios/working/runs", { body: {} });
    const cookie = start.headers.getSetCookie()[0]?.split(";")[0] ?? "";
    const { runId } = start.json<{ runId: string }>();
    const deadline = Date.now() + 120_000;
    let state = "";
    let result: string | null = null;
    while (state !== "cleanup_complete" && Date.now() < deadline) {
      const body = (await apiRequest("GET", `/demo/runs/${runId}`, { cookie })).json<{ state: string; result: string | null }>();
      state = body.state;
      result = body.result;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const stranger = await apiRequest("GET", `/demo/runs/${runId}`);
    // #then
    expect(result).toBe("received");
    expect(stranger.status).toBe(404);
  }, 180_000);

  it("rejects a scenario that is not in the allowlist", async () => {
    // #when
    const response = await apiRequest("POST", "/demo/scenarios/http%3A%2F%2Fevil.example/runs", { body: {} });
    // #then
    expect(response.status).toBe(404);
  });
});
