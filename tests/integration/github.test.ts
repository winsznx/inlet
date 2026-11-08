import { createServer } from "node:http";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const PORT = 18791;
vi.hoisted(() => {
  process.env.GITHUB_API_URL = "http://127.0.0.1:18791";
});

import { createPullRequest } from "@inlet/integrations";
import type { PullRequestInput } from "@inlet/integrations";

type Recorded = { method: string; path: string; body: Record<string, unknown> };

const BASE = "a".repeat(40);
let recorded: Recorded[] = [];
let head = BASE;
let server: Server;

function respond(method: string, path: string): unknown {
  if (method === "GET" && path.includes("/git/ref/heads/")) return { object: { sha: head } };
  if (method === "GET" && path.includes("/git/commits/")) return { tree: { sha: "tree-base" } };
  if (method === "POST" && path.endsWith("/git/trees")) return { sha: "tree-new" };
  if (method === "POST" && path.endsWith("/git/commits")) return { sha: "commit-new" };
  if (method === "POST" && path.endsWith("/git/refs")) return { ref: "created" };
  if (method === "POST" && path.endsWith("/pulls")) return { number: 7, html_url: "https://github.test/acme/site/pull/7", state: "open" };
  return {};
}

const input: PullRequestInput = {
  token: "installation-token",
  repo: "acme/site",
  baseBranch: "main",
  baseSha: BASE,
  branch: "inlet/fix-incident",
  title: "Fix enquiry notification delivery",
  body: "Proposed by Inlet.",
  files: [{ path: "src/lib/settings.ts", content: "export {};\n" }],
};

beforeAll(async () => {
  server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    request.on("end", () => {
      recorded.push({ method: request.method ?? "", path: request.url ?? "", body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(respond(request.method ?? "", request.url ?? "")));
    });
  });
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  recorded = [];
  head = BASE;
});

describe("createPullRequest against a GitHub-shaped server", () => {
  it("creates the branch and opens a pull request", async () => {
    // #when
    const pull = await createPullRequest(input);
    // #then
    expect(pull).toEqual({ number: 7, url: "https://github.test/acme/site/pull/7", state: "open" });
    expect(recorded.find((item) => item.path.endsWith("/git/refs"))?.body).toEqual({ ref: "refs/heads/inlet/fix-incident", sha: "commit-new" });
  });

  it("never writes to the default branch", async () => {
    // #when
    const attempt = createPullRequest({ ...input, branch: "main" });
    // #then
    await expect(attempt).rejects.toThrow(/own inlet\/ branches/);
    expect(recorded).toHaveLength(0);
  });

  it("stops without writing when the base branch has moved", async () => {
    // #given
    head = "b".repeat(40);
    // #when
    const attempt = createPullRequest(input);
    // #then
    await expect(attempt).rejects.toThrow(/has moved/);
    expect(recorded.every((item) => item.method === "GET")).toBe(true);
  });
});
