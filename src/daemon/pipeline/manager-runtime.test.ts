import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { PipelineState, SkillPlugin } from "./interface";
import { PipelineManager } from "./manager";
import { PipelineStore } from "./store";

const tenant = { accountId: "a", projectId: "p", createdBy: "u" };
const mgr = (): PipelineManager => new PipelineManager(new PipelineStore(new Database(":memory:")));

describe("create() validation", () => {
  test("rejects an empty phase list", () => {
    expect(() => mgr().create({ name: "x", phases: [], ...tenant })).toThrow("at least one phase");
  });
  test("rejects an unknown phase kind", () => {
    expect(() => mgr().create({ name: "x", phases: [{ id: "one", kind: "nope" }], ...tenant })).toThrow(
      /unknown kind/,
    );
  });
  test("rejects an unknown gate / entry gate", () => {
    expect(() =>
      mgr().create({ name: "x", phases: [{ id: "one", kind: "noop", gate: "nope" }], ...tenant }),
    ).toThrow(/unknown gate/);
    expect(() =>
      mgr().create({ name: "x", phases: [{ id: "one", kind: "noop", entryGate: "nope" }], ...tenant }),
    ).toThrow(/unknown entry gate/);
  });
  test("rejects an unknown skill", () => {
    expect(() =>
      mgr().create({ name: "x", phases: [{ id: "one", kind: "skill", skill: "nope" }], ...tenant }),
    ).toThrow(/unknown skill/);
  });
  test("accepts built-in kinds + gates", () => {
    expect(mgr().create({ name: "x", phases: [{ id: "one", kind: "noop", gate: "always" }], ...tenant }).status).toBe(
      "draft",
    );
  });
  test("rejects kind:skill with no skill id", () => {
    expect(() => mgr().create({ name: "x", phases: [{ id: "one", kind: "skill" }], ...tenant })).toThrow(
      /requires a skill id/,
    );
  });
  test("rejects duplicate phase ids", () => {
    expect(() =>
      mgr().create({
        name: "x",
        phases: [
          { id: "dup", kind: "noop" },
          { id: "dup", kind: "noop" },
        ],
        ...tenant,
      }),
    ).toThrow(/duplicate phase id/);
  });
});

describe("get() isolation", () => {
  test("mutating a returned pipeline does not corrupt the cache", () => {
    const m = mgr();
    const p = m.create({ name: "x", phases: [{ id: "one", kind: "noop", gate: "always" }], ...tenant });
    const got = m.get(p.id);
    if (got) {
      got.status = "failed";
      got.name = "hacked";
    }
    const again = m.get(p.id);
    expect(again?.status).toBe("draft");
    expect(again?.name).toBe("x");
  });
});

describe("abort()", () => {
  test("marks the pipeline abandoned and fails the unresolved active phase", async () => {
    const m = mgr();
    const p = m.create({ name: "x", phases: [{ id: "one", kind: "noop", gate: "manual" }], ...tenant });
    const gone = await m.abort(p.id);
    expect(gone?.status).toBe("abandoned");
    expect(gone?.phases[0].state.status).toBe("failed");
  });
  test("is a no-op on an already-terminal pipeline", async () => {
    const m = mgr();
    const p = m.create({ name: "x", phases: [{ id: "one", kind: "noop", gate: "always" }], ...tenant });
    const halted = await m.advance(p.id); // runs phase → halts for human review
    const st = halted.phases[0].state;
    if (st.status !== "halted") throw new Error("expected a boundary halt");
    const done = await m.answer(p.id, st.requestId, { approved: true }); // approve → done
    expect(done.status).toBe("done");
    expect((await m.abort(p.id))?.status).toBe("done"); // abort no-ops on terminal
  });
});

describe("driveResumable()", () => {
  test("re-drives draft/running to their next boundary but leaves halted parked", async () => {
    const store = new PipelineStore(new Database(":memory:"));
    const m = new PipelineManager(store);
    const draft = m.create({ name: "d", phases: [{ id: "one", kind: "noop", gate: "always" }], ...tenant });
    const halting = m.create({ name: "h", phases: [{ id: "one", kind: "noop", gate: "manual" }], ...tenant });
    await m.advance(halting.id); // → halted

    // Fresh manager (restart): resume() caches both; driveResumable re-drives the
    // draft. Every phase halts for a human, so the draft advances from draft to
    // its first boundary halt (it ran) rather than auto-completing.
    const revived = new PipelineManager(store);
    await revived.driveResumable();
    const d = revived.get(draft.id);
    expect(d?.status).toBe("halted");
    expect(d?.phases[0].state.status).toBe("halted"); // the phase actually ran
    expect(revived.get(halting.id)?.status).toBe("halted"); // already halted → parked
  });

  test("re-drives a persisted 'running' pipeline (crash mid-run)", async () => {
    const store = new PipelineStore(new Database(":memory:"));
    // A pipeline persisted mid-run at a crash: status running, next phase pending.
    const running: PipelineState = {
      id: "r1",
      name: "x",
      phases: [
        { def: { id: "one", kind: "noop", gate: "always" }, state: { status: "passed", summary: "" } },
        { def: { id: "two", kind: "noop", gate: "always" }, state: { status: "pending" } },
      ],
      cursor: 1,
      status: "running",
      accountId: "a",
      projectId: "p",
      createdBy: "u",
      createdAt: 1,
      updatedAt: 1,
    };
    store.save(running);
    const revived = new PipelineManager(store);
    await revived.driveResumable();
    // Phase "two" runs on resume and halts at its boundary (never auto-done).
    const r = revived.get("r1");
    expect(r?.status).toBe("halted");
    expect(r?.cursor).toBe(1);
    expect(r?.phases[1].state.status).toBe("halted");
  });
});

describe("advance() serialization", () => {
  test("concurrent advances don't double-run a phase", async () => {
    const m = mgr();
    let calls = 0;
    const skill: SkillPlugin = {
      id: "work",
      kind: "fn",
      async run() {
        await new Promise((r) => setTimeout(r, 5));
        calls += 1;
        return { summary: "done" };
      },
    };
    m.registries.skills.register(skill);
    const p = m.create({ name: "x", phases: [{ id: "one", kind: "skill", skill: "work" }], ...tenant });
    const [a, b] = await Promise.all([m.advance(p.id), m.advance(p.id)]);
    // The phase runs once and halts for review; serialization means the second
    // advance saw the already-halted pipeline (no double-run).
    expect(a.status).toBe("halted");
    expect(b.status).toBe("halted");
    expect(calls).toBe(1);
  });
});
