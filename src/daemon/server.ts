/**
 * Codeoid daemon — WebSocket server + frontend plugin host.
 *
 * The daemon owns the SessionManager and Store. External clients (terminal CLI)
 * connect over WebSocket. Embedded frontends (Telegram, Web UI) get direct
 * access to the SessionManager via the Frontend plugin interface.
 */

import { WebSocketServer, WebSocket } from "ws";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { verifyToken, type AuthConfig } from "./auth.js";
import { SessionManager } from "./session-manager.js";
import { Store } from "./store.js";
import type { AuthContext, ClientMessage, DaemonMessage } from "../protocol/types.js";
import type { AttachedClient } from "./session.js";
import { AgentIdentityManager } from "./agent-identity.js";
import type { Frontend, FrontendContext } from "../frontends/types.js";

export interface DaemonConfig {
  port: number;
  host: string;
  dbPath: string;
  auth: AuthConfig;
  /** If set, agents and sub-agents get ZeroID identities. */
  agentIdentity?: {
    accountId: string;
    projectId: string;
  };
}

interface AuthenticatedSocket {
  ws: WebSocket;
  clientId: string;
  auth: AuthContext;
}

export class DaemonServer {
  #config: DaemonConfig;
  #store: Store;
  #manager: SessionManager;
  #httpServer: Server;
  #wss: WebSocketServer;
  #sockets = new Map<string, AuthenticatedSocket>();
  #frontends: Frontend[] = [];
  #httpHandlers: Array<(req: IncomingMessage, res: ServerResponse) => boolean> = [];

  constructor(config: DaemonConfig) {
    this.#config = config;
    this.#store = new Store(config.dbPath);

    // Create agent identity manager if configured
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

    this.#manager = new SessionManager(this.#store, identityManager);

    this.#httpServer = createServer(this.#handleHttp.bind(this));
    this.#wss = new WebSocketServer({ server: this.#httpServer });
    this.#wss.on("connection", this.#handleConnection.bind(this));
  }

  get manager(): SessionManager {
    return this.#manager;
  }

  get httpServer(): Server {
    return this.#httpServer;
  }

  // ── Frontend plugin management ──────────────────────────────────────

  /**
   * Register a frontend plugin. Call before start().
   */
  use(frontend: Frontend): void {
    this.#frontends.push(frontend);
  }

  /**
   * Register an HTTP route handler. Frontends use this to mount their
   * own routes (e.g. /web/* for the web UI). Return true if handled.
   */
  route(handler: (req: IncomingMessage, res: ServerResponse) => boolean): void {
    this.#httpHandlers.push(handler);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#httpServer.listen(this.#config.port, this.#config.host, () => {
        console.log(`[codeoid] daemon listening on ${this.#config.host}:${this.#config.port}`);
        resolve();
      });
    });

    // Start all registered frontends
    const ctx: FrontendContext = {
      manager: this.#manager,
      store: this.#store,
      auth: this.#config.auth,
      httpServer: this.#httpServer,
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
    // Stop frontends first
    for (const frontend of this.#frontends) {
      try {
        await frontend.stop();
      } catch (err) {
        console.error(`[codeoid] frontend failed to stop: ${frontend.name}`, err);
      }
    }

    for (const { ws } of this.#sockets.values()) {
      ws.close(1001, "Server shutting down");
    }
    this.#wss.close();
    await new Promise<void>((resolve) => this.#httpServer.close(() => resolve()));
    this.#store.close();
    console.log("[codeoid] daemon stopped");
  }

  // ── HTTP handler ──────────────────────────────────────────────────────

  #handleHttp(req: IncomingMessage, res: ServerResponse): void {
    // Health check
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: "0.1.0" }));
      return;
    }

    // Let registered frontend handlers try first
    for (const handler of this.#httpHandlers) {
      if (handler(req, res)) return;
    }

    res.writeHead(404);
    res.end();
  }

  // ── WebSocket handler (for terminal CLI clients) ──────────────────────

  #handleConnection(ws: WebSocket, _req: IncomingMessage): void {
    const clientId = randomUUID();
    let authenticated = false;
    let auth: AuthContext | null = null;

    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        ws.close(4001, "Authentication timeout");
      }
    }, 10_000);

    ws.on("message", async (data) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        this.#sendError(ws, "", "Invalid JSON", "invalid_request");
        return;
      }

      if (!authenticated) {
        clearTimeout(authTimeout);
        const token = typeof parsed["token"] === "string" ? parsed["token"] : undefined;
        if (!token) {
          ws.close(4001, "Missing auth token");
          return;
        }

        try {
          auth = await verifyToken(token, this.#config.auth);
        } catch (err) {
          ws.close(4003, `Authentication failed: ${err instanceof Error ? err.message : "unknown"}`);
          return;
        }

        authenticated = true;
        this.#sockets.set(clientId, { ws, clientId, auth });

        ws.send(JSON.stringify({
          type: "auth.ok",
          sub: auth.sub,
          name: auth.name,
          scopes: auth.scopes,
        }));
        return;
      }

      const msg = parsed as unknown as ClientMessage;
      const client: AttachedClient = {
        id: clientId,
        auth: auth!,
        send: (m: DaemonMessage) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(m));
          }
        },
      };

      try {
        const response = await this.#manager.handle(msg, auth!, client);
        ws.send(JSON.stringify(response));
      } catch (err) {
        this.#sendError(
          ws,
          (msg as { id?: string }).id ?? "",
          err instanceof Error ? err.message : "Internal error",
          "internal",
        );
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimeout);
      this.#manager.disconnectClient(clientId);
      this.#sockets.delete(clientId);
    });

    ws.on("error", () => {
      this.#manager.disconnectClient(clientId);
      this.#sockets.delete(clientId);
    });
  }

  #sendError(ws: WebSocket, requestId: string, error: string, code: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "response.error", requestId, error, code }));
    }
  }
}
