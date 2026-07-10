/**
 * Telegram streaming relay — buffers daemon stream deltas and delivers them
 * to a chat exactly once, in order.
 *
 * Telegram's rate limits make per-token streaming infeasible, so deltas are
 * accumulated per messageId and flushed at well-defined points:
 *
 *   - when the message's own final full broadcast arrives (authoritative —
 *     the buffer is dropped so idle can't re-send it),
 *   - when an unrelated message (e.g. a tool_call) interleaves mid-stream —
 *     only the *unflushed tail* is sent and the buffer stays live, so later
 *     deltas keep appending (per-buffer flushed offset),
 *   - when the session goes idle,
 *   - when the user detaches/switches sessions (so buffered content is never
 *     silently discarded).
 *
 * All sends go through a single per-relay promise chain, so chunks of long
 * messages, tool lines, and the final "✅ Done." marker arrive in order.
 */

import type {
  SessionMessage,
  SessionMessageDelta,
  ToolState,
} from "../../protocol/types.js";

/** Minimal Telegram API surface the relay needs (test-injectable). */
export interface RelayApi {
  sendMessage(
    chatId: number,
    text: string,
    opts?: Record<string, unknown>,
  ): Promise<unknown>;
}

interface StreamBuf {
  role: string;
  content: string;
  /** How much of `content` has already been sent to the chat. */
  flushed: number;
}

/** Telegram message size limit is 4096; leave headroom. */
const CHUNK_LIMIT = 4000;

/** Flush a pending tool-line batch after this much quiet time. */
const TOOL_BATCH_MS = 1000;
/** Flush a pending tool-line batch when it reaches this many lines. */
const TOOL_BATCH_MAX = 10;

/**
 * Split text into Telegram-sized chunks, preferring line boundaries so a
 * message isn't cut mid-line when a newline exists within the window.
 */
export function chunkText(text: string, limit = CHUNK_LIMIT): string[] {
  if (text.length <= limit) return text.length > 0 ? [text] : [];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const nl = rest.lastIndexOf("\n", limit);
    if (nl > 0) {
      chunks.push(rest.slice(0, nl));
      rest = rest.slice(nl + 1); // drop the boundary newline
    } else {
      chunks.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export class StreamRelay {
  #api: RelayApi;
  /** Per-messageId accumulator for streaming assistant/thinking content. */
  #buffers = new Map<string, StreamBuf>();
  /**
   * messageId → tool name. Tool completion/cancellation arrives as a
   * `session.message.delta` carrying only `toolStateUpdate` — the name lives
   * on the original tool_call broadcast, so remember it here.
   */
  #toolNames = new Map<string, string>();
  /**
   * All sends are chained so they reach Telegram in the order they were
   * produced — long messages chunk sequentially and "✅ Done." can never
   * overtake content.
   */
  #chain: Promise<unknown> = Promise.resolve();
  /**
   * Pending coalesced tool-status lines. A 30-tool turn used to produce 60+
   * sequential sends (one ⚡ per start + one ✓/✗ per completion), tripping
   * Telegram's flood limit and stalling the relay chain on 429s for minutes.
   * Consecutive tool lines are buffered here and flushed as ONE multi-line
   * message when (a) a non-tool send is enqueued, (b) the batch reaches
   * `#toolBatchMax` lines, or (c) `#toolBatchMs` elapses.
   */
  #toolBatch: { chatId: number; lines: string[] } | null = null;
  #toolBatchTimer: ReturnType<typeof setTimeout> | null = null;
  #toolBatchMs: number;
  #toolBatchMax: number;

  constructor(
    api: RelayApi,
    opts: { toolBatchMs?: number; toolBatchMax?: number } = {},
  ) {
    this.#api = api;
    this.#toolBatchMs = opts.toolBatchMs ?? TOOL_BATCH_MS;
    this.#toolBatchMax = opts.toolBatchMax ?? TOOL_BATCH_MAX;
  }

  /** Number of live streaming buffers (exposed for tests/invariants). */
  get bufferCount(): number {
    return this.#buffers.size;
  }

  /** Run `task` after every previously enqueued send has settled. */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(task);
    this.#chain = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  /** Queue a plain message send (order-preserving, errors swallowed). */
  send(
    chatId: number,
    text: string,
    opts?: Record<string, unknown>,
  ): Promise<void> {
    // A non-tool send flushes any pending tool-line batch first, preserving
    // the order tool lines were produced in relative to this message.
    this.#flushToolBatch();
    return this.#rawSend(chatId, text, opts);
  }

  /** send() without the tool-batch flush (used by the flush itself). */
  #rawSend(
    chatId: number,
    text: string,
    opts?: Record<string, unknown>,
  ): Promise<void> {
    return this.enqueue(() => this.#api.sendMessage(chatId, text, opts)).then(
      () => {},
      () => {},
    );
  }

  /** Queue a long message, split into ordered, sequentially-awaited chunks. */
  sendChunked(chatId: number, text: string): Promise<void> {
    this.#flushToolBatch();
    const chunks = chunkText(text);
    if (chunks.length === 0) return Promise.resolve();
    return this.enqueue(async () => {
      for (const chunk of chunks) {
        // Await each chunk before sending the next — parallel fire-and-forget
        // delivers chunks out of order.
        await this.#api.sendMessage(chatId, chunk).catch(() => {});
      }
    }).then(
      () => {},
      () => {},
    );
  }

  /**
   * Send a thinking block. Model text is not valid Telegram Markdown, so an
   * unbalanced `*`/`_`/backtick can 400 — retry as plain text rather than
   * dropping the thought.
   */
  sendThinking(chatId: number, text: string): Promise<void> {
    this.#flushToolBatch();
    const body = `💭 _thinking_\n${text.slice(0, 1500)}`;
    return this.enqueue(async () => {
      try {
        await this.#api.sendMessage(chatId, body, { parse_mode: "Markdown" });
      } catch {
        await this.#api.sendMessage(chatId, body).catch(() => {});
      }
    }).then(
      () => {},
      () => {},
    );
  }

  /** Handle a full `session.message` broadcast. */
  handleMessage(chatId: number, m: SessionMessage): void {
    // An interleaving message means earlier streamed content should render
    // before it — partial-flush other live buffers (they stay live; later
    // deltas keep appending after the flushed offset).
    this.#flushOthers(chatId, m.messageId);

    switch (m.role) {
      case "assistant":
      case "thinking": {
        if (m.content) {
          // Final authoritative broadcast for this messageId: send whatever
          // hasn't been partial-flushed yet and DROP the buffer, so the idle
          // flush can't deliver the same content a second time.
          const buf = this.#buffers.get(m.messageId);
          const pending = buf ? m.content.slice(buf.flushed) : m.content;
          this.#buffers.delete(m.messageId);
          if (pending) {
            if (m.role === "thinking") this.sendThinking(chatId, pending);
            else this.sendChunked(chatId, pending);
          }
        } else if (!this.#buffers.has(m.messageId)) {
          // Empty content = start of a streaming block.
          this.#buffers.set(m.messageId, {
            role: m.role,
            content: "",
            flushed: 0,
          });
        }
        break;
      }
      case "tool_call": {
        if (!m.tool) break;
        // Remember the name — completion/cancellation arrives as a bare
        // toolStateUpdate delta referencing this messageId.
        this.#toolNames.set(m.messageId, m.tool.name);
        const line = toolLine(m.tool.name, m.tool.state);
        if (line) this.#queueToolLine(chatId, line);
        break;
      }
      case "system":
        if (m.content) this.send(chatId, `⚠️ ${m.content}`);
        break;
      // user (echo of our own send) and info: quiet on mobile.
    }
  }

  /** Handle a `session.message.delta` broadcast. */
  handleDelta(chatId: number, d: SessionMessageDelta): void {
    if (d.contentAppend) {
      const buf = this.#buffers.get(d.messageId);
      if (buf) buf.content += d.contentAppend;
    }
    if (d.toolStateUpdate) {
      // The daemon broadcasts tool completed/cancelled as a delta — render
      // ✓/✗ here or the user never sees tools finish. Flush streamed text
      // first so the tool line lands in order.
      this.#flushOthers(chatId, d.messageId);
      const name = this.#toolNames.get(d.messageId) ?? "tool";
      const line = toolLine(name, d.toolStateUpdate);
      if (line) this.#queueToolLine(chatId, line);
      const phase = d.toolStateUpdate.phase;
      if (phase === "completed" || phase === "cancelled") {
        this.#toolNames.delete(d.messageId);
      }
    }
  }

  /** Turn ended: flush every remaining buffer, clear, then confirm. */
  flushIdle(chatId: number): void {
    for (const buf of this.#buffers.values()) this.#flushPartial(chatId, buf);
    this.#buffers.clear();
    this.#toolNames.clear();
    // Queued after the flushes, so "Done" always follows the content.
    this.send(chatId, "✅ Done.");
  }

  /**
   * Buffer a tool-status line for coalesced delivery (see `#toolBatch`).
   * Batches are per-chat; a line for a different chat flushes the previous
   * chat's batch first so cross-chat ordering is never violated.
   */
  #queueToolLine(chatId: number, line: string): void {
    if (this.#toolBatch && this.#toolBatch.chatId !== chatId) {
      this.#flushToolBatch();
    }
    if (!this.#toolBatch) this.#toolBatch = { chatId, lines: [] };
    this.#toolBatch.lines.push(line);
    if (this.#toolBatch.lines.length >= this.#toolBatchMax) {
      this.#flushToolBatch();
      return;
    }
    if (this.#toolBatchTimer === null) {
      this.#toolBatchTimer = setTimeout(() => {
        this.#toolBatchTimer = null;
        this.#flushToolBatch();
      }, this.#toolBatchMs);
      // Don't hold the process open just for a pending batch flush.
      (this.#toolBatchTimer as { unref?: () => void }).unref?.();
    }
  }

  /** Enqueue the pending tool-line batch as one multi-line message. */
  #flushToolBatch(): void {
    if (this.#toolBatchTimer !== null) {
      clearTimeout(this.#toolBatchTimer);
      this.#toolBatchTimer = null;
    }
    const batch = this.#toolBatch;
    this.#toolBatch = null;
    if (!batch || batch.lines.length === 0) return;
    this.#rawSend(batch.chatId, batch.lines.join("\n"));
  }

  /**
   * Session detach/switch: deliver whatever is buffered (never discard
   * content invisibly), mark the stream as cut short, and reset state.
   */
  flushAndClear(chatId: number): void {
    // Deliver any batched tool lines first — after a detach nothing else
    // would ever flush them.
    this.#flushToolBatch();
    let interrupted = false;
    for (const buf of this.#buffers.values()) {
      if (buf.content.length > buf.flushed) interrupted = true;
      this.#flushPartial(chatId, buf);
    }
    this.#buffers.clear();
    this.#toolNames.clear();
    if (interrupted) {
      this.send(chatId, "✂️ Detached mid-stream — output above may be incomplete.");
    }
  }

  /** Send the unflushed tail of every buffer except `exceptId` (kept live). */
  #flushOthers(chatId: number, exceptId: string): void {
    for (const [id, buf] of this.#buffers) {
      if (id !== exceptId) this.#flushPartial(chatId, buf);
    }
  }

  /** Send a buffer's unflushed tail and advance its flushed offset. */
  #flushPartial(chatId: number, buf: StreamBuf): void {
    const pending = buf.content.slice(buf.flushed);
    if (!pending) return;
    buf.flushed = buf.content.length;
    if (buf.role === "thinking") this.sendThinking(chatId, pending);
    else this.sendChunked(chatId, pending);
  }

  /** Resolves once everything queued so far has been sent. Flushes any
   * pending tool-line batch first so "queued so far" includes it — the
   * detach/switch/fork handlers await this before their confirmations. */
  settle(): Promise<void> {
    this.#flushToolBatch();
    return this.#chain.then(
      () => {},
      () => {},
    );
  }
}

/** Escape MarkdownV2 special characters (for regular text context). */
export function escMd(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (m) => `\\${m}`);
}

/**
 * Escape for a MarkdownV2 inline-code span. Inside code entities only
 * backtick and backslash are special — escaping anything else (as escMd
 * does) would render literal backslashes.
 */
export function escCode(text: string): string {
  return text.replace(/[`\\]/g, "\\$&");
}

/**
 * One /ls line. Status and workdir are runtime values and must be escaped —
 * a `tool_running` status underscore or a backtick in a path is otherwise a
 * MarkdownV2 parse error (Telegram 400).
 */
export function formatSessionLine(s: {
  name: string;
  status: string;
  workdir: string;
}): string {
  const icon =
    s.status === "idle"
      ? "🟢"
      : s.status === "thinking" || s.status === "tool_running"
        ? "🟡"
        : "🔴";
  return `${icon} *${escMd(s.name)}* — ${escMd(s.status)}\n   \`${escCode(s.workdir)}\``;
}

/** Render a tool lifecycle state as a one-line chat notification. */
export function toolLine(name: string, state: ToolState): string | null {
  switch (state.phase) {
    case "executing":
      return `⚡ ${name}`;
    case "completed":
      return state.success === false ? `✗ ${name} failed` : `✓ ${name}`;
    case "cancelled":
      return `✗ ${name} cancelled`;
    default:
      // streaming / waiting_confirmation — rendered elsewhere (approval UI).
      return null;
  }
}
