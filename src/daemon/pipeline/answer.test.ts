import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { PhaseDef } from "./interface";
import { PipelineManager } from "./manager";
import { PipelineStore } from "./store";

const tenant = { accountId: "acct", projectId: "proj", createdBy: "user" };

function mgr(): PipelineManager {
  return new PipelineManager(new PipelineStore(new Database(":memory:")));
}

/** A pipeline whose first phase halts on the `manual` gate, followed by a phase
 *  that passes — so answering resumes into the tail. */
const halting: PhaseDef[] = [
  { id: "gate", kind: "noop", gate: "manual" },
  { id: "tail", kind: "noop", gate: "always" },
];

describe("PipelineManager.answer (halt → resume)", () => {
  test("approve resolves the halted phase and resumes to done", async () => {
    const m = mgr();
    const p = m.create({ name: "REQ-1", phases: halting, ...tenant });
    const halted = await m.advance(p.id);
    expect(halted.status).toBe("halted");
    expect(halted.phases[0].state.status).toBe("halted");

    const done = await m.answer(p.id, "gate:gate", { approved: true, value: "LGTM" });
    expect(done.status).toBe("done");
    expect(done.phases[0].state).toMatchObject({ status: "passed", summary: "LGTM" });
    expect(done.phases[1].state.status).toBe("passed");
  });

  test("reject fails the phase and the pipeline", async () => {
    const m = mgr();
    const p = m.create({ name: "REQ-1", phases: halting, ...tenant });
    await m.advance(p.id);
    const failed = await m.answer(p.id, "gate:gate", { approved: false, value: "nope" });
    expect(failed.status).toBe("failed");
    expect(failed.phases[0].state).toMatchObject({ status: "failed", reason: "nope" });
  });

  test("approving the final phase completes without a further advance", async () => {
    const m = mgr();
    const p = m.create({ name: "REQ-1", phases: [{ id: "only", kind: "noop", gate: "manual" }], ...tenant });
    await m.advance(p.id);
    const done = await m.answer(p.id, "gate:only", { approved: true });
    expect(done.status).toBe("done");
    expect(done.phases[0].state).toMatchObject({ status: "passed", summary: "approved" });
  });

  test("rejects a stale requestId", async () => {
    const m = mgr();
    const p = m.create({ name: "REQ-1", phases: halting, ...tenant });
    await m.advance(p.id);
    await expect(m.answer(p.id, "gate:wrong", { approved: true })).rejects.toThrow("stale requestId");
  });

  test("throws when the pipeline is not halted", async () => {
    const m = mgr();
    const p = m.create({ name: "REQ-1", phases: [{ id: "one", kind: "noop", gate: "always" }], ...tenant });
    await m.advance(p.id); // runs straight to done
    await expect(m.answer(p.id, "gate:one", { approved: true })).rejects.toThrow("not halted");
  });

  test("throws on an unknown pipeline id", async () => {
    await expect(mgr().answer("nope", "gate:x", { approved: true })).rejects.toThrow("not found");
  });

  test("the resolved state persists across a restart", async () => {
    const store = new PipelineStore(new Database(":memory:"));
    const m = new PipelineManager(store);
    const p = m.create({ name: "REQ-1", phases: halting, ...tenant });
    await m.advance(p.id);
    await m.answer(p.id, "gate:gate", { approved: true });
    // Fresh manager over the same store sees the completed pipeline.
    expect(new PipelineManager(store).get(p.id)?.status).toBe("done");
  });
});
