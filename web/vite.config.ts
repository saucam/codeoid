import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwind from "@tailwindcss/vite";

export default defineConfig({
  plugins: [solid(), tailwind()],
  server: {
    port: 5173,
    strictPort: true,
    // Daemon WebSocket lives at ws://127.0.0.1:7400. We hit it directly from
    // the client; no proxy needed (browser handles cross-origin WS upgrade
    // and the daemon's CORS is permissive on localhost).
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  optimizeDeps: {
    // micromark / unified pull in `debug`, which ships CJS with default
    // export semantics that need Vite's CJS-ESM bridge to be handled
    // correctly. Without this entry, the dev server fails with:
    //   SyntaxError: ... 'debug/src/browser.js' does not provide an
    //   export named 'default' (at create-tokenizer.js)
    // The production build via Rollup is fine without it; this only
    // affects `vite dev` pre-bundling.
    include: ["debug", "remark-gfm"],
  },
});
