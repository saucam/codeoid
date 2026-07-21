import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { PhaseDef } from "./interface";
import { PipelineManager } from "./manager";
import { PipelineStore } from "./store";

const phases: PhaseDef[] = [
  { id: "one", kind: "noop", gate: "always" },
  { id: "two", kind: "noop", gate: "always" },
];
const tenant = { accountId: "acct", projectId: "proj", createdBy: "user" };

describe("PipelineManager", () => {
  test("create persists a draft pipeline", () => {
    const store = new PipelineStore(new Database(":memory:"));
    const mgr = new PipelineManager(store);
    const p = mgr.create({ name: "REQ-1", phases, ...tenant });
    expect(p.status).toBe("draft");
    expect(mgr.get(p.id)?.id).toBe(p.id);
    expect(store.get(p.id)?.name).toBe("REQ-1");
  });

  test("advance halts at each boundary; approving each drives to done and persists", async () => {
    const store = new PipelineStore(new Database(":memory:"));
    const mgr = new PipelineManager(store);
    const p = mgr.create({ name: "REQ-1", phases, ...tenant });
    let s = await mgr.advance(p.id);
    expect(s.status).toBe("halted"); // every phase halts for a human decision
    // Approve each boundary → done.
    for (const requestId of ["exit:one", "exit:two"]) {
      s = await mgr.answer(p.id, requestId, { approved: true });
    }
    expect(s.status).toBe("done");
    expect(store.get(p.id)?.status).toBe("done");
  });

  test("advance throws on an unknown id", async () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    await expect(mgr.advance("nope")).rejects.toThrow("not found");
  });

  test("list is tenant-scoped", () => {
    const store = new PipelineStore(new Database(":memory:"));
    const mgr = new PipelineManager(store);
    mgr.create({ name: "a", phases, ...tenant });
    mgr.create({ name: "b", phases, accountId: "other", projectId: "proj", createdBy: "user" });
    expect(mgr.list("acct", "proj")).toHaveLength(1);
  });

  test("abort marks a pipeline abandoned; unknown ids return undefined", async () => {
    const store = new PipelineStore(new Database(":memory:"));
    const mgr = new PipelineManager(store);
    const p = mgr.create({ name: "a", phases, ...tenant });
    const gone = await mgr.abort(p.id);
    expect(gone?.status).toBe("abandoned");
    expect(store.get(p.id)?.status).toBe("abandoned");
    expect(await mgr.abort("missing")).toBeUndefined();
  });

  test("resume rehydrates a halted pipeline into a fresh manager (restart survival)", async () => {
    const store = new PipelineStore(new Database(":memory:"));
    const mgr = new PipelineManager(store);
    const halting: PhaseDef[] = [{ id: "one", kind: "noop", gate: "manual" }]; // halts
    const p = mgr.create({ name: "REQ-1", phases: halting, ...tenant });
    expect((await mgr.advance(p.id)).status).toBe("halted");

    // Simulate a daemon restart: a brand-new manager over the same store.
    const revived = new PipelineManager(store);
    const back = revived.get(p.id);
    expect(back?.status).toBe("halted");
    expect(back?.phases[0].state.status).toBe("halted");
  });
});
