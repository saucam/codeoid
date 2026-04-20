/**
 * Attachment resolver tests — prove that the limits, error surfaces, and
 * prompt-formatting invariants hold. The daemon's Session.send inlines
 * attachment content into the Claude prompt, so getting the boundary
 * behavior right is load-bearing.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveAttachments,
  formatAsPrompt,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from "../daemon/attachments.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeoid-attach-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("resolveAttachments — happy path", () => {
  it("reads a file relative to workdir and wraps in <file> block", () => {
    writeFileSync(join(dir, "spec.md"), "# Spec\nshould work");
    const { resolved, promptPrefix } = resolveAttachments(
      [{ path: "spec.md" }],
      { workdir: dir },
    );
    expect(resolved.length).toBe(1);
    expect(resolved[0]!.content).toBe("# Spec\nshould work");
    expect(resolved[0]!.error).toBeUndefined();
    expect(promptPrefix).toContain(`<file path="spec.md">`);
    expect(promptPrefix).toContain("# Spec");
  });

  it("honors inlined content without hitting disk", () => {
    const { resolved } = resolveAttachments(
      [{ path: "pasted.txt", content: "from clipboard" }],
      { workdir: dir },
    );
    expect(resolved[0]!.content).toBe("from clipboard");
    expect(resolved[0]!.error).toBeUndefined();
  });
});

describe("resolveAttachments — error cases", () => {
  it("emits error marker for missing files, does not throw", () => {
    const { resolved, promptPrefix } = resolveAttachments(
      [{ path: "nope.md" }],
      { workdir: dir },
    );
    expect(resolved[0]!.error).toContain("unreadable");
    expect(resolved[0]!.content).toBeUndefined();
    expect(promptPrefix).toContain(`<file path="nope.md" error=`);
    expect(promptPrefix).not.toContain(`</file>`); // self-closing for errors
  });

  it("rejects binary files (null byte in first 1024 bytes)", () => {
    const binary = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]); // JPEG magic + null
    writeFileSync(join(dir, "image.bin"), binary);
    const { resolved } = resolveAttachments(
      [{ path: "image.bin" }],
      { workdir: dir },
    );
    expect(resolved[0]!.error).toContain("binary");
    expect(resolved[0]!.content).toBeUndefined();
  });

  it("rejects directories", () => {
    const { resolved } = resolveAttachments(
      [{ path: "." }],
      { workdir: dir },
    );
    expect(resolved[0]!.error).toContain("not a regular file");
  });
});

describe("resolveAttachments — size limits", () => {
  it("truncates oversized single files with a trailing marker", () => {
    const big = "x".repeat(50); // small for testing
    writeFileSync(join(dir, "big.txt"), big);
    const { resolved } = resolveAttachments(
      [{ path: "big.txt" }],
      { workdir: dir, maxBytes: 20 },
    );
    expect(resolved[0]!.bytes).toBe(50);
    expect(resolved[0]!.content).toContain("truncated");
    expect(resolved[0]!.content!.length).toBeLessThan(big.length + 100);
  });

  it("enforces total budget across multiple files", () => {
    writeFileSync(join(dir, "a.txt"), "a".repeat(50));
    writeFileSync(join(dir, "b.txt"), "b".repeat(50));
    writeFileSync(join(dir, "c.txt"), "c".repeat(50));
    const { resolved } = resolveAttachments(
      [{ path: "a.txt" }, { path: "b.txt" }, { path: "c.txt" }],
      { workdir: dir, maxBytes: 50, maxTotalBytes: 80 },
    );
    expect(resolved[0]!.content).toBe("a".repeat(50));
    // Second gets truncated to the remainder (80 - 50 = 30).
    expect(resolved[1]!.content).toContain("truncated");
    expect(resolved[1]!.content!.startsWith("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBe(true);
    // Third gets the full error marker (no remaining budget).
    expect(resolved[2]!.error).toContain("total attachment budget exceeded");
  });

  it("has sane production defaults", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(100 * 1024);
    expect(MAX_TOTAL_ATTACHMENT_BYTES).toBe(500 * 1024);
  });
});

describe("resolveAttachments — binary payloads (paste/drop)", () => {
  it("writes base64 image payload to the session attachment subdir", () => {
    // 1x1 transparent PNG (base64). Lets Buffer.from round-trip without
    // pulling in a real image lib.
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==";
    const { resolved, promptPrefix } = resolveAttachments(
      [{ path: "paste-1.png", mimeType: "image/png", data: pngBase64 }],
      { workdir: dir },
    );
    expect(resolved.length).toBe(1);
    expect(resolved[0]!.binary).toBe(true);
    expect(resolved[0]!.mimeType).toBe("image/png");
    // Path is rewritten to the attachment subdir under the workdir.
    expect(resolved[0]!.path.startsWith(".codeoid/attachments/")).toBe(true);
    expect(resolved[0]!.path.endsWith(".png")).toBe(true);
    expect(resolved[0]!.content).toBeUndefined();
    expect(resolved[0]!.error).toBeUndefined();
    // Prompt block signals the binary nature and nudges Read.
    expect(promptPrefix).toContain(`binary="true"`);
    expect(promptPrefix).toContain("Use the Read tool");
  });

  it("surfaces a PNG file referenced by path (binary by extension)", () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    writeFileSync(join(dir, "shot.png"), png);
    const { resolved, promptPrefix } = resolveAttachments(
      [{ path: "shot.png" }],
      { workdir: dir },
    );
    expect(resolved[0]!.binary).toBe(true);
    expect(resolved[0]!.mimeType).toBe("image/png");
    expect(resolved[0]!.error).toBeUndefined();
    expect(promptPrefix).toContain(`path="shot.png"`);
    expect(promptPrefix).toContain(`type="image/png"`);
  });

  it("rejects base64 payloads above the binary cap", () => {
    // Synthesize a fake base64 string that decodes to > 2 MB.
    const huge = "A".repeat(Math.ceil((2 * 1024 * 1024 + 1) * 4 / 3));
    const { resolved } = resolveAttachments(
      [{ path: "too-big.png", mimeType: "image/png", data: huge }],
      { workdir: dir },
    );
    expect(resolved[0]!.error).toContain("exceeds");
    expect(resolved[0]!.content).toBeUndefined();
  });
});

describe("formatAsPrompt output shape", () => {
  it("returns empty string when no attachments", () => {
    expect(formatAsPrompt([])).toBe("");
  });

  it("escapes HTML-unsafe characters in the path attribute", () => {
    const prompt = formatAsPrompt([
      { path: 'weird"name<.ts', content: "ok", bytes: 2 },
    ]);
    expect(prompt).toContain('path="weird&quot;name&lt;.ts"');
  });
});
