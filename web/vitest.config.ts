import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  test: {
    // Pure-logic tests run in node by default. Component tests opt in with
    // a top-of-file `// @vitest-environment jsdom` (we'll add jsdom as a
    // dev dep when the first component test lands).
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
  resolve: {
    conditions: ["development", "browser"],
  },
});
