/**
 * Application shell — the 3-pane grid that owns the chrome:
 *
 *   ┌────────────────────────────────────────────────────────┐
 *   │ status bar                                             │
 *   ├──────────┬──────────────────────────────┬──────────────┤
 *   │ sidebar  │ center: transcript + prompt  │ file viewer  │
 *   └──────────┴──────────────────────────────┴──────────────┘
 *
 * The right pane is collapsed (column track at 0fr) by default and
 * grows to ~30% of the viewport when a file is opened. The grid-template
 * track interpolates smoothly thanks to the transition declared below.
 */

import { Component } from "solid-js";

import CenterPane from "./CenterPane";
import FileViewer from "./files/FileViewer";
import SessionListPane from "./SessionListPane";
import StatusBar from "./StatusBar";
import { openedFile } from "../state/files";

const Shell: Component = () => {
  const cols = () =>
    openedFile()
      ? "280px minmax(0, 1fr) minmax(0, 36rem)"
      : "280px minmax(0, 1fr) 0fr";
  return (
    <div
      class="grid h-full grid-rows-[40px_1fr] transition-[grid-template-columns] duration-200 ease-out"
      style={{ "grid-template-columns": cols() }}
    >
      <StatusBar />
      <SessionListPane />
      <CenterPane />
      <aside class="row-start-2 overflow-hidden border-l border-border bg-bg-elev">
        <FileViewer />
      </aside>
    </div>
  );
};

export default Shell;
