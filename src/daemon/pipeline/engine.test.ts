import { describe, expect, test } from "bun:test";
import { registerBuiltins } from "./builtin";
import { PipelineEngine } from "./engine";
import type { PhaseDef, PhaseKind, PipelineRegistries, PipelineState } from "./interface";
import { createRegistries } from "./registry";

function pipeline(phases: PhaseDef[]): PipelineState {
  const ts = 1;
  return {
    id: "p",
    name: "p",
    phases: phases.map((def) => ({ def, state: { status: "pending" } })),
    cursor: 0,
    status: "draft",
    accountId: "a",
    projectId: "p",
    createdBy: "u",
    createdAt: ts,
    updatedAt: ts,
  };
}

function regs(): PipelineRegistries {
  const r = createRegistries();
  registerBuiltins(r);
  return r;
}

describe("PipelineEngine.run", () => {
  test("runs noop phases with a passing gate to done", async () => {
    const out = await new PipelineEngine(regs()).run(
      pipeline([
        { id: "one", kind: "noop", gate: "always" },
        { id: "two", kind: "noop", gate: "always" },
      ]),
    );
    expect(out.status).toBe("done");
    expect(out.cursor).toBe(2);
    expect(out.phases.every((p) => p.state.status === "passed")).toBe(true);
  });

  test("a phase with no gate passes", async () => {
    const out = await new PipelineEngine(regs()).run(pipeline([{ id: "one", kind: "noop" }]));
    expect(out.status).toBe("done");
  });

  test("a failing exit gate with the default onFail halts", async () => {
    const out = await new PipelineEngine(regs()).run(
      pipeline([{ id: "one", kind: "noop", gate: "manual" }]),
    );
    expect(out.status).toBe("halted");
    const st = out.phases[0].state;
    expect(st.status).toBe("halted");
    if (st.status === "halted") expect(st.requestId).toBe("gate:one");
  });

  test("a failing gate with onFail:abort fails the pipeline", async () => {
    const out = await new PipelineEngine(regs()).run(
      pipeline([{ id: "one", kind: "noop", gate: "manual", onFail: { action: "abort" } }]),
    );
    expect(out.status).toBe("failed");
  });

  test("an unknown phase kind fails", async () => {
    const out = await new PipelineEngine(regs()).run(
      pipeline([{ id: "one", kind: "does-not-exist", onFail: { action: "abort" } }]),
    );
    expect(out.status).toBe("failed");
    const st = out.phases[0].state;
    if (st.status === "failed") expect(st.reason).toContain("unknown phase kind");
  });

  test("retry: a flaky kind succeeds within budget", async () => {
    const r = regs();
    let calls = 0;
    const flaky: PhaseKind = {
      id: "flaky",
      async run() {
        calls += 1;
        return calls < 3 ? { outcome: "failed", reason: "not yet" } : { outcome: "passed" };
      },
    };
    r.phases.register(flaky);
    const out = await new PipelineEngine(r).run(
      pipeline([{ id: "one", kind: "flaky", onFail: { action: "retry", max: 5 } }]),
    );
    expect(out.status).toBe("done");
    expect(calls).toBe(3);
  });

  test("retry: an exhausted budget fails with the attempt count", async () => {
    const r = regs();
    r.phases.register({
      id: "alwaysfail",
      async run() {
        return { outcome: "failed", reason: "nope" };
      },
    });
    const out = await new PipelineEngine(r).run(
      pipeline([{ id: "one", kind: "alwaysfail", onFail: { action: "retry", max: 2 } }]),
    );
    expect(out.status).toBe("failed");
    const st = out.phases[0].state;
    if (st.status === "failed") expect(st.attempts).toBe(2);
  });

  test("an entry gate failure halts before the kind runs", async () => {
    const r = regs();
    let ran = false;
    r.phases.register({
      id: "spy",
      async run() {
        ran = true;
        return { outcome: "passed" };
      },
    });
    const out = await new PipelineEngine(r).run(
      pipeline([{ id: "one", kind: "spy", entryGate: "manual" }]),
    );
    expect(out.status).toBe("halted");
    expect(ran).toBe(false);
  });

  test("run is a no-op on an already-terminal state", async () => {
    const done: PipelineState = { ...pipeline([{ id: "one", kind: "noop" }]), status: "done" };
    const out = await new PipelineEngine(regs()).run(done);
    expect(out.status).toBe("done");
    expect(out.phases[0].state.status).toBe("pending");
  });

  test("a halted pipeline is not advanced by run", async () => {
    const halted: PipelineState = { ...pipeline([{ id: "one", kind: "noop" }]), status: "halted" };
    const out = await new PipelineEngine(regs()).run(halted);
    expect(out.status).toBe("halted");
  });

  test("a throwing phase kind is caught and fails the phase (no crash)", async () => {
    const r = regs();
    r.phases.register({
      id: "boom",
      async run() {
        throw new Error("kaboom");
      },
    });
    const out = await new PipelineEngine(r).run(
      pipeline([{ id: "one", kind: "boom", onFail: { action: "abort" } }]),
    );
    expect(out.status).toBe("failed");
    const st = out.phases[0].state;
    if (st.status === "failed") expect(st.reason).toContain("kaboom");
  });

  test("a throwing gate is caught and fails the phase (no crash)", async () => {
    const r = regs();
    r.gates.register({
      id: "boomgate",
      at: "exit",
      async evaluate() {
        throw new Error("gate-boom");
      },
    });
    const out = await new PipelineEngine(r).run(
      pipeline([{ id: "one", kind: "noop", gate: "boomgate", onFail: { action: "abort" } }]),
    );
    expect(out.status).toBe("failed");
    const st = out.phases[0].state;
    if (st.status === "failed") expect(st.reason).toContain("gate-boom");
  });
});
