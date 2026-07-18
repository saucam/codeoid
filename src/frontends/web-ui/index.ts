/**
 * Web-UI frontend — serves the built SolidJS app (`web/dist`) from the
 * daemon at `/ui/*`. This makes the daemon a single origin for the UI, the
 * WebSocket, and the ZeroID token proxy, so one HTTPS tunnel exposes the
 * whole thing — which is exactly what a Telegram Mini App needs.
 *
 * Build it with `cd web && bunx vite build --base=/ui/` (the `/ui/` base
 * makes the emitted asset URLs resolve under this mount).
 *
 * Embed-SSO trust: when the daemon serves `index.html` it injects the
 * operator-configured embed allowlist as `window.__CODEOID_EMBED_ORIGINS__`
 * (a synchronous global, defined before the SPA boots). The web UI's
 * trusted-framing-origin gate reads it to decide whether a URL-hash
 * credential handoff may be consumed (see web/src/lib/handoff.ts). This is
 * the delivery channel for the allowlist — the client reads no other daemon
 * config surface synchronously at boot, and the gate must run before any
 * credential is consumed, so a synchronous injected global fits better than
 * an async fetch. Empty allowlist ⇒ no origin is trusted ⇒ handoff disabled.
 */

import { existsSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import type { Frontend, FrontendContext } from "../types.js";

// src/frontends/web-ui → repo root → web/dist
const DIST = resolve(import.meta.dir, "../../../web/dist");
const INDEX_HTML = join(DIST, "index.html");

export class WebUiFrontend implements Frontend {
  readonly name = "web-ui";

  /** Origins allowed to frame the UI + hand it a credential (embed SSO). */
  readonly #allowedOrigins: readonly string[];

  constructor(allowedOrigins: readonly string[] = []) {
    this.#allowedOrigins = allowedOrigins;
  }

  async start(_ctx: FrontendContext): Promise<void> {
    if (existsSync(INDEX_HTML)) {
      console.log("[codeoid] web-ui (Mini App) served at /ui");
      if (this.#allowedOrigins.length > 0) {
        console.log(
          `[codeoid] web-ui embed SSO allowlist: ${this.#allowedOrigins.join(", ")}`,
        );
      }
    } else {
      console.error(
        `[codeoid:web-ui] no build at ${DIST} — run: cd web && bunx vite build --base=/ui/`,
      );
    }
  }

  async stop(): Promise<void> {}

  /**
   * Serialize the embed allowlist into an inline <script> that defines the
   * synchronous global the client's handoff gate reads. The origins are
   * operator-controlled, but we still JSON-encode and neutralize `<` so a
   * value can never break out of the <script> element (defense in depth).
   */
  #embedOriginsScript(): string {
    const json = JSON.stringify(this.#allowedOrigins ?? []).replace(/</g, "\\u003c");
    return `<script>window.__CODEOID_EMBED_ORIGINS__=${json};</script>`;
  }

  /** Read index.html and inject the embed-origins global just inside <head>. */
  async #serveIndexHtml(): Promise<Response> {
    let html = await Bun.file(INDEX_HTML).text();
    const inject = this.#embedOriginsScript();
    // Insert right after the opening <head> so the global is defined before the
    // SPA module executes. Fall back to prepending if there's no <head>.
    html = /<head[^>]*>/i.test(html)
      ? html.replace(/<head[^>]*>/i, (m) => `${m}${inject}`)
      : `${inject}${html}`;
    return new Response(html, {
      headers: {
        "Cache-Control": "no-cache",
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  }

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
      file = INDEX_HTML;
    }
    if (!existsSync(file)) return new Response("UI not built", { status: 503 });

    // index.html (direct or SPA deep-link fallback) is served with the embed
    // allowlist injected; all other assets stream straight from disk.
    if (file === INDEX_HTML) return this.#serveIndexHtml();

    const cache = "public, max-age=3600";
    // Bun infers Content-Type from the file extension.
    return new Response(Bun.file(file), { headers: { "Cache-Control": cache } });
  }
}
