/**
 * TUI entry point. Exported as a function the CLI calls.
 */

import React from "react";
import { render } from "ink";
import { TuiStoreProvider } from "./store.js";
import { App } from "./App.js";
import type { CodeoidConfig } from "../config.js";

export async function startTui(config: CodeoidConfig): Promise<void> {
  const instance = render(
    <TuiStoreProvider>
      <App config={config} />
    </TuiStoreProvider>,
    { exitOnCtrlC: false },
  );
  await instance.waitUntilExit();
}
