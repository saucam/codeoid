import { describe, test, expect } from "bun:test";
import {
  TranscriptStrategy,
  VerbatimWorkingSetStrategy,
  selectContextStrategy,
  renderSessionMap,
  type SeedContext,
} from "./context-strategy";
import type { SessionProvider } from "./interface";
import type { CanonicalTurn, HistorySeedResult } from "./canonical";
import type { Episode } from "../memory/index";

function mockProvider(opts: {
  supportsMemoryTools?: boolean;
  seedFromHistory?: boolean; // default true
  seedText?: boolean; // default false
  seedResult?: HistorySeedResult;
}) {
  const calls = { seedFromHistory: 0, seedText: [] as string[] };
  const p: Partial<SessionProvider> = { supportsMemoryTools: opts.supportsMemoryTools };
  if (opts.seedFromHistory !== false) {
    p.seedFromHistory = () => {
      calls.seedFromHistory++;
      return opts.seedResult;
    };
  }
  if (opts.seedText) {
    p.seedText = (block: string) => {
      calls.seedText.push(block);
    };
  }
  return { provider: p as unknown as SessionProvider, calls };
}

const history: readonly CanonicalTurn[] = [{ role: "user", content: "hi" }];
const MAP = "<session_map>MAP</session_map>";
function ctx(provider: SessionProvider, memoryEnabled: boolean): SeedContext {
  return { provider, history, memoryEnabled, seedBudgetChars: 10_000, buildSessionMap: () => MAP };
}

describe("TranscriptStrategy (default / fallback)", () => {
  test("warm backend: calls seedFromHistory, reports via=transcript", async () => {
    const { provider, calls } = mockProvider({});
    const out = await new TranscriptStrategy().seed(ctx(provider, true));
    expect(out).toMatchObject({ applied: true, via: "transcript" });
    expect(calls.seedFromHistory).toBe(1);
  });

  test("surfaces truncation from the provider result", async () => {
    const trunc: HistorySeedResult = { text: "", totalTurns: 5, keptTurns: 2, omittedTurns: 3, newestTurnSliced: false };
    const { provider } = mockProvider({ seedResult: trunc });
    const out = await new TranscriptStrategy().seed(ctx(provider, true));
    expect(out.truncation).toEqual(trunc);
  });

  test("stateless backend (no seedFromHistory): applied=false, via=none", async () => {
    const { provider } = mockProvider({ seedFromHistory: false });
    const out = await new TranscriptStrategy().seed(ctx(provider, true));
    expect(out).toMatchObject({ applied: false, via: "none" });
  });
});

describe("VerbatimWorkingSetStrategy (gated, falls back to transcript)", () => {
  test("tools mounted + memory on + seedText: seeds the session map, does NOT render a transcript", async () => {
    const { provider, calls } = mockProvider({ supportsMemoryTools: true, seedText: true });
    const out = await new VerbatimWorkingSetStrategy().seed(ctx(provider, true));
    expect(out).toMatchObject({ applied: true, via: "session-map" });
    expect(calls.seedText).toEqual([MAP]);
    expect(calls.seedFromHistory).toBe(0);
  });

  test("no supportsMemoryTools -> falls back to transcript", async () => {
    const { provider, calls } = mockProvider({ supportsMemoryTools: false, seedText: true });
    const out = await new VerbatimWorkingSetStrategy().seed(ctx(provider, true));
    expect(out.via).toBe("transcript");
    expect(calls.seedText).toEqual([]);
    expect(calls.seedFromHistory).toBe(1);
  });

  test("memory disabled -> falls back to transcript even with tools", async () => {
    const { provider, calls } = mockProvider({ supportsMemoryTools: true, seedText: true });
    const out = await new VerbatimWorkingSetStrategy().seed(ctx(provider, false));
    expect(out.via).toBe("transcript");
    expect(calls.seedFromHistory).toBe(1);
  });

  test("no seedText transport -> falls back to transcript", async () => {
    const { provider, calls } = mockProvider({ supportsMemoryTools: true, seedText: false });
    const out = await new VerbatimWorkingSetStrategy().seed(ctx(provider, true));
    expect(out.via).toBe("transcript");
    expect(calls.seedFromHistory).toBe(1);
  });
});

describe("selectContextStrategy", () => {
  test("defaults to transcript (no behavior change)", () => {
    expect(selectContextStrategy({}).name).toBe("transcript");
    expect(selectContextStrategy({ CODEOID_CONTEXT_STRATEGY: "nonsense" }).name).toBe("transcript");
  });
  test("opts into VWS via the flag (aliases)", () => {
    expect(selectContextStrategy({ CODEOID_CONTEXT_STRATEGY: "vws" }).name).toBe("verbatim-working-set");
    expect(selectContextStrategy({ CODEOID_CONTEXT_STRATEGY: "session-map" }).name).toBe("verbatim-working-set");
    expect(selectContextStrategy({ CODEOID_CONTEXT_STRATEGY: "VWS" }).name).toBe("verbatim-working-set");
  });
});

function epi(id: string, sessionId: string, summary: string): Episode {
  return {
    id,
    workspaceId: "ws",
    sessionId,
    kind: "user_turn",
    summary,
    content: summary,
    filePaths: [],
    tokenEstimate: 1,
    createdAt: 1_000_000,
    createdBy: "t",
  };
}

describe("renderSessionMap (VWS anchor)", () => {
  test("carries continuation notice, tool advertisement, page-table ids, last turns verbatim", () => {
    const out = renderSessionMap({
      workdir: "/w",
      sessionName: "sess",
      sessionId: "s1",
      recentTurns: [
        { role: "user", content: "do the thing" },
        {
          role: "assistant",
          content: "done",
          toolCalls: [{ id: "tc1", name: "Bash", input: {}, output: "", success: true }],
          providerId: "claude",
          model: "m",
        },
      ],
      timelineEpisodes: [epi("ep-123", "s1", "earlier work")],
    });
    expect(out).toContain("<session_map>");
    expect(out).toContain("CONTINUATION");
    expect(out).toContain('Workspace: /w. Session: "sess"');
    expect(out).toContain("get_episode(episode_id)");
    expect(out).toContain("episode_id: ep-123"); // page table carries retrievable ids
    expect(out).toContain("do the thing"); // last user turn, verbatim
    expect(out).toContain("[tool: Bash]"); // assistant tool call surfaced by name
    expect(out).toContain("</session_map>");
  });

  test("omits the page table when there are no episodes", () => {
    const out = renderSessionMap({
      workdir: "/w",
      sessionName: "s",
      sessionId: "s1",
      recentTurns: [],
      timelineEpisodes: [],
    });
    expect(out).toContain("<session_map>");
    expect(out).not.toContain("## Recent episodes");
  });

  test("clamps very long turn content (bounded seed)", () => {
    const out = renderSessionMap({
      workdir: "/w",
      sessionName: "s",
      sessionId: "s1",
      recentTurns: [{ role: "user", content: "x".repeat(5000) }],
      timelineEpisodes: [],
    });
    expect(out).toContain("…");
    expect(out).not.toContain("x".repeat(2500)); // clamped to ~2000
  });
});
