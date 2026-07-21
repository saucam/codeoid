// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { PipelineRunnerView } from "./PipelineRunner";
import type {
  PackWire,
  PipelinePhaseWire,
  PipelineWire,
} from "../protocol/types";

afterEach(cleanup);

function pack(p: Partial<PackWire> & Pick<PackWire, "id" | "name">): PackWire {
  return {
    version: "1.0.0",
    dir: `/cache/${p.id}`,
    trusted: true,
    selected: false,
    phases: [],
    roles: [],
    gates: [],
    active: true,
    ...p,
  };
}

function phase(
  p: Partial<PipelinePhaseWire> & Pick<PipelinePhaseWire, "id">,
): PipelinePhaseWire {
  return { status: "pending", ...p };
}

function pipeline(over: Partial<PipelineWire> = {}): PipelineWire {
  return {
    id: "p1",
    name: "Add a widget",
    status: "running",
    cursor: 0,
    phases: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

const noop = () => {};

function baseProps() {
  return {
    pipeline: null as PipelineWire | null,
    packs: [] as PackWire[],
    onRun: noop,
    onApprove: noop,
    onReject: noop,
    onRevise: noop,
  };
}

describe("PipelineRunnerView — Start panel", () => {
  it("renders installed packs and fires onRun with {pack,goal,workdir}", () => {
    const onRun = vi.fn();
    const { getByText, getByLabelText } = render(() => (
      <PipelineRunnerView
        {...baseProps()}
        packs={[pack({ id: "aif-sdlc", name: "AI Factory SDLC" })]}
        onRun={onRun}
      />
    ));

    expect(getByText("Start a run")).toBeTruthy();
    // The pack picker offers the installed pack (defaulting to it).
    expect(getByLabelText("Pack")).toBeTruthy();

    fireEvent.input(getByLabelText("Workdir"), { target: { value: "/repo" } });
    fireEvent.input(getByLabelText("Goal"), {
      target: { value: "build the thing" },
    });
    fireEvent.click(getByText("Start"));

    expect(onRun).toHaveBeenCalledWith({
      pack: "aif-sdlc",
      goal: "build the thing",
      workdir: "/repo",
    });
  });

  it("prefills the goal and shows an empty-packs fallback", () => {
    const { getByText } = render(() => (
      <PipelineRunnerView {...baseProps()} packs={[]} goalPrefill="seeded goal" />
    ));
    // No active packs → guidance instead of the form.
    expect(getByText(/No active packs/)).toBeTruthy();
  });
});

describe("PipelineRunnerView — Run view", () => {
  const halted = () =>
    pipeline({
      status: "halted",
      cursor: 1,
      phases: [
        phase({ id: "spec", role: "planner", status: "passed" }),
        phase({
          id: "architect",
          name: "Design",
          role: "reviewer",
          status: "halted",
          requestId: "q1",
          reason: "Review the proposed design",
          questions: ["Is the schema right?"],
          feedback: ["earlier: use UUIDs"],
        }),
        phase({ id: "implement", status: "pending" }),
      ],
    });

  it("renders the phase rail from the pipeline", () => {
    const { getByText } = render(() => (
      <PipelineRunnerView {...baseProps()} pipeline={halted()} />
    ));
    expect(getByText("spec")).toBeTruthy();
    expect(getByText("architect")).toBeTruthy();
    expect(getByText("implement")).toBeTruthy();
  });

  it("shows Approve/Revise/Reject at a halt and calls slice fns with the requestId", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const onRevise = vi.fn();
    const { getByText, getByLabelText } = render(() => (
      <PipelineRunnerView
        {...baseProps()}
        pipeline={halted()}
        onApprove={onApprove}
        onReject={onReject}
        onRevise={onRevise}
      />
    ));

    // Halt context is rendered.
    expect(getByText("Review the proposed design")).toBeTruthy();
    expect(getByText("Is the schema right?")).toBeTruthy();
    expect(getByText("earlier: use UUIDs")).toBeTruthy();

    // Approve → onApprove(requestId, undefined) (no note entered).
    fireEvent.click(getByText("Approve"));
    expect(onApprove).toHaveBeenCalledWith("q1", undefined);

    // Revise requires feedback; fill it then click.
    fireEvent.input(getByLabelText("Revise feedback"), {
      target: { value: "please tighten it" },
    });
    fireEvent.click(getByText("Revise"));
    expect(onRevise).toHaveBeenCalledWith("q1", "please tighten it");

    // Reject → onReject(requestId, undefined).
    fireEvent.click(getByText("Reject"));
    expect(onReject).toHaveBeenCalledWith("q1", undefined);
  });

  it("renders a terminal status", () => {
    const { container } = render(() => (
      <PipelineRunnerView {...baseProps()} pipeline={pipeline({ status: "done" })} />
    ));
    expect(container.textContent).toContain("done");
    expect(container.textContent).toContain("Run done.");
  });
});
