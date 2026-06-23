/**
 * Web-UI frontend — serves the built SolidJS app (`web/dist`) from the
 * daemon at `/ui/*`. This makes the daemon a single origin for the UI, the
 * WebSocket, and the ZeroID token proxy, so one HTTPS tunnel exposes the
 * whole thing — which is exactly what a Telegram Mini App needs.
 *
 * Build it with `cd web && bunx vite build --base=/ui/` (the `/ui/` base
 * makes the emitted asset URLs resolve under this mount).
 */

import { existsSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import type { Frontend, FrontendContext } from "../types.js";

// src/frontends/web-ui → repo root → web/dist
const DIST = resolve(import.meta.dir, "../../../web/dist");

export class WebUiFrontend implements Frontend {
  readonly name = "web-ui";

  async start(_ctx: FrontendContext): Promise<void> {
    if (existsSync(join(DIST, "index.html"))) {
      console.log("[codeoid] web-ui (Mini App) served at /ui");
    } else {
      console.error(
        `[codeoid:web-ui] no build at ${DIST} — run: cd web && bunx vite build --base=/ui/`,
      );
    }
  }

  async stop(): Promise<void> {}

  async handleFetch(req: Request): Promise<Response | null> {
    const path = new URL(req.url).pathname;
    if (path !== "/ui" && !path.startsWith("/ui/")) return null;

    const rel =
      path === "/ui" || path === "/ui/" ? "index.html" : path.slice("/ui/".length);
    const target = normalize(join(DIST, rel));
    // Path-traversal guard — never serve outside the dist root.
    if (target !== DIST && !target.startsWith(`${DIST}/`)) {
      return new Response("Forbidden", { status: 403 });
    }

    let file = target;
    if (!existsSync(file)) {
      // A missing asset (has an extension) is a real 404; a missing route
      // (no extension) is an SPA deep-link → serve index.html.
      if (rel.includes(".")) return new Response("Not Found", { status: 404 });
      file = join(DIST, "index.html");
    }
    if (!existsSync(file)) return new Response("UI not built", { status: 503 });

    const cache = rel === "index.html" ? "no-cache" : "public, max-age=3600";
    // Bun infers Content-Type from the file extension.
    return new Response(Bun.file(file), { headers: { "Cache-Control": cache } });
  }
}
