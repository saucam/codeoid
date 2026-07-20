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
    await m.advance(p.id); // → done
    expect((await m.abort(p.id))?.status).toBe("done");
  });
});

describe("driveResumable()", () => {
  test("re-drives draft/running but leaves halted parked", async () => {
    const store = new PipelineStore(new Database(":memory:"));
    const m = new PipelineManager(store);
    const draft = m.create({ name: "d", phases: [{ id: "one", kind: "noop", gate: "always" }], ...tenant });
    const halting = m.create({ name: "h", phases: [{ id: "one", kind: "noop", gate: "manual" }], ...tenant });
    await m.advance(halting.id); // → halted

    // Fresh manager (restart): resume() caches both; driveResumable advances the draft only.
    const revived = new PipelineManager(store);
    await revived.driveResumable();
    expect(revived.get(draft.id)?.status).toBe("done");
    expect(revived.get(halting.id)?.status).toBe("halted");
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
    expect(revived.get("r1")?.status).toBe("done");
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
    expect(a.status).toBe("done");
    expect(b.status).toBe("done");
    expect(calls).toBe(1); // serialized → the second advance saw a completed pipeline
  });
});
