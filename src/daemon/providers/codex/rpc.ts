/**
 * Codex app-server client — newline-delimited JSON-RPC 2.0 over stdio.
 *
 * Verified live against @openai/codex@0.144.1 (`codex app-server`):
 *   - requests:      {jsonrpc, id, method, params} → {id, result|error}
 *   - notifications: {method, params} in both directions
 *   - SERVER→CLIENT requests (approvals, user-input questions) carry an id
 *     and expect a response frame — the seam codeoid's approval gate plugs
 *     into. Unlike pi, no bridge extension is injected: approvals are
 *     native to the protocol.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type CodexFrame = Record<string, unknown> & {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
  params?: Record<string, unknown>;
};

export interface CodexSpawnOptions {
  /** Resolved binary (see resolve.ts). */
  command: string;
  /** argv before `app-server` (bundled runtime entry, if any). */
  argsPrefix?: string[];
  /** Extra args after `app-server`. */
  args?: string[];
  cwd: string;
  /** Allowlisted env (buildCodexEnv) — never raw process.env (GHSA-38vh). */
  env: Record<string, string>;
  /** Server→client NOTIFICATION (no id). */
  onNotification: (method: string, params: Record<string, unknown>) => void;
  /**
   * Server→client REQUEST (id present) — approvals + user-input questions.
   * The returned value is sent back as the JSON-RPC result; a throw sends
   * a JSON-RPC error (codex treats it as a denial-equivalent failure).
   */
  onServerRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  onExit: (info: { code: number | null; signal: string | null; stderrTail: string }) => void;
}

const REQUEST_TIMEOUT_MS = 30_000;
const STDERR_TAIL_BYTES = 4_096;

export class CodexRpcProcess {
  #proc: ChildProcessWithoutNullStreams;
  #stdoutBuf = "";
  #stderrTail = "";
  #nextId = 1;
  #pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  #opts: CodexSpawnOptions;
  #exited = false;

  constructor(opts: CodexSpawnOptions) {
    this.#opts = opts;
    this.#proc = spawn(
      opts.command,
      [...(opts.argsPrefix ?? []), "app-server", ...(opts.args ?? [])],
      { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], env: opts.env },
    );
    this.#proc.stdout.setEncoding("utf8");
    this.#proc.stdout.on("data", (chunk: string) => this.#onStdout(chunk));
    this.#proc.stderr.setEncoding("utf8");
    this.#proc.stderr.on("data", (chunk: string) => {
      this.#stderrTail = (this.#stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    this.#proc.on("error", (err) => this.#failAll(new Error(`codex spawn failed: ${err.message}`)));
    this.#proc.on("exit", (code, signal) => {
      this.#exited = true;
      this.#failAll(new Error(`codex exited (code=${code} signal=${signal})`));
      opts.onExit({ code, signal, stderrTail: this.#stderrTail });
    });
  }

  get alive(): boolean {
    return !this.#exited;
  }

  /** Client→server request; resolves with the JSON-RPC result. */
  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.#exited) return Promise.reject(new Error("codex process has exited"));
    const id = this.#nextId++;
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`codex request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#proc.stdin.write(`${frame}\n`, (err) => {
        if (err) {
          clearTimeout(timer);
          this.#pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /** Client→server notification (no response expected). */
  notify(method: string, params?: Record<string, unknown>): void {
    if (this.#exited) return;
    this.#proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })}\n`,
    );
  }

  kill(): void {
    this.#proc.kill("SIGKILL");
  }

  #onStdout(chunk: string): void {
    this.#stdoutBuf += chunk;
    for (;;) {
      const idx = this.#stdoutBuf.indexOf("\n");
      if (idx < 0) break;
      const line = this.#stdoutBuf.slice(0, idx).trim();
      this.#stdoutBuf = this.#stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let frame: CodexFrame;
      try {
        frame = JSON.parse(line) as CodexFrame;
      } catch {
        continue; // non-JSON noise on stdout — ignore
      }
      this.#dispatch(frame);
    }
  }

  #dispatch(frame: CodexFrame): void {
    // Response to one of OUR requests.
    if (frame.id !== undefined && frame.method === undefined) {
      const pending = this.#pending.get(frame.id as number);
      if (!pending) return;
      this.#pending.delete(frame.id as number);
      clearTimeout(pending.timer);
      if (frame.error) pending.reject(new Error(frame.error.message ?? "codex error"));
      else pending.resolve(frame.result);
      return;
    }
    // Server→client REQUEST — must be answered (approvals, questions).
    if (frame.id !== undefined && frame.method !== undefined) {
      const id = frame.id;
      this.#opts
        .onServerRequest(frame.method, frame.params ?? {})
        .then((result) => {
          this.#proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
        })
        .catch((err: unknown) => {
          this.#proc.stdin.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
            })}\n`,
          );
        });
      return;
    }
    // Notification.
    if (frame.method !== undefined) {
      this.#opts.onNotification(frame.method, frame.params ?? {});
    }
  }

  #failAll(err: Error): void {
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.#pending.clear();
  }
}
