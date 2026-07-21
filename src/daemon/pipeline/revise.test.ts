/**
 * The Approve/Revise/Reject loop (docs/pipeline-run.md): revise re-runs a halted
 * phase with the human's feedback + the phase's prior output threaded into the
 * prompt. Driven at the manager level with a prompt-capturing fake runner and a
 * `manual` gate (always halts), so we can inspect the re-run prompt.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { PipelineManager } from "./manager";
import { PipelineStore } from "./store";
import { createRegistries } from "./registry";
import { registerBuiltins } from "./builtin";
import { makeSkillPhaseKind } from "./skill-kind";
import type { PhaseRunner, PhaseRunRequest } from "./runner";

const tenant = { accountId: "a", projectId: "p", createdBy: "u" };

/** Fake runner that records every prompt it's handed and returns a summary. */
function capturingManager(): { m: PipelineManager; prompts: string[] } {
  const prompts: string[] = [];
  let n = 0;
  const runner: PhaseRunner = {
    async runPrompt(req: PhaseRunRequest) {
      prompts.push(req.prompt);
      return { summary: `attempt ${++n} output` };
    },
  };
  const r = createRegistries();
  registerBuiltins(r);
  r.phases.register(makeSkillPhaseKind(runner));
  r.skills.register({ id: "build", kind: "prompt", template: "IMPLEMENT-THE-THING" });
  const m = new PipelineManager(new PipelineStore(new Database(":memory:")), { registries: r });
  return { m, prompts };
}

describe("pipeline.revise", () => {
  test("re-runs the phase with feedback + prior output threaded into the prompt", async () => {
    const { m, prompts } = capturingManager();
    // A skill phase with a `manual` exit gate → runs the skill, then halts.
    const p = m.create({
      name: "t",
      phases: [{ id: "impl", kind: "skill", skill: "build", gate: "manual" }],
      spec: "build a JSON exporter",
      ...tenant,
    });
    await m.advance(p.id);
    // First run: skill executed, manual gate halted the phase.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("IMPLEMENT-THE-THING");
    expect(prompts[0]).toContain("build a JSON exporter"); // goal threaded in
    expect(prompts[0]).not.toContain("Reviewer feedback");
    const halted = m.get(p.id)!;
    expect(halted.status).toBe("halted");
    const reqId = halted.phases[0]!.state.status === "halted" ? halted.phases[0]!.state.requestId : "";

    // Revise with feedback → phase re-runs with the note + its prior output.
    await m.revise(p.id, reqId, "handle the empty-input case");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("handle the empty-input case"); // feedback
    expect(prompts[1]).toContain("attempt 1 output"); // prior output shown back
    const after = m.get(p.id)!;
    expect(after.phases[0]!.feedback).toEqual(["handle the empty-input case"]);
    expect(after.status).toBe("halted"); // manual gate halts again — ready for another revise/approve

    // A second revise accumulates feedback.
    const reqId2 = after.phases[0]!.state.status === "halted" ? after.phases[0]!.state.requestId : "";
    await m.revise(p.id, reqId2, "also add a --pretty flag");
    expect(m.get(p.id)!.phases[0]!.feedback).toEqual(["handle the empty-input case", "also add a --pretty flag"]);
    expect(prompts[2]).toContain("also add a --pretty flag");
  });

  test("rejects revise on a non-halted pipeline and empty feedback", async () => {
    const { m } = capturingManager();
    const p = m.create({ name: "t", phases: [{ id: "impl", kind: "skill", skill: "build", gate: "manual" }], ...tenant });
    // draft, not halted yet
    await expect(m.revise(p.id, "x", "note")).rejects.toThrow(/not halted/);
    await m.advance(p.id);
    const reqId = (() => {
      const st = m.get(p.id)!.phases[0]!.state;
      return st.status === "halted" ? st.requestId : "";
    })();
    await expect(m.revise(p.id, reqId, "   ")).rejects.toThrow(/non-empty feedback/);
    await expect(m.revise(p.id, "stale-id", "note")).rejects.toThrow(/stale requestId/);
  });
});
