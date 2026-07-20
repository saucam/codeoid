import { describe, expect, test } from "bun:test";
import type { PipelineState } from "./interface";
import { type PhaseTurnHost, SessionPhaseRunner } from "./runner";

function fakePipeline(over: Partial<PipelineState> = {}): PipelineState {
  return {
    id: "p",
    name: "p",
    phases: [],
    cursor: 0,
    status: "running",
    accountId: "a",
    projectId: "pr",
    createdBy: "u",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

type Req = Parameters<PhaseTurnHost["runPhaseTurn"]>[0];

describe("SessionPhaseRunner", () => {
  test("forwards prompt + provider/model + tenant to the host and returns the summary", async () => {
    const calls: Req[] = [];
    const host: PhaseTurnHost = {
      async runPhaseTurn(req) {
        calls.push(req);
        return "the result";
      },
    };
    const out = await new SessionPhaseRunner(() => host).runPrompt({
      prompt: "/spec",
      provider: "gemini",
      model: "flash",
      pipeline: fakePipeline({ workdir: "/repo", accountId: "acc", projectId: "prj", createdBy: "usr" }),
      phase: { id: "one", kind: "skill", skill: "spec" },
    });
    expect(out).toEqual({ summary: "the result" });
    expect(calls[0]).toMatchObject({
      prompt: "/spec",
      provider: "gemini",
      model: "flash",
      workdir: "/repo",
      accountId: "acc",
      projectId: "prj",
      createdBy: "usr",
    });
  });

  test("falls back to process.cwd() when the pipeline has no workdir", async () => {
    let seen = "";
    const host: PhaseTurnHost = {
      async runPhaseTurn(req) {
        seen = req.workdir;
        return "";
      },
    };
    await new SessionPhaseRunner(() => host).runPrompt({
      prompt: "x",
      pipeline: fakePipeline(),
      phase: { id: "one", kind: "skill" },
    });
    expect(seen).toBe(process.cwd());
  });
});
