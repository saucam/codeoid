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
});
