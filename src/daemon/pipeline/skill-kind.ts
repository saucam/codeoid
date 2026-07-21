/**
 * The "skill" phase kind: resolve the phase's `skill` from the registry and run
 * it. A `fn` skill runs natively (no backend); a `prompt` / `slash` skill is
 * driven through an injected PhaseRunner (the daemon backend seam). Without a
 * runner, a prompt/slash skill fails with a clear reason — so the kind stays
 * usable in pure tests and degrades safely when no backend is wired.
 */

import type { PhaseCtx, PhaseKind, PhaseRunResult, PipelinePhase, SkillPlugin } from "./interface";
import type { PhaseRunner } from "./runner";

/** Compose a phase's prompt: the skill command/template, the run's goal, and —
 *  on a revise re-run — the phase's prior output + the accumulated human
 *  feedback so the agent re-iterates on the same phase (docs/pipeline-run.md). */
function composePhasePrompt(base: string, spec: string | undefined, phase: PipelinePhase | undefined): string {
  const parts = [base];
  if (spec) parts.push(`## Goal / feature\n${spec}`);
  const feedback = phase?.feedback ?? [];
  if (feedback.length > 0) {
    if (phase?.lastSummary) parts.push(`## Your previous output for this phase\n${phase.lastSummary}`);
    parts.push(`## Reviewer feedback — revise this phase accordingly\n${feedback.map((f, i) => `${i + 1}. ${f}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

export function makeSkillPhaseKind(runner?: PhaseRunner): PhaseKind {
  return {
    id: "skill",
    async run(ctx: PhaseCtx): Promise<PhaseRunResult> {
      const skillId = ctx.phase.skill;
      if (!skillId) {
        return { outcome: "failed", reason: `phase "${ctx.phase.id}" has kind:"skill" but no skill id` };
      }
      const skill = ctx.registries.skills.resolve(skillId);
      if (!skill) return { outcome: "failed", reason: `unknown skill "${skillId}"` };
      return runSkill(skill, ctx, runner);
    },
  };
}

async function runSkill(
  skill: SkillPlugin,
  ctx: PhaseCtx,
  runner: PhaseRunner | undefined,
): Promise<PhaseRunResult> {
  if (skill.kind === "fn") {
    try {
      const res = await skill.run(ctx);
      return { outcome: "passed", summary: res.summary, artifacts: res.artifacts };
    } catch (err) {
      // A throwing native skill is a phase failure, not a crash. (The engine
      // also guards this, but catching here attributes the error to the skill.)
      const reason = err instanceof Error ? err.message : String(err);
      return { outcome: "failed", reason: `skill "${skill.id}" threw: ${reason}` };
    }
  }
  if (!runner) {
    return {
      outcome: "failed",
      reason: `skill "${skill.id}" (${skill.kind}) needs a phase runner, but none is configured`,
    };
  }
  const base = skill.kind === "slash" ? skill.command : skill.template;
  const prompt = composePhasePrompt(base, ctx.pipeline.spec, ctx.pipeline.phases[ctx.pipeline.cursor]);
  const res = await runner.runPrompt({
    prompt,
    provider: ctx.phase.provider,
    model: ctx.phase.model,
    pipeline: ctx.pipeline,
    phase: ctx.phase,
  });
  return { outcome: "passed", summary: res.summary, artifacts: res.artifacts };
}
