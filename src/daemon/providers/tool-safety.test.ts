/**
 * Tool-safety classification — read-safe set, and the capability-role gate used
 * by ambient pack activation (docs/pack-loading.md).
 */

import { describe, expect, test } from "bun:test";
import { isNetworkTool, isSafeTool, isWriteTool, roleDeniesTool, type ToolRole } from "./tool-safety";

describe("classifiers", () => {
  test("read-safe tools", () => {
    expect(isSafeTool("Read")).toBe(true);
    expect(isSafeTool("Grep")).toBe(true);
    expect(isSafeTool("Write")).toBe(false);
  });
  test("write tools (Bash is NOT a write tool — reviewer keeps shell)", () => {
    for (const t of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) expect(isWriteTool(t)).toBe(true);
    expect(isWriteTool("Bash")).toBe(false);
    expect(isWriteTool("Read")).toBe(false);
  });
  test("network tools", () => {
    expect(isNetworkTool("WebFetch")).toBe(true);
    expect(isNetworkTool("WebSearch")).toBe(true);
    expect(isNetworkTool("Read")).toBe(false);
  });
});

describe("roleDeniesTool", () => {
  const reviewer: ToolRole = { write: false, network: "read-only", envelope: ["read", "grep", "glob", "bash"] };
  const implementer: ToolRole = { write: true, network: "read-only", envelope: "all" };
  const noNet: ToolRole = { write: true, network: false, envelope: "all" };

  test("read-only role denies write tools, allows reads + bash", () => {
    expect(roleDeniesTool(reviewer, "Write")).toMatch(/read-only/);
    expect(roleDeniesTool(reviewer, "Edit")).toMatch(/read-only/);
    expect(roleDeniesTool(reviewer, "Read")).toBeNull();
    expect(roleDeniesTool(reviewer, "Bash")).toBeNull(); // shell kept for inspection
  });

  test("read-only role (network:'read-only') still allows read-only fetches", () => {
    expect(roleDeniesTool(reviewer, "WebFetch")).toBeNull();
  });

  test("write-capable role allows writes", () => {
    expect(roleDeniesTool(implementer, "Write")).toBeNull();
    expect(roleDeniesTool(implementer, "WebFetch")).toBeNull();
  });

  test("network:false denies network tools but not writes", () => {
    expect(roleDeniesTool(noNet, "WebFetch")).toMatch(/network/);
    expect(roleDeniesTool(noNet, "Write")).toBeNull();
  });
});
