/**
 * Web frontend search tests — validates the client-side logic for the
 * search modal: formatAgo, compactExcerpt, result rendering, keyboard
 * navigation state, and message routing via pendingSearchHandlers.
 */

import { describe, it, expect } from "bun:test";

// ── Re-implement web frontend pure helpers (inline JS, not importable) ──

function formatAgo(when: number | undefined): string {
  if (!when) return "";
  const dt = Math.max(0, Date.now() - when);
  if (dt < 60_000) return "just now";
  if (dt < 3_600_000) return Math.round(dt / 60_000) + "m ago";
  if (dt < 86_400_000) return Math.round(dt / 3_600_000) + "h ago";
  return Math.round(dt / 86_400_000) + "d ago";
}

function compactExcerpt(s: string | undefined): string {
  if (!s) return "";
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > 140 ? collapsed.slice(0, 137) + "..." : collapsed;
}

/** Simulates esc() in the web frontend (DOM-based in browser, here simplified). */
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Simplified version of renderSearchResults logic for testing. */
function renderSearchHitHtml(
  hit: {
    sessionId: string;
    sessionName: string;
    matchCount: number;
    lastMatchAt: number;
    snippets: { kind: string; excerpt: string; toolName?: string }[];
    workdir?: string;
  },
  idx: number,
  selectedIdx: number,
): string {
  const sel = idx === selectedIdx ? " selected" : "";
  const when = formatAgo(hit.lastMatchAt);
  const matchLabel =
    hit.matchCount + " match" + (hit.matchCount === 1 ? "" : "es");
  const snippetHtml = (hit.snippets || [])
    .slice(0, 3)
    .map((s) => {
      const prefix =
        s.kind === "user_turn"
          ? "you"
          : s.kind === "assistant_turn"
            ? "claude"
            : s.toolName
              ? s.toolName
              : "tool";
      const excerpt = compactExcerpt(s.excerpt);
      return (
        '<div class="search-snippet">' +
        '<span class="search-snippet-prefix">' +
        esc(prefix) +
        ":</span> " +
        esc(excerpt) +
        "</div>"
      );
    })
    .join("");
  return (
    '<div class="search-hit' +
    sel +
    '" data-sid="' +
    hit.sessionId +
    '" data-idx="' +
    idx +
    '">' +
    '<div class="search-hit-header">' +
    '<span class="search-hit-name">' +
    esc(hit.sessionName) +
    "</span>" +
    '<span class="search-meta">' +
    esc(matchLabel) +
    " \u00b7 " +
    esc(when) +
    "</span>" +
    "</div>" +
    snippetHtml +
    '<div class="search-workdir">' +
    esc(hit.workdir || "") +
    "</div>" +
    "</div>"
  );
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("web formatAgo", () => {
  it("returns empty string for undefined/falsy", () => {
    expect(formatAgo(undefined)).toBe("");
    expect(formatAgo(0)).toBe("");
  });

  it("returns 'just now' for recent timestamps", () => {
    expect(formatAgo(Date.now())).toBe("just now");
    expect(formatAgo(Date.now() - 45_000)).toBe("just now");
  });

  it("returns minutes", () => {
    expect(formatAgo(Date.now() - 120_000)).toBe("2m ago");
    expect(formatAgo(Date.now() - 30 * 60_000)).toBe("30m ago");
  });

  it("returns hours", () => {
    expect(formatAgo(Date.now() - 2 * 3_600_000)).toBe("2h ago");
  });

  it("returns days", () => {
    expect(formatAgo(Date.now() - 3 * 86_400_000)).toBe("3d ago");
  });
});

describe("compactExcerpt", () => {
  it("returns empty for undefined/null/empty", () => {
    expect(compactExcerpt(undefined)).toBe("");
    expect(compactExcerpt("")).toBe("");
  });

  it("collapses multiple whitespace to single space", () => {
    expect(compactExcerpt("hello   \n\t world")).toBe("hello world");
  });

  it("trims leading/trailing whitespace", () => {
    expect(compactExcerpt("  foo  ")).toBe("foo");
  });

  it("truncates at 140 chars with ellipsis", () => {
    const long = "a".repeat(200);
    const result = compactExcerpt(long);
    expect(result.length).toBe(140); // 137 chars + "..."
    expect(result.endsWith("...")).toBe(true);
    expect(result.startsWith("a".repeat(137))).toBe(true);
  });

  it("does not truncate strings <= 140 chars", () => {
    const exact = "b".repeat(140);
    expect(compactExcerpt(exact)).toBe(exact);
  });
});

describe("web search result rendering", () => {
  const baseHit = {
    sessionId: "sid-123",
    sessionName: "my-session",
    matchCount: 3,
    lastMatchAt: Date.now() - 300_000,
    snippets: [
      { kind: "user_turn", excerpt: "how do I fix this?" },
      { kind: "assistant_turn", excerpt: "try restarting the service" },
    ],
    workdir: "/home/user/project",
  };

  it("renders session name and match count", () => {
    const html = renderSearchHitHtml(baseHit, 0, 0);
    expect(html).toContain("my-session");
    expect(html).toContain("3 matches");
  });

  it("marks selected index with 'selected' class", () => {
    const selected = renderSearchHitHtml(baseHit, 0, 0);
    expect(selected).toContain("search-hit selected");

    const notSelected = renderSearchHitHtml(baseHit, 1, 0);
    expect(notSelected).not.toContain("selected");
  });

  it("renders snippet prefixes correctly", () => {
    const html = renderSearchHitHtml(baseHit, 0, 0);
    expect(html).toContain("you:</span>");
    expect(html).toContain("claude:</span>");
  });

  it("uses toolName for tool_call snippets", () => {
    const hit = {
      ...baseHit,
      snippets: [{ kind: "tool_call", excerpt: "content", toolName: "Read" }],
    };
    const html = renderSearchHitHtml(hit, 0, 0);
    expect(html).toContain("Read:</span>");
  });

  it("falls back to 'tool' when toolName missing", () => {
    const hit = {
      ...baseHit,
      snippets: [{ kind: "tool_call", excerpt: "content" }],
    };
    const html = renderSearchHitHtml(hit, 0, 0);
    expect(html).toContain("tool:</span>");
  });

  it("limits snippets to 3 per hit", () => {
    const hit = {
      ...baseHit,
      snippets: [
        { kind: "user_turn", excerpt: "s1" },
        { kind: "assistant_turn", excerpt: "s2" },
        { kind: "tool_call", excerpt: "s3", toolName: "Bash" },
        { kind: "user_turn", excerpt: "s4-should-not-appear" },
      ],
    };
    const html = renderSearchHitHtml(hit, 0, 0);
    expect(html).toContain("s1");
    expect(html).toContain("s2");
    expect(html).toContain("s3");
    expect(html).not.toContain("s4-should-not-appear");
  });

  it("renders workdir", () => {
    const html = renderSearchHitHtml(baseHit, 0, 0);
    expect(html).toContain("/home/user/project");
  });

  it("escapes HTML in session names", () => {
    const hit = { ...baseHit, sessionName: '<script>alert("xss")</script>' };
    const html = renderSearchHitHtml(hit, 0, 0);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes HTML in excerpts", () => {
    const hit = {
      ...baseHit,
      snippets: [{ kind: "user_turn", excerpt: '<img src=x onerror="alert(1)">' }],
    };
    const html = renderSearchHitHtml(hit, 0, 0);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("includes data-sid and data-idx attributes", () => {
    const html = renderSearchHitHtml(baseHit, 2, 0);
    expect(html).toContain('data-sid="sid-123"');
    expect(html).toContain('data-idx="2"');
  });

  it("shows singular 'match' for count=1", () => {
    const hit = { ...baseHit, matchCount: 1 };
    const html = renderSearchHitHtml(hit, 0, 0);
    expect(html).toContain("1 match");
    expect(html).not.toContain("1 matches");
  });
});

describe("web search — keyboard navigation state", () => {
  it("ArrowDown increments index clamped to length-1", () => {
    const hitsLength = 5;
    let selectedIdx = 0;

    // Simulate ArrowDown
    selectedIdx = Math.min(hitsLength - 1, selectedIdx + 1);
    expect(selectedIdx).toBe(1);

    // At the end
    selectedIdx = 4;
    selectedIdx = Math.min(hitsLength - 1, selectedIdx + 1);
    expect(selectedIdx).toBe(4); // clamped
  });

  it("ArrowUp decrements index clamped to 0", () => {
    let selectedIdx = 3;

    selectedIdx = Math.max(0, selectedIdx - 1);
    expect(selectedIdx).toBe(2);

    // At the top
    selectedIdx = 0;
    selectedIdx = Math.max(0, selectedIdx - 1);
    expect(selectedIdx).toBe(0); // clamped
  });
});

describe("web search — pendingSearchHandlers routing", () => {
  it("routes message by requestId and removes handler", () => {
    const handlers: Record<string, (msg: unknown) => void> = {};
    let received: unknown = null;

    const reqId = "req-abc";
    handlers[reqId] = (msg) => {
      received = msg;
    };

    // Simulate incoming message
    const msg = { type: "session.search.result", requestId: reqId, sessions: [] };
    if (msg.requestId && handlers[msg.requestId]) {
      handlers[msg.requestId](msg);
      delete handlers[msg.requestId];
    }

    expect(received).toEqual(msg);
    expect(handlers[reqId]).toBeUndefined();
  });

  it("ignores messages without matching requestId", () => {
    const handlers: Record<string, (msg: unknown) => void> = {};
    let called = false;
    handlers["req-xyz"] = () => { called = true; };

    const msg = { type: "session.search.result", requestId: "req-other", sessions: [] };
    if (msg.requestId && handlers[msg.requestId]) {
      handlers[msg.requestId](msg);
      delete handlers[msg.requestId];
    }

    expect(called).toBe(false);
    expect(handlers["req-xyz"]).toBeDefined();
  });

  it("stale sequence check prevents old responses from rendering", () => {
    let searchSeq = 0;
    const results: unknown[] = [];

    // Simulate first search
    const seq1 = ++searchSeq;
    // Second search fires before first returns
    const seq2 = ++searchSeq;

    // First response arrives — stale
    const handler1 = (msg: unknown) => {
      if (seq1 !== searchSeq) return; // stale guard
      results.push(msg);
    };

    // Second response arrives — current
    const handler2 = (msg: unknown) => {
      if (seq2 !== searchSeq) return;
      results.push(msg);
    };

    handler1({ sessions: ["old"] });
    handler2({ sessions: ["new"] });

    // Only the current-seq result is accepted.
    expect(results).toHaveLength(1);
    expect((results[0] as { sessions: string[] }).sessions[0]).toBe("new");
  });
});
