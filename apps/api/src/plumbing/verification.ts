import { randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { checkPublicTarget, verificationRecord } from "@inlet/policy";
import { TARGET_REJECTION_COPY } from "@inlet/policy";

const MAX_BODY = 512 * 1024;
const MAX_REDIRECTS = 3;

export function newVerificationToken(): string {
  return randomBytes(18).toString("hex");
}

export async function verifyDnsTxt(hostname: string, token: string): Promise<{ ok: boolean; detail: string }> {
  const expected = verificationRecord(token);
  try {
    const records = await dns.resolveTxt(hostname);
    const found = records.some((chunks) => chunks.join("") === expected);
    return found ? { ok: true, detail: "TXT record found." } : { ok: false, detail: `No TXT record on ${hostname} matched. DNS can take a few minutes to update.` };
  } catch {
    return { ok: false, detail: `No TXT records were found on ${hostname}.` };
  }
}

function fetchPinned(url: URL, address: string): Promise<{ status: number; location?: string; body: string }> {
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (typeof options === "object" && options.all) {
      callback(null, [{ address, family: address.includes(":") ? 6 : 4 }]);
    } else {
      (callback as unknown as (error: null, address: string, family: number) => void)(null, address, address.includes(":") ? 6 : 4);
    }
  };
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      { method: "GET", lookup, timeout: 8_000, headers: { "user-agent": "InletVerifier/1.0", accept: "text/html" } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > MAX_BODY) response.destroy();
        });
        const finish = () => resolve({ status: response.statusCode ?? 0, location: response.headers.location, body });
        response.on("end", finish);
        response.on("close", finish);
      },
    );
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    request.end();
  });
}

export async function verifyHtmlMeta(pageUrl: string, token: string): Promise<{ ok: boolean; detail: string }> {
  let current = pageUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const check = await checkPublicTarget(current);
    if (!check.ok) return { ok: false, detail: TARGET_REJECTION_COPY[check.reason] };
    let response: { status: number; location?: string; body: string };
    try {
      response = await fetchPinned(check.url, check.addresses[0] ?? "");
    } catch {
      return { ok: false, detail: "The page could not be reached." };
    }
    if (response.status >= 300 && response.status < 400 && response.location) {
      current = new URL(response.location, check.url).toString();
      continue;
    }
    if (response.status !== 200) return { ok: false, detail: `The page responded with status ${response.status}.` };
    const pattern = new RegExp(`<meta[^>]+name=["']inlet-verification["'][^>]+content=["']${token}["']`, "i");
    return pattern.test(response.body) ? { ok: true, detail: "Meta tag found." } : { ok: false, detail: "The page does not contain the verification meta tag yet." };
  }
  return { ok: false, detail: "The page redirected too many times." };
}
