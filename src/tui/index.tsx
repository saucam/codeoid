/**
 * TUI entry point. Exported as a function the CLI calls.
 */

import React from "react";
import { render } from "ink";
import { TuiStoreProvider } from "./store.js";
import { App } from "./App.js";
import type { CodeoidConfig } from "../config.js";

export async function startTui(config: CodeoidConfig): Promise<void> {
  // Any stdout/stderr write between Ink frames desyncs its cursor-up
  // math and leaves orphan top-borders stacked in native scrollback.
  // `patchConsole` funnels console.* through Ink's writer; the two
  // process handlers swallow Node's default logger for stray rejections
  // and uncaught errors (e.g. from `void client.xxx().catch(() => {})`
  // sites that miss, or from transitive libs) so they can't print.
  const onRejection = (_err: unknown) => {
    /* silenced — Ink mustn't see stdout/stderr writes mid-frame */
  };
  const onException = (_err: unknown) => {
    /* silenced — same reason */
  };
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);

  const instance = render(
    <TuiStoreProvider>
      <App config={config} />
    </TuiStoreProvider>,
    { exitOnCtrlC: false, patchConsole: true },
  );
  try {
    await instance.waitUntilExit();
  } finally {
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
  }
}
