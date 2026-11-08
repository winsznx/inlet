import { describe, expect, it } from "vitest";
import { AGENT_TOOL_NAMES, evaluateNavigation, isAllowedTool } from "@inlet/policy";

const VERIFIED = ["https://www.example.com"];

describe("isAllowedTool", () => {
  it("allows exactly the declared tools", () => {
    for (const name of AGENT_TOOL_NAMES) expect(isAllowedTool(name)).toBe(true);
  });

  it.each(["", "shell", "bash", "exec", "read_file", "write_file", "INSPECT_RUN", "inspect_run ", " inspect_run", "inspect_run\n", "__proto__", "constructor", "toString", "finalize_proposal; rm -rf /"])(
    "rejects %j",
    (name) => {
      expect(isAllowedTool(name)).toBe(false);
    },
  );

  it("offers no shell, network or raw file tool", () => {
    expect(AGENT_TOOL_NAMES.filter((name) => /shell|exec|bash|fetch|http|write/i.test(name))).toEqual([]);
  });
});

describe("evaluateNavigation", () => {
  it.each(["https://www.example.com/", "https://www.example.com/contact?a=1", "https://WWW.EXAMPLE.com/thanks", "https://www.example.com:443/x"])("allows %s", (target) => {
    expect(evaluateNavigation(target, VERIFIED)).toEqual({ allowed: true });
  });

  it.each([
    "http://www.example.com/",
    "https://example.com/",
    "https://evil.www.example.com/",
    "https://www.example.com.evil.net/",
    "https://www.example.com:8443/",
    "https://evil.net/https://www.example.com/",
    "https://www.example.com@evil.net/",
    "javascript:alert(1)",
    "data:text/html,<h1>x</h1>",
    "file:///etc/passwd",
    "about:blank",
    "http://169.254.169.254/latest/meta-data",
  ])("denies %s as origin_not_verified", (target) => {
    expect(evaluateNavigation(target, VERIFIED)).toEqual({ allowed: false, reasonCode: "origin_not_verified" });
  });

  it("reports an unparseable target as invalid", () => {
    expect(evaluateNavigation("not a url", VERIFIED)).toEqual({ allowed: false, reasonCode: "invalid_url" });
  });

  it("denies everything when nothing is verified", () => {
    expect(evaluateNavigation("https://www.example.com/", [])).toEqual({ allowed: false, reasonCode: "origin_not_verified" });
  });

  it("does not treat the opaque 'null' origin as verified", () => {
    expect(evaluateNavigation("data:text/html,x", ["null"]).allowed).toBe(true);
    expect(evaluateNavigation("data:text/html,x", VERIFIED).allowed).toBe(false);
  });
});
