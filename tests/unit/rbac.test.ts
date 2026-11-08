import { describe, expect, it } from "vitest";
import { can, ROLES } from "@inlet/domain";
import type { Permission, Role } from "@inlet/domain";

// Transcribed from PRD section 9.1, with "Restricted", "if explicitly granted" and "unless delegated" resolved to deny by default.
const MATRIX: Record<Permission, Record<Role, boolean>> = {
  "evidence:view": { owner: true, admin: true, maintainer: true, viewer: true },
  "site:edit": { owner: true, admin: true, maintainer: true, viewer: false },
  "run:start": { owner: true, admin: true, maintainer: true, viewer: false },
  "investigation:start": { owner: true, admin: true, maintainer: true, viewer: false },
  "patch:decide": { owner: true, admin: true, maintainer: false, viewer: false },
  "secret:manage": { owner: true, admin: true, maintainer: false, viewer: false },
  "member:manage": { owner: true, admin: true, maintainer: false, viewer: false },
  "workspace:delete": { owner: true, admin: false, maintainer: false, viewer: false },
  "policy:view": { owner: true, admin: true, maintainer: false, viewer: false },
};

const PERMISSIONS = Object.keys(MATRIX) as Permission[];

describe("role matrix", () => {
  const cases = PERMISSIONS.flatMap((permission) => ROLES.map((role) => [role, permission, MATRIX[permission][role]] as const));

  it.each(cases)("%s %s = %s", (role, permission, expected) => {
    expect(can(role, permission)).toBe(expected);
  });
});

describe("maintainer approval grant", () => {
  it("lets a maintainer decide patches only when explicitly granted", () => {
    expect(can("maintainer", "patch:decide", { maintainerMayApprove: true })).toBe(true);
    expect(can("maintainer", "patch:decide", { maintainerMayApprove: false })).toBe(false);
    expect(can("maintainer", "patch:decide", {})).toBe(false);
  });

  it("never elevates a viewer", () => {
    expect(can("viewer", "patch:decide", { maintainerMayApprove: true })).toBe(false);
  });

  it("grants nothing beyond patch decisions", () => {
    for (const permission of PERMISSIONS.filter((item) => item !== "patch:decide")) {
      expect(can("maintainer", permission, { maintainerMayApprove: true })).toBe(MATRIX[permission].maintainer);
    }
  });

  it("does not take approval away from owners or admins", () => {
    expect(can("owner", "patch:decide", { maintainerMayApprove: false })).toBe(true);
    expect(can("admin", "patch:decide", { maintainerMayApprove: false })).toBe(true);
  });
});
