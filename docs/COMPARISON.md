# How Codeoid compares

Codeoid is not a general-purpose IDE assistant — it's aimed at **long-horizon multi-session agent work** where context continuity and token economics matter more than inline code actions. Here's where it differs from the tools you're probably already using.

| Capability | Claude Code CLI | VSCode Extension | Cursor | Aider | **Omnigent** | **Codeoid** |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| **Cross-session verbatim memory** | ❌ `/compact` is lossy | ❌ session-scoped | ❌ | ❌ | ~ conversation full-text search + optional long-term store, not workspace-scoped episodic | ✅ SQLite + FTS5 + vectors, workspace-scoped verbatim episodes |
| **Parallel sessions, one control plane** | ❌ one terminal | ❌ one window per repo | ~ tabs | ❌ | ✅ Polly delegates to parallel agents | ✅ N sessions, switch with Ctrl-G |
| **Git-worktree-aware memory sharing** | ❌ | ❌ | ❌ | ❌ | ~ worktrees for isolation, not shared memory | ✅ anchored on `git-common-dir` |
| **Workspace memory index** injected into system prompt | ❌ | ❌ | ❌ | ~ repo map | ❌ | ✅ hot files + topic clusters + recent sessions, auto-regenerated |
| **Pre-entry CLI output compression** (git diff, test runners, etc.) with recall recovery | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ declarative rules, 60-90% reduction with tee-cache |
| **Auto-rotation of backing context** near compaction ceiling | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ lossless via memory recall seed |
| **Mid-turn user input (stream)** | ❌ interactive CLI is turn-based | ✅ | ~ | ❌ | ✅ mid-turn steer + live collab | ✅ with `now`/`next`/`later` priority |
| **Per-turn token / cost / cache telemetry** | ~ `/cost` total only | ❌ | ❌ | ~ | ~ spend caps + routing | ✅ persistent SQLite, StatusBar, Δ per turn |
| **Current context occupancy visible** | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ `ctx 65k/1.0M (7%)` live in StatusBar |
| **Cryptographic identity per agent + sub-agent** (SPIFFE) | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ ZeroID WIMSE URIs |
| **Autonomous mode with write-action budget** | ❌ | ~ | ~ | ❌ | ✅ stateful spend caps + risk escalation | ✅ budget tracked per session |
| **Multi-frontend** (terminal + web + mobile) | ❌ CLI only | ❌ IDE only | ❌ IDE only | ❌ | ✅ terminal → browser → phone | ✅ TUI + Web + Telegram, same session |
| **Device handoff** (start laptop, continue phone) | ❌ | ❌ | ❌ | ❌ | ✅ sessions follow you | ✅ WS re-attach with scrollback replay |
| **Multi-harness** (Claude + Codex + Cursor + Pi + custom) | ❌ Claude only | ❌ | ❌ | ❌ | ✅ swap/combine harnesses in one session | ❌ Claude Agent SDK only |
| **OS-level sandbox** (filesystem + network isolation) | ~ permission modes | ❌ | ❌ | ❌ | ✅ secure OS sandbox | ~ approval + autonomous budget, not OS-level |
| **Credential brokering** (hide secrets from the agent) | ❌ | ❌ | ❌ | ❌ | ✅ broker access, hide creds | ~ scoped ZeroID identity tokens |
| **Inline IDE code actions** | ❌ | ✅ | ✅ | ~ | ❌ orchestrates, not inline | ❌ not our niche |
| **SWE-bench / automated coding benchmark score** | — | — | ✅ | ✅ | — meta-harness | ❌ not yet benchmarked |
| **Multi-model routing** (Opus for plan, Haiku for cheap subtasks) | ~ recent | ~ | ✅ | ✅ | ✅ model routing across harnesses | ❌ roadmap |

Legend: ✅ first-class · ~ partial · ❌ not supported · — not a meaningful comparison

**Where each tool fits:** **[Omnigent](https://github.com/omnigent-ai/omnigent)** is Codeoid's closest peer — a *meta-harness* that puts Claude Code, Codex, Cursor, and Pi behind one governance layer with an OS-level sandbox, credential brokering, and cross-harness model routing. It has cross-session recall of its own, too: full-text search across conversations plus an optional long-term memory store. Codeoid trades that multi-harness breadth for depth on a single harness — workspace-scoped *verbatim episodic* memory with a hybrid ranker injected into context, a cryptographic identity per agent and sub-agent (ZeroID), pre-entry output compression, and per-turn token economics. So: if you need to orchestrate *many different* agents with OS-level isolation, reach for Omnigent; if you live in Claude Code across weeks and devices and want workspace memory that returns the exact bytes it saw last time, Codeoid goes deeper; and if you just want "fix this function I'm looking at right now," Cursor is still sharper.
