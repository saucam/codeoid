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
| **Multi-harness** (multiple agent backends) | ❌ Claude only | ❌ | ❌ | ❌ | ✅ swap/combine harnesses in one session (also Cursor, OpenCode, Hermes) | ✅ Claude, Codex, Gemini, OpenAI, pi, Gemini CLI — per session + fork across backends |
| **OS-level sandbox** (filesystem + network isolation) | ~ permission modes | ❌ | ❌ | ❌ | ✅ secure OS sandbox | ~ approval + autonomous budget, not OS-level |
| **Credential brokering** (hide secrets from the agent) | ❌ | ❌ | ❌ | ❌ | ✅ broker access, hide creds | ~ scoped ZeroID identity tokens |
| **Inline IDE code actions** | ❌ | ✅ | ✅ | ~ | ❌ orchestrates, not inline | ❌ not our niche |
| **SWE-bench / automated coding benchmark score** | — | — | ✅ | ✅ | — meta-harness | ❌ not yet benchmarked |
| **Multi-model routing** (Opus for plan, Haiku for cheap subtasks) | ~ recent | ~ | ✅ | ✅ | ✅ model routing across harnesses | ~ per-session model + provider choice; automatic cost-routing on the roadmap |

Legend: ✅ first-class · ~ partial · ❌ not supported · — not a meaningful comparison

**Where each tool fits:** **[Omnigent](https://github.com/omnigent-ai/omnigent)** is Codeoid's closest peer — both are multi-harness meta-harnesses that run Claude, Codex, Gemini, OpenAI, and pi. They differ in emphasis. Omnigent optimizes for **breadth and isolation**: the widest harness set (it also wires up Cursor, OpenCode, and Hermes, and can swap or combine harnesses within one session), an OS-level sandbox (bwrap/seatbelt + an L7 egress proxy), credential brokering that keeps real secrets out of the sandbox, and cross-harness model routing. It has cross-session recall of its own, too — full-text search across conversations plus an optional long-term memory store. Codeoid optimizes for **memory and identity**: workspace-scoped *verbatim episodic* memory with a hybrid ranker injected into context, a cryptographic identity per agent and sub-agent (ZeroID SPIFFE), pre-entry output compression, and per-turn token economics — all reachable from a terminal, a browser, or a phone with live device handoff. So: reach for Omnigent when you need OS-level isolation, credential brokering, or the broadest harness set; reach for Codeoid when you want persistent cross-session memory and cryptographic per-agent audit for long-horizon work across devices; and if you just want "fix this function I'm looking at right now," Cursor is still sharper.
