# Prior Art: hermes-agent — what to borrow, where codeoid is better

> [hermes-agent](https://github.com/NousResearch/hermes-agent) (Nous Research,
> MIT) is the most *complete* personal-assistant prior art we've studied — a
> multi-platform gateway (Telegram/Discord/Slack/WhatsApp/Signal/email), cron
> **routines**, autonomous skill creation, cross-session memory + user modeling,
> `delegate_task` + a durable **Kanban** work-queue, all running on a $5 VPS. It is
> the closest thing to the original "master of my machine" ask. Analysis from its
> `README`, `docs/session-lifecycle.md`, `hermes-already-has-routines.md`,
> `AGENTS.md` (Delegation / Curator / Cron / Kanban), and the subsystem layout.

## Triangulation — where codeoid sits

Three prior-arts, three niches:

| System | Niche | Security model | Substrate |
|---|---|---|---|
| **OpenClaw** | channel-gateway breadth (front door + life-admin) | allowlist | files + bash |
| **hermes** | **most complete personal assistant** (gateway + routines + skills + memory + user model) | allowlist + DM-pairing + command-approval | Python monolith (`cli.py` 738 KB) |
| **firstmate** | *coding-fleet* conductor (crew + worktrees + PRs) | guarded-by-construction + merge approval | 122 KB prompt + bash |
| **codeoid** | **identity-native + retrieval-first + typed multi-client daemon** | **ZeroID/WIMSE per-session + delegation** | TS daemon, clients-are-renderers |

hermes and firstmate each hold one or two legs; **codeoid is the only one with all
three** (crypto identity + semantic session resolution + typed multi-client daemon).
That triad is the defensible position. hermes serves the *personal-assistant
breadth* better than firstmate — which is exactly why it's worth mining for the
"master of my machine" surface our plan was thin on.

## STEAL — ranked by leverage

### 1. Routines — scheduled + triggered autonomy (the biggest gap in our plan)
hermes has cron **and** webhook/event triggers, in natural language:
`hermes cron create "0 2 * * *" "triage the backlog" --deliver telegram`;
`hermes webhook subscribe pr-review --events pull_request --prompt "…"` (HMAC-auth).
Per-job fields: `skills`, `model`/`provider` override, `script` (pre-run
data-collection whose stdout is injected — or `no_agent=True` to make the script
the *whole* job), `context_from` (chain job A's output into job B), `workdir` (run
in a repo with its `AGENTS.md` loaded), multi-platform delivery.
`cron/jobs.py` (store) + `cron/scheduler.py` (tick loop).
**Two hardening patterns to steal whole:**
- **Script-injection + `[SILENT]` pattern** — a script does the mechanical work
  (fetch/diff/compute), the agent only *reasons*, and the job emits nothing unless
  something changed (`respond with [SILENT]`). Zero-spam, near-zero-token monitors.
- **Cron hardening** — 3-minute hard interrupt (runaway loops can't monopolize the
  scheduler), file-lock (`.tick.lock`) against duplicate ticks across processes,
  catchup/grace windows, `skip_memory=True` by default on cron sessions, and cron
  output lands in its *own* session (header/footer frame) so it never corrupts the
  main conversation's role alternation.
→ **New conductor phase (P4.5).** Neither codeoid nor firstmate has this, and it's
core to "master of my machine" (nightly triage, monitors, digests, event triggers).

### 2. Durable Kanban work-queue as the dispatch backbone
`AGENTS.md` §Kanban + `tools/kanban_tools.py`: a **SQLite-backed board** with a
**dispatcher loop** (default 60 s) that reclaims stale claims, promotes ready tasks,
**atomically claims**, and spawns the assigned worker. **Board = hard boundary**
(workers get `HERMES_KANBAN_BOARD` pinned in env, can't see other boards); tenant =
soft namespace within a board. After `failure_limit` consecutive failures (default
2) the dispatcher **auto-blocks the task** to prevent spin loops.
→ Far more restart-proof than firstmate's markdown backlog. **Upgrade P4's dispatch
to sit on a durable queue like this** (codeoid already has SQLite): atomic claim,
stale-claim reclaim, failure-limit auto-block (complements firstmate's stuck-loop).

### 3. `delegate_task` role model — leaf vs orchestrator
`tools/delegate_tool.py`: a subagent gets an isolated context + terminal.
`role="leaf"` (default) is a focused worker that **cannot** call `delegate_task`,
`memory`, `send_message`, `execute_code`; `role="orchestrator"` **can** spawn,
bounded by `max_spawn_depth` (default 2) and `max_concurrent_children` (default 3).
Background delegation returns an id immediately and re-enters via an async
completion queue. Durability rule: background delegate is process-local — for
restart-survival use a cronjob or `terminal(background, notify_on_complete)`.
→ This *is* our read-only-by-construction + delegation-depth decisions, with the
concrete knobs — except **codeoid enforces the role's capability restriction
cryptographically via ZeroID scopes**, where hermes uses config flags. Adopt the
leaf/orchestrator split; enforce it at the scope layer, not by prompt or flag.

### 4. Session-lifecycle hardening (`docs/session-lifecycle.md`)
A mature, battle-tested state machine worth mining for reliability:
- **Restart recovery:** `resume_pending` (soft — preserve `session_id`, continue the
  transcript) vs `suspended` (hard wipe); `suspend_recently_active(120s)` on a crash
  (no `.clean_shutdown` marker); a `.clean_shutdown` marker skips resurrection after
  a clean restart.
- **Stuck-loop escalation:** a restart-count file auto-suspends a session active
  across 3+ consecutive restarts (terminal escalation, complements Kanban's
  failure-limit).
- **Agent LRU cache** (128 entries, 1 h idle TTL) that **preserves prompt-cache**
  across turns; background expiry watcher (5 min) finalizes + evicts.
- **Burst-collapse message queue:** single "next-up" slot per session (repeat sends
  overwrite) + FIFO overflow for explicit `/queue`, so multi-message bursts during a
  turn never process out of order.
- **Per-session token/cost tracking** baked into the session record.
→ codeoid's daemon has some of this; the `resume_pending`/stuck-loop/clean-shutdown
state machine + burst-collapse queue are concrete P4 hardening.

### 5. Multi-platform gateway
One gateway process → Telegram/Discord/Slack/WhatsApp/Signal/email, with a clean
`SessionSource` (message-origin descriptor) → deterministic session-key
(`agent:main:{platform}:{chat_type}:{chat_id}:{thread}:{participant}`) → home
channels + delivery routing + multi-user isolation + PII-redaction-in-prompt.
→ How our P5 adds platforms cheaply beyond web+Telegram. Copy the SessionSource +
session-key shape; codeoid's daemon already owns the session store this plugs into.

### 6. Zero-context-cost tool-RPC scripts
"Write a Python script that calls tools via RPC, collapsing multi-step pipelines
into one zero-context turn." Complements codeoid's saar/extraction work and
firstmate's zero-token supervision — a script surface for mechanical multi-step
work that never floods the conductor's context.

### 7. Self-improving loop (Curator) — aspirational, clean invariants
`agent/curator.py`: autonomous skill creation after complex tasks + a maintenance
loop that tracks per-skill usage and **archives (never deletes)** stale skills,
exempts pinned, and **only touches `created_by: agent` skills** (bundled/hub skills
off-limits). Plus Honcho dialectic user modeling ("who you are across sessions").
→ The direction codeoid's memory engine could grow (autonomous skills + a user
model); the safe-autonomy invariants (archive-not-delete, pinned-exempt,
provenance-scoped) are worth copying if/when we add agent-authored skills.

### 8. Notes
- **ACP** (`acp_adapter`, `acp_registry`, `agent/copilot_acp_client.py`) — hermes
  speaks the Agent-Client-Protocol. An interop/meta-harness play: codeoid speaking
  ACP would let editors (Zed/Copilot) drive it.
- **Serverless-persistence backends** (Modal/Daytona) — hibernate-when-idle so a
  cloud conductor costs ~nothing between sessions. The cheap-VPS story.

## Where codeoid is already better — keep

1. **Identity.** hermes is allowlist + DM-pairing + command-approval — no
   cryptographic per-session identity or delegation chain. For "master of my
   machine" with email + arbitrary tools + a fleet, codeoid's ZeroID is the moat;
   and it lets us enforce the delegate role model (#3) *cryptographically* rather
   than by config flag.
2. **Retrieval.** hermes cross-session recall = FTS5 + LLM summarization (better
   than firstmate's markdown grep, but no rerank or bi-temporal cards). Our P1
   (BGE-M3 hybrid + cross-encoder rerank + bi-temporal cards) is more sophisticated.
3. **Typed daemon + modularity.** hermes is a Python monolith with 250–738 KB
   god-files. codeoid's typed TS daemon + clients-are-renderers keeps the
   multi-client (web/TUI/mobile) story crisp and the code testable.

## Anti-patterns to avoid
1. **God-files** (`cli.py` 738 KB, `run_agent.py` 268 KB, `hermes_state.py` 255 KB)
   — keep the daemon in small typed modules.
2. **Allowlist-only security** — don't regress from ZeroID to DM-pairing/allowlists.
3. **Prompt-heavy `AGENTS.md`** (71 KB) — same trap as firstmate, less extreme; keep
   orchestration in code.

## Net — refinements to the plan
- **Upgrade P4** — durable Kanban-style work-queue (atomic claim, stale reclaim,
  failure-limit auto-block) + the `leaf`/`orchestrator` role model (enforced via
  scopes) + session-lifecycle hardening (resume_pending / stuck-loop / clean-shutdown
  / burst-collapse queue).
- **Add P4.5 — Routines** — scheduled + webhook/event-triggered autonomy, with the
  script-injection `[SILENT]` pattern and cron hardening (hard interrupt, tick lock,
  own-session output). This is what turns the conductor from a fleet *supervisor*
  into a personal *assistant*.
