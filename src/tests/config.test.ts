/**
 * Config loader tests — exercise the layered precedence, env overrides,
 * path resolution, and failure modes. Tests pass a controlled env object
 * instead of touching process.env so we don't leak state between runs.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveZeroidUrl } from "../config.js";

let tmp: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-config-"));
  configPath = join(tmp, "config.json");
});

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

function writeConfig(obj: unknown): void {
  writeFileSync(configPath, JSON.stringify(obj, null, 2));
}

describe("loadConfig — defaults", () => {
  it("returns sane defaults with no file + no env", () => {
    const c = loadConfig({ configPath, env: {} });
    expect(c.daemonUrl).toBe("ws://127.0.0.1:7400");
    // Ships pointing at the Highflame SaaS issuer (preset "highflame").
    expect(c.zeroidUrl).toBe("https://auth.highflame.ai");
    // Issuer claim is pinned to the resolved base URL by default.
    expect(c.auth.issuer).toBe("https://auth.highflame.ai");
    expect(c.compress.enabled).toBe(false);
    expect(c.compress.minBytes).toBe(1024);
    expect(c.workspaceIndex.enabled).toBe(true);
    expect(c.memory?.enabled).toBe(true);
    expect(c.memory?.clusters.enabled).toBe(false);
    expect(c.telemetry.osc8).toBe("auto");
  });

  it("agentIdentity stays undefined when no file/env supplies it", () => {
    const c = loadConfig({ configPath, env: {} });
    expect(c.agentIdentity).toBeUndefined();
  });
});

describe("loadConfig — file values", () => {
  it("honors a full config file", () => {
    writeConfig({
      daemonUrl: "ws://10.0.0.1:9999",
      apiKey: "zid_sk_xxx",
      compress: { enabled: true, excludeCommands: ["curl"], minBytes: 2048 },
      memory: { enabled: false, dbPath: "/tmp/mem.db", clusters: { enabled: true } },
      workspaceIndex: { enabled: false, episodeThreshold: 99, timeThresholdMs: 5000, debounceMs: 1000 },
      telemetry: { osc8: "force" },
      agentIdentity: { accountId: "acme", projectId: "prod" },
    });
    const c = loadConfig({ configPath, env: {} });
    expect(c.daemonUrl).toBe("ws://10.0.0.1:9999");
    expect(c.apiKey).toBe("zid_sk_xxx");
    expect(c.compress.enabled).toBe(true);
    expect(c.compress.excludeCommands).toEqual(["curl"]);
    expect(c.compress.minBytes).toBe(2048);
    expect(c.memory?.enabled).toBe(false);
    expect(c.memory?.clusters.enabled).toBe(true);
    expect(c.workspaceIndex.enabled).toBe(false);
    expect(c.workspaceIndex.episodeThreshold).toBe(99);
    expect(c.telemetry.osc8).toBe("force");
    expect(c.agentIdentity).toEqual({ accountId: "acme", projectId: "prod" });
  });

  it("accepts a partial file (missing sections get defaults)", () => {
    writeConfig({ apiKey: "legacy_only" });
    const c = loadConfig({ configPath, env: {} });
    expect(c.apiKey).toBe("legacy_only");
    expect(c.compress.enabled).toBe(false);
    expect(c.workspaceIndex.enabled).toBe(true);
    expect(c.memory?.enabled).toBe(true);
  });
});

describe("loadConfig — env precedence", () => {
  it("env overrides file on every field type", () => {
    writeConfig({
      daemonUrl: "ws://file",
      compress: { enabled: false, minBytes: 100, excludeCommands: ["a"] },
    });
    const c = loadConfig({
      configPath,
      env: {
        CODEOID_DAEMON_URL: "ws://env",
        CODEOID_COMPRESS: "1",
        CODEOID_COMPRESS_MIN_BYTES: "4096",
        CODEOID_COMPRESS_EXCLUDE: "curl, wget ,playwright",
      },
    });
    expect(c.daemonUrl).toBe("ws://env");
    expect(c.compress.enabled).toBe(true);
    expect(c.compress.minBytes).toBe(4096);
    // CSV parsing trims whitespace and drops empties.
    expect(c.compress.excludeCommands).toEqual(["curl", "wget", "playwright"]);
  });

  it("boolean env accepts 1/true, ignores empty", () => {
    writeConfig({ memory: { enabled: true } });
    const c1 = loadConfig({ configPath, env: { CODEOID_MEMORY: "1" } });
    expect(c1.memory?.enabled).toBe(true);

    const c2 = loadConfig({ configPath, env: { CODEOID_MEMORY: "true" } });
    expect(c2.memory?.enabled).toBe(true);

    const c3 = loadConfig({ configPath, env: { CODEOID_MEMORY: "0" } });
    expect(c3.memory?.enabled).toBe(false);

    // Empty string = no override — file value wins.
    const c4 = loadConfig({ configPath, env: { CODEOID_MEMORY: "" } });
    expect(c4.memory?.enabled).toBe(true);
  });

  it("ANTHROPIC_API_KEY flows into labeling", () => {
    const c = loadConfig({
      configPath,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
    });
    expect(c.labeling.anthropicApiKey).toBe("sk-ant-test");
  });

  it("int env rejects non-numeric", () => {
    expect(() =>
      loadConfig({
        configPath,
        env: { CODEOID_COMPRESS_MIN_BYTES: "notanumber" },
      }),
    ).toThrow(/Expected integer/);
  });
});

describe("loadConfig — path resolution", () => {
  it("expands ~ in file paths", () => {
    writeConfig({ memory: { dbPath: "~/custom.db" } });
    const c = loadConfig({ configPath, env: {} });
    expect(c.memory?.dbPath.startsWith("/")).toBe(true);
    expect(c.memory?.dbPath.endsWith("custom.db")).toBe(true);
    expect(c.memory?.dbPath.includes("~")).toBe(false);
  });

  it("resolves relative paths against the config dir", () => {
    writeConfig({ dbPath: "codeoid.db" });
    const c = loadConfig({ configPath, env: {} });
    expect(c.dbPath).toMatch(/codeoid\.db$/);
    // Resolved to an absolute path.
    expect(c.dbPath.startsWith("/")).toBe(true);
  });

  it("preserves absolute paths verbatim", () => {
    writeConfig({ dbPath: "/tmp/explicit.db" });
    const c = loadConfig({ configPath, env: {} });
    expect(c.dbPath).toBe("/tmp/explicit.db");
  });
});

describe("loadConfig — failure modes", () => {
  it("loud-fails on malformed JSON", () => {
    writeFileSync(configPath, "{ not valid json");
    expect(() => loadConfig({ configPath, env: {} })).toThrow(/Failed to parse/);
  });

  it("loud-fails on schema violation", () => {
    writeConfig({ compress: { minBytes: -1 } }); // zod: nonnegative
    expect(() => loadConfig({ configPath, env: {} })).toThrow(/Invalid config/);
  });

  it("no file present — succeeds with defaults", () => {
    const c = loadConfig({ configPath: join(tmp, "missing.json"), env: {} });
    expect(c.compress.enabled).toBe(false);
  });
});

describe("resolveZeroidUrl", () => {
  it("maps known preset names to their URLs", () => {
    expect(resolveZeroidUrl("highflame")).toBe("https://auth.highflame.ai");
    expect(resolveZeroidUrl("highflame-dev")).toBe("https://auth-dev.highflame.dev");
    expect(resolveZeroidUrl("local")).toBe("http://localhost:8899");
  });

  it("passes through a full URL verbatim (trimming trailing slashes)", () => {
    expect(resolveZeroidUrl("https://zeroid.acme.com")).toBe("https://zeroid.acme.com");
    expect(resolveZeroidUrl("https://zeroid.acme.com/")).toBe("https://zeroid.acme.com");
    expect(resolveZeroidUrl("  http://10.0.0.1:8899  ")).toBe("http://10.0.0.1:8899");
  });

  it("assumes https:// for a bare host", () => {
    expect(resolveZeroidUrl("zeroid.acme.com")).toBe("https://zeroid.acme.com");
  });
});

describe("loadConfig — issuer presets + iss pinning", () => {
  it("resolves a preset name in the file to its URL and pins the issuer", () => {
    writeConfig({ zeroidUrl: "highflame-dev" });
    const c = loadConfig({ configPath, env: {} });
    expect(c.zeroidUrl).toBe("https://auth-dev.highflame.dev");
    expect(c.auth.baseUrl).toBe("https://auth-dev.highflame.dev");
    expect(c.auth.issuer).toBe("https://auth-dev.highflame.dev");
  });

  it("ZEROID_URL env (preset or URL) overrides the file", () => {
    writeConfig({ zeroidUrl: "highflame" });
    const c = loadConfig({ configPath, env: { ZEROID_URL: "local" } });
    expect(c.zeroidUrl).toBe("http://localhost:8899");
    expect(c.auth.issuer).toBe("http://localhost:8899");
  });

  it("an explicit issuer is NOT overwritten by the base-URL pin", () => {
    writeConfig({ zeroidUrl: "https://zeroid.acme.com", auth: { issuer: "https://id.acme.com" } });
    const c = loadConfig({ configPath, env: {} });
    expect(c.auth.baseUrl).toBe("https://zeroid.acme.com");
    expect(c.auth.issuer).toBe("https://id.acme.com");
  });

  it("ZEROID_ISSUER env overrides the pin", () => {
    writeConfig({ zeroidUrl: "highflame" });
    const c = loadConfig({ configPath, env: { ZEROID_ISSUER: "https://custom.issuer" } });
    expect(c.auth.issuer).toBe("https://custom.issuer");
  });
});

describe("loadConfig — oauth conditional", () => {
  it("populates oauth only when hmacSecret is set", () => {
    const none = loadConfig({ configPath, env: {} });
    expect(none.oauth).toBeUndefined();

    const viaEnv = loadConfig({
      configPath,
      env: { CODEOID_HMAC_SECRET: "deadbeef" },
    });
    expect(viaEnv.oauth).toBeDefined();
    expect(viaEnv.oauth?.hmacSecret).toBe("deadbeef");
    expect(viaEnv.oauth?.clientId).toBe("codeoid");
  });
});

describe("loadConfig — workspace index tunables", () => {
  it("exposes regen thresholds as top-level knobs", () => {
    writeConfig({
      workspaceIndex: {
        enabled: true,
        episodeThreshold: 10,
        timeThresholdMs: 30000,
        debounceMs: 5000,
      },
    });
    const c = loadConfig({ configPath, env: {} });
    expect(c.workspaceIndex.episodeThreshold).toBe(10);
    expect(c.workspaceIndex.timeThresholdMs).toBe(30000);
    expect(c.workspaceIndex.debounceMs).toBe(5000);
  });

  it("env override beats file for regen knob", () => {
    writeConfig({ workspaceIndex: { episodeThreshold: 10 } });
    const c = loadConfig({
      configPath,
      env: { CODEOID_WORKSPACE_INDEX_EPISODE_THRESHOLD: "25" },
    });
    expect(c.workspaceIndex.episodeThreshold).toBe(25);
  });
});
