/**
 * importClaudeMcpServers (S5) — fold global ~/.claude.json mcpServers into
 * registry specs so a user's existing Claude MCP servers work on every backend.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importClaudeMcpServers } from "../daemon/mcp/import-claude.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codeoid-claude-home-"));
});
afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});

function writeClaude(obj: unknown): void {
  writeFileSync(join(home, ".claude.json"), JSON.stringify(obj));
}

describe("importClaudeMcpServers", () => {
  it("imports global stdio + http servers with codeoid defaults; skips malformed", () => {
    writeClaude({
      mcpServers: {
        github: { command: "npx", args: ["-y", "@mcp/github"], env: { GH: "x" } },
        linear: { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer z" } },
        broken: { note: "neither command nor url" },
      },
      // Per-project servers are NOT imported (workdir-scoped, stay claude-only).
      projects: { "/some/dir": { mcpServers: { proj: { command: "x" } } } },
    });
    const specs = importClaudeMcpServers(home);
    expect(Object.keys(specs).sort()).toEqual(["github", "linear"]);
    expect(specs.github).toMatchObject({ command: "npx", args: ["-y", "@mcp/github"], env: { GH: "x" }, trust: "prompt", scope: "workspace", native: false });
    expect(specs.linear).toMatchObject({ url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer z" } });
    expect("proj" in specs).toBe(false);
  });

  it("returns {} when the file is missing or has no mcpServers", () => {
    expect(importClaudeMcpServers(home)).toEqual({}); // no file
    writeClaude({ somethingElse: true });
    expect(importClaudeMcpServers(home)).toEqual({});
  });

  it("never throws on malformed JSON", () => {
    writeFileSync(join(home, ".claude.json"), "{ not json");
    expect(importClaudeMcpServers(home)).toEqual({});
  });
});
