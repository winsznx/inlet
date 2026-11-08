declare module "*/egress-gateway/policy.mjs" {
  export const PACKAGE_MIRRORS: Set<string>;
  export function isPublicAddress(address: string): boolean;
  export type EgressSession = {
    expiresAt: number;
    bytes: number;
    maxBytes: number;
    allow: { host: string; port: number; scope: "fixture" | "mirror" | "verified" }[];
  };
  export function evaluate(input: {
    session: EgressSession | null;
    host: string;
    port: number;
    profile: string;
    fixtureSuffix: string;
  }): { allowed: boolean; reason: string; resolveMode?: "docker" | "public" };
}
