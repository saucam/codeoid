# Deterministic phase detection & transition

**Status:** proposed.
**Supersedes:** the text-sentinel completion contract shipped in `#224`/`#225`
(`⟦PHASE-COMPLETE⟧` detection in `SessionManager.runPhaseOnSession` +
`phase-completion.ts`).
**Depends on:** the conductor-over-live-session run model (`docs/pipeline-run.md`)
and the pack model (`docs/sdlc-pipeline.md`, `pack.ts`).

---

## 1. The problem

A pipeline phase is a **deliverable** (a spec, a design, an implementation), but
the daemon only sees **mechanical** signals (a turn rested, a tool was called,
history grew). Today we bridge that gap by asking the *model* to self-declare
completion:

- **Detection = a text sentinel.** `runPhaseOnSession` scans
  `session.lastAssistantText` for `⟦PHASE-COMPLETE⟧`; if it's missing it nudges
  (`PHASE_CONTINUE_NUDGE`, bounded by `MAX_PHASE_NUDGES`), then falls through to
  the human boundary. So a "vanilla" transition is never actually *detected* — it
  either catches a marker the model remembered to emit, or times out into a
  nudge-then-handoff. There is **no deterministic signal that the deliverable is
  done.**
- **The signal is not portable across backends.** A capability role is only
  HARD-enforced (tool-deny via `canUseTool`) on backends that route every tool
  under canonical names — `roleEnforcement(providerId)` returns `"advisory"`
  everywhere except `claude`. So *anything that lives inside the model's output*
  — a text marker OR a forced tool call — is reliable on some backends and
  best-effort on others.
- **Two soft points, one unused lever.** Every transition is human-gated
  (`#answerInner`: approve → `passed`, `cursor += 1`); the outcome vocabulary is
  only `passed | halted | failed` (no `skipped`); and the engine already has
  `entryGate`/`exitGate` seams (`engine.ts#step`) wired to a no-op
  `humanReviewGate`.

The bug is that we **conflate "the model paused" (mechanical) with "the
deliverable is done" (semantic).**

## 2. Design principles (what the research established)

A deep survey of comparable systems (Kiro, GitHub Spec Kit, Devin playbooks,
Claude/open Agent Skills, BMAD) and the determinism literature drove five
principles. See §12 for citations.

1. **Move the source of truth off the model, onto the daemon.** A deterministic
   predicate the daemon runs against the workspace is 100% backend-agnostic — the
   same whether the phase ran on Claude, Gemini, or a local model. This is the
   only way to be deterministic *everywhere*. (The determinism-over-stochastic-
   self-report principle is independently supported; a non-LLM "gate is a
   deterministic predicate… not an LLM judge" catches silent wrong-state failures
   reflection cannot.)
2. **Keep the mandatory authoring surface tiny.** The most-adopted authoring
   ecosystem (Agent Skills) requires exactly **two** fields — `name` +
   `description` — with a free-form body and *no* phase/gate/probe concept. A
   *required* probe field would make Forge a contribution-suppressing outlier.
3. **Determinism is opt-in with smart defaults.** Where scaled systems add
   checks, they are optional body patterns ("run validator → fix → repeat"),
   never a required schema field. So: **probes OPTIONAL; the common ones free.**
4. **Convention over configuration.** Conventional deliverable filenames in fixed
   locations make presence detectable by file-existence with *zero* author input
   (Spec Kit hardcodes `spec.md`/`plan.md`/`tasks.md`; `check-prerequisites`
   fails if missing). Auto-derive build/test gates from ecosystem detection.
5. **Auto-skip is a *suggestion*, not a silent transition.** **No** surveyed
   system auto-skips already-satisfied phases — file-existence detects *presence,
   not quality*, and an existence-based skip would silently pass a *stale or
   wrong* artifact. Spec Kit handles re-entry manually. So we surface a suggested
   skip at the human boundary (or gate it on a content check), never a silent
   jump.

## 3. The model is the worker; probes are the arbiter

Split "is the phase done?" and assign each half to the right actor:

| Question | Actor | Deterministic? |
| --- | --- | --- |
| Did the deliverable get produced? | **daemon-run exit probe** | ✅ yes — the transition gate |
| Is the deliverable any *good*? | **explicit gate** (human, or judge subagent) | ❌ no — declared, not faked |

The model's job shrinks to (a) produce the deliverable and (b) rest — both of
which *every* backend does. Its marker/tool call is **demoted to an
accelerator**: where a backend supports a structured signal it tells us *when* to
run the exit probe early and carries `summary`/`artifacts` metadata; where it
doesn't, we run the exit probe on every rest. **The verdict is identical across
backends** — only the promptness of detection differs.

### 3.1 The universal loop

```
[framing]      prompt the phase with end-goal-as-context + this-phase-as-target
[entry probe]  deliverable already present?  ──yes──▶  suggest SKIP at boundary
                     │ no
[run]          drive the turn; model works (streamed, interruptible)
[rest]         on turn_done / idle (universal signal; skip content-free rebuilds
                     via historyLength, per the #225 fix)
[exit probe]   deliverable present now / builds / tests pass?
                     ├─ pass ──▶ phase PASSED (deterministic — not "model said so")
                     │            then the human/quality gate if the phase declares one
                     └─ fail ──▶ not done: nudge/continue (bounded), or hand to gate
```

Every leg is either pure prompt text (portable) or a daemon-side check
(backend-agnostic). Nothing depends on backend-specific tool enforcement for
*correctness*.

### 3.2 Backend tiering — same verdict, different niceness

| Backend | Framing | Exit probe (truth) | Structured self-report |
| --- | --- | --- | --- |
| `claude` | ✅ prompt | ✅ daemon-run | ✅ hard-enforced tool → earliest, richest hint |
| `gemini` / `openai` / `pi` | ✅ prompt | ✅ daemon-run | ⚠️ advisory tool or JSON text block → accelerator only |
| any future / local model | ✅ prompt | ✅ daemon-run | ❌ none → probe-on-every-rest still deterministic |

The bottom row is the proof: a model that emits *nothing* structured still
transitions deterministically, because the daemon checks the workspace itself.

## 4. Phase-scoped prompt framing (leg 0)

`composePhasePrompt` (`skill-kind.ts`) currently puts the whole feature under
`## Goal / feature`, which is *why* a `/spec` phase implements the feature. Split
it so the end goal is **context** and the phase deliverable is the **target**:

```
## Overall goal (context — do NOT complete this now)
<the end goal: the whole feature>

## Your target for THIS phase
<just this phase's deliverable, e.g. "a spec at specs/<slug>/spec.md; do not implement">
The next phase continues from your output. Stop when THIS target exists.
```

This does double duty: the model rests at the phase boundary (so `turn_done`
aligns with the exit probe passing), and the exit probe gets a crisply-scoped
thing to check. It is pure prompt text → works on every backend. **Framing makes
the model *behave*; it is not by itself determinism** — the daemon-run probe is
what makes it *always* correct.

## 5. `pack.yaml` schema

**Required per phase: `id`/`name` + a `description`/`skill`. Everything else
optional.** A pack with zero gates runs today's loop minus the sentinel
fragility (framing + rest + human boundary). Gates are additive and mostly free.

```yaml
# pack.yaml — a phase's OPTIONAL determinism surface
phases:
  - id: spec
    skill: spec
    role: explorer
    # No gates declared → default entry/exit derived from convention (§6).
    # The phase still halts at the human boundary as today.

  - id: implement
    skill: impl
    role: implementer
    entry:   file-exists            # named gate type (§7), one line
    exit:    [build, test]          # a list runs as an AND
    onExitFail: retry               # existing onFail vocabulary (retry|halt|abort)

  - id: review
    skill: review
    role: reviewer
    exit:    judge:no-blocking-findings   # a judge-subagent gate (explicitly non-deterministic)
    gate:    human                         # still a human decision at the boundary
```

Notes:

- `entry` / `exit` accept a **named gate type** (§7), a **list** (AND), or an
  **inline object** for parameters (`{type: file-exists, path: "specs/**/spec.md"}`).
  A bare string is the 90% case.
- Omitting `entry`/`exit` does **not** mean "no check" — it means "use the
  convention-derived default" (§6). A pack opts *out* with `exit: none`.
- Reuses the existing `onFail` mapping in `pack.ts` (`retry: N` → `max`,
  `halt`, `abort`) for probe failures — no new failure vocabulary.
- `gate: human` (default) keeps the universal human boundary; `gate: auto`
  lets a phase with a green exit probe advance without a human click (opt-in,
  for phases that don't touch a contract).

## 6. Convention-derived defaults (zero author input)

When a phase declares no `entry`/`exit`, derive them:

- **Entry probe** ← *does the phase's conventional deliverable already exist?*
  Deliverable paths follow a convention (`specs/<slug>/spec.md`, `plan.md`,
  `design.md`, `tasks.md`), pack-overridable via a phase `deliverable:` field.
  A satisfied entry probe → **suggested skip** at the human boundary (§8), never
  a silent jump (§2.5).
- **Exit probe** ← *does the deliverable now exist* (+ for build/impl phases,
  the ecosystem build/test gate auto-derived in §7). Existence is the floor;
  build/test is added when the workspace ecosystem is detected.

Convention is a **default, not a law**: Spec Kit's own artifact root has churned
across versions (`specs/` vs `.specify/specs/`), so a pack may override the path,
and a phase may set `exit: none` to bypass entirely.

## 7. The named gate-type library

Probes are **references to a small library of reusable types**, so a probe is one
line, not a bespoke script. This keeps shell *out* of packs — which matters
because codeoid already fails closed on untrusted `command` gates
(`buildGate`/`failClosedGate` in `pack.ts`); a pack full of arbitrary shell is
exactly the trust surface that model forbids.

| Type | Predicate | Auto-derivable? |
| --- | --- | --- |
| `file-exists` | a path/glob resolves to ≥1 file | — (path from convention) |
| `glob-nonempty` | a glob matches non-empty content | — |
| `build` | the ecosystem build passes | ✅ from `go.mod`/`package.json`/`pyproject.toml`/`Cargo.toml` |
| `test` | the ecosystem test suite passes | ✅ same detection |
| `lint` | the ecosystem linter is clean | ✅ same detection |
| `git-diff-nonempty` | the phase changed tracked files | ✅ always |
| `judge:<name>` | a judge subagent returns a verdict | — (explicitly **non-deterministic**; a declared quality gate, not a probe) |

**Ecosystem auto-derivation:** `go.mod` → `build: go build ./...`, `test: go
test ./...`; `package.json` → the `build`/`test` scripts (`pnpm`/`npm`);
`pyproject.toml` → `pytest`; `Cargo.toml` → `cargo build`/`cargo test`. The
author declares `exit: [build, test]` (or nothing on an `implement` phase and
gets it by default); the platform supplies the command. Detection is a daemon
capability, not pack data — so it's reviewed once, centrally, not per pack.

`judge:*` is deliberately in the table to name the boundary: quality checks are
*subagent calls*, stochastic, and surfaced as advisory verdicts alongside the
human decision — never dressed up as deterministic.

## 8. Protocol lifecycle events & outcome vocabulary

Make transitions observable and testable instead of inferred from chat.

- **New outcome:** add `skipped` to `PhaseRunResult` / phase state
  (`passed | halted | failed | skipped`), carrying the reason
  (`entry probe satisfied: specs/x/spec.md exists`).
- **New protocol events** (mirrors the existing pipeline snapshot stream):
  `pipeline.phase.started`, `pipeline.phase.progress`,
  `pipeline.phase.completed { via: "exit-probe" | "marker" | "nudge-timeout" }`,
  `pipeline.phase.skipped { reason }`, `pipeline.phase.needs_input`. The web
  cockpit renders these directly rather than polling status.
- **Suggested skip UX:** a satisfied entry probe surfaces at the boundary as a
  one-click *"`spec` already satisfied (specs/x/spec.md exists) — Skip / Run
  anyway"* card, not a silent transition. This is the honest handling of the
  file-existence-≠-quality gap.

## 9. Engine changes

The seams already exist — this fills them.

- `engine.ts#step` already calls `entryGate` before the kind and `exitGate`
  after; today both resolve to `humanReviewGate` (pass-through). Register the
  named gate types as real `GatePlugin`s and resolve a phase's `entry`/`exit`
  to them (or to the convention default).
- A satisfied **entry** probe short-circuits the kind → `skipped` (surfaced as a
  suggestion per §8), rather than running the phase.
- A passing **exit** probe is what makes `runPhaseOnSession` return "done" —
  replacing `isPhaseComplete(text)` as the primary signal. The marker becomes an
  *early-exit hint* that triggers the exit probe; a passing probe with no marker
  still completes; a marker with a failing probe does **not** complete (it nudges
  or hands to the gate). This inverts today's trust: **probe is truth, marker is
  hint.**
- Keep `MAX_SPURIOUS_RESTS` (the `historyLength` content-free-rebuild skip from
  `#225`) and `MAX_PHASE_NUDGES` as the liveness backstops — they still bound a
  phase whose probe never passes so it always reaches the human boundary.

## 10. Migration (no big-bang)

1. **Framing first** (§4) — pure prompt change to `composePhasePrompt`. Ships
   independently; improves every backend immediately; zero schema change.
2. **Exit probe as opt-in accelerator, behind a flag.** Add the gate-type
   library + `exit:` resolution; when a phase declares `exit`, the probe becomes
   the completion signal; otherwise the sentinel path is unchanged. Dogfood on
   the built-in SDLC pack.
3. **Convention-derived defaults** (§6) — turn on default entry/exit derivation;
   the sentinel drops to a pure accelerator. Gate behind a pack `schemaVersion`
   so existing community packs are untouched.
4. **`skipped` outcome + suggested-skip UX + lifecycle events** (§8).
5. **Retire the sentinel as *primary*** — keep it only as the "run the probe now"
   hint. Never remove the human-boundary backstop.

Each step is independently shippable and leaves existing packs working.

## 11. Anti-patterns (do not build)

- **Required probe per phase** → contribution killer; makes Forge an outlier
  (§2.2).
- **Silent auto-skip on bare file-existence** → skips stale/wrong artifacts; the
  re-entry case every surveyed system handles manually (§2.5).
- **Bespoke shell in every phase** → unreviewable, unportable, a trust surface
  that fights codeoid's own fail-closed `command`-gate model. Named types +
  central auto-derivation keep shell out of packs (§7).
- **LLM-judge dressed as a deterministic gate** → a judge is another stochastic
  call; label it `judge:*` and surface it as advisory, not truth (§7).

## 12. Open questions

- **Adoption of optional gates is unmeasured.** The research established the
  *schemas* are minimal but not how often authors actually populate optional
  gates vs. leave defaults. We should instrument this once packs ship.
- **File-existence false-positive rate** for auto-skip: an artifact that exists
  but is stale/wrong. Mitigated by "suggest, don't skip" (§8); a light content
  check (does the artifact reference the current goal?) may reduce it further.
- **Do strong models even need probes?** The headline determinism gain in the
  literature was on a *budget* model; frontier coding models may need probes less
  — which argues *further* for optional-not-required.
- **The right default gate library** for a multi-language platform and how
  reliably build/test can be auto-derived from ecosystem detection.

## 13. Prior art & sources

Deterministic-gate principle and the model-self-report failure mode:
arXiv:2607.07405 (deterministic predicate gates vs. LLM-judge; silent
wrong-state failures). Authoring-surface minimalism: the Agent Skills open
specification (two required fields, no phase/probe concept) and Anthropic's
Agent Skills best-practices (validation as an optional body pattern). Feed-forward
conventional artifacts + human/AI-judgment gating (no per-phase probes,
no auto-skip): AWS Kiro specs docs and GitHub Spec Kit. Composable/bundled
distribution with a pre-install inventory: Claude Code plugins & marketplaces.
Full citation set and adversarial-verification notes in the research record
attached to the PR.

**Caveat on the evidence:** all findings are *analogical* — no source is
Forge/codeoid-specific — and the strongest determinism datapoint is a
non-peer-reviewed preprint whose gates are pre-execution policy checks on a
tool-use benchmark, not SDLC phase probes. Cite the *principle* (probe as source
of truth), not the magnitude.
