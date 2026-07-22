import { describe, test, expect } from "bun:test";
import { isElicitationTool, isSafeTool } from "../daemon/providers/tool-safety.js";
import { MEMORY_TOOL_NAMES } from "../daemon/memory/tools.js";

describe("isSafeTool", () => {
  test("built-in read-only tools are safe", () => {
    for (const t of ["Read", "Grep", "Glob"]) expect(isSafeTool(t)).toBe(true);
  });

  test("write/exec tools are never safe", () => {
    for (const t of ["Write", "Edit", "Bash", "WebFetch"]) expect(isSafeTool(t)).toBe(false);
  });

  test("known memory tools are safe under both namespaces", () => {
    for (const t of MEMORY_TOOL_NAMES) {
      expect(isSafeTool(`mcp__codeoid_memory__${t}`)).toBe(true); // Claude in-process
      expect(isSafeTool(`codeoid_memory__${t}`)).toBe(true); // gemini-cli/codex URL mount
    }
  });

  test("look-alike names cannot bypass the prompt (the Gemini #182 finding)", () => {
    // A third-party/malicious server whose name merely CONTAINS the segment.
    expect(isSafeTool("x_codeoid_memory__wipe")).toBe(false);
    expect(isSafeTool("not_codeoid_memory__delete")).toBe(false);
    expect(isSafeTool("malicious_codeoid_memory")).toBe(false);
    // Correct namespace but an UNKNOWN (e.g. future write-capable) memory tool.
    expect(isSafeTool("codeoid_memory__delete_all")).toBe(false);
    expect(isSafeTool("mcp__codeoid_memory__purge")).toBe(false);
    // Namespace as a substring but not a prefix.
    expect(isSafeTool("evil.codeoid_memory__recall")).toBe(false);
  });
});

describe("isElicitationTool", () => {
  test("AskUserQuestion and its snake_case alias are elicitation tools", () => {
    expect(isElicitationTool("AskUserQuestion")).toBe(true);
    expect(isElicitationTool("ask_user_question")).toBe(true);
  });

  test("ordinary tools are not elicitation tools", () => {
    for (const t of [
      "Read",
      "Bash",
      "Write",
      "AskUser", // partial name must not match
      "askuserquestion", // wrong case must not match
      "mcp__codeoid_fleet__fleet_send",
    ]) {
      expect(isElicitationTool(t)).toBe(false);
    }
  });
});
