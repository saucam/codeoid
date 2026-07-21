/**
 * Subagent parsing for ambient pack activation (docs/pack-loading.md).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSubagents, parseSubagentFile } from "./subagents";

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "subagents-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const AGENT = `---
name: reviewer-bot
description: Reviews code for correctness and security.
tools: Read, Grep, Glob
model: opus
---
You are a meticulous code reviewer. Find real defects.`;

describe("parseSubagentFile", () => {
  test("parses frontmatter + body", () => {
    const dir = tmp();
    const p = join(dir, "reviewer.md");
    writeFileSync(p, AGENT);
    const a = parseSubagentFile(p)!;
    expect(a.name).toBe("reviewer-bot");
    expect(a.description).toMatch(/Reviews code/);
    expect(a.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(a.model).toBe("opus");
    expect(a.prompt).toBe("You are a meticulous code reviewer. Find real defects.");
  });

  test("tools as a YAML list also parses", () => {
    const dir = tmp();
    const p = join(dir, "a.md");
    writeFileSync(p, "---\nname: a\ndescription: d\ntools:\n  - Read\n  - Bash\n---\nbody");
    expect(parseSubagentFile(p)!.tools).toEqual(["Read", "Bash"]);
  });

  test("returns undefined for missing frontmatter / name / description / body", () => {
    const dir = tmp();
    const noFm = join(dir, "b.md");
    writeFileSync(noFm, "just text, no frontmatter");
    expect(parseSubagentFile(noFm)).toBeUndefined();

    const noName = join(dir, "c.md");
    writeFileSync(noName, "---\ndescription: d\n---\nbody");
    expect(parseSubagentFile(noName)).toBeUndefined();

    const noBody = join(dir, "d.md");
    writeFileSync(noBody, "---\nname: n\ndescription: d\n---\n");
    expect(parseSubagentFile(noBody)).toBeUndefined();
  });

  test("rejects a hostile/reserved name (prototype-pollution guard)", () => {
    const dir = tmp();
    for (const bad of ["__proto__", "constructor", "has space", "-leading-dash"]) {
      const p = join(dir, "x.md");
      writeFileSync(p, `---\nname: "${bad}"\ndescription: d\n---\nbody`);
      expect(parseSubagentFile(p)).toBeUndefined();
    }
  });
});

describe("loadSubagents", () => {
  test("loads all *.md, skips non-md + malformed, tolerates a missing dir", () => {
    expect(loadSubagents(join(tmp(), "nope"))).toEqual([]);
    const dir = tmp();
    writeFileSync(join(dir, "good.md"), AGENT);
    writeFileSync(join(dir, "bad.md"), "no frontmatter here");
    writeFileSync(join(dir, "notes.txt"), "ignored");
    const loaded = loadSubagents(dir);
    expect(loaded.map((a) => a.name)).toEqual(["reviewer-bot"]);
  });
});
