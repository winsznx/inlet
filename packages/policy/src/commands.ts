import type { RepairProfile } from "@inlet/domain";

export type PackageManager = "pnpm" | "npm";

const scriptRunner: Record<PackageManager, string[]> = {
  pnpm: ["pnpm", "--config.verify-deps-before-run=false", "run"],
  npm: ["npm", "run", "--silent"],
};

const SCRIPT_FOR_PROFILE: Record<Exclude<RepairProfile, "preview_stop" | "preview_start">, string[]> = {
  typecheck: ["typecheck"],
  lint: ["lint"],
  unit: ["test:unit"],
  build: ["build"],
};

const PREVIEW_ARGS: Record<PackageManager, string[]> = {
  pnpm: ["start", "-p", "3000", "-H", "0.0.0.0"],
  npm: ["start", "--", "-p", "3000", "-H", "0.0.0.0"],
};

export const PROFILE_TIMEOUT_MS: Record<RepairProfile, number> = {
  typecheck: 60_000,
  lint: 30_000,
  unit: 45_000,
  build: 150_000,
  preview_start: 20_000,
  preview_stop: 5_000,
};

export function commandForProfile(manager: PackageManager, profile: RepairProfile): string[] | null {
  if (profile === "preview_stop") return null;
  if (profile === "preview_start") return [...scriptRunner[manager], ...PREVIEW_ARGS[manager]];
  return [...scriptRunner[manager], ...SCRIPT_FOR_PROFILE[profile]];
}

export function isKnownProfile(value: string): value is RepairProfile {
  return ["typecheck", "lint", "unit", "build", "preview_start", "preview_stop"].includes(value);
}

export type BuildProfile = {
  id: string;
  packageManager: PackageManager;
  installCommand: string[];
  requiredChecks: readonly ("typecheck" | "lint" | "unit" | "build")[];
};

export const BUILD_PROFILES: Record<string, BuildProfile> = {
  "next-pnpm": {
    id: "next-pnpm",
    packageManager: "pnpm",
    installCommand: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts", "--config.node-linker=hoisted"],
    requiredChecks: ["typecheck", "lint", "unit", "build"],
  },
  "next-npm": {
    id: "next-npm",
    packageManager: "npm",
    installCommand: ["npm", "ci", "--ignore-scripts"],
    requiredChecks: ["typecheck", "lint", "unit", "build"],
  },
};
