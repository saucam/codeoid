import { describe, test, expect } from "bun:test";
import {
  TranscriptStrategy,
  VerbatimWorkingSetStrategy,
  selectContextStrategy,
  type SeedContext,
} from "./context-strategy";
import type { SessionProvider } from "./interface";
import type { CanonicalTurn, HistorySeedResult } from "./canonical";

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
