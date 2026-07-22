import { describe, expect, test } from "bun:test";
import { registerBuiltins } from "./builtin";
import { PipelineEngine } from "./engine";
import type { GatePlugin, PhaseDef, PhaseKind, PipelineRegistries, PipelineState } from "./interface";
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

/** Drive the engine to a terminal state by simulating a human Approve at every
 *  boundary halt (mirrors PipelineManager #answerInner approve) — since every
 *  phase now halts for a human, reaching "done" means approving each boundary. */
async function runApprovingAll(engine: PipelineEngine, state: PipelineState): Promise<PipelineState> {
  let s = await engine.run(state);
  let guard = 0;
  while (s.status === "halted" && guard++ < 100) {
    s = structuredClone(s);
    const ph = s.phases[s.cursor];
    if (ph) ph.state = { status: "passed", summary: ph.lastSummary };
    s.cursor += 1;
    s.status = s.cursor >= s.phases.length ? "done" : "running";
    if (s.status === "running") s = await engine.run(s);
  }
  return s;
}

describe("PipelineEngine.run", () => {
  test("halts at each phase boundary for review (a passing gate does NOT auto-advance); approving each reaches done", async () => {
    const engine = new PipelineEngine(regs());
    const p = pipeline([
      { id: "one", kind: "noop", gate: "always" },
      { id: "two", kind: "noop", gate: "always" },
    ]);
    // The first advance halts at phase 0 for a human decision, even though its
    // gate passes — the boundary halt is universal (docs/pipeline-run.md).
    const first = await engine.run(p);
    expect(first.status).toBe("halted");
    expect(first.cursor).toBe(0);
    const st0 = first.phases[0].state;
    if (st0.status === "halted") expect(st0.requestId).toBe("exit:one");
    // Approving each boundary walks the run to done.
    const out = await runApprovingAll(engine, p);
    expect(out.status).toBe("done");
    expect(out.cursor).toBe(2);
    expect(out.phases.every((p) => p.state.status === "passed")).toBe(true);
  });

  test("a phase with no gate halts for human review (never auto-advances)", async () => {
    const out = await new PipelineEngine(regs()).run(pipeline([{ id: "one", kind: "noop" }]));
    expect(out.status).toBe("halted");
    const st = out.phases[0].state;
    expect(st.status).toBe("halted");
    if (st.status === "halted") expect(st.requestId).toBe("exit:one");
  });

  test("a failing exit gate with the default onFail halts", async () => {
    const out = await new PipelineEngine(regs()).run(
      pipeline([{ id: "one", kind: "noop", gate: "manual" }]),
    );
    expect(out.status).toBe("halted");
    const st = out.phases[0].state;
    expect(st.status).toBe("halted");
    if (st.status === "halted") expect(st.requestId).toBe("exit:one");
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

  test("a THROWING kind fails the pipeline under the DEFAULT onFail (never halts)", async () => {
    const r = regs();
    r.phases.register({
      id: "boom",
      async run() {
        throw new Error("kaboom");
      },
    });
    // No onFail specified ⇒ the default is "halt". A gate rejection would halt
    // for a human, but an EXECUTION error must fail the run — a human can't
    // approve a crashed turn into a green "passed".
    const out = await new PipelineEngine(r).run(pipeline([{ id: "one", kind: "boom" }]));
    expect(out.status).toBe("failed");
    const st = out.phases[0].state;
    expect(st.status).toBe("failed");
    if (st.status === "failed") expect(st.reason).toContain("kaboom");
  });

  test("a kind returning outcome:failed fails the pipeline under the DEFAULT onFail", async () => {
    const r = regs();
    r.phases.register({
      id: "nope",
      async run() {
        return { outcome: "failed", reason: "explicit failure" };
      },
    });
    const out = await new PipelineEngine(r).run(pipeline([{ id: "one", kind: "nope" }]));
    expect(out.status).toBe("failed");
    const st = out.phases[0].state;
    expect(st.status).toBe("failed");
    if (st.status === "failed") expect(st.reason).toContain("explicit failure");
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
    // The retry loop is a MACHINE loop (no human); once it succeeds the phase
    // reaches its boundary and halts for the human — it does not fail.
    expect(out.status).toBe("halted");
    expect(calls).toBe(3);
    const st = out.phases[0].state;
    if (st.status === "halted") expect(st.requestId).toBe("exit:one");
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

  test("retry exhaustion via a failing GATE (not kind) fails the phase", async () => {
    const out = await new PipelineEngine(regs()).run(
      pipeline([{ id: "one", kind: "noop", gate: "manual", onFail: { action: "retry", max: 2 } }]),
    );
    expect(out.status).toBe("failed");
    const st = out.phases[0].state;
    if (st.status === "failed") expect(st.attempts).toBe(2);
  });

  test("MAX_STEPS exhaustion fails the pipeline terminally (no stuck 'running')", async () => {
    const r = regs();
    r.phases.register({
      id: "alwaysfail",
      async run() {
        return { outcome: "failed", reason: "never" };
      },
    });
    // A retry budget far above MAX_STEPS ⇒ the step guard trips first.
    const out = await new PipelineEngine(r).run(
      pipeline([{ id: "one", kind: "alwaysfail", onFail: { action: "retry", max: 1_000_000 } }]),
    );
    expect(out.status).toBe("failed");
    const st = out.phases[0].state;
    if (st.status === "failed") expect(st.reason).toContain("exceeded");
  });

  test("a phase kind mutating its ctx.pipeline cannot corrupt the engine", async () => {
    const r = regs();
    r.phases.register({
      id: "vandal",
      async run(ctx) {
        ctx.pipeline.cursor = 999;
        ctx.pipeline.status = "abandoned";
        ctx.pipeline.phases = [];
        return { outcome: "passed" };
      },
    });
    const out = await new PipelineEngine(r).run(
      pipeline([
        { id: "one", kind: "vandal" },
        { id: "two", kind: "noop" },
      ]),
    );
    // Vandal ran and halted at its boundary; its ctx-clone mutations (cursor 999,
    // status abandoned, phases []) did NOT leak into the engine's real state.
    expect(out.status).toBe("halted");
    expect(out.cursor).toBe(0);
    expect(out.phases).toHaveLength(2);
  });
});


// ── Deterministic phase detection (docs/pipeline-phase-detection.md) ─────────

/** A gate that resolves to a fixed verdict — for exercising skip / verify-bounce. */
function fixedGate(id: string, pass: boolean, reason?: string): GatePlugin {
  return { id, at: "exit", async evaluate() { return pass ? { pass: true } : { pass: false, reason }; } };
}

describe("PipelineEngine — auto-skip (skipWhenSatisfied)", () => {
  test("opted-in phase whose exit probe already passes at entry is marked skipped and advances", async () => {
    const r = regs();
    r.gates.register(fixedGate("done-already", true));
    const out = await new PipelineEngine(r).run(
      pipeline([{ id: "spec", kind: "noop", gate: "done-already", skipWhenSatisfied: true }]),
    );
    expect(out.status).toBe("done");
    expect(out.cursor).toBe(1);
    const st = out.phases[0].state;
    expect(st.status).toBe("skipped");
    if (st.status === "skipped") expect(st.reason).toContain("already present");
  });

  test("opted-in phase whose probe does NOT pass at entry runs normally (halts at boundary)", async () => {
    const r = regs();
    r.gates.register(fixedGate("not-yet", false, "missing"));
    const out = await new PipelineEngine(r).run(
      pipeline([{ id: "spec", kind: "noop", gate: "not-yet", skipWhenSatisfied: true }]),
    );
    // Not skipped — it ran; the exit gate then fails → default halt for the human.
    expect(out.phases[0].state.status).toBe("halted");
  });

  test("a phase that did NOT opt in never auto-skips even if its probe would pass", async () => {
    const r = regs();
    r.gates.register(fixedGate("passes", true));
    const out = await new PipelineEngine(r).run(
      pipeline([{ id: "spec", kind: "noop", gate: "passes" /* no skipWhenSatisfied */ }]),
    );
    // It ran and halted at the boundary — the passing gate does not skip it.
    expect(out.phases[0].state.status).toBe("halted");
  });

  test("skipWhenSatisfied with no gate is a no-op (nothing to probe) — the phase runs", async () => {
    const out = await new PipelineEngine(regs()).run(
      pipeline([{ id: "spec", kind: "noop", skipWhenSatisfied: true }]),
    );
    expect(out.phases[0].state.status).toBe("halted");
  });

  test("a phase re-entered on retry/revise is NEVER auto-skipped even if its probe now passes", async () => {
    const r = regs();
    r.gates.register(fixedGate("passes-now", true));
    // Simulate a retry/revise in progress: the phase is already `running`
    // (not pending), as applyFail / #reviseInner leave it, probe would now pass.
    const p = pipeline([{ id: "impl", kind: "noop", gate: "passes-now", skipWhenSatisfied: true }]);
    p.phases[0].state = { status: "running", startedAt: 1, attempts: 1 };
    p.status = "running";
    const out = await new PipelineEngine(r).run(p);
    // Not skipped — the model DID the work; normal pass path (exit gate + halt).
    expect(out.phases[0].state.status).toBe("halted");
  });
});

describe("PipelineEngine — verify-bounce (failing exit probe threads feedback on retry)", () => {
  test("a failing exit probe under onFail:retry threads its reason into the phase feedback", async () => {
    const r = regs();
    r.gates.register(fixedGate("build-ok", false, "test failed (exit 1): go test ./..."));
    const out = await new PipelineEngine(r).run(
      pipeline([{ id: "impl", kind: "noop", gate: "build-ok", onFail: { action: "retry", max: 2 } }]),
    );
    // retry budget exhausts (noop can't make the probe pass) → failed, but the
    // failure reason was threaded into feedback so a re-run's prompt carries it.
    expect(out.status).toBe("failed");
    const fb = out.phases[0].feedback ?? [];
    expect(fb.length).toBeGreaterThan(0);
    expect(fb.some((f) => f.includes("Automated check failed") && f.includes("test failed"))).toBe(true);
  });

  test("a passing exit probe adds no feedback", async () => {
    const r = regs();
    r.gates.register(fixedGate("build-ok", true));
    const out = await new PipelineEngine(r).run(
      pipeline([{ id: "impl", kind: "noop", gate: "build-ok", onFail: { action: "retry", max: 2 } }]),
    );
    expect(out.phases[0].state.status).toBe("halted"); // passed gate → boundary halt
    expect(out.phases[0].feedback ?? []).toHaveLength(0);
  });
});
