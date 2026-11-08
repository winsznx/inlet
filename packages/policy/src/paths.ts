import { posix } from "node:path";

const FORBIDDEN_SEGMENTS: readonly RegExp[] = [
  /(^|\/)\.env(rc)?($|[./])/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.yarnrc/,
  /(^|\/)\.git($|\/)/,
  /(^|\/)\.github($|\/)/,
  /(^|\/)\.gitlab-ci/,
  /(^|\/)\.circleci($|\/)/,
  /(^|\/)\.ssh($|\/)/,
  /(^|\/)\.aws($|\/)/,
  /(^|\/)id_(rsa|ed25519|ecdsa)/,
  /\.(pem|key|p12|pfx|keystore)$/,
  /(^|\/)(secrets?|credentials?)(\.[a-z]+)?$/i,
  /(^|\/)Dockerfile/i,
  /(^|\/)docker-compose/i,
  /(^|\/)(infra|sandbox|policy)\//,
];

const LOCK_OR_MANIFEST = [
  /(^|\/)package\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)pnpm-workspace\.yaml$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
];

const TEST_FILES = [/\.(test|spec)\.[cm]?[jt]sx?$/, /(^|\/)(__tests__|tests?|e2e)\//];

export type PathRejection =
  | "absolute_path"
  | "path_traversal"
  | "outside_approved_paths"
  | "forbidden_file"
  | "dependency_manifest"
  | "guardrail_test"
  | "invalid_characters";

export function normalizeRepoPath(raw: string): string | null {
  if (raw.includes("\0") || raw.includes("\\")) return null;
  const normalized = posix.normalize(raw);
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") return null;
  return normalized.replace(/^\.\//, "");
}

export function checkRepoPath(raw: string, approvedPaths: readonly string[]): PathRejection | null {
  if (/[\0\r\n\\]/.test(raw)) return "invalid_characters";
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) return "absolute_path";
  if (raw.split("/").includes("..")) return "path_traversal";
  const path = normalizeRepoPath(raw);
  if (!path) return "path_traversal";
  if (FORBIDDEN_SEGMENTS.some((pattern) => pattern.test(path))) return "forbidden_file";
  if (LOCK_OR_MANIFEST.some((pattern) => pattern.test(path))) return "dependency_manifest";
  if (TEST_FILES.some((pattern) => pattern.test(path))) return "guardrail_test";
  const approved = approvedPaths.some((root) => {
    const base = root.replace(/\/+$/, "");
    return base === "." || path === base || path.startsWith(`${base}/`);
  });
  return approved ? null : "outside_approved_paths";
}

export function checkReadablePath(raw: string, approvedPaths: readonly string[]): PathRejection | null {
  if (/[\0\r\n\\]/.test(raw)) return "invalid_characters";
  if (raw.startsWith("/")) return "absolute_path";
  if (raw.split("/").includes("..")) return "path_traversal";
  const path = normalizeRepoPath(raw);
  if (!path) return "path_traversal";
  if (FORBIDDEN_SEGMENTS.some((pattern) => pattern.test(path))) return "forbidden_file";
  const approved = approvedPaths.some((root) => {
    const base = root.replace(/\/+$/, "");
    return base === "." || path === base || path.startsWith(`${base}/`);
  });
  return approved ? null : "outside_approved_paths";
}

const SNAPSHOT_EXCLUDES: readonly RegExp[] = [
  /(^|\/)\.env(rc)?($|[./])/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.yarnrc/,
  /(^|\/)\.git($|\/)/,
  /(^|\/)\.ssh($|\/)/,
  /(^|\/)\.aws($|\/)/,
  /(^|\/)id_(rsa|ed25519|ecdsa)/,
  /\.(pem|key|p12|pfx|keystore)$/,
  /(^|\/)node_modules\//,
  /(^|\/)\.next\//,
  /(^|\/)dist\//,
  /(^|\/)coverage\//,
];

export const SNAPSHOT_MAX_FILE_BYTES = 512 * 1024;
export const SNAPSHOT_MAX_TOTAL_BYTES = 48 * 1024 * 1024;
export const SNAPSHOT_MAX_FILES = 8000;

export function isExcludedFromSnapshot(path: string): boolean {
  return SNAPSHOT_EXCLUDES.some((pattern) => pattern.test(path));
}
