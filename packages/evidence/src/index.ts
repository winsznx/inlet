import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { artifactRoot, env } from "@inlet/config";
import { TOKEN_PREFIX } from "@inlet/domain";
import type { RunnerArtifact } from "@inlet/domain";
import { redactSecrets } from "@inlet/policy";

export const REDACTION_VERSION = 1;

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hmacIp(ip: string): string {
  return createHmac("sha256", env().SESSION_SECRET).update(ip).digest("hex").slice(0, 32);
}

function masterKey(): Buffer {
  return Buffer.from(env().MASTER_ENCRYPTION_KEY, "base64");
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

export function decryptSecret(sealed: string): string {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || body === undefined) throw new Error("Unsupported secret format");
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}

export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const TOKEN = new RegExp(`${TOKEN_PREFIX}[0-9a-f]{28}([0-9a-f]{4})`, "g");

export function redactText(text: string, options?: { keepEmails?: boolean }): string {
  const secretsRemoved = redactSecrets(text).replace(TOKEN, `${TOKEN_PREFIX}••••$1`);
  return options?.keepEmails ? secretsRemoved : secretsRemoved.replace(EMAIL, "[email]");
}

export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type ArtifactBudget = { maxBytes: number; maxFiles: number };

export class ArtifactCollector {
  private bytes = 0;
  private files = 0;
  readonly rejected: string[] = [];

  constructor(private readonly budget: ArtifactBudget) {}

  accept(artifact: RunnerArtifact): { name: string; kind: string; mime: string; data: Buffer } | null {
    const data = Buffer.from(artifact.b64, "base64");
    if (this.files >= this.budget.maxFiles || this.bytes + data.length > this.budget.maxBytes) {
      this.rejected.push(`${artifact.name}: over budget`);
      return null;
    }
    if (artifact.mime === "image/png" && !data.subarray(0, 8).equals(PNG_MAGIC)) {
      this.rejected.push(`${artifact.name}: not a PNG`);
      return null;
    }
    if (artifact.mime !== "image/png") {
      const redacted = redactText(data.toString("utf8"));
      const buffer = Buffer.from(redacted, "utf8");
      this.files += 1;
      this.bytes += buffer.length;
      return { name: artifact.name, kind: artifact.kind, mime: artifact.mime, data: buffer };
    }
    this.files += 1;
    this.bytes += data.length;
    return { name: artifact.name, kind: artifact.kind, mime: artifact.mime, data };
  }
}

export function objectKey(organizationId: string, scope: string, name: string): string {
  return join(organizationId, scope, name);
}

function resolveObject(key: string): string {
  const root = artifactRoot();
  const target = resolve(root, key);
  if (relative(root, target).startsWith("..")) throw new Error("Artifact path escapes the store");
  return target;
}

export async function putObject(key: string, data: Buffer | string): Promise<{ sha256: string; sizeBytes: number }> {
  const target = resolveObject(key);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, data, { mode: 0o600 });
  const buffer = typeof data === "string" ? Buffer.from(data) : data;
  return { sha256: sha256(buffer), sizeBytes: buffer.length };
}

export async function getObject(key: string): Promise<Buffer> {
  return readFile(resolveObject(key));
}

export async function deleteObject(key: string): Promise<void> {
  await rm(resolveObject(key), { force: true });
}

export async function deletePrefix(prefix: string): Promise<void> {
  await rm(resolveObject(prefix), { force: true, recursive: true });
}

export type ManifestEntry = { name: string; sha256: string; sizeBytes: number; kind: string };

export function buildEvidenceZip(files: { name: string; data: Uint8Array; kind: string }[], meta: Record<string, unknown>): Uint8Array {
  const entries: ManifestEntry[] = files.map((file) => ({
    name: file.name,
    sha256: sha256(file.data),
    sizeBytes: file.data.length,
    kind: file.kind,
  }));
  const manifest = {
    ...meta,
    generatedAt: new Date().toISOString(),
    redactionVersion: REDACTION_VERSION,
    note: "Hashes identify the files in this bundle. This manifest is not an attestation of the host.",
    files: entries,
  };
  const archive: Record<string, Uint8Array> = { "manifest.json": strToU8(JSON.stringify(manifest, null, 2)) };
  for (const file of files) archive[`evidence/${file.name}`] = file.data;
  return zipSync(archive, { level: 6 });
}

const DOWNLOAD_TOKEN_TTL_MS = 5 * 60_000;

export function signDownload(artifactId: string, subject: string, now = Date.now()): string {
  const expires = now + DOWNLOAD_TOKEN_TTL_MS;
  const payload = `${artifactId}.${subject}.${expires}`;
  const signature = createHmac("sha256", env().SESSION_SECRET).update(payload).digest("base64url");
  return `${expires}.${signature}`;
}

export function verifyDownload(artifactId: string, subject: string, token: string, now = Date.now()): boolean {
  const [expires, signature] = token.split(".");
  if (!expires || !signature || Number(expires) < now) return false;
  const expected = createHmac("sha256", env().SESSION_SECRET)
    .update(`${artifactId}.${subject}.${expires}`)
    .digest("base64url");
  return safeEqual(expected, signature);
}
