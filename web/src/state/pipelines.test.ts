// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";

const clientRequestMock = vi.hoisted(() => vi.fn());
vi.mock("./connection", () => ({
  newRequestId: () => "r",
  getClient: () => ({ request: clientRequestMock }),
}));

import {
  runPipeline,
  approve,
  reject,
  revise,
  abort,
  pipelinesState,
  _resetPipelinesForTest,
} from "./pipelines";
import { sessionList, focusedSessionId } from "./sessions";

afterEach(() => {
  _resetPipelinesForTest();
  clientRequestMock.mockReset();
});

/** Flush pending microtasks (steer .then/.catch/.finally). */
const tick = () => new Promise((r) => setTimeout(r, 0));

function snap(pipelineOver: Record<string, unknown> = {}) {
  return {
    type: "pipeline.snapshot",
    requestId: "r",
    pipeline: {
      id: "p1",
      name: "run",
      status: "running",
      cursor: 0,
      phases: [],
      createdAt: 0,
      updatedAt: 0,
      ...pipelineOver,
    },
  };
}

/** Seed an active (halted) pipeline into state so steer verbs have a target. */
async function seed(): Promise<void> {
  clientRequestMock.mockResolvedValue(snap({ id: "p1", status: "halted" }));
  await runPipeline({ pack: "aif-sdlc", goal: "x", workdir: "/repo" });
  clientRequestMock.mockClear();
}

describe("pipelines store", () => {
  it("runPipeline creates from {pack,spec,workdir} then fires advance", async () => {
    clientRequestMock.mockResolvedValue(snap({ id: "p1" }));
    await runPipeline({ pack: "aif-sdlc", goal: "add a widget", workdir: "/repo" });

    const create = clientRequestMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(create).toMatchObject({
      type: "pipeline.create",
      pack: "aif-sdlc",
      spec: "add a widget",
      workdir: "/repo",
    });
    // name is a short label derived from the goal.
    expect(typeof create.name).toBe("string");
    expect((create.name as string).length).toBeGreaterThan(0);

    // advance follows, targeting the created pipeline.
    const advance = clientRequestMock.mock.calls[1]?.[0];
    expect(advance).toMatchObject({ type: "pipeline.advance", pipelineId: "p1" });

    expect(pipelinesState().pipeline?.id).toBe("p1");
    expect(pipelinesState().loading).toBe(false);
    expect(pipelinesState().error).toBeNull();
  });

  // Regression: pipeline.create returns only a sessionId (not a full
  // SessionInfo), so focusing it without first adding it to the list rendered
  // the empty "new session" state until the next reconnect refresh (~30-50s).
  // runPipeline must upsert the bound session so the view has something to show.
  it("adds the bound session to the list and focuses it (no reconnect wait)", async () => {
    clientRequestMock.mockResolvedValue(
      snap({ id: "p1", sessionId: "sess-boundtest", name: "run", workdir: "/repo" }),
    );
    await runPipeline({ pack: "aif-sdlc", goal: "x", workdir: "/repo" });

    const bound = sessionList().find((s) => s.id === "sess-boundtest");
    expect(bound).toBeDefined(); // in the list → view renders immediately
    expect(bound?.name).toBe("run");
    expect(bound?.workdir).toBe("/repo");
    expect(focusedSessionId()).toBe("sess-boundtest"); // and focused
  });

  it("surfaces a create rejection (pipeline disabled) without a run", async () => {
    clientRequestMock.mockRejectedValueOnce({
      type: "response.error",
      requestId: "r",
      error: "Pipeline is disabled",
      code: "invalid_request",
    });
    await runPipeline({ pack: "aif-sdlc", goal: "x", workdir: "/repo" });
    expect(pipelinesState().error).toBe("Pipeline is disabled");
    expect(pipelinesState().pipeline).toBeNull();
    expect(pipelinesState().loading).toBe(false);
  });

  it("approve answers approved:true, echoing the requestId + note", async () => {
    await seed();
    approve("q1", "looks good");
    expect(clientRequestMock.mock.calls[0]?.[0]).toMatchObject({
      type: "pipeline.answer",
      pipelineId: "p1",
      requestId: "q1",
      approved: true,
      value: "looks good",
    });
  });

  it("reject answers approved:false", async () => {
    await seed();
    reject("q1");
    expect(clientRequestMock.mock.calls[0]?.[0]).toMatchObject({
      type: "pipeline.answer",
      pipelineId: "p1",
      requestId: "q1",
      approved: false,
    });
  });

  it("revise sends pipeline.revise with the feedback", async () => {
    await seed();
    revise("q1", "tighten the schema");
    expect(clientRequestMock.mock.calls[0]?.[0]).toMatchObject({
      type: "pipeline.revise",
      pipelineId: "p1",
      requestId: "q1",
      feedback: "tighten the schema",
    });
  });

  it("abort sends pipeline.abort", async () => {
    await seed();
    abort();
    expect(clientRequestMock.mock.calls[0]?.[0]).toMatchObject({
      type: "pipeline.abort",
      pipelineId: "p1",
    });
  });

  it("steer verbs are no-ops with no active pipeline", () => {
    approve("q1");
    reject("q1");
    revise("q1", "x");
    abort();
    expect(clientRequestMock).not.toHaveBeenCalled();
  });

  it("swallows a steer client-timeout but surfaces a real rejection", async () => {
    await seed();

    // A client-side timeout is expected while a phase runs — the poll loop
    // drives the view, so it must NOT surface as an error.
    clientRequestMock.mockRejectedValueOnce(new Error("request r timed out"));
    approve("q1");
    await tick();
    expect(pipelinesState().error).toBeNull();

    // A genuine rejection (scope/forbidden) surfaces.
    clientRequestMock.mockRejectedValueOnce({
      error: "Missing scope: pipeline:answer",
      code: "forbidden",
    });
    approve("q1");
    await tick();
    expect(pipelinesState().error).toBe("Missing scope: pipeline:answer");
  });
});
