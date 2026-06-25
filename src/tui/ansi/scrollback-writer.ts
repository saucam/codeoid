/**
 * ScrollbackWriter — the imperative counterpart to Ink's `<Static>`.
 *
 * Why this exists:
 *   Ink's `<Static>` treats the scrollback stream as declarative: you
 *   hand it a keyed list, and Ink figures out what's new. In practice,
 *   this breaks every time the terminal overflows, resizes, or the SDK
 *   writes stdout mid-frame. The symptom is repeated borders, session
 *   tab lines printed 20x, and spinners stuck after errors.
 *
 *   This writer sidesteps the declarative model: the caller tells us
 *   "emit this message now" and we do it once, atomically, via
 *   `console.log` — which Ink's `patchConsole: true` setup routes
 *   through `writeToStdout`. That path is Ink-synchronized: it clears
 *   the live region, writes our bytes, then redraws the live region.
 *   No overflow bugs because the writer never touches the live region
 *   state.
 *
 * Guarantees:
 *   1. Idempotent per (sessionId, messageId): writing the same message
 *      twice is a no-op. This makes scrollback replay on reconnect
 *      safe — the daemon batches us 100 messages, 90 of which we've
 *      already emitted; only the 10 new ones reach the terminal.
 *   2. Banner emitted once per focus transition. Repeat writes of the
 *      same focused session do nothing. A null focus clears the last-
 *      banner pointer so re-focusing re-announces.
 *   3. All writes go through `console.log` — consistent with the rest
 *      of the process and survives Ink patchConsole.
 *   4. Respects terminal color/TTY via the `render-message` module.
 *   5. State is owned by ONE instance (use `getScrollbackWriter()` —
 *      not a module-level singleton so tests can construct their own).
 *
 * What this is NOT:
 *   - Not a buffer. We don't hold messages; we write and forget.
 *   - Not a replayer. The DAEMON owns scrollback state + replay on
 *     reconnect. This writer just mirrors that to the terminal.
 *   - Not a live-region manager. Streaming messages stay in Ink until
 *     finalized; we only see the finalized form.
 */

import type { SessionInfo, SessionMessage } from "../../protocol/types.js";
import {
	renderMessage,
	renderSessionBanner,
	renderStreamHeader,
} from "./render-message.js";

export interface WriterDeps {
	/**
	 * Where to write scrollback lines. In production this is `console.log`,
	 * which Ink's `patchConsole: true` routes through `writeToStdout` (see
	 * ink/build/ink.js:writeToStdout). In tests we inject a capture fn.
	 */
	log: (line: string) => void;
	/** Current terminal column count. */
	getCols: () => number;
}

/**
 * Per-message streaming state. We hold the accumulated raw content so we
 * can (a) know how much has already been written to stdout, and (b)
 * still emit a final atomic render on `finalizeStream` when `renderMessage`
 * would produce a DIFFERENT output than the raw stream (e.g. markdown
 * formatting). For now we trust the raw stream and treat finalize as a
 * no-op emit — tokens already in scrollback are authoritative.
 */
interface StreamState {
	sessionId: string;
	/** Bytes already emitted to stdout for this stream. */
	emittedLen: number;
	/** Header line already printed? */
	headerEmitted: boolean;
	/** Role — used to pick the header style. */
	role: SessionMessage["role"];
	/** Identity — for subagent prefixing in headers. */
	identity: SessionMessage["identity"];
}

export interface BannerInput {
	sessionId: string;
	name: string;
	workdir: string;
}

export class ScrollbackWriter {
	/**
	 * Ids of messages we've already emitted. Keyed `${sessionId}:${messageId}`.
	 * Messages and session ids are both UUIDs in practice, so collision
	 * isn't a concern. Grows unbounded over a long-lived TUI — if this
	 * becomes a memory issue, we could prune on session removal, but in
	 * practice "seen" sets over a single TUI lifetime stay under 10k
	 * entries even in heavy use, which is a few hundred KB.
	 */
	#emitted = new Set<string>();
	/**
	 * In-flight streams. Keyed `${sessionId}:${messageId}`. Populated on
	 * the first `streamDelta` and cleared on `finalizeStream` (which
	 * also marks the id as emitted so subsequent writeMessage/Batch is a
	 * no-op).
	 */
	#streams = new Map<string, StreamState>();
	/**
	 * Partial (not-yet-newline-terminated) buffer per stream. We only
	 * flush a run to stdout when it contains a newline — `console.log`
	 * always appends its own `\n`, so flushing partial fragments would
	 * insert spurious line breaks mid-sentence. The buffer length is
	 * bounded by the worst-case "longest line before a newline", which
	 * is a few hundred chars for typical LLM output.
	 */
	#streamBuffers = new Map<string, string>();
	/**
	 * The session id whose banner was last emitted. null = no banner yet
	 * or focus was cleared. On next write we emit a banner iff the
	 * focused session differs from this.
	 */
	#lastBannerSessionId: string | null = null;

	constructor(private readonly deps: WriterDeps) {}

	/**
	 * Emit a session banner iff the focused session changed. No-op on
	 * null focus — we don't emit "unfocused" banners because there's
	 * nothing contextually useful to say.
	 */
	maybeEmitBanner(
		focusedId: string | null,
		resolveInfo: (id: string) => Pick<SessionInfo, "name" | "workdir"> | null,
	): void {
		if (focusedId === this.#lastBannerSessionId) return;
		if (focusedId === null) {
			this.#lastBannerSessionId = null;
			return;
		}
		const info = resolveInfo(focusedId);
		if (!info) {
			// We refuse to emit a banner for an unknown session; it would look
			// like corruption. Update the pointer so we don't retry each frame.
			this.#lastBannerSessionId = focusedId;
			return;
		}
		const rendered = renderSessionBanner(info);
		this.#writeAtomic(rendered);
		this.#lastBannerSessionId = focusedId;
	}

	/**
	 * Emit a finalized message once. Subsequent calls with the same
	 * (sessionId, messageId) are no-ops. Content changes to a previously-
	 * committed message are IGNORED — that would be an append-only
	 * violation (scrollback is history, not a mutable view).
	 *
	 * If the message was previously streamed via `streamDelta`, this call
	 * is also a no-op — the tokens are already in the terminal, and
	 * re-emitting a markdown-rendered version would duplicate them.
	 */
	writeMessage(sessionId: string, msg: SessionMessage): void {
		const key = `${sessionId}:${msg.messageId}`;
		if (this.#emitted.has(key)) return;
		if (this.#streams.has(key)) {
			// Streamed but not yet finalized — let finalizeStream() seal it.
			return;
		}
		const rendered = renderMessage(msg, { cols: this.deps.getCols() });
		if (!rendered) return;
		this.#writeAtomic(rendered);
		this.#emitted.add(key);
	}

	/**
	 * Append streaming content for a message directly to the terminal's
	 * native scrollback. First call for a (sessionId, messageId) emits
	 * the role header (`Claude` / `thinking` / etc); subsequent calls
	 * append the new content tail beyond what's already been emitted.
	 *
	 * `totalContent` is the full accumulated content of the message so
	 * far — the caller doesn't have to track the delta; we do, by
	 * remembering `emittedLen`. This makes the API idempotent-ish: calling
	 * twice with the same `totalContent` is a no-op.
	 *
	 * Writes go through `console.log` (Ink-safe); to keep tokens from
	 * landing on their own line, we buffer non-newline-terminated
	 * fragments internally and only flush on `\n` or `finalizeStream`.
	 */
	streamDelta(
		sessionId: string,
		msg: Pick<
			SessionMessage,
			"messageId" | "role" | "content" | "identity"
		>,
	): void {
		const key = `${sessionId}:${msg.messageId}`;
		if (this.#emitted.has(key)) return;

		let state = this.#streams.get(key);
		if (!state) {
			state = {
				sessionId,
				emittedLen: 0,
				headerEmitted: false,
				role: msg.role,
				identity: msg.identity,
			};
			this.#streams.set(key, state);
		}

		// Emit header on first real token — avoids orphan "Claude" lines
		// for messages that were canceled before producing any output.
		const full = msg.content;
		if (full.length === 0) return;
		if (!state.headerEmitted) {
			const header = renderStreamHeader(state.role, state.identity);
			if (header) this.#writeAtomic(header);
			state.headerEmitted = true;
		}

		if (full.length <= state.emittedLen) return;
		const newText = full.slice(state.emittedLen);
		state.emittedLen = full.length;

		// Buffer + line-wise flush: each console.log adds a `\n`, so we
		// only flush complete lines to avoid spurious breaks mid-token.
		const buf = (this.#streamBuffers.get(key) ?? "") + newText;
		const lastNewline = buf.lastIndexOf("\n");
		if (lastNewline < 0) {
			this.#streamBuffers.set(key, buf);
			return;
		}
		const toFlush = buf.slice(0, lastNewline);
		const remainder = buf.slice(lastNewline + 1);
		this.#streamBuffers.set(key, remainder);
		// Indent streamed body to match renderMessage's BODY_INDENT
		// convention ("  " prefix under the role header).
		this.#writeAtomic(`${indentStreamedBody(toFlush)}\n`);
	}

	/**
	 * Seal a streaming message. Flushes any buffered partial line and
	 * marks the id as fully emitted so `writeMessage` / `writeBatch`
	 * treats it as already-done. Safe to call for messages that were
	 * never streamed (no-op).
	 */
	finalizeStream(sessionId: string, messageId: string): void {
		const key = `${sessionId}:${messageId}`;
		const state = this.#streams.get(key);
		if (!state) return;
		const buf = this.#streamBuffers.get(key) ?? "";
		if (buf.length > 0) {
			this.#writeAtomic(`${indentStreamedBody(buf)}\n`);
		}
		this.#streams.delete(key);
		this.#streamBuffers.delete(key);
		this.#emitted.add(key);
	}

	/**
	 * Emit a batch of messages for one session. Each one goes through
	 * the same dedupe path as `writeMessage`. Useful for the initial
	 * scrollback replay after attach.
	 *
	 * Batched here (vs. the caller looping) so we can emit each message
	 * as an atomic write — Ink's writeToStdout path does a clear+redraw
	 * per call, and batching 100 individual frames is wasteful. We emit
	 * the whole batch as a single write instead.
	 */
	writeBatch(sessionId: string, messages: readonly SessionMessage[]): void {
		const cols = this.deps.getCols();
		const chunks: string[] = [];
		const newlyEmitted: string[] = [];
		for (const msg of messages) {
			const key = `${sessionId}:${msg.messageId}`;
			if (this.#emitted.has(key)) continue;
			// Currently-streaming message: its tokens are already in the
			// terminal via streamDelta(), and finalizeStream() will seal it.
			// Re-rendering here would print the body (and header) a second
			// time. Mirror writeMessage()'s guard — this is the common path
			// when a live assistant/thinking message finalizes, because the
			// committed-emission effect runs BEFORE the stream-finalize one.
			if (this.#streams.has(key)) continue;
			const rendered = renderMessage(msg, { cols });
			if (!rendered) continue;
			chunks.push(rendered);
			newlyEmitted.push(key);
		}
		if (chunks.length === 0) return;
		this.#writeAtomic(chunks.join(""));
		for (const k of newlyEmitted) this.#emitted.add(k);
	}

	/**
	 * Forget a session's message history. Call on session removal so the
	 * seen-set doesn't leak indefinitely for one-off sessions. Safe to
	 * call with an unknown id.
	 */
	forget(sessionId: string): void {
		const prefix = `${sessionId}:`;
		for (const key of this.#emitted) {
			if (key.startsWith(prefix)) this.#emitted.delete(key);
		}
		for (const key of this.#streams.keys()) {
			if (key.startsWith(prefix)) {
				this.#streams.delete(key);
				this.#streamBuffers.delete(key);
			}
		}
		if (this.#lastBannerSessionId === sessionId) {
			this.#lastBannerSessionId = null;
		}
	}

	/** Drop all state — for tests only. Not used in production. */
	reset(): void {
		this.#emitted.clear();
		this.#streams.clear();
		this.#streamBuffers.clear();
		this.#lastBannerSessionId = null;
	}

	/**
	 * One call = one `console.log`. `renderMessage` always ends with a
	 * newline, and `console.log` also appends one. To avoid a stray blank
	 * line between messages we strip the trailing newline here before
	 * handing off — `console.log`'s own `\n` closes the message.
	 *
	 * We intentionally do NOT write via `process.stdout.write` even though
	 * it would skip the extra newline: that bypasses Ink's patchConsole
	 * redirect, which is the whole mechanism that lets us write safely
	 * above the live region.
	 */
	#writeAtomic(data: string): void {
		const trimmed = data.endsWith("\n") ? data.slice(0, -1) : data;
		this.deps.log(trimmed);
	}
}

/**
 * Indent a multi-line streamed block to sit under its role header —
 * mirrors `BODY_INDENT` in render-message.ts. Exported-less helper
 * because it's only used locally by the writer.
 */
function indentStreamedBody(text: string): string {
	return text
		.split("\n")
		.map((ln) => (ln.length ? `  ${ln}` : ln))
		.join("\n");
}

/**
 * Construct the production writer. Uses `console.log` (Ink-routed) and
 * `process.stdout.columns` as the col source. Kept as a function so
 * tests can construct writers with injected deps without touching this
 * default wiring.
 */
export function createScrollbackWriter(): ScrollbackWriter {
	return new ScrollbackWriter({
		log: (line) => console.log(line),
		getCols: () => process.stdout.columns ?? 120,
	});
}
