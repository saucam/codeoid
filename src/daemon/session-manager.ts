/**
 * SessionManager — orchestrates multiple concurrent agent sessions.
 *
 * Production-grade patterns:
 *   - Per-user rate limiting on session creation
 *   - Session resume from transcript on daemon restart
 *   - Scope enforcement on every operation
 *   - Graceful drain on shutdown
 */

import { Session, type AttachedClient } from "./session.js";
import { Store } from "./store.js";
import { hasScope, SCOPES } from "../protocol/scopes.js";
import { RateLimiter } from "./rate-limit.js";
import { TranscriptStore } from "./transcript.js";
import {
  FsAccessError,
  handleFsBrowseDir,
  handleFsList,
  handleFsRead,
} from "./fs.js";
import { readClaudeConfig } from "./claude-config.js";
import {
  packSession,
  unpackBundle,
  validateBundle,
  writeBundleToFile,
  type ImportedSessionInit,
} from "./share/index.js";
import type { AgentIdentityManager } from "./agent-identity.js";
import { type MemoryEngine, workspaceIdFromPath } from "./memory/index.js";
import type { CodeoidConfig } from "../config.js";
import type { CompressionRegistry } from "./compress/index.js";
import type {
  AuthContext,
  ClientMessage,
  DaemonMessage,
  SessionInfo,
} from "../protocol/types.js";

export class SessionManager {
  #sessions = new Map<string, Session>();
  #store: Store;
  #transcriptStore: TranscriptStore;
  #identityManager?: AgentIdentityManager;
  #rateLimiter: RateLimiter;
  #memory?: MemoryEngine;
  #config?: CodeoidConfig;
  #compressionRegistry?: CompressionRegistry;

  constructor(
    store: Store,
    transcriptStore: TranscriptStore,
    identityManager?: AgentIdentityManager,
    rateLimiter?: RateLimiter,
    memory?: MemoryEngine,
    opts?: { config?: CodeoidConfig; compressionRegistry?: CompressionRegistry },
  ) {
    this.#store = store;
    this.#transcriptStore = transcriptStore;
    this.#identityManager = identityManager;
    this.#rateLimiter = rateLimiter ?? new RateLimiter();
    this.#memory = memory;
    this.#config = opts?.config;
    this.#compressionRegistry = opts?.compressionRegistry;
  }

  /**
   * Resume sessions from persisted transcripts (called on daemon restart).
   * Rebuilds in-memory session objects and scrollback buffers.
   */
  async resumeSessions(): Promise<number> {
    const metas = await this.#transcriptStore.loadAllMeta();
    let resumed = 0;

    for (const meta of metas) {
      try {
        const session = new Session({
          name: meta.sessionName,
          workdir: meta.workdir,
          auth: {
            sub: meta.createdBy,
            scopes: [],
            delegationDepth: 0,
            accountId: meta.accountId,
            projectId: meta.projectId,
          },
          store: this.#store,
          transcriptStore: this.#transcriptStore,
          identityManager: this.#identityManager,
          existingId: meta.sessionId,
          memory: this.#memory,
          config: this.#config,
          compressionRegistry: this.#compressionRegistry,
        });

        // Restore scrollback from transcript
        const entries = await this.#transcriptStore.loadTranscript(meta.sessionId);
        const messages = entries.map((e) => e.message);
        session.restoreScrollback(messages);

        this.#sessions.set(session.id, session);
        // Resume is NOT a creation — don't burn a slot in the
        // per-user concurrency cap. Otherwise restarting with N
        // persisted sessions saturates the limit on the spot and the
        // next legitimate `session.create` fails with
        // "Concurrent session limit reached" until the user
        // /destroys some.
        resumed++;
      } catch {
        // Skip sessions that fail to resume
      }
    }

    return resumed;
  }

  /**
   * Resolve a session by id, gated on tenancy. Returns null when:
   *
   *   - the id doesn't exist, OR
   *   - the requester's `(accountId, projectId)` doesn't match the
   *     session's owner.
   *
   * Both cases collapse to the same "not found" response at the
   * caller, so we don't leak session-id existence across tenants —
   * an account-A user trying to attach to an account-B sessionId
   * gets the same shape they'd get for a typo. Sessions whose
   * owner has empty tenancy (e.g. a malformed resume) only match
   * an auth context with empty tenancy, which doesn't happen in
   * normal flows; those sessions remain only visible to system /
   * resume paths.
   */
  #getOwnedSession(sessionId: string, auth: AuthContext): Session | null {
    const session = this.#sessions.get(sessionId);
    if (!session) return null;
    if (
      session.accountId !== auth.accountId ||
      session.projectId !== auth.projectId
    ) {
      return null;
    }
    return session;
  }

  /**
   * Handle an inbound client message, enforce scopes, and return a response.
   */
  async handle(
    msg: ClientMessage,
    auth: AuthContext,
    client: AttachedClient,
  ): Promise<DaemonMessage> {
    switch (msg.type) {
      case "session.create":
        return this.#create(msg, auth);
      case "session.list":
        return this.#list(msg, auth);
      case "session.attach":
        return this.#attach(msg, auth, client);
      case "session.detach":
        return this.#detach(msg, client);
      case "session.send":
        return this.#send(msg, auth);
      case "session.interrupt":
        return this.#interrupt(msg, auth);
      case "session.approve":
        return this.#approve(msg, auth);
      case "session.destroy":
        return this.#destroySession(msg, auth);
      case "session.set_mode":
        return this.#setMode(msg, auth);
      case "session.pin":
        return this.#pin(msg, auth);
      case "session.unpin":
        return this.#unpin(msg, auth);
      case "session.rotate":
        return this.#rotate(msg, auth);
      case "session.search":
        return this.#search(msg, auth);
      case "session.set_model":
        return this.#setModel(msg, auth);
      case "session.rename":
        return this.#rename(msg, auth);
      case "fs.list":
        return this.#fsList(msg, auth);
      case "fs.read":
        return this.#fsRead(msg, auth);
      case "fs.browse_dir":
        return this.#fsBrowseDir(msg, auth);
      case "claude.config":
        return this.#claudeConfig(msg, auth);
      case "session.export":
        return this.#sessionExport(msg, auth);
      case "session.import":
        return this.#sessionImport(msg, auth);
    }
  }

  async #sessionExport(
    msg: Extract<ClientMessage, { type: "session.export" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_LIST)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: session:list",
        code: "forbidden",
      };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Session not found",
        code: "not_found",
      };
    }
    try {
      const info = session.toInfo();
      const bundle = await packSession(
        {
          session: {
            id: info.id,
            name: info.name,
            workdir: info.workdir,
            createdAt: info.createdAt,
            ...(info.model ? { model: info.model } : {}),
            ...(info.fallbackModel ? { fallbackModel: info.fallbackModel } : {}),
            ...(info.mode ? { mode: info.mode } : {}),
            ...(info.rotation ? { rotation: { count: info.rotation.count } } : {}),
            ...(info.pinnedFiles ? { pinnedFiles: info.pinnedFiles } : {}),
          },
          exporter: auth,
          includeMemory: msg.includeMemory ?? true,
          includePinnedFiles: msg.includePinnedFiles ?? false,
          ...(msg.aliasOverride ? { aliasOverride: msg.aliasOverride } : {}),
        },
        {
          transcript: this.#transcriptStore,
          store: this.#store,
          memory: this.#memory ?? null,
          workspaceIdFor: workspaceIdFromPath,
        },
      );

      // Inline below 5 MiB; otherwise spill to disk so a clipboard
      // round-trip stays sane.
      const json = JSON.stringify(bundle);
      const sizeBytes = Buffer.byteLength(json, "utf-8");
      const inlineCap = 5 * 1024 * 1024;
      const useFile = msg.toFile === true || sizeBytes > inlineCap;

      const manifest = {
        exportedAt: bundle.manifest.exportedAt,
        session: {
          id: bundle.manifest.session.id,
          name: bundle.manifest.session.name,
          createdAt: bundle.manifest.session.createdAt,
          ...(bundle.manifest.session.model ? { model: bundle.manifest.session.model } : {}),
          ...(bundle.manifest.session.mode ? { mode: bundle.manifest.session.mode } : {}),
        },
        workdir: {
          alias: bundle.manifest.workdir.alias,
          aliasSource: bundle.manifest.workdir.aliasSource,
          originalAbsolute: bundle.manifest.workdir.originalAbsolute,
        },
        counts: bundle.manifest.counts,
      };

      if (useFile) {
        const written = await writeBundleToFile(bundle);
        return {
          type: "session.export.result",
          requestId: msg.id,
          manifest,
          payload: { kind: "file", path: written.path, sizeBytes: written.sizeBytes },
        };
      }
      return {
        type: "session.export.result",
        requestId: msg.id,
        manifest,
        payload: { kind: "inline", bundle, sizeBytes },
      };
    } catch (err) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: err instanceof Error ? err.message : String(err),
        code: "internal",
      };
    }
  }

  async #sessionImport(
    msg: Extract<ClientMessage, { type: "session.import" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_CREATE)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: session:create",
        code: "forbidden",
      };
    }
    // Same per-user rate limit as session.create — import allocates a
    // fresh Session, SDK identity, and DB rows. Without this gate a
    // tight loop of inline imports OOMs the daemon.
    const rateCheck = this.#rateLimiter.check(auth.sub);
    if (!rateCheck.allowed) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: rateCheck.reason,
        code: "rate_limited",
      };
    }
    try {
      // Resolve the bundle JSON from inline payload or a saved file.
      let bundleRaw: unknown;
      if (msg.source.kind === "inline") {
        bundleRaw = msg.source.bundle;
      } else {
        // SECURITY: bound the file-source path to a fixed import dir.
        // Without this any client with `session:create` can read any
        // file the daemon can — `/etc/passwd`, `~/.aws/credentials`,
        // sibling sessions' transcripts. The fixed dir is created on
        // first use and realpath-checked to defeat symlink pivots.
        const safe = await resolveImportPath(msg.source.path);
        if (!safe.ok) {
          return {
            type: "response.error",
            requestId: msg.id,
            error: safe.reason,
            code: "invalid_request",
          };
        }
        const fs = await import("node:fs");
        // Cap the read at 100 MB to bound memory pressure under
        // pathological bundles.
        const stat = await fs.promises.stat(safe.path);
        if (stat.size > 100 * 1024 * 1024) {
          return {
            type: "response.error",
            requestId: msg.id,
            error: `bundle too large (${stat.size} bytes; cap 100 MB)`,
            code: "invalid_request",
          };
        }
        const text = await fs.promises.readFile(safe.path, "utf-8");
        bundleRaw = JSON.parse(text);
      }
      const v = validateBundle(bundleRaw);
      if (!v.ok) {
        return {
          type: "response.error",
          requestId: msg.id,
          error: v.reason,
          code: "invalid_request",
        };
      }
      const bundle = v.bundle;

      const result = await unpackBundle(
        {
          bundle,
          targetWorkdir: msg.targetWorkdir,
          ...(msg.nameOverride ? { nameOverride: msg.nameOverride } : {}),
          writePinnedFiles: msg.writePinnedFiles ?? false,
          importer: auth,
        },
        {
          transcript: this.#transcriptStore,
          memory: this.#memory ?? null,
          workspaceIdFor: workspaceIdFromPath,
          registerSession: async (init: ImportedSessionInit) => {
            // Create the Session shell first so we have an id; we don't
            // start() its query loop — the importer attaches via the
            // normal session.attach flow afterwards.
            const session = new Session({
              name: init.name,
              workdir: init.workdir,
              auth,
              store: this.#store,
              transcriptStore: this.#transcriptStore,
              ...(this.#identityManager
                ? { identityManager: this.#identityManager }
                : {}),
              ...(this.#memory ? { memory: this.#memory } : {}),
              config: this.#config,
              compressionRegistry: this.#compressionRegistry,
            });
            this.#sessions.set(session.id, session);
            this.#rateLimiter.recordCreation(auth.sub);
            this.#store.audit(
              auth.sub,
              "session.import",
              session.id,
              `forked-from=${init.forkedFrom.alias}@session:${init.forkedFrom.sessionId} exporter=${init.forkedFrom.exporterIdentity.sub}`,
            );
            return session.id;
          },
        },
      );

      return {
        type: "session.import.result",
        requestId: msg.id,
        newSessionId: result.newSessionId,
        importedMessages: result.importedMessages,
        importedEpisodes: result.importedEpisodes,
        importedTurns: result.importedTurns,
        pinnedFilesWritten: result.pinnedFilesWritten,
        warnings: result.warnings,
      };
    } catch (err) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: err instanceof Error ? err.message : String(err),
        code: "internal",
      };
    }
  }

  async #claudeConfig(
    msg: Extract<ClientMessage, { type: "claude.config" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    // Reuse fs:read since this only reads ~/.claude/ + workdir/.claude/ —
    // strictly broader than session.workdir, but the data is descriptive
    // (no secrets — env values are stripped, only key names returned).
    if (!hasScope(auth.scopes as string[], SCOPES.FS_READ)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: fs:read",
        code: "forbidden",
      };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Session not found",
        code: "not_found",
      };
    }
    try {
      const snapshot = await readClaudeConfig(session.workdir);
      const live = session.sdkMcpSnapshot;
      const mcpServers = snapshot.mcpServers.map((s) => {
        const liveStatus = live.status.get(s.name);
        const liveTools = live.tools.get(s.name);
        return {
          ...s,
          ...(liveStatus !== undefined ? { liveStatus } : {}),
          ...(liveTools !== undefined ? { liveTools } : {}),
        };
      });
      return {
        type: "claude.config.result",
        requestId: msg.id,
        workdir: session.workdir,
        agents: snapshot.agents,
        skills: snapshot.skills,
        mcpServers,
        hooks: snapshot.hooks,
      };
    } catch (err) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: err instanceof Error ? err.message : String(err),
        code: "internal",
      };
    }
  }

  async #fsBrowseDir(
    msg: Extract<ClientMessage, { type: "fs.browse_dir" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.FS_READ)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: fs:read",
        code: "forbidden",
      };
    }
    try {
      return await handleFsBrowseDir(msg);
    } catch (err) {
      return this.#fsErr(msg.id, err);
    }
  }

  // ---------- fs verbs ----------

  async #fsList(
    msg: Extract<ClientMessage, { type: "fs.list" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.FS_READ)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: fs:read",
        code: "forbidden",
      };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Session not found",
        code: "not_found",
      };
    }
    try {
      return await handleFsList(msg, session.workdir);
    } catch (err) {
      return this.#fsErr(msg.id, err);
    }
  }

  async #fsRead(
    msg: Extract<ClientMessage, { type: "fs.read" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.FS_READ)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: fs:read",
        code: "forbidden",
      };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Session not found",
        code: "not_found",
      };
    }
    try {
      return await handleFsRead(msg, session.workdir);
    } catch (err) {
      return this.#fsErr(msg.id, err);
    }
  }

  #fsErr(requestId: string, err: unknown): DaemonMessage {
    if (err instanceof FsAccessError) {
      return { type: "response.error", requestId, error: err.message, code: err.code };
    }
    return {
      type: "response.error",
      requestId,
      error: err instanceof Error ? err.message : String(err),
      code: "internal",
    };
  }

  /** Inject the MemoryEngine after construction (embedder init is async). */
  setMemory(memory: MemoryEngine): void {
    this.#memory = memory;
  }

  /** Remove a client from all sessions (e.g. on disconnect). */
  disconnectClient(clientId: string): void {
    for (const session of this.#sessions.values()) {
      session.detach(clientId);
    }
  }

  /** Get a session by name (for Telegram convenience). */
  findByName(name: string): Session | undefined {
    for (const session of this.#sessions.values()) {
      if (session.name === name) return session;
    }
    return undefined;
  }

  /**
   * Graceful drain — wait for all in-flight sessions to reach idle.
   * Used during shutdown.
   *
   * Each working session is interrupted **once**. The previous loop
   * re-interrupted on every poll iteration; if the SDK subprocess
   * was mid HTTP retry and didn't respond within 500 ms, drain
   * piled up duplicate "interrupted by system:shutdown" info rows
   * (up to 20 in a 10-s window) and 20× the audit log churn. Track
   * a per-session "already interrupted" set, then poll status until
   * idle or deadline.
   */
  async drain(timeoutMs: number = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const systemAuth: AuthContext = {
      sub: "system:shutdown",
      scopes: [],
      delegationDepth: 0,
      accountId: "",
      projectId: "",
    };
    const interrupted = new Set<string>();
    while (Date.now() < deadline) {
      const working = [...this.#sessions.values()].filter(
        (s) => s.status === "working" || s.status === "waiting_approval",
      );
      if (working.length === 0) return;
      for (const session of working) {
        if (interrupted.has(session.id)) continue;
        session.interrupt(systemAuth);
        interrupted.add(session.id);
      }
      await Bun.sleep(500);
    }
  }

  // ── Handlers ──────────────────────────────────────────────────────────

  #create(
    msg: Extract<ClientMessage, { type: "session.create" }>,
    auth: AuthContext,
  ): DaemonMessage {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_CREATE)) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:create", code: "forbidden" };
    }

    // Rate limit check
    const rateCheck = this.#rateLimiter.check(auth.sub);
    if (!rateCheck.allowed) {
      return { type: "response.error", requestId: msg.id, error: rateCheck.reason, code: "rate_limited" };
    }

    const session = new Session({
      name: msg.name,
      workdir: msg.workdir,
      auth,
      store: this.#store,
      transcriptStore: this.#transcriptStore,
      identityManager: this.#identityManager,
      memory: this.#memory,
      config: this.#config,
      compressionRegistry: this.#compressionRegistry,
    });

    this.#sessions.set(session.id, session);
    this.#rateLimiter.recordCreation(auth.sub);

    return {
      type: "response.ok",
      requestId: msg.id,
      data: session.toInfo(),
    };
  }

  #list(
    msg: Extract<ClientMessage, { type: "session.list" }>,
    auth: AuthContext,
  ): DaemonMessage {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_LIST)) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:list", code: "forbidden" };
    }

    const sessions: SessionInfo[] = [];
    for (const session of this.#sessions.values()) {
      // Tenancy filter — never enumerate sessions belonging to a
      // different account/project. Same shape as #getOwnedSession.
      if (
        session.accountId !== auth.accountId ||
        session.projectId !== auth.projectId
      ) {
        continue;
      }
      const info = session.toInfo();
      sessions.push({ ...info, attachedClients: session.attachedClientCount });
    }

    return { type: "session.list.result", requestId: msg.id, sessions };
  }

  #attach(
    msg: Extract<ClientMessage, { type: "session.attach" }>,
    auth: AuthContext,
    client: AttachedClient,
  ): DaemonMessage {
    const scope = hasScope(auth.scopes as string[], SCOPES.SESSION_ATTACH)
      || hasScope(auth.scopes as string[], SCOPES.SESSION_WATCH);
    if (!scope) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:attach or session:watch", code: "forbidden" };
    }

    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }

    session.attach(client);
    return { type: "response.ok", requestId: msg.id, data: session.toInfo() };
  }

  #detach(
    msg: Extract<ClientMessage, { type: "session.detach" }>,
    client: AttachedClient,
  ): DaemonMessage {
    const session = this.#getOwnedSession(msg.sessionId, client.auth);
    if (!session) {
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }

    session.detach(client.id);
    return { type: "response.ok", requestId: msg.id };
  }

  #send(
    msg: Extract<ClientMessage, { type: "session.send" }>,
    auth: AuthContext,
  ): DaemonMessage {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_SEND)) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:send", code: "forbidden" };
    }

    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }

    // Fire and forget — output streams to attached clients.
    // priority controls mid-turn insertion semantics (default "later" = FIFO).
    session
      .send(msg.text, auth, msg.attachments, msg.priority)
      .catch(() => {});

    return { type: "response.ok", requestId: msg.id };
  }

  #pin(
    msg: Extract<ClientMessage, { type: "session.pin" }>,
    auth: AuthContext,
  ): DaemonMessage {
    // Reuse SESSION_SEND scope — pins only make sense to holders of send.
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_SEND)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: session:send",
        code: "forbidden",
      };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Session not found",
        code: "not_found",
      };
    }
    session.pinFile(msg.path, auth);
    return { type: "response.ok", requestId: msg.id };
  }

  #unpin(
    msg: Extract<ClientMessage, { type: "session.unpin" }>,
    auth: AuthContext,
  ): DaemonMessage {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_SEND)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: session:send",
        code: "forbidden",
      };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Session not found",
        code: "not_found",
      };
    }
    session.unpinFile(msg.path, auth);
    return { type: "response.ok", requestId: msg.id };
  }

  /**
   * Cross-session search — fans out to the memory engine, groups by
   * session, and returns a ranked list with evidence snippets. Requires
   * SESSION_LIST scope (same level as listing sessions — you need to be
   * able to see sessions to search their content).
   *
   * Resolution of workspace scope:
   *   - `scope: "all"` → search across every workspace the memory store has
   *   - `scope: "workspace"` (default) + `workdir` explicit → anchor there
   *   - `scope: "workspace"` + no workdir → use the caller's most recent
   *     session if any, else empty-string (engine handles gracefully)
   */
  async #search(
    msg: Extract<ClientMessage, { type: "session.search" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_LIST)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: session:list",
        code: "forbidden",
      };
    }
    if (!this.#memory) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Memory is disabled — session search requires CODEOID_MEMORY=1",
        code: "invalid_request",
      };
    }
    if (!msg.query || msg.query.trim().length === 0) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Query must be a non-empty string",
        code: "invalid_request",
      };
    }

    const scope = msg.scope ?? "workspace";
    let workspaceId = "";
    if (scope === "workspace") {
      const anchorPath = msg.workdir ?? this.#guessCallerWorkdir(auth);
      if (anchorPath) workspaceId = workspaceIdFromPath(anchorPath);
    }

    // Provide a session-name map so the ranker can boost exact-name hits.
    // Only include sessions visible to this caller — name leakage across
    // tenants is the same disclosure as `session.list` would be.
    const sessionNames = new Map<string, string>();
    for (const s of this.#sessions.values()) {
      if (s.accountId !== auth.accountId || s.projectId !== auth.projectId) continue;
      sessionNames.set(s.id, s.name);
    }

    const limit = Math.max(1, Math.min(msg.limit ?? 10, 50));
    const hits = await this.#memory.searchSessions({
      query: msg.query,
      workspaceId,
      limit,
      sessionNames,
    });

    // Enrich each hit with sessionName + workdir from the in-memory map
    // (store has the rest; we just want ergonomic display). Hits that
    // resolve to a session belonging to a different tenant render as
    // "(unknown)" — same shape we already use for sessions that aren't
    // live in memory.
    const enriched = hits.map((h) => {
      const liveSession = this.#getOwnedSession(h.sessionId, auth);
      return {
        ...h,
        sessionName: liveSession?.name ?? "(unknown)",
        workdir: liveSession?.workdir ?? "",
      };
    });

    return {
      type: "session.search.result",
      requestId: msg.id,
      query: msg.query,
      sessions: enriched,
      workspaceId,
      limit,
    };
  }

  /**
   * Infer a workdir for the caller to anchor workspace search. We look for
   * the caller's most-recent session (by createdBy match); the daemon
   * doesn't track per-client focus explicitly so "most recent session
   * they created" is the best stand-in.
   */
  #guessCallerWorkdir(auth: AuthContext): string | null {
    let best: Session | null = null;
    for (const s of this.#sessions.values()) {
      if (s.createdBy !== auth.sub) continue;
      if (!best || s.createdAt > best.createdAt) best = s;
    }
    return best?.workdir ?? null;
  }

  /**
   * Switch the model for a session. Reuses SESSION_SEND scope (same as
   * setMode / rotate — anyone who can drive the session can change its
   * model). Returns `response.ok` with the resolved model in `data` on
   * success; rejects with a 400 when the model id is unknown.
   */
  async #setModel(
    msg: Extract<ClientMessage, { type: "session.set_model" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_SEND)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: session:send",
        code: "forbidden",
      };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Session not found",
        code: "not_found",
      };
    }
    try {
      const result = await session.setModel(msg.model, msg.fallbackModel, auth);
      return {
        type: "response.ok",
        requestId: msg.id,
        data: { model: result.model, fallbackModel: result.fallbackModel },
      };
    } catch (err) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: err instanceof Error ? err.message : String(err),
        code: "invalid_request",
      };
    }
  }

  /**
   * Manual rotation via `/rotate` slash. Reuses SESSION_SEND scope: anyone
   * who can drive the session can rotate it. Rejects silently (with
   * `response.ok` + boolean in `data`) when the min-turns guard fires —
   * the user sees the reason in the scrollback info message the session
   * itself emits.
   */
  async #rotate(
    msg: Extract<ClientMessage, { type: "session.rotate" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_SEND)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: session:send",
        code: "forbidden",
      };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Session not found",
        code: "not_found",
      };
    }
    const rotated = await session.manualRotate(auth);
    return {
      type: "response.ok",
      requestId: msg.id,
      data: { rotated },
    };
  }

  #interrupt(
    msg: Extract<ClientMessage, { type: "session.interrupt" }>,
    auth: AuthContext,
  ): DaemonMessage {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_INTERRUPT)) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:interrupt", code: "forbidden" };
    }

    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }

    session.interrupt(auth);
    return { type: "response.ok", requestId: msg.id };
  }

  #approve(
    msg: Extract<ClientMessage, { type: "session.approve" }>,
    auth: AuthContext,
  ): DaemonMessage {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_APPROVE)) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:approve", code: "forbidden" };
    }

    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }

    session.approve(msg.approvalId, msg.approved, auth, msg.updatedInput);
    return { type: "response.ok", requestId: msg.id };
  }

  #setMode(
    msg: Extract<ClientMessage, { type: "session.set_mode" }>,
    auth: AuthContext,
  ): DaemonMessage {
    // Set-mode reuses the same scope gates as approve/send — the caller must
    // already be authorized to act on the session.
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_APPROVE)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: session:approve",
        code: "forbidden",
      };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Session not found",
        code: "not_found",
      };
    }
    session.setMode(msg.mode, msg.maxTurns, auth);
    return { type: "response.ok", requestId: msg.id };
  }

  #rename(
    msg: Extract<ClientMessage, { type: "session.rename" }>,
    auth: AuthContext,
  ): DaemonMessage {
    // Rename reuses the session:approve scope — anyone with write access
    // to session config qualifies. Stricter scopes can be introduced
    // later if we split config vs. execution permissions.
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_APPROVE)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: session:approve",
        code: "forbidden",
      };
    }
    const trimmed = msg.name.trim();
    if (!trimmed) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Session name cannot be empty",
        code: "invalid_request",
      };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Session not found",
        code: "not_found",
      };
    }
    session.rename(trimmed, auth);
    return { type: "response.ok", requestId: msg.id };
  }

  async #destroySession(
    msg: Extract<ClientMessage, { type: "session.destroy" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_DESTROY)) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:destroy", code: "forbidden" };
    }

    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }

    // Await teardown so the OK response only goes out AFTER:
    //   1. SDK subprocess fully aborts
    //   2. ZeroID identity is deactivated
    //   3. Transcript/meta files are unlinked
    //
    // Otherwise a client recreating a session by name immediately
    // races the still-running consumer task and the appendFile that
    // landed in P1 #10 — ENOENT or partially-written final lines on
    // the new session.
    await session.destroy(auth);
    this.#sessions.delete(msg.sessionId);
    this.#rateLimiter.recordDestruction(auth.sub);
    return { type: "response.ok", requestId: msg.id };
  }
}

/**
 * Bound `session.import {kind:"file", path}` to a fixed import dir
 * under `~/.codeoid/imports/`. Without this any client with
 * `session:create` can read any file the daemon can — `/etc/passwd`,
 * `~/.aws/credentials`, sibling sessions' transcripts, our own
 * SQLite files. Same realpath + prefix pattern attachments.ts
 * already uses for workdir bounding.
 *
 * The dir is created on first call (`mkdir -p`) so users don't have
 * to set it up manually; the user moves bundles in via `mv`.
 */
async function resolveImportPath(
  requested: string,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const importsDir = path.join(os.homedir(), ".codeoid", "imports");
  try {
    await fs.promises.mkdir(importsDir, { recursive: true });
  } catch {
    return { ok: false, reason: "import dir not writable" };
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.promises.realpath(importsDir);
  } catch {
    return { ok: false, reason: "import dir not resolvable" };
  }
  const lexicallyResolved = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(canonicalRoot, requested);
  let resolved: string;
  try {
    resolved = await fs.promises.realpath(lexicallyResolved);
  } catch {
    return { ok: false, reason: `bundle not found: ${requested}` };
  }
  const rootPrefix = canonicalRoot.replace(/\/+$/, "") + path.sep;
  if (resolved !== canonicalRoot && !resolved.startsWith(rootPrefix)) {
    return {
      ok: false,
      reason: `import path must live under ${importsDir}`,
    };
  }
  return { ok: true, path: resolved };
}
