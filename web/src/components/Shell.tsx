/**
 * Application shell — the 3-pane grid that owns the chrome:
 *
 *   ┌────────────────────────────────────────────────────────┐
 *   │ status bar                                             │
 *   ├──────────┬──────────────────────────────┬──────────────┤
 *   │ sidebar  │ center: transcript + prompt  │ file viewer  │
 *   └──────────┴──────────────────────────────┴──────────────┘
 *
 * The right pane is collapsed (column track at 0fr) by default and grows
 * to a fixed width when a file is selected — animation handled by CSS
 * grid track transition. Phase 5 wires that up.
 */

import { Component } from "solid-js";

import CenterPane from "./CenterPane";
import SessionListPane from "./SessionListPane";
import StatusBar from "./StatusBar";

const Shell: Component = () => (
  <div class="grid h-full grid-cols-[280px_1fr_0fr] grid-rows-[40px_1fr] transition-[grid-template-columns] duration-200 ease-out">
    <StatusBar />
    <SessionListPane />
    <CenterPane />
    <aside class="row-start-2 overflow-hidden border-l border-border bg-bg-elev" />
  </div>
);

export default Shell;
