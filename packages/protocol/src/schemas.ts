/**
 * Runtime validation schemas for the INBOUND (client → daemon) protocol
 * surface. The daemon validates every frame against these before acting on
 * it; clients may use them to pre-validate.
 *
 * Import via the subpath export — `@codeoid/protocol/schemas` — which keeps
 * the root package (`@codeoid/protocol`) dependency-free for type-only
 * consumers. `zod` is an optional peer dependency: only installs that import
 * this module need it.
 *
 * Forward-compat contract (mirrors the "ignore unknown" wire rule):
 *   - Unknown FIELDS on a known message are STRIPPED, never rejected — a
 *     newer client talking to an older daemon must not be turned away.
 *   - Unknown MESSAGE TYPES are rejected (`invalid_request`) — the daemon
 *     cannot act on a verb it doesn't know.
 *   - String/array bounds come from `LIMITS` (published, so clients can
 *     pre-validate instead of discovering limits from errors).
 */

import { z } from "zod";
import type { AuthMsg, ClientMessage } from "./types.js";
import { LIMITS } from "./types.js";

// ── Shared field schemas ──────────────────────────────────────────────────────

const idField = z.string().min(1).max(LIMITS.ID_MAX);
const sessionIdField = z.string().min(1).max(LIMITS.ID_MAX);
const pathField = z.string().max(LIMITS.PATH_MAX);
const nameField = z.string().min(1).max(LIMITS.NAME_MAX);

const base = { id: idField };

// ── Attachments ───────────────────────────────────────────────────────────────

export const attachmentSchema = z
  .object({
    path: pathField,
    content: z.string().max(LIMITS.ATTACHMENT_CONTENT_MAX).optional(),
    mimeType: z.string().max(256).optional(),
    data: z.string().max(LIMITS.ATTACHMENT_DATA_MAX).optional(),
  })
  .refine((a) => !(a.data !== undefined && a.content !== undefined), {
    message: "content and data are mutually exclusive",
  })
  .refine((a) => !(a.data !== undefined && a.mimeType === undefined), {
    message: "data requires mimeType",
  });

// ── Per-message schemas (one per ClientMessage variant) ───────────────────────

export const pingSchema = z.object({ ...base, type: z.literal("ping") });

export const sessionCreateSchema = z.object({
  ...base,
  type: z.literal("session.create"),
  name: nameField,
  workdir: pathField,
  /**
   * Session role. "conductor" requests THE per-tenant conductor session —
   * the daemon chooses its name/workdir itself, creates it on first request,
   * and returns the existing one afterwards (idempotent). Absent = a normal
   * coding session.
   *
   * Validated as a bounded string, not a literal, on purpose: the frame must
   * PARSE even for a role this daemon doesn't implement (a newer client, a
   * future P4 worker role) — the daemon then fail-closes with a clear
   * "unsupported role" error rather than the schema opaquely rejecting the
   * whole create. Matches the "accept the frame, act on what you understand"
   * wire contract.
   */
  role: z.string().max(LIMITS.NAME_MAX).optional(),
  /**
   * Backend id, validated as a bounded string (not an enum) on purpose: the
   * frame must PARSE for a provider this daemon doesn't know — the daemon
   * then fail-closes with a clear "unknown provider" error instead of the
   * schema opaquely rejecting the whole create.
   */
  providerId: z.string().min(1).max(64).optional(),
});

export const sessionListSchema = z.object({ ...base, type: z.literal("session.list") });

export const sessionAttachSchema = z.object({
  ...base,
  type: z.literal("session.attach"),
  sessionId: sessionIdField,
  resume: z
    .object({
      key: z.string().min(1).max(LIMITS.ID_MAX),
      sinceSeq: z.number().int().nonnegative(),
    })
    .optional(),
});

export const sessionDetachSchema = z.object({
  ...base,
  type: z.literal("session.detach"),
  sessionId: sessionIdField,
});

export const sessionSendSchema = z.object({
  ...base,
  type: z.literal("session.send"),
  sessionId: sessionIdField,
  // The token-bill safety net: see LIMITS.SEND_TEXT_MAX.
  text: z.string().max(LIMITS.SEND_TEXT_MAX),
  attachments: z.array(attachmentSchema).max(LIMITS.ATTACHMENTS_MAX).optional(),
  priority: z.enum(["now", "next", "later"]).optional(),
  clientMsgId: z.string().min(1).max(LIMITS.ID_MAX).optional(),
});

export const sessionInterruptSchema = z.object({
  ...base,
  type: z.literal("session.interrupt"),
  sessionId: sessionIdField,
});

export const sessionApproveSchema = z.object({
  ...base,
  type: z.literal("session.approve"),
  sessionId: sessionIdField,
  approvalId: z.string().min(1).max(LIMITS.ID_MAX),
  approved: z.boolean(),
  updatedInput: z.record(z.string(), z.unknown()).optional(),
});

export const sessionUiResponseSchema = z
  .object({
    ...base,
    type: z.literal("session.ui_response"),
    sessionId: sessionIdField,
    requestId: z.string().min(1).max(LIMITS.ID_MAX),
    value: z.string().max(LIMITS.UI_TEXT_MAX).optional(),
    confirmed: z.boolean().optional(),
    cancelled: z.boolean().optional(),
  })
  .refine(
    (r) =>
      [r.value, r.confirmed, r.cancelled].filter((v) => v !== undefined)
        .length === 1,
    { message: "exactly one of value, confirmed, or cancelled must be set" },
  );

export const sessionPartActionSchema = z.object({
  ...base,
  type: z.literal("session.part_action"),
  sessionId: sessionIdField,
  messageId: z.string().min(1).max(LIMITS.ID_MAX),
  action: z.string().min(1).max(256),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const sessionCommandsSchema = z.object({
  ...base,
  type: z.literal("session.commands"),
  sessionId: sessionIdField,
});

export const sessionDestroySchema = z.object({
  ...base,
  type: z.literal("session.destroy"),
  sessionId: sessionIdField,
});

export const sessionSetModeSchema = z.object({
  ...base,
  type: z.literal("session.set_mode"),
  sessionId: sessionIdField,
  mode: z.enum(["interactive", "guarded", "autonomous"]),
  maxTurns: z.number().int().positive().max(10_000).optional(),
});

export const sessionPinSchema = z.object({
  ...base,
  type: z.literal("session.pin"),
  sessionId: sessionIdField,
  path: pathField,
});

export const sessionUnpinSchema = z.object({
  ...base,
  type: z.literal("session.unpin"),
  sessionId: sessionIdField,
  path: pathField,
});

export const sessionRotateSchema = z.object({
  ...base,
  type: z.literal("session.rotate"),
  sessionId: sessionIdField,
});

export const sessionSearchSchema = z.object({
  ...base,
  type: z.literal("session.search"),
  query: z.string().min(1).max(LIMITS.QUERY_MAX),
  scope: z.enum(["workspace", "all"]).optional(),
  workdir: pathField.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const sessionSetProviderSchema = z.object({
  ...base,
  type: z.literal("session.set_provider"),
  sessionId: sessionIdField,
  // Bounded string, not an enum — the frame must PARSE for a provider this
  // daemon doesn't know so the daemon can fail-close with a clear error.
  providerId: z.string().min(1).max(64),
});

export const sessionSetModelSchema = z.object({
  ...base,
  type: z.literal("session.set_model"),
  sessionId: sessionIdField,
  model: z.string().min(1).max(LIMITS.MODEL_MAX),
  fallbackModel: z.string().max(LIMITS.MODEL_MAX).nullable().optional(),
});

export const sessionForkSchema = z.object({
  ...base,
  type: z.literal("session.fork"),
  sessionId: sessionIdField,
  name: nameField.optional(),
  providerId: z.string().min(1).max(64).optional(),
});

export const scrollbackPageSchema = z.object({
  ...base,
  type: z.literal("scrollback.page"),
  sessionId: sessionIdField,
  beforeMessageId: z.string().min(1).max(128),
  maxBytes: z.number().int().min(1).optional(),
});

export const sessionRenameSchema = z.object({
  ...base,
  type: z.literal("session.rename"),
  sessionId: sessionIdField,
  name: nameField,
});

export const fsListSchema = z.object({
  ...base,
  type: z.literal("fs.list"),
  sessionId: sessionIdField,
  path: pathField,
});

export const fsReadSchema = z.object({
  ...base,
  type: z.literal("fs.read"),
  sessionId: sessionIdField,
  path: pathField,
  maxBytes: z.number().int().positive().max(16 * 1024 * 1024).optional(),
});

export const fsBrowseDirSchema = z.object({
  ...base,
  type: z.literal("fs.browse_dir"),
  path: pathField.optional(),
});

export const claudeConfigSchema = z.object({
  ...base,
  type: z.literal("claude.config"),
  sessionId: sessionIdField,
});

export const modelsListSchema = z.object({
  ...base,
  type: z.literal("models.list"),
  provider: z.string().max(64).optional(),
});

export const sessionExportSchema = z.object({
  ...base,
  type: z.literal("session.export"),
  sessionId: sessionIdField,
  includeMemory: z.boolean().optional(),
  includePinnedFiles: z.boolean().optional(),
  aliasOverride: z.string().max(LIMITS.NAME_MAX).optional(),
  toFile: z.boolean().optional(),
});

export const sessionImportSchema = z.object({
  ...base,
  type: z.literal("session.import"),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("inline"), bundle: z.unknown() }),
    z.object({ kind: z.literal("file"), path: pathField }),
  ]),
  targetWorkdir: pathField,
  nameOverride: nameField.optional(),
  writePinnedFiles: z.boolean().optional(),
});

export const usageDailySchema = z.object({
  ...base,
  type: z.literal("usage.daily"),
  days: z.number().int().min(1).max(365).optional(),
});

export const settingsSchemaSchema = z.object({
  ...base,
  type: z.literal("settings.schema"),
});

export const settingsGetSchema = z.object({
  ...base,
  type: z.literal("settings.get"),
});

/** A single settings change — value is one of the JSON-serializable kinds. */
const settingValueField = z.union([
  z.string().max(LIMITS.SETTING_VALUE_MAX),
  z.number(),
  z.boolean(),
  z.array(z.string().max(LIMITS.SETTING_VALUE_MAX)).max(256),
  z.null(),
]);

export const settingsSetSchema = z.object({
  ...base,
  type: z.literal("settings.set"),
  patches: z
    .array(
      z.object({
        key: z.string().min(1).max(128),
        value: settingValueField,
      }),
    )
    .min(1)
    .max(256),
});

// ── The unions ────────────────────────────────────────────────────────────────

// ── SDLC pipeline ─────────────────────────────────────────────────────────────

const phaseDefSchema = z.object({
  id: z.string().min(1).max(LIMITS.ID_MAX),
  name: z.string().max(LIMITS.NAME_MAX).optional(),
  kind: z.string().min(1).max(64),
  skill: z.string().max(64).optional(),
  gate: z.string().max(64).optional(),
  entryGate: z.string().max(64).optional(),
  provider: z.string().max(64).optional(),
  model: z.string().max(LIMITS.MODEL_MAX).optional(),
  tools: z
    .object({
      allow: z.array(z.string().max(256)).max(128).optional(),
      deny: z.array(z.string().max(256)).max(128).optional(),
    })
    .optional(),
  reads: z.array(z.string().max(256)).max(128).optional(),
  writes: z.string().max(256).optional(),
  onFail: z
    .union([
      z.object({ action: z.literal("halt") }),
      z.object({ action: z.literal("retry"), max: z.number().int().positive().max(100) }),
      z.object({ action: z.literal("abort") }),
    ])
    .optional(),
});

export const pipelineCreateSchema = z.object({
  ...base,
  type: z.literal("pipeline.create"),
  name: nameField,
  phases: z.array(phaseDefSchema).min(1).max(64),
  spec: z.string().max(LIMITS.SEND_TEXT_MAX).optional(),
  workdir: pathField.optional(),
});

export const pipelineListSchema = z.object({
  ...base,
  type: z.literal("pipeline.list"),
});

export const pipelineGetSchema = z.object({
  ...base,
  type: z.literal("pipeline.get"),
  pipelineId: idField,
});

export const pipelineAnswerSchema = z.object({
  ...base,
  type: z.literal("pipeline.answer"),
  pipelineId: idField,
  requestId: z.string().min(1).max(LIMITS.ID_MAX),
  approved: z.boolean(),
  value: z.string().max(LIMITS.SEND_TEXT_MAX).optional(),
});

export const pipelineAbortSchema = z.object({
  ...base,
  type: z.literal("pipeline.abort"),
  pipelineId: idField,
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  pingSchema,
  sessionCreateSchema,
  sessionListSchema,
  sessionAttachSchema,
  sessionDetachSchema,
  sessionSendSchema,
  sessionInterruptSchema,
  sessionApproveSchema,
  sessionUiResponseSchema,
  sessionPartActionSchema,
  sessionCommandsSchema,
  sessionDestroySchema,
  sessionSetModeSchema,
  sessionPinSchema,
  sessionUnpinSchema,
  sessionRotateSchema,
  sessionSearchSchema,
  sessionSetModelSchema,
  sessionSetProviderSchema,
  sessionForkSchema,
  scrollbackPageSchema,
  sessionRenameSchema,
  fsListSchema,
  fsReadSchema,
  fsBrowseDirSchema,
  claudeConfigSchema,
  modelsListSchema,
  sessionExportSchema,
  sessionImportSchema,
  settingsSchemaSchema,
  settingsGetSchema,
  settingsSetSchema,
  usageDailySchema,
  pipelineCreateSchema,
  pipelineListSchema,
  pipelineGetSchema,
  pipelineAnswerSchema,
  pipelineAbortSchema,
]);

/**
 * The auth handshake frame — validated separately from `ClientMessage`
 * because it is the only frame accepted pre-authentication and carries no
 * request `id`.
 */
export const authMsgSchema = z.object({
  type: z.literal("auth"),
  token: z.string().min(1).max(16_384),
  protocolVersion: z.number().int().positive().optional(),
  capabilities: z.array(z.string().max(64)).max(64).optional(),
  client: z.string().max(128).optional(),
});

// ── Parse helpers ─────────────────────────────────────────────────────────────

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** Compact, single-line summary of a Zod error — safe to echo to clients. */
function summarize(error: z.ZodError): string {
  const issues = error.issues;
  const first = issues[0];
  if (!first) return "invalid message";
  const path = first.path.length > 0 ? `${first.path.join(".")}: ` : "";
  const head = `${path}${first.message}`.slice(0, 300);
  return issues.length > 1 ? `${head} (+${issues.length - 1} more)` : head;
}

/**
 * Validate an inbound post-auth frame. Returns the PARSED value (unknown
 * fields stripped) — callers should act on `value`, not the raw input.
 */
export function parseClientMessage(input: unknown): ParseResult<ClientMessage> {
  const result = clientMessageSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data as ClientMessage };
  return { ok: false, error: summarize(result.error) };
}

/** Validate the first (pre-auth) frame of a connection. */
export function parseAuthMsg(input: unknown): ParseResult<AuthMsg> {
  const result = authMsgSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data as AuthMsg };
  return { ok: false, error: summarize(result.error) };
}
