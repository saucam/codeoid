import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseFrontmatter, readClaudeConfig } from "../daemon/claude-config";

describe("parseFrontmatter", () => {
  test("extracts name + description from a typical agent frontmatter", () => {
    const md = [
      "---",
      "name: security-reviewer",
      "description: Audits Highflame code for auth violations.",
      "tools: Read, Grep, Glob, Bash",
      "---",
      "",
      "Body content here.",
    ].join("\n");
    const fm = parseFrontmatter(md);
    expect(fm.name).toBe("security-reviewer");
    expect(fm.description).toBe(
      "Audits Highflame code for auth violations.",
    );
    expect(fm.tools).toBe("Read, Grep, Glob, Bash");
  });

  test("returns empty object when no frontmatter", () => {
    expect(parseFrontmatter("just markdown\n")).toEqual({});
  });

  test("strips quoted strings", () => {
    const md = ["---", 'name: "quoted-name"', "description: 'single-quoted'", "---"].join("\n");
    const fm = parseFrontmatter(md);
    expect(fm.name).toBe("quoted-name");
    expect(fm.description).toBe("single-quoted");
  });

  test("ignores yaml comment lines and unmatched", () => {
    const md = ["---", "# this is a comment", "name: ok", "no-colon-line", "---"].join("\n");
    const fm = parseFrontmatter(md);
    expect(fm.name).toBe("ok");
    expect(Object.keys(fm)).toEqual(["name"]);
  });
});

describe("readClaudeConfig", () => {
  let tmp: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeoid-cc-"));
    originalHome = process.env.HOME;
    process.env.HOME = path.join(tmp, "home");
    await fs.mkdir(path.join(tmp, "home", ".claude"), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function writeAgent(root: string, name: string, opts: { description?: string; tools?: string } = {}) {
    const dir = path.join(root, "agents");
    await fs.mkdir(dir, { recursive: true });
    const fm = ["---", `name: ${name}`];
    if (opts.description) fm.push(`description: ${opts.description}`);
    if (opts.tools) fm.push(`tools: ${opts.tools}`);
    fm.push("---", "", "body");
    await fs.writeFile(path.join(dir, `${name}.md`), fm.join("\n"));
  }

  async function writeSkill(root: string, name: string, opts: { description?: string; nested?: boolean } = {}) {
    const fm = ["---", `name: ${name}`];
    if (opts.description) fm.push(`description: ${opts.description}`);
    fm.push("---", "", "body");
    if (opts.nested) {
      const dir = path.join(root, "skills", name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "SKILL.md"), fm.join("\n"));
    } else {
      const dir = path.join(root, "skills");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${name}.md`), fm.join("\n"));
    }
  }

  test("reads global agents and skills with frontmatter", async () => {
    const globalRoot = path.join(tmp, "home", ".claude");
    await writeAgent(globalRoot, "security-reviewer", {
      description: "Audits auth.",
      tools: "Read, Grep",
    });
    await writeAgent(globalRoot, "no-frontmatter");
    await writeSkill(globalRoot, "add-detector", {
      description: "Scaffolds detector.",
      nested: true,
    });
    await writeSkill(globalRoot, "flat-skill");

    const workdir = path.join(tmp, "workdir");
    await fs.mkdir(workdir, { recursive: true });
    const snap = await readClaudeConfig(workdir);

    expect(snap.agents.map((a) => a.name).sort()).toEqual([
      "no-frontmatter",
      "security-reviewer",
    ]);
    const securityAgent = snap.agents.find((a) => a.name === "security-reviewer");
    expect(securityAgent?.scope).toBe("global");
    expect(securityAgent?.description).toBe("Audits auth.");
    expect(securityAgent?.tools).toEqual(["Read", "Grep"]);

    expect(snap.skills.map((s) => s.name).sort()).toEqual([
      "add-detector",
      "flat-skill",
    ]);
  });

  test("workdir overrides do not collide; both surface", async () => {
    const globalRoot = path.join(tmp, "home", ".claude");
    const workdir = path.join(tmp, "workdir");
    const workRoot = path.join(workdir, ".claude");
    await fs.mkdir(workdir, { recursive: true });

    await writeAgent(globalRoot, "shared-name", { description: "Global one." });
    await writeAgent(workRoot, "shared-name", { description: "Workdir one." });
    await writeAgent(workRoot, "workdir-only", { description: "Local." });

    const snap = await readClaudeConfig(workdir);
    expect(snap.agents.map((a) => `${a.scope}:${a.name}`).sort()).toEqual([
      "global:shared-name",
      "workdir:shared-name",
      "workdir:workdir-only",
    ]);
  });

  test("parses mcpServers and hooks from settings.json (env values stripped)", async () => {
    const workdir = path.join(tmp, "workdir");
    const workRoot = path.join(workdir, ".claude");
    await fs.mkdir(workRoot, { recursive: true });
    const settings = {
      mcpServers: {
        gitnexus: {
          command: "gitnexus",
          args: ["mcp"],
          env: { GITNEXUS_TOKEN: "should-not-leak" },
        },
        _comment: { command: "ignored" },
      },
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [
              { type: "command", command: "format.sh" },
              { type: "command", command: "lint.sh" },
            ],
          },
        ],
        _comment: "ignored",
      },
    };
    await fs.writeFile(
      path.join(workRoot, "settings.json"),
      JSON.stringify(settings),
    );

    const snap = await readClaudeConfig(workdir);
    expect(snap.mcpServers).toHaveLength(1);
    const gitnexus = snap.mcpServers[0]!;
    expect(gitnexus.name).toBe("gitnexus");
    expect(gitnexus.command).toBe("gitnexus");
    expect(gitnexus.args).toEqual(["mcp"]);
    expect(gitnexus.envKeys).toEqual(["GITNEXUS_TOKEN"]);
    // The actual env value must NEVER ship.
    expect(JSON.stringify(snap.mcpServers)).not.toContain("should-not-leak");

    expect(snap.hooks).toHaveLength(2);
    expect(snap.hooks.map((h) => h.command)).toEqual(["format.sh", "lint.sh"]);
    expect(snap.hooks[0]!.event).toBe("PostToolUse");
    expect(snap.hooks[0]!.matcher).toBe("Edit|Write");
  });

  test("malformed settings.json degrades gracefully", async () => {
    const workdir = path.join(tmp, "workdir");
    const workRoot = path.join(workdir, ".claude");
    await fs.mkdir(workRoot, { recursive: true });
    await fs.writeFile(path.join(workRoot, "settings.json"), "{not json");
    const snap = await readClaudeConfig(workdir);
    expect(snap.mcpServers).toEqual([]);
    expect(snap.hooks).toEqual([]);
  });

  test("reads MCP servers from ~/.claude.json (Claude Code primary config)", async () => {
    const workdir = path.join(tmp, "workdir");
    await fs.mkdir(workdir, { recursive: true });
    const claudeJson = {
      mcpServers: {
        "highflame-platform": {
          type: "http",
          url: "https://mcp.example/highflame-platform",
          headers: { "X-Highflame-APIKey": "should-not-leak" },
        },
        "stdio-tool": {
          command: "/usr/local/bin/some-mcp",
          args: ["--flag", "x"],
          env: { TOKEN: "also-should-not-leak" },
        },
      },
      projects: {
        [workdir]: {
          mcpServers: {
            "workdir-only": {
              type: "http",
              url: "http://localhost:9000/mcp",
            },
          },
        },
      },
    };
    await fs.writeFile(
      path.join(tmp, "home", ".claude.json"),
      JSON.stringify(claudeJson),
    );

    const snap = await readClaudeConfig(workdir);
    const byName = new Map(snap.mcpServers.map((m) => [m.name, m]));
    expect(byName.size).toBe(3);

    const hf = byName.get("highflame-platform")!;
    expect(hf.scope).toBe("global");
    expect(hf.type).toBe("http");
    expect(hf.url).toBe("https://mcp.example/highflame-platform");
    expect(hf.headerKeys).toEqual(["X-Highflame-APIKey"]);

    const stdio = byName.get("stdio-tool")!;
    expect(stdio.command).toBe("/usr/local/bin/some-mcp");
    expect(stdio.args).toEqual(["--flag", "x"]);
    expect(stdio.envKeys).toEqual(["TOKEN"]);

    const wd = byName.get("workdir-only")!;
    expect(wd.scope).toBe("workdir");

    // Bearer / API key values must NEVER be in the wire payload.
    const wireJson = JSON.stringify(snap.mcpServers);
    expect(wireJson).not.toContain("should-not-leak");
    expect(wireJson).not.toContain("also-should-not-leak");
  });

  test(".mcp.json in workdir is treated as a workdir-scoped settings file", async () => {
    const workdir = path.join(tmp, "workdir");
    await fs.mkdir(workdir, { recursive: true });
    await fs.writeFile(
      path.join(workdir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          local: { command: "./run-mcp.sh" },
        },
      }),
    );
    const snap = await readClaudeConfig(workdir);
    expect(snap.mcpServers).toHaveLength(1);
    expect(snap.mcpServers[0]!.name).toBe("local");
    expect(snap.mcpServers[0]!.scope).toBe("workdir");
    expect(snap.mcpServers[0]!.path.endsWith(".mcp.json")).toBe(true);
  });

  test("missing .claude tree yields empty snapshot", async () => {
    const workdir = path.join(tmp, "fresh-workdir");
    await fs.mkdir(workdir, { recursive: true });
    const snap = await readClaudeConfig(workdir);
    expect(snap.agents).toEqual([]);
    expect(snap.skills).toEqual([]);
    expect(snap.mcpServers).toEqual([]);
    expect(snap.hooks).toEqual([]);
  });
});
