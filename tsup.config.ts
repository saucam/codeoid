import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    daemon: "src/daemon/index.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  splitting: true,
  sourcemap: true,
  clean: true,
  dts: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
