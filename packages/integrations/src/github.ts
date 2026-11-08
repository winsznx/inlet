import { createHmac, createSign } from "node:crypto";
import { env, githubConfigured } from "@inlet/config";
import { AppError } from "@inlet/domain";

function appJwt(): string {
  const { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY: key } = env();
  if (!appId || !key) throw new AppError("GITHUB_NOT_CONFIGURED", "GitHub is not connected on this server.");
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 30, exp: now + 540, iss: appId })}`;
  const signature = createSign("RSA-SHA256").update(payload).sign(key.replace(/\\n/g, "\n"), "base64url");
  return `${payload}.${signature}`;
}

async function githubRequest<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${env().GITHUB_API_URL}${path}`, {
    ...init,
    signal: AbortSignal.timeout(20_000),
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw new AppError("DEPENDENCY_UNAVAILABLE", `GitHub answered ${response.status}.`, {
      nextAction: "Check the app installation and repository access.",
      details: { path: path.split("?")[0], status: response.status },
    });
  }
  return (await response.json()) as T;
}

export async function installationToken(installationId: string): Promise<string> {
  const body = await githubRequest<{ token: string }>(`/app/installations/${installationId}/access_tokens`, appJwt(), {
    method: "POST",
    body: JSON.stringify({ permissions: { contents: "write", pull_requests: "write" } }),
  });
  return body.token;
}

export function assertGithubConfigured(): void {
  if (!githubConfigured()) {
    throw new AppError("GITHUB_NOT_CONFIGURED", "GitHub is not connected on this server.", {
      nextAction: "Download the patch instead, or configure the GitHub App.",
    });
  }
}

export async function headSha(token: string, repo: string, branch: string): Promise<string> {
  const ref = await githubRequest<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, token);
  return ref.object.sha;
}

export async function downloadTarball(token: string, repo: string, sha: string): Promise<Buffer> {
  const response = await fetch(`${env().GITHUB_API_URL}/repos/${repo}/tarball/${sha}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new AppError("DEPENDENCY_UNAVAILABLE", `GitHub answered ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
}

export type PullRequestFile = { path: string; content: string | null };

export type PullRequestInput = {
  token: string;
  repo: string;
  baseBranch: string;
  baseSha: string;
  branch: string;
  title: string;
  body: string;
  files: PullRequestFile[];
};

export async function createPullRequest(input: PullRequestInput): Promise<{ number: number; url: string; state: string }> {
  const { token, repo, baseBranch, baseSha, branch } = input;
  if (branch === baseBranch || !branch.startsWith("inlet/")) {
    throw new AppError("FORBIDDEN", "Inlet only pushes to its own inlet/ branches.");
  }
  const current = await headSha(token, repo, baseBranch);
  if (current !== baseSha) {
    throw new AppError("BASE_MOVED", "The base branch has moved since this patch was tested.", {
      nextAction: "Run the investigation again against the new commit.",
      details: { baseSha, currentSha: current },
    });
  }
  const baseCommit = await githubRequest<{ tree: { sha: string } }>(`/repos/${repo}/git/commits/${baseSha}`, token);
  const tree = await githubRequest<{ sha: string }>(`/repos/${repo}/git/trees`, token, {
    method: "POST",
    body: JSON.stringify({
      base_tree: baseCommit.tree.sha,
      tree: input.files.map((file) => ({ path: file.path, mode: "100644", type: "blob", content: file.content })),
    }),
  });
  const commit = await githubRequest<{ sha: string }>(`/repos/${repo}/git/commits`, token, {
    method: "POST",
    body: JSON.stringify({ message: input.title, tree: tree.sha, parents: [baseSha] }),
  });
  await githubRequest(`/repos/${repo}/git/refs`, token, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
  });
  const pull = await githubRequest<{ number: number; html_url: string; state: string }>(`/repos/${repo}/pulls`, token, {
    method: "POST",
    body: JSON.stringify({ title: input.title, head: branch, base: baseBranch, body: input.body, draft: false }),
  });
  return { number: pull.number, url: pull.html_url, state: pull.state };
}

export function verifyGithubSignature(payload: string, header: string | undefined): boolean {
  const secret = env().GITHUB_WEBHOOK_SECRET;
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  return expected.length === header.length && Buffer.from(expected).equals(Buffer.from(header));
}
