/**
 * The "skill" phase kind: resolve the phase's `skill` from the registry and run
 * it. A `fn` skill runs natively (no backend); a `prompt` / `slash` skill is
 * driven through an injected PhaseRunner (the daemon backend seam). Without a
 * runner, a prompt/slash skill fails with a clear reason — so the kind stays
 * usable in pure tests and degrades safely when no backend is wired.
 */

import type { PhaseCtx, PhaseKind, PhaseRunResult, SkillPlugin } from "./interface";
import type { PhaseRunner } from "./runner";

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
  const prompt = skill.kind === "slash" ? skill.command : skill.template;
  const res = await runner.runPrompt({
    prompt,
    provider: ctx.phase.provider,
    model: ctx.phase.model,
    pipeline: ctx.pipeline,
    phase: ctx.phase,
  });
  return { outcome: "passed", summary: res.summary, artifacts: res.artifacts };
}
