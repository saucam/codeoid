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
   * All sends are chained so they reach Telegram in the order they were
   * produced — long messages chunk sequentially and "✅ Done." can never
   * overtake content.
   */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(api: RelayApi) {
    this.#api = api;
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
    return this.enqueue(() => this.#api.sendMessage(chatId, text, opts)).then(
      () => {},
      () => {},
    );
  }

  /** Queue a long message, split into ordered, sequentially-awaited chunks. */
  sendChunked(chatId: number, text: string): Promise<void> {
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
        const line = toolLine(m.tool.name, m.tool.state);
        if (line) this.send(chatId, line);
        break;
      }
      case "system":
        if (m.content) this.send(chatId, `⚠️ ${m.content}`);
        break;
      // user (echo of our own send) and info: quiet on mobile.
    }
  }

  /** Handle a `session.message.delta` broadcast. */
  handleDelta(_chatId: number, d: SessionMessageDelta): void {
    if (d.contentAppend) {
      const buf = this.#buffers.get(d.messageId);
      if (buf) buf.content += d.contentAppend;
    }
  }

  /** Turn ended: flush every remaining buffer, clear, then confirm. */
  flushIdle(chatId: number): void {
    for (const buf of this.#buffers.values()) this.#flushPartial(chatId, buf);
    this.#buffers.clear();
    // Queued after the flushes, so "Done" always follows the content.
    this.send(chatId, "✅ Done.");
  }

  /** Drop all buffered state without sending (e.g. session switch). */
  clear(): void {
    this.#buffers.clear();
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

  /** Resolves once everything queued so far has been sent (test helper). */
  settle(): Promise<void> {
    return this.#chain.then(
      () => {},
      () => {},
    );
  }
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
