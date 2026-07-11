/**
 * SessionManager — orchestrates multiple concurrent agent sessions.
 *
 * Production-grade patterns:
 *   - Per-user rate limiting on session creation
 *   - Session resume from transcript on daemon restart
 *   - Scope enforcement on every operation
 *   - Graceful drain on shutdown
 */

import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Session, type AttachedClient } from "./session.js";
import type { SessionProvider } from "./providers/interface.js";
import {
  createDefaultProviderRegistry,
  type ProviderRegistry,
} from "./providers/registry.js";
import type { HookBus } from "./hooks/bus.js";
import type { Store } from "./store.js";
import { hasScope, SCOPES } from "../protocol/scopes.js";
import { RateLimiter } from "./rate-limit.js";
import type { TranscriptStore } from "./transcript.js";
import {
  FsAccessError,
  handleFsBrowseDir,
  handleFsList,
  handleFsRead,
  isProtectedPath,
} from "./fs.js";
import { readClaudeConfig } from "./claude-config.js";
import { fallbackModelInfos, resolveAgainstList } from "./models.js";
import {
  packSession,
  unpackBundle,
  validateBundle,
  writeBundleToFile,
  type ImportedSessionInit,
} from "./share/index.js";
import type { AgentIdentityManager } from "./agent-identity.js";
import { buildFleetMcpServer, type FleetDispatchDeps, type FleetSessionView, type FleetTaskView } from "./fleet.js";
import {
  Dispatcher,
  NonRetryableDispatchError,
  type DispatcherHost,
} from "./dispatch.js";
import type { DispatchEventRow, DispatchTaskRow } from "./store.js";
import { type MemoryEngine, workspaceIdFromPath } from "./memory/index.js";
import type { CodeoidConfig } from "../config.js";
import type { CompressionRegistry } from "./compress/index.js";
import type {
  AuthContext,
  ClientMessage,
  DaemonMessage,
  ModelInfo,
  SessionInfo,
} from "../protocol/types.js";
import type { DailyUsageBucket, LifetimeUsageTotals } from "./memory/store.js";

/**
 * Optional safe-root for session workdirs. When `CODEOID_FS_BROWSE_ROOT` is set
 * (the same knob `fs.browse_dir` uses), a session's workdir must resolve inside
 * it — so a scoped token can't create a session rooted anywhere on the host.
 * Unset = no root constraint (workdirs are still barred from protected dirs).
 */
function workdirSafeRoot(): string | null {
  const override = process.env.CODEOID_FS_BROWSE_ROOT;
  if (!override || override.trim().length === 0) return null;
  try {
    return realpathSync(override.trim());
  } catch {
    return resolve(override.trim());
  }
}

/**
 * Resolve a user-supplied workdir to an absolute, existing directory.
 * Expands a leading `~`, resolves relative paths against the daemon cwd, and
 * returns null if the path doesn't exist, isn't a directory, lands inside a
 * protected directory (the daemon's own secret store / host credential dirs),
 * or escapes the configured safe-root.
 *
 * The containment check is the session-creation half of GHSA-38vh vector 2:
 * `fs.read` is already bounded to the session workdir, so refusing a workdir
 * that IS (or is an ancestor of) the daemon config dir stops a scoped token
 * from rooting a session at `~` and reading `~/.codeoid/config.json` — the root
 * ZeroID key. `fs.resolveSafe` enforces the same deny-list as defence in depth.
 */
function normalizeWorkdir(input: string): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  let p: string;
  if (raw === "~") p = homedir();
  else if (raw.startsWith("~/")) p = resolve(homedir(), raw.slice(2));
  else p = resolve(raw);
  try {
    if (!existsSync(p) || !statSync(p).isDirectory()) return null;
    // Canonicalise so a symlinked workdir can't smuggle the resolved path
    // into a protected dir or outside the safe-root.
    const canonical = realpathSync(p);
    if (isProtectedPath(canonical)) return null;
    const root = workdirSafeRoot();
    if (root && canonical !== root && !canonical.startsWith(root + sep)) {
      return null;
    }
    return canonical;
  } catch {
    return null;
  }
}

/** Eager-resume bounds. Resume runs before the daemon listens — so an
 * unbounded resume can block startup or OOM. Cap to the newest-N sessions and
 * stop past a deadline (applied WITHIN each transcript parse too, not just
 * between sessions); the rest stay on disk (loadable on a future restart). */
const RESUME_MAX_SESSIONS = 50;
const RESUME_DEADLINE_MS = 20_000;
/** Per-session transcript read budget on resume. Scrollback keeps at most
 * 20 MiB / 5000 messages — parsing history past that would be evicted on
 * arrival, so cap the read slightly above the scrollback byte cap. */
const RESUME_TRANSCRIPT_MAX_BYTES = 24 * 1024 * 1024;

/** Provider assumed when a client doesn't say which catalog it wants.
 *  Sessions are Claude-backed today; when the provider registry is wired
 *  into session creation this becomes the configured default provider. */
export const DEFAULT_PROVIDER_ID = "claude";

/** Sort key for resume ordering: most-recently-active first. Falls back to
 * createdAt, then 0, so a malformed timestamp never throws. */
function resumeSortKey(m: { lastActivityAt?: string; createdAt?: string }): number {
  const t = m.lastActivityAt ?? m.createdAt ?? "";
  const n = Date.parse(t);
  return Number.isFinite(n) ? n : 0;
}

export class SessionManager {
  #sessions = new Map<string, Session>();
  #store: Store;
  #transcriptStore: TranscriptStore;
  #identityManager?: AgentIdentityManager;
  #rateLimiter: RateLimiter;
  #memory?: MemoryEngine;
  /** Live model catalogs by provider id (via each backend's supportedModels
   *  equivalent), cached daemon-wide once any session of that provider
   *  initializes. Empty until then. */
  #modelsCache = new Map<string, ModelInfo[]>();
  #config?: CodeoidConfig;
  #compressionRegistry?: CompressionRegistry;
  #dispatcher: Dispatcher;
  /** The daemon's provider catalog — one registry, shared by every session. */
  #providers: ProviderRegistry;
  /** The daemon's hook bus — one instance, shared by every session. */
  #hooks?: HookBus;
  #testProviderFactory?: () => SessionProvider;
  /** Stable observer identity — every Session reports status transitions here. */
  #statusObserver = (sessionId: string, status: SessionInfo["status"]): void => {
    this.#dispatcher.onSessionStatus(sessionId, status);
  };

  constructor(
    store: Store,
    transcriptStore: TranscriptStore,
    identityManager?: AgentIdentityManager,
    rateLimiter?: RateLimiter,
    memory?: MemoryEngine,
    opts?: {
      config?: CodeoidConfig;
      compressionRegistry?: CompressionRegistry;
      /**
       * Provider registry override (tests / embedders adding backends).
       * Absent = the built-in catalog (claude, gemini, openai).
       */
      providers?: ProviderRegistry;
      /**
       * The daemon's hook bus (built once at startup from config.hooks).
       * Absent = no hooks; sessions pay zero overhead.
       */
      hooks?: HookBus;
      /**
       * Test-only: provider factory injected into every Session this manager
       * constructs, so manager-level integration tests (conductor injection,
       * worker spawn, dispatch host) run without the Claude Agent SDK
       * subprocess. Mirrors SessionCreateOptions._testProvider.
       */
      _testProviderFactory?: () => SessionProvider;
    },
  ) {
    this.#store = store;
    this.#transcriptStore = transcriptStore;
    this.#identityManager = identityManager;
    this.#rateLimiter = rateLimiter ?? new RateLimiter();
    this.#memory = memory;
    this.#config = opts?.config;
    this.#compressionRegistry = opts?.compressionRegistry;
    this.#providers = opts?.providers ?? createDefaultProviderRegistry(opts?.config);
    this.#hooks = opts?.hooks;
    this.#testProviderFactory = opts?._testProviderFactory;
    this.#dispatcher = new Dispatcher(
      store,
      this.#makeDispatcherHost(),
      opts?.config?.dispatch,
    );
  }

  /** The dispatch queue driver (P4). Exposed for server lifecycle + tests. */
  get dispatcher(): Dispatcher {
    return this.#dispatcher;
  }

  /**
   * Registered provider ids, default first — advertised on `auth.ok` so
   * clients can populate the new-session provider picker.
   */
  providerIds(): string[] {
    const ids = this.#providers.ids();
    const def = this.#providers.defaultId;
    return [def, ...ids.filter((id) => id !== def)];
  }

  /** Supported backends that couldn't activate at startup (diagnostics). */
  unavailableProviders(): Array<{ id: string; hint: string }> {
    return this.#providers.unavailableEntries();
  }

  /** Start the dispatcher loop. Call AFTER resumeSessions so surviving
   * workers are back in #sessions before the boot-time reclaim pass runs. */
  startDispatcher(): void {
    this.#dispatcher.start();
  }

  stopDispatcher(): void {
    this.#dispatcher.stop();
  }

  /**
   * Resume sessions from persisted transcripts (called on daemon restart).
   * Rebuilds in-memory session objects and scrollback buffers.
   */
  async resumeSessions(): Promise<number> {
    // Reload the durable conductor identity first (design R2): the persisted
    // {identityId, wimseUri, apiKey} row is reused instead of re-registering,
    // so the conductor keeps ONE stable WIMSE URI across daemon restarts.
    // Best-effort and null-safe — a missing or stale row just means the next
    // registerConductor() starts fresh.
    const conductor = await this.#identityManager?.resumeConductor();
    if (conductor) {
      console.log(
        `[codeoid] resumed conductor identity ${conductor.wimseUri}`,
      );
    }

    const allMetas = await this.#transcriptStore.loadAllMeta();
    // Newest-first by last activity so the cap keeps the most relevant
    // sessions when there are more than RESUME_MAX_SESSIONS on disk.
    const sorted = [...allMetas].sort(
      (a, b) => resumeSortKey(b) - resumeSortKey(a),
    );
    const capped = sorted.slice(0, RESUME_MAX_SESSIONS);
    const deadline = Date.now() + RESUME_DEADLINE_MS;
    let resumed = 0;
    let skippedDeadline = 0;

    for (let i = 0; i < capped.length; i++) {
      // Time-box: a few huge transcripts shouldn't wedge startup. Stop and
      // leave the remainder on disk rather than blocking the daemon listen.
      if (Date.now() > deadline) {
        skippedDeadline = capped.length - i;
        break;
      }
      const meta = capped[i]!;
      try {
        const session = new Session({
          name: meta.sessionName,
          // Heal a workdir persisted with a literal `~` or one that has since
          // moved — expand/validate it so the SDK can launch. Falls back to
          // the raw value if it can't be resolved (surfaces a clear error on
          // first send rather than crashing resume).
          workdir: normalizeWorkdir(meta.workdir) ?? meta.workdir,
          auth: {
            sub: meta.createdBy,
            scopes: [],
            delegationDepth: 0,
            accountId: meta.accountId,
            projectId: meta.projectId,
          },
          store: this.#store,
          transcriptStore: this.#transcriptStore,
          providers: this.#providers,
          hooks: this.#hooks,
          identityManager: this.#identityManager,
          existingId: meta.sessionId,
          memory: this.#memory,
          config: this.#config,
          compressionRegistry: this.#compressionRegistry,
          // The conductor self-persists (design R2): its role, provider
          // selection, and fleet tools all come back across a restart.
          role: meta.role,
          providerId: meta.providerId,
          defaultModel:
            meta.role === "conductor" ? this.#config?.conductor?.model : undefined,
          fleet:
            meta.role === "conductor"
              ? this.#buildFleetServer(meta.accountId, meta.projectId)
              : undefined,
          _testProvider: this.#testProviderFactory?.(),
          onStatusChange: this.#statusObserver,
          onModels: (providerId, m) => this._cacheModels(providerId, m),
        });

        // Restore scrollback from transcript, seeding the seq counter past
        // the persisted tail so new appends continue the monotonic sequence.
        // Byte-budgeted + deadline-aware: one huge transcript can neither
        // OOM the daemon nor eat the whole resume window by itself.
        const loadStats: { truncated?: boolean } = {};
        const entries = await this.#transcriptStore.loadTranscript(meta.sessionId, {
          maxBytes: RESUME_TRANSCRIPT_MAX_BYTES,
          deadlineAt: deadline,
          stats: loadStats,
        });
        const messages = entries.map((e) => e.message);
        const maxSeq = entries.reduce((max, e) => Math.max(max, e.seq), -1);
        session.restoreScrollback(messages, maxSeq + 1, entries.map((e) => e.bytes), {
          partialHistory: loadStats.truncated === true,
        });

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

    const droppedCap = sorted.length - capped.length;
    if (droppedCap > 0 || skippedDeadline > 0) {
      console.warn(
        `[codeoid] resume: restored ${resumed} of ${sorted.length} session(s); ${droppedCap} left over the ${RESUME_MAX_SESSIONS}-session cap, ${skippedDeadline} skipped past the ${RESUME_DEADLINE_MS}ms deadline (still on disk; loadable on a future restart).`,
      );
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
    opts?: {
      /**
       * The caller's raw bearer token, retained by the transport for flows
       * that need the owner as an RFC 8693 delegation SUBJECT — today only
       * conductor creation (owner → conductor token exchange). Never logged,
       * never persisted.
       */
      rawToken?: string;
    },
  ): Promise<DaemonMessage> {
    switch (msg.type) {
      case "ping":
        // Liveness heartbeat — lets a client detect a half-open/zombie
        // socket (suspended webview, slept laptop) that never fired a close
        // event, by noticing the pong never arrives.
        return { type: "response.ok", requestId: msg.id, data: { pong: true } };
      case "session.create":
        if (msg.role === "conductor") {
          return this.#createConductor(msg, auth, opts?.rawToken);
        }
        if (msg.role) {
          // A role this daemon doesn't implement (newer client / future
          // worker role). Fail closed rather than silently downgrading to a
          // normal session — a caller asking for a constrained role must not
          // get an unconstrained one.
          return {
            type: "response.error",
            requestId: msg.id,
            error: `Unsupported session role: "${msg.role}"`,
            code: "invalid_request",
          };
        }
        return this.#create(msg, auth);
      case "session.list":
        return this.#list(msg, auth);
      case "session.attach":
        return this.#attach(msg, auth, client);
      case "scrollback.page":
        return this.#pageScrollback(msg, auth);
      case "session.detach":
        return this.#detach(msg, client);
      case "session.send":
        return this.#send(msg, auth);
      case "session.interrupt":
        return this.#interrupt(msg, auth);
      case "session.approve":
        return this.#approve(msg, auth);
      case "session.ui_response":
        return this.#uiResponse(msg, auth);
      case "session.part_action":
        return this.#partAction(msg, auth);
      case "session.commands":
        return this.#sessionCommands(msg, auth);
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
      case "session.set_provider":
        return this.#setProvider(msg, auth);
      case "session.fork":
        return this.#fork(msg, auth);
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
      case "models.list":
        return this.#modelsList(msg);
      case "session.export":
        return this.#sessionExport(msg, auth);
      case "session.import":
        return this.#sessionImport(msg, auth);
      case "usage.daily":
        return this.#usageDaily(msg, auth);
      default: {
        // Inbound messages are cast from raw JSON at the transport, so an
        // unknown/malformed `type` reaches here. Without this the function
        // returned undefined → the daemon sent nothing → the client's request
        // never resolved until its 30s timeout. Resolve it explicitly.
        const m = msg as { id?: unknown; type?: unknown };
        return {
          type: "response.error",
          requestId: typeof m.id === "string" ? m.id : "",
          error: `Unknown message type: ${typeof m.type === "string" ? m.type : "(none)"}`,
          code: "invalid_request",
        };
      }
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
          // Bind the exporter's tenant so the derived workspace id matches the
          // tenant-scoped ids episodes were written under.
          workspaceIdFor: (wd: string) => workspaceIdFromPath(wd, auth),
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
          // Bind the importer's tenant so imported episodes land under the same
          // tenant-scoped workspace id this importer will read from.
          workspaceIdFor: (wd: string) => workspaceIdFromPath(wd, auth),
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
              providers: this.#providers,
              hooks: this.#hooks,
              ...(this.#identityManager
                ? { identityManager: this.#identityManager }
                : {}),
              ...(this.#memory ? { memory: this.#memory } : {}),
              config: this.#config,
              compressionRegistry: this.#compressionRegistry,
              _testProvider: this.#testProviderFactory?.(),
          onStatusChange: this.#statusObserver,
              onModels: (providerId, m) => this._cacheModels(providerId, m),
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

  /**
   * Cache the live model catalog a provider reported. The list is
   * version-static per provider within a daemon lifetime, so the first
   * report per provider wins and we stop overwriting (cheap idempotence;
   * avoids churn from every new session).
   *
   * The first report of each daemon lifetime is also persisted to SQLite
   * (keyed by provider id), so subsequent boots serve current model names
   * before any turn runs (see `#currentModels`) instead of the baked-in
   * fallback that goes stale between codeoid releases.
   *
   * TypeScript-private (not `#`) so unit tests can exercise the persistence
   * path directly without a live backend query — same convention as
   * `Session._applyInterruptedStateToTool`. Do NOT call from production code
   * outside the `onModels` wiring.
   */
  private _cacheModels(
    providerId: string,
    raw: ReadonlyArray<{ value: string; displayName: string; description?: string }>,
  ): void {
    if (this.#modelsCache.has(providerId) || raw.length === 0) return;
    const models = raw.map((m) => ({
      value: m.value,
      displayName: m.displayName,
      ...(m.description ? { description: m.description } : {}),
      isDefault: m.value === "default",
    }));
    this.#modelsCache.set(providerId, models);
    try {
      this.#store.saveModelCatalog(providerId, models);
    } catch (err) {
      // Persistence is best-effort — the in-memory cache still serves this
      // lifetime; next boot just falls back one tier further.
      console.error(
        `[codeoid/models] failed to persist ${providerId} model catalog: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * The model catalog to serve for a provider, best source first:
   *   1. live    — reported by that provider's backend this daemon lifetime
   *   2. cached  — the last live list persisted by a previous lifetime
   *   3. fallback — the baked-in catalog (claude only; other providers have
   *                 no baked-in list and serve empty until they report)
   * `live` is true only for tier 1, so clients keep refetching until the
   * backend has actually been asked this lifetime.
   */
  #currentModels(providerId: string): { models: ModelInfo[]; live: boolean } {
    const liveModels = this.#modelsCache.get(providerId);
    if (liveModels) return { models: liveModels, live: true };
    const persisted = this.#persistedModels(providerId);
    if (persisted) return { models: persisted, live: false };
    return {
      models: providerId === DEFAULT_PROVIDER_ID ? fallbackModelInfos() : [],
      live: false,
    };
  }

  /** Lazily-loaded persisted catalogs (null = never reported / unreadable). */
  #persistedModelsCache = new Map<string, ModelInfo[] | null>();
  #persistedModels(providerId: string): ModelInfo[] | null {
    if (!this.#persistedModelsCache.has(providerId)) {
      let value: ModelInfo[] | null = null;
      try {
        value = this.#store.getModelCatalog(providerId);
      } catch {
        value = null;
      }
      this.#persistedModelsCache.set(providerId, value);
    }
    return this.#persistedModelsCache.get(providerId) ?? null;
  }

  #modelsList(
    msg: Extract<ClientMessage, { type: "models.list" }>,
  ): DaemonMessage {
    const provider = msg.provider ?? DEFAULT_PROVIDER_ID;
    const { models, live } = this.#currentModels(provider);
    return { type: "models.list.result", requestId: msg.id, models, live, provider };
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
  async drain(timeoutMs = 10_000): Promise<void> {
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
        (s) =>
          s.status === "thinking" ||
          s.status === "tool_running" ||
          s.status === "waiting_approval",
      );
      if (working.length === 0) return;
      for (const session of working) {
        if (interrupted.has(session.id)) continue;
        void session.interrupt(systemAuth);
        interrupted.add(session.id);
      }
      await Bun.sleep(500);
    }
  }

  // ── Handlers ──────────────────────────────────────────────────────────

  /** The configured display name of the conductor session (default "conductor"). */
  #conductorName(): string {
    return this.#config?.conductor?.name ?? "conductor";
  }

  #create(
    msg: Extract<ClientMessage, { type: "session.create" }>,
    auth: AuthContext,
  ): DaemonMessage {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_CREATE)) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:create", code: "forbidden" };
    }

    // Reserve the conductor's display name for the singleton — a normal
    // session named "conductor" would shadow it in session.list and confuse
    // any name-based lookup. Point the caller at the role instead.
    if (msg.name === this.#conductorName()) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: `"${msg.name}" is reserved for the conductor session — create it with role:"conductor" instead`,
        code: "invalid_request",
      };
    }

    // Rate limit check
    const rateCheck = this.#rateLimiter.check(auth.sub);
    if (!rateCheck.allowed) {
      return { type: "response.error", requestId: msg.id, error: rateCheck.reason, code: "rate_limited" };
    }

    // Explicit provider selection fails CLOSED: asking for a backend this
    // daemon doesn't have must never silently hand back a claude session.
    // (Resume keeps the warn-and-fall-back path — see ProviderRegistry.resolve.)
    if (msg.providerId && !this.#providers.has(msg.providerId)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: `Unknown provider "${msg.providerId}" — available: ${this.#providers.ids().join(", ")}`,
        code: "invalid_request",
      };
    }

    // Normalize + validate the workdir. A leading `~` must be expanded and a
    // missing directory rejected up front — otherwise the SDK fails opaquely
    // ("native binary … exists but failed to launch") when it can't spawn the
    // agent subprocess in a non-existent cwd. Protects every frontend.
    const workdir = normalizeWorkdir(msg.workdir);
    if (!workdir) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: `Working directory not found: ${msg.workdir}`,
        code: "invalid_request",
      };
    }

    const session = new Session({
      name: msg.name,
      workdir,
      auth,
      store: this.#store,
      transcriptStore: this.#transcriptStore,
      providers: this.#providers,
      hooks: this.#hooks,
      providerId: msg.providerId,
      identityManager: this.#identityManager,
      memory: this.#memory,
      config: this.#config,
      compressionRegistry: this.#compressionRegistry,
      _testProvider: this.#testProviderFactory?.(),
      onStatusChange: this.#statusObserver,
      onModels: (providerId, m) => this._cacheModels(providerId, m),
    });

    this.#sessions.set(session.id, session);
    this.#rateLimiter.recordCreation(auth.sub);

    return {
      type: "response.ok",
      requestId: msg.id,
      data: session.toInfo(),
    };
  }

  /**
   * Fork a session (`session.fork`) — branch its conversation into a new,
   * independent session seeded with a COPY of the parent's canonical history
   * and scrollback. Optionally onto a different backend (`providerId`), so
   * "branch this claude conversation and continue it on codex" is one call.
   * The parent is untouched.
   *
   * Fails closed: a foreign/unknown parent is `not_found`; an unknown
   * providerId is `invalid_request` (same rule as create/set_provider).
   */
  async #fork(
    msg: Extract<ClientMessage, { type: "session.fork" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_CREATE)) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:create", code: "forbidden" };
    }

    const parent = this.#getOwnedSession(msg.sessionId, auth);
    if (!parent) {
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }
    // Forking THE conductor would mint a second fleet supervisor — refuse.
    if (parent.role) {
      return { type: "response.error", requestId: msg.id, error: `Cannot fork a ${parent.role} session`, code: "invalid_request" };
    }

    const providerId = msg.providerId ?? parent.providerId;
    if (providerId && !this.#providers.has(providerId)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: `Unknown provider "${providerId}" — available: ${this.#providers.ids().join(", ")}`,
        code: "invalid_request",
      };
    }

    const rateCheck = this.#rateLimiter.check(auth.sub);
    if (!rateCheck.allowed) {
      return { type: "response.error", requestId: msg.id, error: rateCheck.reason, code: "rate_limited" };
    }

    // Snapshot the parent's state BEFORE building the fork. Canonical history
    // is the source of truth for the conversation; the transcript rows are
    // replayed into the fork's scrollback for UI visibility.
    const history = parent.canonicalHistory.map((t) => ({ ...t }));
    const parentInfo = parent.toInfo();
    let transcriptRows: DaemonMessage[] = [];
    let sizeHints: Array<number | undefined> = [];
    try {
      const entries = await this.#transcriptStore.loadTranscript(msg.sessionId, {
        maxBytes: RESUME_TRANSCRIPT_MAX_BYTES,
      });
      transcriptRows = entries.map((e) => e.message);
      sizeHints = entries.map((e) => e.bytes);
    } catch (err) {
      // Scrollback replay is best-effort — the fork's CONVERSATION is carried
      // by the canonical history above, which is already in memory.
      console.error(
        `[codeoid/fork] transcript load failed for ${msg.sessionId} (fork keeps history, drops scrollback): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const fork = new Session({
      name: msg.name ?? `${parentInfo.name} (fork)`,
      workdir: parent.workdir,
      auth,
      store: this.#store,
      transcriptStore: this.#transcriptStore,
      providers: this.#providers,
      hooks: this.#hooks,
      providerId,
      identityManager: this.#identityManager,
      memory: this.#memory,
      config: this.#config,
      compressionRegistry: this.#compressionRegistry,
      _testProvider: this.#testProviderFactory?.(),
      onStatusChange: this.#statusObserver,
      onModels: (pid, m) => this._cacheModels(pid, m),
    });

    await fork.primeFromFork(history, transcriptRows, sizeHints);

    this.#sessions.set(fork.id, fork);
    this.#rateLimiter.recordCreation(auth.sub);
    this.#store.audit(
      auth.sub,
      "session.fork",
      fork.id,
      `from=${msg.sessionId} provider=${providerId ?? "default"} turns=${history.length}`,
    );

    return { type: "response.ok", requestId: msg.id, data: fork.toInfo() };
  }

  /**
   * Create — or return — THE conductor session for the caller's tenant
   * (design §3, build plan P3). Idempotent: one conductor per
   * (account, project); a second create request answers with the existing
   * one so `codeoid attach conductor` works from any client without
   * coordination. The daemon chooses name/workdir/provider itself (from
   * config.conductor) — the request's name/workdir are ignored.
   */
  async #createConductor(
    msg: Extract<ClientMessage, { type: "session.create" }>,
    auth: AuthContext,
    rawToken?: string,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_CREATE)) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:create", code: "forbidden" };
    }
    if (this.#config?.conductor?.enabled === false) {
      return { type: "response.error", requestId: msg.id, error: "Conductor is disabled (config.conductor.enabled)", code: "invalid_request" };
    }

    const existing = this.#conductorFor(auth.accountId, auth.projectId);
    if (existing) {
      return { type: "response.ok", requestId: msg.id, data: existing.toInfo() };
    }

    const rateCheck = this.#rateLimiter.check(auth.sub);
    if (!rateCheck.allowed) {
      return { type: "response.error", requestId: msg.id, error: rateCheck.reason, code: "rate_limited" };
    }

    // Durable identity (P2): reuse-or-register the conductor's ZeroID
    // identity, then mint its working token by OWNER delegation — the
    // caller's own bearer token is the RFC 8693 subject. Best-effort like
    // the rest of the identity layer: the conductor still runs without it.
    if (this.#identityManager) {
      const identity = await this.#identityManager.registerConductor(auth.sub);
      if (identity && rawToken) {
        const token = await this.#identityManager.mintConductorToken(rawToken);
        if (!token) {
          console.error(
            "[codeoid] owner->conductor delegation failed — conductor runs with metadata-only attribution (is session:read/session:dispatch in your token's scopes?)",
          );
        }
      }
    }

    // Re-check the singleton after the awaits above: two near-simultaneous
    // conductor creates for the same tenant both pass the first #conductorFor
    // check (neither has a session registered yet), then both await identity
    // work. Re-check now — the re-check → new Session → #sessions.set below
    // runs with no `await` between, so this closes the TOCTOU window and only
    // one conductor is ever registered per (account, project).
    const raced = this.#conductorFor(auth.accountId, auth.projectId);
    if (raced) {
      return { type: "response.ok", requestId: msg.id, data: raced.toInfo() };
    }

    // The conductor is global (cross-workspace), so it gets a dedicated,
    // daemon-owned empty workdir — NOT a repo, NOT ~ (protected-ancestor),
    // and crucially not a directory with a user .mcp.json to auto-load.
    const workdir = join(homedir(), ".codeoid-conductor");
    mkdirSync(workdir, { recursive: true });

    const conductorConfig = this.#config?.conductor;
    const providerId = conductorConfig?.provider ?? DEFAULT_PROVIDER_ID;
    if (providerId !== "claude") {
      console.warn(
        `[codeoid] conductor provider is "${providerId}" — MCP fleet tools are only surfaced by the claude provider today; the conductor will chat but cannot see the fleet`,
      );
    }

    const session = new Session({
      name: this.#conductorName(),
      workdir,
      role: "conductor",
      providerId,
      defaultModel: conductorConfig?.model,
      fleet: this.#buildFleetServer(auth.accountId, auth.projectId),
      auth,
      store: this.#store,
      transcriptStore: this.#transcriptStore,
      providers: this.#providers,
      hooks: this.#hooks,
      identityManager: this.#identityManager,
      memory: this.#memory,
      config: this.#config,
      compressionRegistry: this.#compressionRegistry,
      _testProvider: this.#testProviderFactory?.(),
      onStatusChange: this.#statusObserver,
      onModels: (providerId, m) => this._cacheModels(providerId, m),
    });

    this.#sessions.set(session.id, session);
    this.#rateLimiter.recordCreation(auth.sub);
    this.#store.audit(
      this.#identityManager?.conductorUri ?? auth.sub,
      "conductor.session.created",
      session.id,
      `provider=${providerId}`,
    );

    return { type: "response.ok", requestId: msg.id, data: session.toInfo() };
  }

  /** The tenant's conductor session, if one is live. */
  #conductorFor(accountId: string, projectId: string): Session | undefined {
    for (const session of this.#sessions.values()) {
      if (
        session.role === "conductor" &&
        session.accountId === accountId &&
        session.projectId === projectId
      ) {
        return session;
      }
    }
    return undefined;
  }

  // ── Dispatcher host (P4) ──────────────────────────────────────────────

  /** System principal for dispatcher-driven session operations. */
  #dispatchSystemAuth(accountId: string, projectId: string): AuthContext {
    return {
      sub: "system:dispatch",
      scopes: [],
      delegationDepth: 0,
      accountId,
      projectId,
    };
  }

  /** Principal a dispatched prompt is SENT as — attributed to the conductor. */
  #dispatchSenderAuth(task: DispatchTaskRow): AuthContext {
    return {
      sub: task.createdBy,
      scopes: [],
      delegationDepth: 1,
      accountId: task.accountId,
      projectId: task.projectId,
    };
  }

  /** A tenant-scoped session lookup that treats cross-tenant ids as absent. */
  #sessionForTask(id: string | null, task: DispatchTaskRow): Session | undefined {
    if (!id) return undefined;
    const session = this.#sessions.get(id);
    if (!session) return undefined;
    if (session.accountId !== task.accountId || session.projectId !== task.projectId) {
      return undefined;
    }
    return session;
  }

  /** Complete, self-contained brief for a freshly-spawned worker. */
  #workerBrief(task: DispatchTaskRow): string {
    const contract =
      task.shape === "scout"
        ? "Investigate and report. Do NOT modify files, commit, or push — your identity holds no write scope and your report is the only deliverable."
        : "Deliver the change described below. Keep the diff minimal and verify your work before finishing.";
    return [
      `<fleet_dispatch task="${task.id}" shape="${task.shape}">`,
      `You are a disposable ${task.shape} worker spawned by the codeoid conductor with the owner's approval.`,
      contract,
      `Work only inside ${task.workdir}. You run unattended on a bounded tool budget — be economical.`,
      "End your final message with a concise summary of what you found/changed: it becomes the digest reported back to the conductor.",
      "</fleet_dispatch>",
      "",
      task.prompt,
    ].join("\n");
  }

  #makeDispatcherHost(): DispatcherHost {
    return {
      sendToSession: async (task: DispatchTaskRow): Promise<void> => {
        const target = this.#sessionForTask(task.targetSession, task);
        if (!target) {
          throw new NonRetryableDispatchError(
            `target session ${task.targetSession ?? "?"} no longer exists`,
          );
        }
        await target.send(
          `[conductor dispatch ${task.id.slice(0, 8)} — owner-approved]\n\n${task.prompt}`,
          this.#dispatchSenderAuth(task),
        );
      },

      spawnWorker: async (task: DispatchTaskRow): Promise<{ sessionId: string }> => {
        // Re-validate at execution time — the directory can vanish between
        // approval and claim, and that's a permanent failure, not a retry.
        const workdir = task.workdir ? normalizeWorkdir(task.workdir) : null;
        if (!workdir) {
          throw new NonRetryableDispatchError(
            `workdir not usable: ${task.workdir ?? "(none)"}`,
          );
        }
        const budget = this.#dispatcher.config.workerToolBudget;
        const session = new Session({
          name: `worker-${task.shape}-${task.id.slice(0, 8)}`,
          workdir,
          role: "worker",
          workerShape: task.shape,
          // Autonomous with a bounded budget: unattended until the budget
          // exhausts, then guarded → waiting_approval, which the dispatcher
          // treats as a wedge (lease stops renewing, reclaim handles it).
          initialMode: { mode: "autonomous", maxTurns: budget },
          auth: this.#dispatchSenderAuth(task),
          store: this.#store,
          transcriptStore: this.#transcriptStore,
          providers: this.#providers,
          hooks: this.#hooks,
          identityManager: this.#identityManager,
          memory: this.#memory,
          config: this.#config,
          compressionRegistry: this.#compressionRegistry,
          _testProvider: this.#testProviderFactory?.(),
          onStatusChange: this.#statusObserver,
          onModels: (providerId, m) => this._cacheModels(providerId, m),
        });
        this.#sessions.set(session.id, session);
        // No rate-limiter charge: the dispatcher's own worker cap governs
        // spawn concurrency, and the human never called session.create.
        try {
          await session.send(this.#workerBrief(task), this.#dispatchSenderAuth(task));
        } catch (err) {
          // Partial spawn: the session exists but never got its brief. Tear
          // it down before rethrowing — the dispatcher only learns the
          // worker's id from our return value, so an early throw would
          // otherwise orphan it.
          try {
            await session.destroy(
              this.#dispatchSystemAuth(task.accountId, task.projectId),
            );
          } catch {
            // Best-effort cleanup.
          }
          this.#sessions.delete(session.id);
          throw err;
        }
        return { sessionId: session.id };
      },

      continueWorker: async (task: DispatchTaskRow): Promise<boolean> => {
        const worker = this.#sessionForTask(task.workerSessionId, task);
        if (!worker) return false;
        // Mode isn't persisted across restarts — re-arm the autonomous
        // budget before continuing or the resumed worker wedges immediately.
        worker.setMode("autonomous", this.#dispatcher.config.workerToolBudget);
        const note = [
          `<fleet_dispatch task="${task.id}" continuation="true">`,
          `The daemon restarted while you were working (attempt ${task.attempts + 1} of ${task.failureLimit}).`,
          `Review the current state of ${worker.workdir} — your earlier progress may be partially applied — and CONTINUE the original task below to completion.`,
          "</fleet_dispatch>",
          "",
          task.prompt,
        ].join("\n");
        await worker.send(note, this.#dispatchSenderAuth(task));
        return true;
      },

      workerStatus: (sessionId: string) => this.#sessions.get(sessionId)?.status ?? null,

      buildWorkerDigest: (task: DispatchTaskRow): string => {
        const worker = this.#sessionForTask(task.workerSessionId, task);
        const header = `task ${task.id.slice(0, 8)} (${task.kind}/${task.shape}) in ${task.workdir ?? task.targetSession ?? "?"}`;
        if (!worker) return `${header} — worker session unavailable; check the workdir/git state for artifacts.`;
        const parts: string[] = [header];
        const finalText = worker.lastAssistantText;
        if (finalText) {
          const trimmed = finalText.trim();
          parts.push(
            `Worker's final message${trimmed.length > 700 ? " (truncated)" : ""}:`,
            trimmed.slice(0, 700),
          );
        } else {
          parts.push("(worker produced no final message)");
        }
        if (this.#memory) {
          const episodes = this.#memory
            .timeline(worker.workspaceId, 60)
            .filter((e) => e.sessionId === worker.id)
            .slice(0, 8);
          if (episodes.length > 0) {
            parts.push(
              "Activity:",
              ...episodes.map(
                (e) => `- ${e.kind}${e.toolName ? `/${e.toolName}` : ""}: ${e.summary}`,
              ),
            );
          }
        }
        return parts.join("\n");
      },

      destroyWorker: async (sessionId: string, reason: string): Promise<void> => {
        const worker = this.#sessions.get(sessionId);
        if (!worker || worker.role !== "worker") return;
        try {
          await worker.destroy(
            this.#dispatchSystemAuth(worker.accountId, worker.projectId),
          );
        } catch (err) {
          console.error(
            `[codeoid/dispatch] worker teardown failed (${reason}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        this.#sessions.delete(sessionId);
      },

      deliverEvents: async (
        accountId: string,
        projectId: string,
        events: DispatchEventRow[],
      ): Promise<boolean> => {
        const conductor = this.#conductorFor(accountId, projectId);
        // Hold until there IS an idle conductor — events are durable, and
        // interrupting a mid-turn conductor would corrupt its work. One
        // batched injection per delivery: N completions = one wake.
        if (!conductor || conductor.status !== "idle") return false;
        const body = [
          "<fleet_events>",
          "(daemon-injected dispatch notifications — NOT a message from the owner)",
          ...events.map((e) => `- [${e.type}] ${e.digest}`),
          "</fleet_events>",
          "",
          "Summarize these outcomes for the owner. Decide any follow-up dispatch yourself — it will require approval as usual.",
        ].join("\n");
        await conductor.send(
          body,
          this.#dispatchSystemAuth(accountId, projectId),
        );
        return true;
      },

      audit: (action: string, detail: string): void => {
        this.#store.audit("system:dispatch", action, undefined, detail);
      },
    };
  }

  /**
   * Build the codeoid_fleet MCP server for a tenant's conductor. Tools close
   * over the manager, so the conductor always sees the LIVE session
   * population — tenant-scoped exactly like session.list.
   */
  #buildFleetServer(accountId: string, projectId: string) {
    return buildFleetMcpServer({
      listSessions: (): FleetSessionView[] => {
        const views: FleetSessionView[] = [];
        for (const s of this.#sessions.values()) {
          if (s.accountId !== accountId || s.projectId !== projectId) continue;
          views.push({
            id: s.id,
            name: s.name,
            workdir: s.workdir,
            workspaceId: s.workspaceId,
            status: s.status,
            role: s.role,
            providerId: s.providerId,
            model: s.toInfo().model,
            attachedClients: s.attachedClientCount,
            createdAt: s.createdAt,
          });
        }
        return views;
      },
      memory: this.#memory,
      audit: (action, detail) =>
        this.#store.audit(
          this.#identityManager?.conductorUri ?? `conductor:${accountId}/${projectId}`,
          action,
          undefined,
          detail,
        ),
      conductorSessionId: () =>
        this.#conductorFor(accountId, projectId)?.id ?? "",
      // Send-class dispatch (P4). Every one of these tools is approval-gated
      // upstream (kept out of allowedTools + the hard #shouldAutoApprove
      // gate) — by the time a handler runs, the owner has confirmed.
      dispatch:
        this.#config?.dispatch?.enabled === false
          ? undefined
          : this._fleetDispatchDeps(accountId, projectId),
    });
  }

  /**
   * The send-class capability surface handed to the conductor's fleet tools.
   * Underscore-public so tests can exercise the real closures without an MCP
   * transport (the tool wiring itself is covered in fleet.test.ts).
   */
  _fleetDispatchDeps(accountId: string, projectId: string): FleetDispatchDeps {
    return {
      enqueue: (input) =>
        this.#dispatcher.enqueue({
          ...input,
          accountId,
          projectId,
          createdBy:
            this.#identityManager?.conductorUri ??
            `conductor:${accountId}/${projectId}`,
        }),
      interrupt: async (sessionId: string) => {
        const session = this.#sessions.get(sessionId);
        if (
          !session ||
          session.accountId !== accountId ||
          session.projectId !== projectId
        ) {
          throw new Error("target session no longer exists");
        }
        await session.interrupt(this.#dispatchSystemAuth(accountId, projectId));
      },
      checkWorkdir: (path: string) => normalizeWorkdir(path),
      listTasks: (limit: number): FleetTaskView[] =>
        this.#store
          .dispatchListForTenant(accountId, projectId, limit)
          .map((t) => ({
            id: t.id,
            kind: t.kind,
            shape: t.shape,
            status: t.status,
            attempts: t.attempts,
            target: t.targetSession ?? t.workdir,
            createdAt: t.createdAt,
            error: t.error,
            resultDigest: t.resultDigest,
          })),
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

    session.attach(client, msg.resume);
    return { type: "response.ok", requestId: msg.id, data: session.toInfo() };
  }

  /** History paging (`scrollback.paging`) — same read authority as attach. */
  async #pageScrollback(
    msg: Extract<ClientMessage, { type: "scrollback.page" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    const scope = hasScope(auth.scopes as string[], SCOPES.SESSION_ATTACH)
      || hasScope(auth.scopes as string[], SCOPES.SESSION_WATCH);
    if (!scope) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:attach or session:watch", code: "forbidden" };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }
    const page = await session.pageScrollback(msg.beforeMessageId, msg.maxBytes);
    return {
      type: "scrollback.page.result",
      requestId: msg.id,
      sessionId: msg.sessionId,
      ...page,
    };
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

    // Duplicate-send suppression (`send.idempotency`): a client that
    // couldn't observe whether its send survived a dropped socket resends
    // with the SAME clientMsgId — acknowledging instead of dispatching
    // prevents one prompt from becoming two billed turns. Checked after
    // scope + ownership so a rejected send never poisons the id.
    if (msg.clientMsgId !== undefined && session.markClientMsgSeen(msg.clientMsgId)) {
      return { type: "response.ok", requestId: msg.id, data: { duplicate: true } };
    }

    // Fire and forget — output streams to attached clients. The user message
    // is persisted synchronously at the top of session.send() before any
    // fallible work, so a later throw can't lose it. Surface that throw as a
    // visible system message instead of swallowing it (the old `.catch(() => {})`
    // returned a false "ok" and dropped the error — silent data loss).
    // priority controls mid-turn insertion semantics (default "later" = FIFO).
    session
      .send(msg.text, auth, msg.attachments, msg.priority)
      .catch((err) => session.reportSendFailure(err));

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
      // auth carries the tenant (account_id/project_id) — scope by it so a
      // caller can't recall episodes from another tenant sharing the path.
      if (anchorPath) workspaceId = workspaceIdFromPath(anchorPath, auth);
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
      // Global scope = OMIT workspaceId (the engine treats undefined as
      // "every workspace"); passing "" selected a nonexistent empty
      // workspace and scope:"all" always returned zero hits.
      ...(scope === "all" ? {} : { workspaceId }),
      limit,
      sessionNames,
    });

    // Enrich each hit with sessionName + workdir from the in-memory map
    // (store has the rest; we just want ergonomic display). Hits that
    // resolve to a session belonging to a different tenant render as
    // "(unknown)" — same shape we already use for sessions that aren't
    // live in memory.
    const enriched = hits
      .map((h) => {
        const live = this.#sessions.get(h.sessionId);
        // Drop hits whose session is live under a DIFFERENT tenant — masking
        // only the name (as before) still leaked the snippet body/excerpt
        // when two tenants share a path-hash workspace on one host. Hits with
        // no live session (the caller's own destroyed/not-resumed history)
        // are kept and masked as before. (A fully tenant-scoped episode store
        // would also catch cross-tenant *non-live* hits — tracked in #13.)
        if (
          live &&
          (live.accountId !== auth.accountId || live.projectId !== auth.projectId)
        ) {
          return null;
        }
        const owned =
          live && live.accountId === auth.accountId && live.projectId === auth.projectId
            ? live
            : null;
        return {
          ...h,
          sessionName: owned?.name ?? "(unknown)",
          workdir: owned?.workdir ?? "",
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

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
    // Validate against the session's provider catalog (live, persisted, or
    // fallback). Accepts a canonical value, a case-insensitive display name
    // (`opus` → "Opus"), or a full claude-* id. An unknown value is rejected
    // here with the set of valid choices, so `/model o` gets actionable
    // feedback.
    const { models } = this.#currentModels(session.providerId);
    const resolvedModel = resolveAgainstList(msg.model, models);
    if (!resolvedModel) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: `Unknown model "${msg.model}". Available: ${models
          .map((m) => m.value)
          .join(", ")}`,
        code: "invalid_request",
      };
    }
    let resolvedFallback = msg.fallbackModel;
    if (typeof msg.fallbackModel === "string") {
      const rf = resolveAgainstList(msg.fallbackModel, models);
      if (!rf) {
        return {
          type: "response.error",
          requestId: msg.id,
          error: `Unknown fallback model "${msg.fallbackModel}".`,
          code: "invalid_request",
        };
      }
      resolvedFallback = rf;
    }
    try {
      const result = await session.setModel(resolvedModel, resolvedFallback, auth);
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

    // interrupt() does its UI-visible work (flush, deny approvals, info row)
    // synchronously before its first await, so the ack is accurate; the
    // SDK turn-stop resolves shortly after. Fire-and-forget — errors are
    // handled inside interrupt() (hard-abort fallback).
    void session.interrupt(auth);
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

  #uiResponse(
    msg: Extract<ClientMessage, { type: "session.ui_response" }>,
    auth: AuthContext,
  ): DaemonMessage {
    // Answering a provider dialog is the same trust class as answering a
    // tool approval — reuse session:approve.
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
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }
    const applied = session.resolveUiRequestFromClient(
      msg.requestId,
      { value: msg.value, confirmed: msg.confirmed, cancelled: msg.cancelled },
      auth,
    );
    if (!applied) {
      // Already answered elsewhere, timed out, or never existed. Clients
      // treat this as "dismiss my copy" (the ui_resolved broadcast already
      // did or will do that).
      return {
        type: "response.error",
        requestId: msg.id,
        error: "UI request is not pending",
        code: "not_found",
      };
    }
    return { type: "response.ok", requestId: msg.id };
  }

  async #partAction(
    msg: Extract<ClientMessage, { type: "session.part_action" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    // Activating a provider button is an act-on-session operation — same
    // trust class as sending a prompt.
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
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }
    const result = await session.dispatchPartAction(msg.messageId, msg.action, msg.data, auth);
    if (!result.ok) {
      return { type: "response.error", requestId: msg.id, error: result.error, code: result.code };
    }
    return { type: "response.ok", requestId: msg.id };
  }

  async #sessionCommands(
    msg: Extract<ClientMessage, { type: "session.commands" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    // Read-class visibility — same gate as listing sessions.
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
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }
    const commands = await session.listProviderCommands();
    return {
      type: "session.commands.result",
      requestId: msg.id,
      sessionId: session.id,
      providerId: session.providerId,
      commands,
    };
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

  async #setProvider(
    msg: Extract<ClientMessage, { type: "session.set_provider" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    // Same trust class as set_mode (set_model uses the lower SESSION_SEND
    // scope): switching backends is a heavier session-config write.
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
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }
    const result = await session.switchProvider(msg.providerId, auth);
    if (!result.ok) {
      return { type: "response.error", requestId: msg.id, error: result.error, code: result.code };
    }
    return {
      type: "response.ok",
      requestId: msg.id,
      data: { providerId: result.providerId },
    };
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

  #emptyUsageResponse(requestId: string): DaemonMessage {
    return {
      type: "response.ok",
      requestId,
      data: {
        daily: [] as DailyUsageBucket[],
        lifetime: {
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          numTurns: 0,
          numSessions: 0,
        } as LifetimeUsageTotals,
      },
    };
  }

  #usageDaily(
    msg: Extract<ClientMessage, { type: "usage.daily" }>,
    auth: AuthContext,
  ): DaemonMessage {
    if (!this.#memory) {
      return this.#emptyUsageResponse(msg.id);
    }
    const days = typeof msg.days === "number" && msg.days > 0 ? Math.min(msg.days, 365) : 30;
    const ownedSessionIds = this.#store
      .listSessions(auth.accountId, auth.projectId)
      .map((s) => s.id);
    // An identity that owns no sessions gets zeros — never the unfiltered
    // aggregate. (The store also enforces this: an empty array is a strict
    // filter, not "no filter". Belt and suspenders around a tenancy leak.)
    if (ownedSessionIds.length === 0) {
      return this.#emptyUsageResponse(msg.id);
    }
    const daily = this.#memory.store.dailyUsage(days, ownedSessionIds);
    const lifetime = this.#memory.store.lifetimeTotals(ownedSessionIds);
    return {
      type: "response.ok",
      requestId: msg.id,
      data: { daily, lifetime },
    };
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
