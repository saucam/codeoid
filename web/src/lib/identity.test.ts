import { describe, it, expect } from "vitest";
import { identityColorClass, roleColorClass } from "./identity";

describe("roleColorClass", () => {
  it("returns role-specific tokens", () => {
    expect(roleColorClass("user")).toBe("text-role-user");
    expect(roleColorClass("assistant")).toBe("text-role-assistant");
    expect(roleColorClass("tool_call")).toBe("text-role-tool");
    expect(roleColorClass("thinking")).toBe("text-role-thinking");
    expect(roleColorClass("system")).toBe("text-danger");
    expect(roleColorClass("info")).toBe("text-fg-faint");
  });

  it("falls back gracefully on unknown roles", () => {
    expect(roleColorClass("unknown-role")).toBe("text-fg-faint");
  });
});

describe("identityColorClass", () => {
  it("maps each identity type", () => {
    expect(identityColorClass("human")).toBe("text-role-user");
    expect(identityColorClass("agent")).toBe("text-role-assistant");
    expect(identityColorClass("subagent")).toBe("text-role-tool");
    expect(identityColorClass("system")).toBe("text-fg-faint");
  });

  it("falls back gracefully", () => {
    expect(identityColorClass(undefined)).toBe("text-fg-muted");
    expect(identityColorClass(null)).toBe("text-fg-muted");
  });
});
