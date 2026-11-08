import { describe, expect, it } from "vitest";
import { REPAIR_PROFILES } from "@inlet/domain";
import { BUILD_PROFILES, commandForProfile, isKnownProfile, PROFILE_TIMEOUT_MS } from "@inlet/policy";

describe("commandForProfile", () => {
  it.each([
    ["pnpm", "typecheck", ["pnpm", "--config.verify-deps-before-run=false", "run", "typecheck"]],
    ["pnpm", "lint", ["pnpm", "--config.verify-deps-before-run=false", "run", "lint"]],
    ["pnpm", "unit", ["pnpm", "--config.verify-deps-before-run=false", "run", "test:unit"]],
    ["pnpm", "build", ["pnpm", "--config.verify-deps-before-run=false", "run", "build"]],
    ["npm", "typecheck", ["npm", "run", "--silent", "typecheck"]],
    ["npm", "unit", ["npm", "run", "--silent", "test:unit"]],
    ["npm", "build", ["npm", "run", "--silent", "build"]],
  ] as const)("%s %s", (manager, profile, expected) => {
    expect(commandForProfile(manager, profile)).toEqual(expected);
  });

  it("binds previews to the fixed internal port", () => {
    expect(commandForProfile("pnpm", "preview_start")).toEqual(["pnpm", "--config.verify-deps-before-run=false", "run", "start", "-p", "3000", "-H", "0.0.0.0"]);
    expect(commandForProfile("npm", "preview_start")).toEqual(["npm", "run", "--silent", "start", "--", "-p", "3000", "-H", "0.0.0.0"]);
  });

  it("has no command for preview_stop", () => {
    expect(commandForProfile("pnpm", "preview_stop")).toBeNull();
  });

  it("every profile has a bounded timeout", () => {
    for (const profile of REPAIR_PROFILES) {
      expect(PROFILE_TIMEOUT_MS[profile]).toBeGreaterThan(0);
      expect(PROFILE_TIMEOUT_MS[profile]).toBeLessThanOrEqual(150_000);
    }
  });
});

describe("isKnownProfile", () => {
  it("accepts every declared profile", () => {
    for (const profile of REPAIR_PROFILES) expect(isKnownProfile(profile)).toBe(true);
  });

  it.each(["", "sh", "bash -c id", "install", "typecheck; rm -rf /", "TYPECHECK", "__proto__"])("rejects %j", (value) => {
    expect(isKnownProfile(value)).toBe(false);
  });
});

describe("BUILD_PROFILES", () => {
  it.each(Object.keys(BUILD_PROFILES))("%s installs from the lockfile without running lifecycle scripts", (id) => {
    const profile = BUILD_PROFILES[id];
    expect(profile?.installCommand).toContain("--ignore-scripts");
    expect(profile?.packageManager === "pnpm" ? profile.installCommand : ["--frozen-lockfile"]).toContain("--frozen-lockfile");
    expect(profile?.packageManager === "npm" ? profile.installCommand[1] : "ci").toBe("ci");
  });

  it.each(Object.keys(BUILD_PROFILES))("%s requires every check", (id) => {
    expect(BUILD_PROFILES[id]?.requiredChecks).toEqual(["typecheck", "lint", "unit", "build"]);
  });
});
