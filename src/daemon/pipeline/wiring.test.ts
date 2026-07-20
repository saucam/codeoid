import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PhaseDef } from "./interface";
import { createPipelineManagerFromConfig } from "./wiring";

const phases: PhaseDef[] = [{ id: "one", kind: "noop", gate: "always" }];
const tenant = { accountId: "acct", projectId: "proj", createdBy: "user" };

const dbFiles: string[] = [];
function tmpDb(): string {
  const p = join(tmpdir(), `codeoid-pipeline-${randomUUID()}.db`);
  dbFiles.push(p);
  return p;
}

afterEach(() => {
  for (const p of dbFiles.splice(0)) {
    for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true });
  }
});

describe("createPipelineManagerFromConfig", () => {
  test("returns undefined when config is absent", () => {
    expect(createPipelineManagerFromConfig(undefined)).toBeUndefined();
  });

  test("returns undefined when the pipeline is disabled (the default)", () => {
    expect(createPipelineManagerFromConfig({ dbPath: tmpDb() })).toBeUndefined();
    expect(createPipelineManagerFromConfig({ dbPath: tmpDb(), pipeline: { enabled: false } })).toBeUndefined();
  });

  test("returns a manager when enabled", () => {
    const mgr = createPipelineManagerFromConfig({ dbPath: tmpDb(), pipeline: { enabled: true } });
    expect(mgr).toBeDefined();
    const p = mgr?.create({ name: "REQ-1", phases, ...tenant });
    expect(mgr?.get(p?.id ?? "")?.name).toBe("REQ-1");
  });

  test("shares the daemon DB file so a fresh manager resumes (restart survival)", async () => {
    const dbPath = tmpDb();
    const mgr = createPipelineManagerFromConfig({ dbPath, pipeline: { enabled: true } });
    const halting: PhaseDef[] = [{ id: "one", kind: "noop", gate: "manual" }]; // halts
    const p = mgr?.create({ name: "REQ-1", phases: halting, ...tenant });
    expect((await mgr?.advance(p?.id ?? ""))?.status).toBe("halted");

    // Simulate a daemon restart: a brand-new manager over the same DB file.
    const revived = createPipelineManagerFromConfig({ dbPath, pipeline: { enabled: true } });
    expect(revived?.get(p?.id ?? "")?.status).toBe("halted");
  });
});
