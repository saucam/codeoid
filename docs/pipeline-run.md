# Governed Pipeline Run — Design

> Builds on [`pack-loading.md`](./pack-loading.md) + [`sdlc-pipeline.md`](./sdlc-pipeline.md).
> Goal: the user-facing way to **use** an installed pack — trigger a governed
> `spec → ship` run with a feature goal, watch it auto-advance through the
> phases, and steer each phase (approve / revise / reject) at its gate.

## The model

You don't "activate a pack on a session" — you **run** it:

```
/pipeline            → Start panel { pack (default=selected), workdir (default=session cwd), goal (multi-line) }
/pipeline <goal…>    → quick-start with the default pack + session cwd

  Start → pipeline.create({ pack, spec: goal, workdir }) → advance
        → spec ─gate▹ architect ─gate▹ implement ─gate▹ review ─gate▹ ship → done
                 (auto-advances between phases; HALTS at each gate for you)
```

The pack defines the **fixed phase sequence**; the goal **seeds the spec phase**;
"done" = the final phase completes. After Start it runs on its own, pausing only
at gate halts. Each phase runs under **its declared capability role** (reviewer =
read-only, implementer = write) — the per-phase governance, enforced by the same
`canUseTool` role gate the ambient machinery added (#216), now applied to each
phase's worker.

## Halt interaction — Approve / Revise / Reject

At every gate halt the run parks and you choose:
- **Approve & continue** — accept the phase; advance to the next gate. (`pipeline.answer approved:true`)
- **Revise** — give feedback/opinions; the agent **re-runs the SAME phase** with
  your notes (+ its prior output) threaded into the phase prompt, then halts
  again. **Loop until satisfied**, then Approve. (new `pipeline.revise`)
- **Reject & stop** — hard-stop the run. (`pipeline.answer approved:false` → terminal fail)

Revise is the "not satisfied → dig more → agent re-iterates on the same phase"
loop — it's what makes the run collaborative rather than a black-box autorun.
(A later extension: full conversational digging within a phase; v1 = the
feedback-box revise loop.)

## Engine additions (small)

The engine already auto-advances through phases and halts at gates
(`PipelineManager.advance` → `engine.run`; `answer(approved)` auto-resumes). New:
- **`pipeline.revise { pipelineId, requestId, feedback }`** (scope `pipeline:answer`)
  → `PipelineManager.revise`: validate the halted phase, thread `feedback` (+ the
  phase's prior summary) into the phase's re-run context, reset the phase to
  running, and advance (re-runs the current phase → halts again).
- **Per-phase role activation**: when the phase runner spawns the phase's worker
  session, pass a `PackActivation` built from the pack's constitution + the
  phase's role, so the worker runs under that role's tool envelope (reusing the
  #216 gate). A reviewer phase physically can't use write tools.

## UI / CLI (poll-driven — no push; phases run for minutes)

`advance`/`answer`/`revise` block server-side up to 10 min/phase, past the 30s
request timeout — so the client fires them **fire-and-forget** (large timeout)
and drives the view off a **poll loop** on `pipeline.get`.

- **Web** `PipelineRunner` (`/pipeline` + a per-pack Run action): Start panel →
  live phase rail (per-phase status + role) → Approve/Revise/Reject card at halts
  → terminal. State slice `state/pipelines.ts` mirrors `state/packs.ts`.
- **CLI**: `codeoid pipeline run --pack <id> --goal "…" --workdir .`,
  `pipeline status <id>`, `pipeline approve|revise|reject <id>`.
- **Scopes**: add `pipeline:create` (create/advance/abort) + `pipeline:answer`
  (answer/revise) to `DEFAULT_WEB_SCOPES` (web re-login to pick up).

## Prerequisites for a live run

The pipeline runtime is **on by default** (opt out with `pipeline.enabled: false`
/ `CODEOID_PIPELINE_ENABLED=false`), so a live run just needs: the pack **active +
trusted** with its **skills installed**; a **provider + API keys**; a real
**workdir/repo**. A full run is 5 real model turns (minutes each) and can fail
mid-phase — so the UI is verified on a short/fast pipeline; a live `aif-sdlc` run
works given the prereqs.

## Non-goals (here)

- Ambient per-session pack activation (the New-Session pack/role selector was
  removed — packs are used via a run, not a session). The role-gate/constitution
  machinery from #216 is retained and repurposed as per-phase governance.
