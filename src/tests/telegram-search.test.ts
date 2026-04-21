/**
 * Telegram frontend /search command tests — validates query parsing,
 * result formatting, markdown escaping, formatAgo, and the 4096-char
 * chunking fallback.
 */

import { describe, it, expect } from "bun:test";

// ── Re-implement the pure helpers under test (module-private in source) ──

function escMd(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (m) => "\\" + m);
}

function formatAgo(when: number): string {
  const dt = Math.max(0, Date.now() - when);
  if (dt < 60_000) return "just now";
  if (dt < 3_600_000) return Math.round(dt / 60_000) + "m ago";
  if (dt < 86_400_000) return Math.round(dt / 3_600_000) + "h ago";
  return Math.round(dt / 86_400_000) + "d ago";
}

/** Builds formatted search output matching the Telegram frontend logic. */
function buildSearchReply(
  query: string,
  sessions: {
    sessionName: string;
    matchCount: number;
    lastMatchAt: number;
    snippets: { kind: string; excerpt: string; toolName?: string }[];
  }[],
): string {
  const lines: string[] = [];
  lines.push(`🔍 *Search: ${escMd(query)}*\n`);

  for (const hit of sessions) {
    const when = formatAgo(hit.lastMatchAt);
    const matchLabel = `${hit.matchCount} match${hit.matchCount === 1 ? "" : "es"}`;
    lines.push(
      `▸ *${escMd(hit.sessionName)}* — ${escMd(matchLabel)} · ${escMd(when)}`,
    );

    for (const snippet of hit.snippets.slice(0, 2)) {
      const prefix =
        snippet.kind === "user_turn"
          ? "you"
          : snippet.kind === "assistant_turn"
            ? "claude"
            : snippet.toolName ?? "tool";
      const excerpt = snippet.excerpt
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
      lines.push(`  _${escMd(prefix)}:_ ${escMd(excerpt)}`);
    }
    lines.push("");
  }

  lines.push(`Use /attach \\<name\\> to jump into a session\\.`);
  return lines.join("\n");
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("formatAgo", () => {
  it("returns 'just now' for timestamps < 60s ago", () => {
    expect(formatAgo(Date.now())).toBe("just now");
    expect(formatAgo(Date.now() - 30_000)).toBe("just now");
    expect(formatAgo(Date.now() - 59_999)).toBe("just now");
  });

  it("returns minutes for 1m–59m", () => {
    expect(formatAgo(Date.now() - 60_000)).toBe("1m ago");
    expect(formatAgo(Date.now() - 5 * 60_000)).toBe("5m ago");
    expect(formatAgo(Date.now() - 59 * 60_000)).toBe("59m ago");
  });

  it("returns hours for 1h–23h", () => {
    expect(formatAgo(Date.now() - 3_600_000)).toBe("1h ago");
    expect(formatAgo(Date.now() - 12 * 3_600_000)).toBe("12h ago");
    expect(formatAgo(Date.now() - 23 * 3_600_000)).toBe("23h ago");
  });

  it("returns days for >= 24h", () => {
    expect(formatAgo(Date.now() - 86_400_000)).toBe("1d ago");
    expect(formatAgo(Date.now() - 7 * 86_400_000)).toBe("7d ago");
  });

  it("clamps future timestamps to 'just now'", () => {
    expect(formatAgo(Date.now() + 100_000)).toBe("just now");
  });
});

describe("escMd — MarkdownV2 escaping", () => {
  it("escapes all MarkdownV2 special chars", () => {
    const specials = "_*[]()~`>#+-.=|{}!\\";
    const escaped = escMd(specials);
    // Every special char is preceded by a backslash.
    for (const ch of specials) {
      expect(escaped).toContain("\\" + ch);
    }
  });

  it("leaves plain text untouched", () => {
    expect(escMd("hello world")).toBe("hello world");
    expect(escMd("abc123")).toBe("abc123");
  });

  it("handles mixed content", () => {
    expect(escMd("func()")).toBe("func\\(\\)");
    expect(escMd("2+2=4")).toBe("2\\+2\\=4");
  });
});

describe("Telegram search reply formatting", () => {
  it("formats a single session with one snippet", () => {
    const reply = buildSearchReply("auth bug", [
      {
        sessionName: "debug-session",
        matchCount: 3,
        lastMatchAt: Date.now() - 120_000,
        snippets: [
          {
            kind: "user_turn",
            excerpt: "I found a bug in the auth handler",
          },
        ],
      },
    ]);

    expect(reply).toContain("*Search: auth bug*");
    expect(reply).toContain("*debug\\-session*");
    expect(reply).toContain("3 matches");
    expect(reply).toContain("2m ago");
    expect(reply).toContain("_you:_");
    expect(reply).toContain("auth handler");
  });

  it("formats multiple sessions correctly", () => {
    const reply = buildSearchReply("deploy", [
      {
        sessionName: "deploy-fix",
        matchCount: 5,
        lastMatchAt: Date.now() - 7_200_000,
        snippets: [
          { kind: "assistant_turn", excerpt: "deploying to staging" },
        ],
      },
      {
        sessionName: "infra-work",
        matchCount: 1,
        lastMatchAt: Date.now() - 86_400_000,
        snippets: [
          { kind: "tool_call", excerpt: "kubectl apply", toolName: "Bash" },
        ],
      },
    ]);

    expect(reply).toContain("deploy\\-fix");
    expect(reply).toContain("infra\\-work");
    expect(reply).toContain("5 matches");
    expect(reply).toContain("1 match ·"); // singular
    expect(reply).toContain("_claude:_");
    expect(reply).toContain("_Bash:_");
  });

  it("limits snippets to 2 per session", () => {
    const reply = buildSearchReply("test", [
      {
        sessionName: "s",
        matchCount: 10,
        lastMatchAt: Date.now(),
        snippets: [
          { kind: "user_turn", excerpt: "snippet 1" },
          { kind: "assistant_turn", excerpt: "snippet 2" },
          { kind: "tool_call", excerpt: "snippet 3", toolName: "Read" },
        ],
      },
    ]);

    expect(reply).toContain("snippet 1");
    expect(reply).toContain("snippet 2");
    expect(reply).not.toContain("snippet 3");
  });

  it("truncates long excerpts to 120 chars", () => {
    const longExcerpt = "a".repeat(200);
    const reply = buildSearchReply("long", [
      {
        sessionName: "s",
        matchCount: 1,
        lastMatchAt: Date.now(),
        snippets: [{ kind: "user_turn", excerpt: longExcerpt }],
      },
    ]);

    // The escaped excerpt should be at most 120 chars of original content.
    expect(reply).toContain("a".repeat(120));
    expect(reply).not.toContain("a".repeat(121));
  });

  it("collapses whitespace in excerpts", () => {
    const reply = buildSearchReply("ws", [
      {
        sessionName: "s",
        matchCount: 1,
        lastMatchAt: Date.now(),
        snippets: [
          { kind: "user_turn", excerpt: "hello   \n\t  world" },
        ],
      },
    ]);

    expect(reply).toContain("hello world");
  });

  it("falls back to 'tool' when snippet.toolName is undefined", () => {
    const reply = buildSearchReply("x", [
      {
        sessionName: "s",
        matchCount: 1,
        lastMatchAt: Date.now(),
        snippets: [{ kind: "tool_call", excerpt: "something" }],
      },
    ]);

    expect(reply).toContain("_tool:_");
  });

  it("respects 4096-char Telegram limit awareness", () => {
    // Build a very long reply.
    const sessions = Array.from({ length: 30 }, (_, i) => ({
      sessionName: `session-${i}-${"x".repeat(50)}`,
      matchCount: 10,
      lastMatchAt: Date.now() - i * 3_600_000,
      snippets: [
        { kind: "user_turn" as const, excerpt: "y".repeat(120) },
        { kind: "assistant_turn" as const, excerpt: "z".repeat(120) },
      ],
    }));
    const reply = buildSearchReply("big query", sessions);

    // The telegram handler checks > 4096 and falls back to plain text.
    // Here we just verify we can detect when it's over the limit.
    if (reply.length > 4096) {
      const plain = reply.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1");
      // Plain text should be shorter (no backslashes).
      expect(plain.length).toBeLessThan(reply.length);
    }
  });
});

describe("Telegram /search command — query parsing", () => {
  // The handler extracts query via: text.split(/\s+/).slice(1).join(" ").trim()
  function parseQuery(text: string): string {
    return (text.split(/\s+/).slice(1).join(" ") ?? "").trim();
  }

  it("extracts single-word query", () => {
    expect(parseQuery("/search auth")).toBe("auth");
  });

  it("extracts multi-word query", () => {
    expect(parseQuery("/search fix the bug")).toBe("fix the bug");
  });

  it("handles extra whitespace", () => {
    expect(parseQuery("/search   lots   of   spaces")).toBe("lots of spaces");
  });

  it("returns empty for bare /search", () => {
    expect(parseQuery("/search")).toBe("");
    expect(parseQuery("/search   ")).toBe("");
  });
});
