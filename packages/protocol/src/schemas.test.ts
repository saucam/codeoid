/**
 * Schema tests — the runtime-validation contract for the inbound surface.
 *
 * Guards three properties:
 *   1. COVERAGE — every ClientMessage variant has a schema (compile-time
 *      assertion on the discriminant literals, both directions).
 *   2. FIDELITY — a valid sample of every variant round-trips unchanged.
 *   3. FORWARD-COMPAT — unknown FIELDS are stripped (never rejected);
 *      unknown message TYPES are rejected; documented LIMITS are enforced.
 */

import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import type { ClientMessage } from "./types.js";
import { LIMITS } from "./types.js";
import {
  attachmentSchema,
  authMsgSchema,
  type clientMessageSchema,
  parseAuthMsg,
  parseClientMessage,
} from "./schemas.js";

// ── 1. Compile-time coverage: schema discriminants ⇔ ClientMessage types ─────

type SchemaTypes = z.infer<typeof clientMessageSchema>["type"];
type ClientTypes = ClientMessage["type"];
type MutualCover = [SchemaTypes] extends [ClientTypes]
  ? [ClientTypes] extends [SchemaTypes]
    ? true
    : never
  : never;

test("every ClientMessage variant has a schema and vice versa (compile-time)", () => {
  // This const fails to TYPECHECK when a variant is missing on either side —
  // the runtime assertion is just so the check lives in a visible test.
  const covered: MutualCover = true;
  expect(covered).toBe(true);
});

// ── 2. Fidelity: one valid sample per variant, keyed so adding a variant
//      without a sample is a compile error ─────────────────────────────────────

const samples: { [T in ClientTypes]: Extract<ClientMessage, { type: T }> } = {
  ping: { type: "ping", id: "r1" },
  "session.create": {
    type: "session.create",
    id: "r2",
    name: "demo",
    workdir: "/tmp/w",
    providerId: "pi",
  },
  "session.list": { type: "session.list", id: "r3" },
  "session.attach": { type: "session.attach", id: "r4", sessionId: "s1" },
  "session.detach": { type: "session.detach", id: "r5", sessionId: "s1" },
  "session.send": {
    type: "session.send",
    id: "r6",
    sessionId: "s1",
    text: "hello",
    attachments: [{ path: "notes.md" }, { path: "img.png", mimeType: "image/png", data: "aGk=" }],
    priority: "next",
  },
  "session.interrupt": { type: "session.interrupt", id: "r7", sessionId: "s1" },
  "session.approve": {
    type: "session.approve",
    id: "r8",
    sessionId: "s1",
    approvalId: "a1",
    approved: true,
    updatedInput: { answers: { "Which?": "B" } },
  },
  "session.ui_response": {
    type: "session.ui_response",
    id: "r25",
    sessionId: "s1",
    requestId: "u1",
    value: "Allow",
  },
  "session.part_action": {
    type: "session.part_action",
    id: "r26",
    sessionId: "s1",
    messageId: "m1",
    action: "retry-build",
    data: { target: "web" },
  },
  "session.commands": { type: "session.commands", id: "r27", sessionId: "s1" },
  "session.destroy": { type: "session.destroy", id: "r9", sessionId: "s1" },
  "session.set_mode": { type: "session.set_mode", id: "r10", sessionId: "s1", mode: "autonomous", maxTurns: 5 },
  "session.pin": { type: "session.pin", id: "r11", sessionId: "s1", path: "SPEC.md" },
  "session.unpin": { type: "session.unpin", id: "r12", sessionId: "s1", path: "SPEC.md" },
  "session.rotate": { type: "session.rotate", id: "r13", sessionId: "s1" },
  "session.search": { type: "session.search", id: "r14", query: "auth bug", scope: "all", limit: 5 },
  "session.set_model": { type: "session.set_model", id: "r15", sessionId: "s1", model: "opus", fallbackModel: null },
  "session.rename": { type: "session.rename", id: "r16", sessionId: "s1", name: "renamed" },
  "fs.list": { type: "fs.list", id: "r17", sessionId: "s1", path: "src" },
  "fs.read": { type: "fs.read", id: "r18", sessionId: "s1", path: "src/a.ts", maxBytes: 1024 },
  "fs.browse_dir": { type: "fs.browse_dir", id: "r19", path: "/home" },
  "claude.config": { type: "claude.config", id: "r20", sessionId: "s1" },
  "models.list": { type: "models.list", id: "r21", provider: "claude" },
  "session.export": { type: "session.export", id: "r22", sessionId: "s1", includeMemory: true, toFile: false },
  "session.import": {
    type: "session.import",
    id: "r23",
    source: { kind: "inline", bundle: { manifest: { v: 1 } } },
    targetWorkdir: "/tmp/w2",
    nameOverride: "imported",
  },
  "usage.daily": { type: "usage.daily", id: "r24", days: 30 },
};

describe("fidelity — valid samples round-trip unchanged", () => {
  for (const [type, sample] of Object.entries(samples)) {
    test(type, () => {
      const result = parseClientMessage(sample);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual(sample);
    });
  }
});

// ── 3. Forward-compat + rejection behaviour ───────────────────────────────────

describe("forward-compat", () => {
  test("unknown FIELDS on a known message are stripped, not rejected", () => {
    const result = parseClientMessage({
      type: "session.attach",
      id: "r1",
      sessionId: "s1",
      futureField: { anything: true },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ type: "session.attach", id: "r1", sessionId: "s1" });
      expect("futureField" in result.value).toBe(false);
    }
  });

  test("unknown message TYPES are rejected", () => {
    const result = parseClientMessage({ type: "session.teleport", id: "r1" });
    expect(result.ok).toBe(false);
  });

  test("non-object frames are rejected", () => {
    expect(parseClientMessage("hi").ok).toBe(false);
    expect(parseClientMessage(null).ok).toBe(false);
    expect(parseClientMessage(42).ok).toBe(false);
  });

  test("auth frame also strips unknown fields (future handshake additions)", () => {
    const result = parseAuthMsg({ type: "auth", token: "t", resume: { key: "k" } });
    expect(result.ok).toBe(true);
    if (result.ok) expect("resume" in result.value).toBe(false);
  });
});

describe("required fields", () => {
  test("missing id is rejected", () => {
    expect(parseClientMessage({ type: "ping" }).ok).toBe(false);
  });

  test("missing sessionId is rejected", () => {
    expect(parseClientMessage({ type: "session.attach", id: "r1" }).ok).toBe(false);
  });

  test("empty session name is rejected (create + rename)", () => {
    expect(parseClientMessage({ type: "session.create", id: "r", name: "", workdir: "/w" }).ok).toBe(false);
    expect(parseClientMessage({ type: "session.rename", id: "r", sessionId: "s", name: "" }).ok).toBe(false);
  });

  test("multiple issues are summarized with a (+N more) suffix", () => {
    const result = parseClientMessage({ type: "session.create", id: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/\(\+\d+ more\)/);
  });
});

describe("LIMITS enforcement", () => {
  test("session.send text at the cap is accepted; over the cap is rejected", () => {
    const at = { type: "session.send", id: "r", sessionId: "s", text: "x".repeat(LIMITS.SEND_TEXT_MAX) };
    const over = { type: "session.send", id: "r", sessionId: "s", text: "x".repeat(LIMITS.SEND_TEXT_MAX + 1) };
    expect(parseClientMessage(at).ok).toBe(true);
    const rejected = parseClientMessage(over);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toContain("text");
  });

  test("attachments array over ATTACHMENTS_MAX is rejected", () => {
    const attachments = Array.from({ length: LIMITS.ATTACHMENTS_MAX + 1 }, (_, i) => ({ path: `f${i}` }));
    expect(parseClientMessage({ type: "session.send", id: "r", sessionId: "s", text: "t", attachments }).ok).toBe(false);
  });

  test("oversized name / query / model are rejected", () => {
    expect(
      parseClientMessage({ type: "session.create", id: "r", name: "n".repeat(LIMITS.NAME_MAX + 1), workdir: "/w" }).ok,
    ).toBe(false);
    expect(parseClientMessage({ type: "session.search", id: "r", query: "q".repeat(LIMITS.QUERY_MAX + 1) }).ok).toBe(false);
    expect(
      parseClientMessage({ type: "session.set_model", id: "r", sessionId: "s", model: "m".repeat(LIMITS.MODEL_MAX + 1) }).ok,
    ).toBe(false);
  });

  test("numeric bounds: search limit, usage days, fs.read maxBytes, set_mode maxTurns", () => {
    expect(parseClientMessage({ type: "session.search", id: "r", query: "q", limit: 0 }).ok).toBe(false);
    expect(parseClientMessage({ type: "session.search", id: "r", query: "q", limit: 101 }).ok).toBe(false);
    expect(parseClientMessage({ type: "usage.daily", id: "r", days: 366 }).ok).toBe(false);
    expect(parseClientMessage({ type: "fs.read", id: "r", sessionId: "s", path: "p", maxBytes: 0 }).ok).toBe(false);
    expect(parseClientMessage({ type: "session.set_mode", id: "r", sessionId: "s", mode: "autonomous", maxTurns: -1 }).ok).toBe(false);
  });
});

describe("attachments", () => {
  test("content and data are mutually exclusive", () => {
    expect(attachmentSchema.safeParse({ path: "f", content: "x", data: "eA==", mimeType: "text/plain" }).success).toBe(false);
  });

  test("data requires mimeType", () => {
    expect(attachmentSchema.safeParse({ path: "f", data: "eA==" }).success).toBe(false);
    expect(attachmentSchema.safeParse({ path: "f", data: "eA==", mimeType: "text/plain" }).success).toBe(true);
  });

  test("plain path-only and content attachments are valid", () => {
    expect(attachmentSchema.safeParse({ path: "f" }).success).toBe(true);
    expect(attachmentSchema.safeParse({ path: "f", content: "inline" }).success).toBe(true);
  });
});

describe("auth handshake", () => {
  test("minimal frame (legacy client) is valid", () => {
    const result = parseAuthMsg({ type: "auth", token: "jwt" });
    expect(result.ok).toBe(true);
  });

  test("full frame with version + capabilities + client is valid", () => {
    const frame = {
      type: "auth" as const,
      token: "jwt",
      protocolVersion: 1,
      capabilities: ["parts", "replay.chunked"],
      client: "codeoid-web",
    };
    const result = parseAuthMsg(frame);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(frame);
  });

  test("missing or empty token is rejected", () => {
    expect(parseAuthMsg({ type: "auth" }).ok).toBe(false);
    expect(parseAuthMsg({ type: "auth", token: "" }).ok).toBe(false);
  });

  test("malformed capabilities are rejected", () => {
    expect(parseAuthMsg({ type: "auth", token: "t", capabilities: "parts" }).ok).toBe(false);
    expect(parseAuthMsg({ type: "auth", token: "t", capabilities: [42] }).ok).toBe(false);
  });

  test("wrong type literal is rejected", () => {
    expect(authMsgSchema.safeParse({ type: "ping", token: "t" }).success).toBe(false);
  });
});

describe("session.ui_response payload exclusivity", () => {
  test("ambiguous payloads are rejected", () => {
    // Two payload fields at once.
    expect(
      parseClientMessage({
        type: "session.ui_response",
        id: "r1",
        sessionId: "s1",
        requestId: "u1",
        value: "x",
        cancelled: true,
      }).ok,
    ).toBe(false);
    // No payload field at all.
    expect(
      parseClientMessage({
        type: "session.ui_response",
        id: "r1",
        sessionId: "s1",
        requestId: "u1",
      }).ok,
    ).toBe(false);
  });

  test("each single-field payload is accepted", () => {
    for (const payload of [{ value: "x" }, { confirmed: false }, { cancelled: true }]) {
      const result = parseClientMessage({
        type: "session.ui_response",
        id: "r1",
        sessionId: "s1",
        requestId: "u1",
        ...payload,
      });
      expect(result.ok).toBe(true);
    }
  });
});
