/**
 * Per-rule unit tests for Phase 3 built-in compressors.
 *
 * Each rule is tested against representative fixture outputs. We assert:
 *   - small outputs pass through (null return)
 *   - large outputs produce compressed text
 *   - rule preserves load-bearing content (hunk headers, failure lines, etc.)
 *   - ruleName + hint formatting is right
 */

import { describe, it, expect } from "bun:test";
import {
  gitDiffRule,
  gitStatusRule,
  gitLogRule,
  lsRule,
  catRule,
  findTreeRule,
  searchRule,
  testRunnerRule,
  type CompressionContext,
} from "../daemon/compress/index.js";

function ctx(bytes: number, cmd: string): CompressionContext {
  return {
    workdir: "/tmp",
    originalCommand: cmd,
    exitCode: 0,
    isLarge: true,
    rawBytes: bytes,
    env: {},
  };
}

// ── git-diff ─────────────────────────────────────────────────────────────

describe("gitDiffRule", () => {
  function bigDiff(): string {
    const lines: string[] = [];
    lines.push("diff --git a/src/big.ts b/src/big.ts");
    lines.push("index 1111111..2222222 100644");
    lines.push("--- a/src/big.ts");
    lines.push("+++ b/src/big.ts");
    lines.push("@@ -1,200 +1,200 @@");
    // 100 unchanged context lines
    for (let i = 0; i < 100; i++) lines.push(` unchanged context ${i}`);
    lines.push("-removed line");
    lines.push("+added line");
    // 100 more unchanged
    for (let i = 100; i < 200; i++) lines.push(` unchanged context ${i}`);
    return lines.join("\n");
  }

  it("matches git diff / show / log -p / format-patch", () => {
    expect(gitDiffRule.match("git diff HEAD~5")).toBe(true);
    expect(gitDiffRule.match("git show abc123")).toBe(true);
    expect(gitDiffRule.match("git log -p")).toBe(true);
    expect(gitDiffRule.match("git log --oneline")).toBe(false);
    expect(gitDiffRule.match("git status")).toBe(false);
  });

  it("passes through tiny diffs", () => {
    const tiny = "diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+b\n";
    expect(gitDiffRule.compress(tiny, ctx(tiny.length, "git diff"))).toBeNull();
  });

  it("collapses long unchanged context on big diffs", () => {
    const big = bigDiff();
    const r = gitDiffRule.compress(big, ctx(big.length, "git diff HEAD"));
    expect(r).not.toBeNull();
    expect(r!.ruleName).toBe("git-diff");
    // Preserves hunk header and changed lines.
    expect(r!.compressed).toContain("@@ -1,200 +1,200 @@");
    expect(r!.compressed).toContain("-removed line");
    expect(r!.compressed).toContain("+added line");
    // Collapses the context into an "... N unchanged lines ..." marker.
    expect(r!.compressed).toContain("unchanged lines");
    expect(r!.compressed.length).toBeLessThan(big.length);
  });

  it("elides binary diff blocks", () => {
    const lines = [
      "diff --git a/pic.png b/pic.png",
      "index 0000000..1111111",
      "GIT binary patch",
      "Binary files a/pic.png and b/pic.png differ",
    ];
    // Pad with a second diff containing long unchanged-context runs so
    // the total exceeds the 4KB rule threshold. Use lines long enough to
    // matter byte-wise.
    lines.push("diff --git a/foo.ts b/foo.ts");
    lines.push("@@ -1,200 +1,200 @@");
    for (let i = 0; i < 120; i++) {
      lines.push(` // unchanged context line with actual bytes ${i} ${"x".repeat(20)}`);
    }
    lines.push("-removed line");
    lines.push("+added line");
    const body = lines.join("\n");
    const r = gitDiffRule.compress(body, ctx(body.length, "git diff"));
    expect(r).not.toBeNull();
    expect(r!.compressed).toContain("binary diff elided");
    expect(r!.compressed).toContain("+added line");
  });
});

// ── git-status ───────────────────────────────────────────────────────────

describe("gitStatusRule", () => {
  it("passes through small status", () => {
    const small = "On branch main\nnothing to commit, working tree clean\n";
    expect(gitStatusRule.compress(small, ctx(small.length, "git status"))).toBeNull();
  });

  it("elides huge untracked-files list", () => {
    const header = [
      "On branch main",
      "Your branch is up to date",
      "",
      "Changes to be committed:",
      "  new file:   src/foo.ts",
      "",
      "Untracked files:",
      '  (use "git add <file>..." to include in what will be committed)',
    ].join("\n");
    const untracked = Array.from({ length: 300 }, (_, i) => `\tsrc/generated-${i}.ts`).join("\n");
    const full = header + "\n" + untracked + "\n";
    const r = gitStatusRule.compress(full, ctx(full.length, "git status"));
    expect(r).not.toBeNull();
    expect(r!.ruleName).toBe("git-status");
    // Header + staged changes preserved.
    expect(r!.compressed).toContain("Changes to be committed");
    expect(r!.compressed).toContain("new file");
    // Tail truncated.
    expect(r!.compressed).toContain("untracked files omitted");
    expect(r!.compressed.length).toBeLessThan(full.length);
  });
});

// ── git-log ──────────────────────────────────────────────────────────────

describe("gitLogRule", () => {
  function bigLog(n: number): string {
    const blocks: string[] = [];
    for (let i = 0; i < n; i++) {
      blocks.push(
        [
          `commit ${String(i).padStart(40, "0").slice(0, 40)}`,
          `Author: Test <test@example.com>`,
          `Date:   Mon Jan 1 00:00:0${i % 10} 2024`,
          ``,
          `    Commit message ${i}`,
          ``,
        ].join("\n"),
      );
    }
    return blocks.join("\n");
  }

  it("does NOT match git log -p (that's handled by git-diff)", () => {
    expect(gitLogRule.match("git log -p")).toBe(false);
    expect(gitLogRule.match("git log --patch")).toBe(false);
  });

  it("matches plain git log", () => {
    expect(gitLogRule.match("git log --oneline")).toBe(true);
    expect(gitLogRule.match("git log")).toBe(true);
  });

  it("collapses middle commits on long history", () => {
    const big = bigLog(100);
    const r = gitLogRule.compress(big, ctx(big.length, "git log"));
    expect(r).not.toBeNull();
    expect(r!.compressed).toContain("Commit message 0");
    expect(r!.compressed).toContain("Commit message 99");
    expect(r!.compressed).toContain("older commits elided");
  });
});

// ── ls ───────────────────────────────────────────────────────────────────

describe("lsRule", () => {
  it("passes through short directory listings", () => {
    const small = Array.from({ length: 30 }, (_, i) => `file_${i}.ts`).join("\n");
    expect(lsRule.compress(small, ctx(small.length, "ls"))).toBeNull();
  });

  it("groups large listings by extension", () => {
    // Use long filenames so the listing exceeds the 2 KB rule threshold.
    const files = [
      ...Array.from({ length: 40 }, (_, i) => `src_very_long_filename_${i}_padding_to_fit_size_threshold.ts`),
      ...Array.from({ length: 30 }, (_, i) => `asset_long_${i}.png`),
      ...Array.from({ length: 20 }, (_, i) => `doc_long_${i}.md`),
    ].join("\n");
    const r = lsRule.compress(files, ctx(files.length, "ls -la"));
    expect(r).not.toBeNull();
    expect(r!.ruleName).toBe("ls");
    expect(r!.compressed).toContain("Extensions");
    expect(r!.compressed).toContain(".ts: 40");
    expect(r!.compressed).toContain(".png: 30");
    expect(r!.compressed).toContain(".md: 20");
    expect(r!.compressed.length).toBeLessThan(files.length);
  });
});

// ── cat ──────────────────────────────────────────────────────────────────

describe("catRule", () => {
  it("matches cat/bat/less/more", () => {
    expect(catRule.match("cat package.json")).toBe(true);
    expect(catRule.match("bat src/foo.ts")).toBe(true);
    expect(catRule.match("less /var/log/app.log")).toBe(true);
    expect(catRule.match("head -n 100 file")).toBe(false);
  });

  it("head+tail truncates files over 200 lines", () => {
    const content = Array.from({ length: 500 }, (_, i) => `// source line ${i}`).join("\n");
    const r = catRule.compress(content, ctx(content.length, "cat big.ts"));
    expect(r).not.toBeNull();
    expect(r!.compressed).toContain("source line 0");
    expect(r!.compressed).toContain("source line 499");
    expect(r!.compressed).toContain("Read tool");
    expect(r!.compressed.length).toBeLessThan(content.length);
  });
});

// ── find / tree ──────────────────────────────────────────────────────────

describe("findTreeRule", () => {
  it("groups many paths by parent directory", () => {
    const paths: string[] = [];
    for (let d = 0; d < 10; d++) {
      for (let f = 0; f < 20; f++) {
        paths.push(`src/module-${d}/file-${f}.ts`);
      }
    }
    const raw = paths.join("\n");
    const r = findTreeRule.compress(raw, ctx(raw.length, "find src/ -type f"));
    expect(r).not.toBeNull();
    expect(r!.ruleName).toBe("find-tree");
    expect(r!.compressed).toContain("200 paths from 10 directories");
    // Top-N listing surfaces one of the dirs.
    expect(r!.compressed).toMatch(/src\/module-\d+\/ — 20 entries/);
  });
});

// ── search ──────────────────────────────────────────────────────────────

describe("searchRule", () => {
  it("passes through small searches", () => {
    const small = "src/a.ts:10:hello\nsrc/b.ts:5:world\n";
    expect(searchRule.compress(small, ctx(small.length, "rg hello"))).toBeNull();
  });

  it("groups hits by file on large result sets", () => {
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 12; j++) {
        lines.push(`src/file-${i}.ts:${j + 1}:match text ${i}-${j}`);
      }
    }
    const raw = lines.join("\n");
    const r = searchRule.compress(raw, ctx(raw.length, "rg needle"));
    expect(r).not.toBeNull();
    expect(r!.ruleName).toBe("search");
    expect(r!.compressed).toContain("120 matches across 10 files");
    // Should show "more hits in" for files with >5 matches.
    expect(r!.compressed).toContain("more hits in");
  });
});

// ── test-runner ─────────────────────────────────────────────────────────

describe("testRunnerRule", () => {
  it("matches common runners", () => {
    expect(testRunnerRule.match("bun test")).toBe(true);
    expect(testRunnerRule.match("pnpm test")).toBe(true);
    expect(testRunnerRule.match("npx vitest run")).toBe(true);
    expect(testRunnerRule.match("pytest tests/")).toBe(true);
    expect(testRunnerRule.match("go test ./...")).toBe(true);
    expect(testRunnerRule.match("cargo test --lib")).toBe(true);
    expect(testRunnerRule.match("rspec")).toBe(true);
    expect(testRunnerRule.match("ls")).toBe(false);
  });

  it("drops passing lines, keeps failures + summary", () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) lines.push(`✓ test case ${i} passed`);
    lines.push("");
    lines.push("✗ test case 201 FAILED");
    lines.push("  AssertionError: expected 1 but got 2");
    lines.push("  at foo.test.ts:42");
    lines.push("");
    lines.push("Tests:       1 failed, 200 passed, 201 total");
    const raw = lines.join("\n");
    const r = testRunnerRule.compress(raw, ctx(raw.length, "bun test"));
    expect(r).not.toBeNull();
    expect(r!.ruleName).toBe("test-runner");
    // Passing lines gone.
    expect(r!.compressed).not.toContain("test case 50 passed");
    // Failure block preserved with surrounding context.
    expect(r!.compressed).toContain("test case 201 FAILED");
    expect(r!.compressed).toContain("AssertionError");
    // Summary line preserved.
    expect(r!.compressed).toContain("1 failed, 200 passed");
    // Meaningfully smaller.
    expect(r!.compressed.length).toBeLessThan(raw.length / 2);
  });

  it("does not fire when there's nothing to drop", () => {
    const raw = [
      "Test run started",
      "Loading specs...",
      "Running on node 22.4",
      "Tests:       2 failed, 0 passed, 2 total",
    ].join("\n");
    expect(testRunnerRule.compress(raw, ctx(raw.length, "bun test"))).toBeNull();
  });
});
