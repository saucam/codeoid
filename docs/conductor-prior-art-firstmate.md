# Prior Art: firstmate — what to borrow, where codeoid is better

> [firstmate](https://github.com/kunchenguid/firstmate) (by @kunchenguid) is the
> single most relevant prior art for the conductor: a **shipped** implementation
> of the exact "talk to one agent, it runs a crew" model, dogfooding the author's
> own tools (treehouse worktrees, herdr, Orca). It is the **architectural inverse**
> of codeoid — which is precisely why it's worth studying. Analysis based on its
> `docs/architecture.md`, `AGENTS.md` §1 (identity) + §8 (supervision), the 40+
> `bin/` scripts, and its skills.

## The mirror

Both systems are the same idea: one liaison you talk to, a crew of autonomous
workers, worktree isolation, approval-gated merges, restart-proof state. The
substrate is opposite:

| Axis | firstmate | codeoid conductor |
|---|---|---|
| Orchestrator | **`AGENTS.md` (122 KB prompt) + bash helpers** — "a directory that turns any agent into your firstmate" | **TS/Bun daemon** — logic in code, thin prompts |
| Worker isolation | git worktree (treehouse) per task, visible tmux/herdr/zellij/Orca window | daemon-owned session per task |
| State owner | disk (`data/`, `state/`) + the session backend | the daemon (clients are pure renderers) |
| Session/task resolution | **human names it; conductor greps `data/backlog.md`** — no semantic search | **hybrid retrieval + rerank over cards** (the P1 linchpin) |
| Identity/safety | "guarded by construction" + git auth + merge approval — **no crypto identity** | **ZeroID/WIMSE per session + delegation chain + (later) Cedar/Shield** |
| Supervision | zero-token bash watcher; absorbs benign wakes, wakes LLM only on actionable events | (to build — see P4) |
| Harness | **any** (claude/codex/opencode/pi/grok) via adapters | Claude-first, going meta-harness |

The headline: firstmate **needs** a 122 KB prompt precisely *because* it has no
daemon to enforce invariants — every rule ("never write to a project", "keep one
live watcher cycle") is a fragile instruction the model must remember every turn.
Codeoid enforces those in code. So firstmate is both a **feature catalog to mine**
and a **proof of what you pay if you skip the daemon.**

## STEAL — ranked by leverage

### 1. The conductor is read-only over targets *by construction*
firstmate Hard Rule #1: "**Never write to a project.** You read projects to
understand them; crewmates change them." Only 6 narrow, all-fast-forward/guarded
write exceptions exist. This is a **stronger invariant than our R3** ("confirm
before send-class acts") because it's architectural, not a prompt discipline.
→ **Adopt:** the conductor's `codeoid_fleet` tool surface is **read + dispatch
only** — no file/git/shell-write tool on target repos ever. All mutation flows
through spawned crewmates behind approval. The blast-radius bound becomes a
property of the tool surface, and codeoid can *enforce* it (deny those tools to
the conductor identity via scopes), where firstmate can only *ask* for it.

### 2. Zero-token, event-driven supervision (their crown jewel)
A cheap watcher (`fm-watch.sh` + `fm-classify-lib.sh` + `fm-crew-state.sh`)
classifies every wake in bash, **absorbs the benign majority** (`working:` notes,
no-change heartbeats, provably-working stale panes) without ever spending an LLM
turn, and wakes the conductor **only on actionable events** (`needs-decision` /
`blocked` / `failed` / `done` / `PR ready` / `merged`). Idle fleet = zero tokens.
Heartbeats **back off exponentially** (600 s → 2 h cap). Actionable wakes hit a
**durable queue** before detector state advances, so a missed exit is recoverable.
→ **Adopt (and do it better):** this is the answer to our "never OOC + cost" goal
and our P4 "event-driven digests." Codeoid's daemon already owns session state, so
it can **push** real events — no bash polling, no pane-tail regex. Conductor LLM
turns fire only on actionable daemon events; a "provably working" predicate gates
absorption; heartbeat backstop with exponential backoff; durable event queue for
crash recovery.

### 3. Two task shapes: **ship** vs **scout**
ship = deliver a change (PR / local-merge → teardown); scout = investigate / plan /
reproduce / audit → report at `data/<id>/report.md`, never pushes, worktree is
scratch from the start.
→ **Adopt:** dispatch carries a `shape`. Scout results are reports (great for "go
find out X" without touching code); ship results are PRs/merges; teardown rules
differ. Clean taxonomy our P4 lacked.

### 4. Per-project autonomy modes (not blanket confirm)
`data/projects.md` gives each project a mode — `no-mistakes` / `direct-PR` /
`local-only` — plus optional **`+yolo`** ("make routine approval decisions
yourself; destructive/irreversible/security-sensitive still escalates").
→ **Adopt:** replace our blanket R4 "owner approval only" with **per-workspace
autonomy policy**. This maps *perfectly* onto codeoid's identity/Cedar future — a
project's mode literally *is* a policy bound to the conductor's identity. Low-risk
repos run hands-off; sensitive repos require approval.

### 5. `/afk` batched-digest away-mode + `/stow` knowledge sweep
`/afk` hands supervision to a daemon that self-handles routine wakes and escalates
**only captain-relevant events as one batched, single-line digest** — cutting cost
while you step away. `/stow` sweeps the session for durable knowledge and routes
each finding to its disk home (prefs → `captain.md`, gotchas → `learnings.md`,
project knowledge → project `AGENTS.md`, task notes → backlog).
→ **Adopt** both as conductor UX: an away-mode that batches escalations, and a
handoff/knowledge-capture that routes findings to durable homes (codeoid already
has the memory engine to route into).

### 6. Harness dispatch profiles
`config/crew-dispatch.json` — natural-language rules the conductor reads at intake
to pick `--harness/--model/--effort` per task; the shell validates the shape, the
LLM matches intent.
→ **Adopt:** directly feeds codeoid's meta-harness direction — the conductor routes
each task to the best backend (claude/codex/gemini) per NL rules + a validated
config.

### 7. Sentinel marker for system-injected messages
Daemon escalations injected into the conductor's chat are prefixed with
`FM_INJECT_MARK` (ASCII unit-separator `0x1f`) so the conductor can tell an
internal escalation from a real captain message.
→ **Adopt:** our conductor faces the same ambiguity (daemon event-digests vs. real
messages from web/Telegram/mobile). Use an out-of-band field or sentinel so
injected events are never confused with user input.

### 8. Secondmates = the nested-conductor scaling path (future)
Persistent **domain supervisors** that are "ordinary direct reports run from
isolated homes" — "there is no second architecture; a secondmate is a crewmate
whose workspace is an isolated home and whose brief is a charter."
→ **Note:** validates that our single-global-conductor choice can grow *domain
sub-conductors* later using the **same delegation-depth identity chain** we already
designed (human → conductor → sub-conductor → crewmate). No new architecture.

Also worth borrowing: **restart-proof reconcile + durable wake-queue**, and the
**status-vs-current-state discipline** (`fm-crew-state.sh` reconciles an
authoritative run-step over a possibly-stale status line — a worker that reported
`done:` before a long validation isn't actually done).

## Where codeoid is already better — keep these

1. **Identity-native.** firstmate has *no* cryptographic identity; safety is prompt
   discipline + git auth + merge approval. For the "master of my machine" ambition
   (email, arbitrary tools, many agents), codeoid's per-session ZeroID + delegation
   + (later) Cedar/Shield is a real moat firstmate can't match. Its worker
   isolation is filesystem homes; ours is cryptographic delegation with cascading
   revocation.
2. **Semantic session resolution.** firstmate resolves "which session" via the
   human naming it + the conductor grepping a markdown backlog. It has **no**
   embedding/rerank/hybrid recall — exactly the P1 linchpin we're building. This is
   a genuine advance over the most mature conductor in the wild.
3. **Determinism — logic in code, not a 122 KB prompt.** Orchestration invariants
   live in testable TS, not re-read-every-turn prose. Cheaper context, deterministic
   behavior, unit-testable (see our P0 tests).
4. **Daemon-native events beat bash polling.** firstmate scrapes tmux panes with
   regex because tmux "has no native primitive and always reports unknown." Our
   daemon owns lifecycle → real push events, no scraping.

## Anti-patterns to avoid

1. **Prompt-as-program.** Don't drift toward encoding conductor logic in a giant
   `AGENTS.md`. Keep it in code; prompts stay thin.
2. **Pane-tail-regex liveness.** Never guess worker health by scraping terminal
   output — use daemon-authoritative state.
3. **Status side-channels that go stale.** firstmate spends pages reconciling
   "status log says done but a run is active." Don't reintroduce a lossy status
   stream parallel to the daemon's authoritative state.

## Net

The comparison **validates codeoid's architecture** (daemon + identity + structured
memory) as the right foundation, and firstmate proves the conductor concept ships.
The highest-leverage borrows are **behavioral/design, not code** (opposite
substrate): read-only-by-construction (#1), zero-token event supervision (#2),
ship/scout shapes (#3), per-project modes (#4). Fold #1–#4 into the design now;
#5–#8 are UX/scaling adds for P4–P7.
