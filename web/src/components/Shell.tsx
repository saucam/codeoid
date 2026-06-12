/**
 * Application shell — the 3-pane grid that owns the chrome:
 *
 *   ┌────────────────────────────────────────────────────────┐
 *   │ status bar                                             │
 *   ├──────────┬──────────────────────────────┬──────────────┤
 *   │ sidebar  │ center: transcript + prompt  │ file viewer  │
 *   └──────────┴──────────────────────────────┴──────────────┘
 *
 * Pane widths come from `state/layout.ts`. The user can drag the
 * dividers (4px gutters) to resize, double-click to reset, or click
 * the collapse button on the sidebar to fold it into a 56px rail.
 *
 * The right pane only shows when a file is open (`openedFile()` is
 * non-null) and gets its own drag handle on the left edge.
 */

import { Component, Show, createMemo } from "solid-js";

import CapabilitiesDrawer from "./CapabilitiesDrawer";
import CenterPane from "./CenterPane";
import FileViewer from "./files/FileViewer";
import HelpModal from "./HelpModal";
import IdentityDrawer from "./IdentityDrawer";
import NewSessionModal from "./NewSessionModal";
import ResizeHandle from "./ResizeHandle";
import SearchModal from "./SearchModal";
import SessionExportModal from "./SessionExportModal";
import SessionImportModal from "./SessionImportModal";
import SessionListPane from "./SessionListPane";
import StatusBar from "./StatusBar";
import { openedFile } from "../state/files";
import {
  LIMITS_RO,
  isLeftCollapsed,
  leftSidebarEffectivePx,
  rightWidth,
  setLeftWidth,
  setRightWidth,
  sidebarWidth,
} from "../state/layout";

const Shell: Component = () => {
  const cols = createMemo(() => {
    const left = `${leftSidebarEffectivePx()}px`;
    const right = openedFile() ? `${rightWidth()}px` : "0px";
    return `${left} 4px minmax(0, 1fr) 4px ${right}`;
  });
  return (
    <div
      class="grid h-full grid-rows-[40px_1fr] transition-[grid-template-columns] duration-150 ease-out"
      style={{ "grid-template-columns": cols() }}
    >
      <StatusBar />
      <SessionListPane />
      <div class="row-start-2 col-start-2 flex h-full">
        <Show when={!isLeftCollapsed()}>
          <ResizeHandle
            side="right"
            current={sidebarWidth}
            onResize={setLeftWidth}
            onReset={() => setLeftWidth(280)}
            ariaLabel="Resize sidebar"
          />
        </Show>
      </div>
      <CenterPane />
      <div class="row-start-2 col-start-4 flex h-full">
        <Show when={openedFile()}>
          <ResizeHandle
            side="left"
            current={rightWidth}
            onResize={setRightWidth}
            onReset={() => setRightWidth(576)}
            ariaLabel="Resize file viewer"
          />
        </Show>
      </div>
      <aside
        class="row-start-2 col-start-5 overflow-hidden border-l border-border bg-bg-elev"
        style={{
          "min-width": openedFile() ? `${LIMITS_RO.rightMinPx}px` : undefined,
        }}
      >
        <FileViewer />
      </aside>
      <SearchModal />
      <NewSessionModal />
      <IdentityDrawer />
      <CapabilitiesDrawer />
      <SessionExportModal />
      <SessionImportModal />
      <HelpModal />
    </div>
  );
};

export default Shell;
