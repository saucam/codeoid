/**
 * Codeoid daemon — Bun WebSocket server + frontend plugin host.
 *
 * Production-grade patterns:
 *   - Graceful shutdown with cleanup registry
 *   - Session resume from transcript on startup
 *   - Frontend plugin architecture (Telegram, Web UI)
 *   - ZeroID JWT verification on every connection
 */

import { randomUUID } from "node:crypto";
import { verifyToken, type AuthConfig } from "./auth.js";
import { SessionManager } from "./session-manager.js";
import { Store } from "./store.js";
import { TranscriptStore } from "./transcript.js";
import { RateLimiter } from "./rate-limit.js";
import { ShutdownManager } from "./shutdown.js";
import { AgentIdentityManager } from "./agent-identity.js";
import { OAuthHandler, type OAuthConfig } from "./oauth.js";
import { GoogleOAuthProvider, LocalProvider } from "./identity-provider.js";
import { createMemory, type MemoryEngine } from "./memory/index.js";
import {
  CompressionRegistry,
  createRegistry,
} from "./compress/index.js";
import type { CodeoidConfig } from "../config.js";
import type { AuthContext, ClientMessage, DaemonMessage } from "../protocol/types.js";
import type { AttachedClient } from "./session.js";
import type { Frontend, FrontendContext } from "../frontends/types.js";
import type { Server } from "node:http";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface DaemonConfig {
  port: number;
  host: string;
  dbPath: string;
  transcriptDir: string;
  auth: AuthConfig;
  oauth?: OAuthConfig;
  agentIdentity?: {
    accountId: string;
    projectId: string;
  };
  /** Memory config — when present, episodes are stored and recall() is exposed to Claude. */
  memory?: {
    /** Absolute path to the episode database. */
    dbPath: string;
    /** HuggingFace embedding model (default: Xenova/bge-small-en-v1.5). */
    model?: string;
    /** Weight cache directory (default: ~/.codeoid/models). */
    modelCacheDir?: string;
  };
  /**
   * Full parsed CodeoidConfig — wired through to Session so the compression
   * subsystem (Layer B) can consult toggles and rule exclusions.
   */
  fullConfig?: CodeoidConfig;
}

interface AuthenticatedSocket {
  ws: WebSocket;
  clientId: string;
  auth: AuthContext;
}

export class DaemonServer {
  #config: DaemonConfig;
  #store: Store;
  #transcriptStore: TranscriptStore;
  #manager: SessionManager;
  #shutdown: ShutdownManager;
  #memory: MemoryEngine | null = null;
  #httpServer: ReturnType<typeof createServer> | null = null;
  #bunServer: ReturnType<typeof Bun.serve> | null = null;
  #sockets = new Map<string, AuthenticatedSocket>();
  #frontends: Frontend[] = [];
  #httpHandlers: Array<(req: IncomingMessage, res: ServerResponse) => boolean> = [];
  #oauthHandler: OAuthHandler | null = null;

  constructor(config: DaemonConfig) {
    this.#config = config;
    this.#store = new Store(config.dbPath);
    this.#transcriptStore = new TranscriptStore(config.transcriptDir);
    this.#shutdown = new ShutdownManager();

    if (config.oauth) {
      // Choose IdP based on env config
      const googleClientId = process.env["GOOGLE_CLIENT_ID"];
      const googleClientSecret = process.env["GOOGLE_CLIENT_SECRET"];

      const idp = (googleClientId && googleClientSecret)
        ? new GoogleOAuthProvider({ clientId: googleClientId, clientSecret: googleClientSecret })
        : new LocalProvider();

      this.#oauthHandler = new OAuthHandler(config.oauth, idp);
      console.log(`[codeoid] auth provider: ${idp.name}`);
    }

    let identityManager: AgentIdentityManager | undefined;
    if (config.agentIdentity) {
      identityManager = new AgentIdentityManager(
        {
          auth: config.auth,
          accountId: config.agentIdentity.accountId,
          projectId: config.agentIdentity.projectId,
        },
        this.#store,
      );
    }

    // Build the compression registry once at startup. It's stateless and
    // safe to share across all sessions — rules never mutate.
    const compressionRegistry: CompressionRegistry | undefined = config.fullConfig
      ? createRegistry(config.fullConfig)
      : undefined;

    const rateLimiter = new RateLimiter();
    this.#manager = new SessionManager(
      this.#store, this.#transcriptStore, identityManager, rateLimiter,
      // Memory is wired post-construction via initMemory() — see start()
      undefined,
      { config: config.fullConfig, compressionRegistry },
    );

    // Register cleanup functions (LIFO order)
    this.#shutdown.register("sessions", () => this.#manager.drain(10_000));
    this.#shutdown.register("memory", async () => {
      if (this.#memory) await this.#memory.close();
    });
    this.#shutdown.register("store", () => this.#store.close());
    this.#shutdown.register("websockets", () => {
      for (const { ws } of this.#sockets.values()) {
        ws.close(1001, "Server shutting down");
      }
    });
    this.#shutdown.register("server", () => {
      this.#bunServer?.stop();
    });
  }

  get manager(): SessionManager {
    return this.#manager;
  }

  // ── Frontend plugin management ──────────────────────────────────────

  use(frontend: Frontend): void {
    this.#frontends.push(frontend);

    // Register frontend cleanup
    this.#shutdown.register(`frontend:${frontend.name}`, () => frontend.stop());
  }

  route(handler: (req: IncomingMessage, res: ServerResponse) => boolean): void {
    this.#httpHandlers.push(handler);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // Install signal handlers
    this.#shutdown.install();

    // Boot memory engine if configured — before resume so ingestion queue is ready.
    if (this.#config.memory) {
      try {
        this.#memory = await createMemory({
          dbPath: this.#config.memory.dbPath,
          embedder: {
            model: this.#config.memory.model,
            cacheDir: this.#config.memory.modelCacheDir,
          },
        });
        await this.#memory.init();
        this.#manager.setMemory(this.#memory);
        console.log(
          `[codeoid] memory enabled — episodes -> ${this.#config.memory.dbPath}`,
        );
      } catch (err) {
        console.error(
          `[codeoid] memory init failed, continuing without recall: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.#memory = null;
      }
    }

    // Resume sessions from transcripts
    const resumed = await this.#manager.resumeSessions();
    if (resumed > 0) {
      console.log(`[codeoid] resumed ${resumed} session(s) from transcript`);
    }

    // Start Bun HTTP + WebSocket server
    const self = this;
    const authConfig = this.#config.auth;

    this.#bunServer = Bun.serve({
      port: this.#config.port,
      hostname: this.#config.host,

      async fetch(req, server) {
        const url = new URL(req.url);

        // WebSocket upgrade
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const success = server.upgrade(req, {
            data: { clientId: randomUUID(), authenticated: false, auth: null as AuthContext | null },
          });
          return success
            ? undefined
            : new Response("WebSocket upgrade failed", { status: 500 });
        }

        // HTTP routes
        if (url.pathname === "/health") {
          return Response.json({ status: "ok", version: "0.1.0" });
        }

        if (url.pathname === "/config") {
          return Response.json({ zeroid_url: authConfig.baseUrl });
        }

        // Token exchange proxy (avoids CORS)
        if (url.pathname === "/auth/token" && req.method === "POST") {
          try {
            const body = await req.text();
            const zeroidResp = await fetch(`${authConfig.baseUrl}/oauth2/token`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body,
            });
            const data = await zeroidResp.text();
            return new Response(data, {
              status: zeroidResp.status,
              headers: { "Content-Type": "application/json" },
            });
          } catch {
            return Response.json({ error: "ZeroID unreachable" }, { status: 502 });
          }
        }

        // OAuth authorization routes (/auth/authorize, /auth/callback)
        if (self.#oauthHandler && url.pathname.startsWith("/auth/")) {
          const oauthResp = await self.#oauthHandler.handleFetch(req);
          if (oauthResp) return oauthResp;
        }

        // Frontend routes (Web UI etc.)
        for (const frontend of self.#frontends) {
          if ("handleFetch" in frontend && typeof frontend.handleFetch === "function") {
            const resp = await (frontend as { handleFetch: (req: Request) => Promise<Response | null> }).handleFetch(req);
            if (resp) return resp;
          }
        }

        return new Response("Not Found", { status: 404 });
      },

      websocket: {
        open(ws) {
          // Auth timeout — client must authenticate within 10 seconds
          const data = ws.data as { clientId: string; authenticated: boolean; auth: AuthContext | null; authTimer?: ReturnType<typeof setTimeout> };
          data.authTimer = setTimeout(() => {
            if (!data.authenticated) {
              ws.close(4001, "Authentication timeout");
            }
          }, 10_000);
        },

        async message(ws, rawMessage) {
          const data = ws.data as { clientId: string; authenticated: boolean; auth: AuthContext | null; authTimer?: ReturnType<typeof setTimeout> };
          let parsed: Record<string, unknown>;

          try {
            parsed = JSON.parse(typeof rawMessage === "string" ? rawMessage : new TextDecoder().decode(rawMessage));
          } catch {
            ws.send(JSON.stringify({ type: "response.error", requestId: "", error: "Invalid JSON", code: "invalid_request" }));
            return;
          }

          // First message must be auth
          if (!data.authenticated) {
            if (data.authTimer) clearTimeout(data.authTimer);
            const token = typeof parsed["token"] === "string" ? parsed["token"] : undefined;
            if (!token) {
              ws.close(4001, "Missing auth token");
              return;
            }

            try {
              data.auth = await verifyToken(token, authConfig);
            } catch (err) {
              ws.close(4003, `Authentication failed: ${err instanceof Error ? err.message : "unknown"}`);
              return;
            }

            data.authenticated = true;
            self.#sockets.set(data.clientId, { ws: ws as unknown as WebSocket, clientId: data.clientId, auth: data.auth });

            ws.send(JSON.stringify({
              type: "auth.ok",
              identity: {
                sub: data.auth.sub,
                name: data.auth.name,
                type: data.auth.delegationDepth === 0 ? "human" : "agent",
              },
              scopes: data.auth.scopes,
            }));
            return;
          }

          // Authenticated — route through session manager
          const msg = parsed as unknown as ClientMessage;
          const client: AttachedClient = {
            id: data.clientId,
            auth: data.auth!,
            send: (m: DaemonMessage) => {
              try {
                ws.send(JSON.stringify(m));
              } catch { /* client may have disconnected */ }
            },
          };

          try {
            const response = await self.#manager.handle(msg, data.auth!, client);
            ws.send(JSON.stringify(response));
          } catch (err) {
            ws.send(JSON.stringify({
              type: "response.error",
              requestId: (msg as { id?: string }).id ?? "",
              error: err instanceof Error ? err.message : "Internal error",
              code: "internal",
            }));
          }
        },

        close(ws) {
          const data = ws.data as { clientId: string; authTimer?: ReturnType<typeof setTimeout> };
          if (data.authTimer) clearTimeout(data.authTimer);
          self.#manager.disconnectClient(data.clientId);
          self.#sockets.delete(data.clientId);
        },
      },
    });

    console.log(`[codeoid] daemon listening on ${this.#config.host}:${this.#config.port}`);

    // Start all registered frontends
    const ctx: FrontendContext = {
      manager: this.#manager,
      store: this.#store,
      auth: this.#config.auth,
      httpServer: null as unknown as Server, // Not used with Bun.serve
      host: this.#config.host,
      port: this.#config.port,
    };

    for (const frontend of this.#frontends) {
      try {
        await frontend.start(ctx);
        console.log(`[codeoid] frontend started: ${frontend.name}`);
      } catch (err) {
        console.error(`[codeoid] frontend failed to start: ${frontend.name}`, err);
      }
    }
  }

  async stop(): Promise<void> {
    await this.#shutdown.shutdown("manual");
  }
}
