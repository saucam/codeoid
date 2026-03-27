/**
 * WebSocket server — the daemon's network interface.
 *
 * Clients connect with a ZeroID JWT in the first message (auth handshake).
 * After verification, all subsequent messages are routed through the
 * SessionManager with the verified AuthContext.
 */

import { WebSocketServer, WebSocket } from "ws";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { verifyToken, extractBearerToken, type AuthConfig } from "./auth.js";
import { SessionManager } from "./session-manager.js";
import { Store } from "./store.js";
import type { AuthContext, ClientMessage, DaemonMessage } from "../protocol/types.js";
import type { AttachedClient } from "./session.js";

export interface DaemonConfig {
  port: number;
  host: string;
  dbPath: string;
  auth: AuthConfig;
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

  constructor(config: DaemonConfig) {
    this.#config = config;
    this.#store = new Store(config.dbPath);
    this.#manager = new SessionManager(this.#store);

    this.#httpServer = createServer(this.#handleHttp.bind(this));
    this.#wss = new WebSocketServer({ server: this.#httpServer });
    this.#wss.on("connection", this.#handleConnection.bind(this));
  }

  get manager(): SessionManager {
    return this.#manager;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.#httpServer.listen(this.#config.port, this.#config.host, () => {
        console.log(`[codeoid] daemon listening on ${this.#config.host}:${this.#config.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const { ws } of this.#sockets.values()) {
      ws.close(1001, "Server shutting down");
    }
    this.#wss.close();
    await new Promise<void>((resolve) => this.#httpServer.close(() => resolve()));
    this.#store.close();
    console.log("[codeoid] daemon stopped");
  }

  // ── HTTP handler (health check) ───────────────────────────────────────

  #handleHttp(req: IncomingMessage, res: import("node:http").ServerResponse): void {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: "0.1.0" }));
      return;
    }
    res.writeHead(404);
    res.end();
  }

  // ── WebSocket handler ─────────────────────────────────────────────────

  #handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const clientId = randomUUID();
    let authenticated = false;
    let auth: AuthContext | null = null;

    // Auth timeout — client must authenticate within 10 seconds
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

      // First message must be auth
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

      // Authenticated — route through session manager
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
