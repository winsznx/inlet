export const SECRET_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/ },
  { name: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "github_app_token", pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { name: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "stripe_key", pattern: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/ },
  { name: "openai_style_key", pattern: /\bsk-[A-Za-z0-9_-]{32,}\b/ },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "connection_string", pattern: /\b[a-z][a-z0-9+.-]+:\/\/[^\s:/@]+:[^\s:/@]+@[^\s]+/i },
  {
    name: "assigned_secret",
    pattern: /\b(?:password|passwd|secret|api[_-]?key|auth[_-]?token)\b\s*[:=]\s*["'][^"'\s]{8,}["']/i,
  },
];

export function findSecretPatterns(text: string): string[] {
  return SECRET_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
}

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (current, { pattern, name }) => current.replace(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`), `[redacted:${name}]`),
    text,
  );
}
