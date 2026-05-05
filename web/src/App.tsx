import { Component } from "solid-js";

const App: Component = () => {
  return (
    <div class="grid h-full grid-cols-[260px_1fr_0fr] grid-rows-[36px_1fr] transition-[grid-template-columns] duration-200 ease-out">
      {/* Status bar */}
      <header class="col-span-3 flex items-center gap-3 border-b border-border bg-bg-elev px-3 text-sm text-fg-muted">
        <span class="font-mono text-fg">codeoid</span>
        <span class="text-fg-faint">·</span>
        <span class="text-fg-faint">scaffold ok</span>
      </header>

      {/* Left sidebar — sessions + files */}
      <aside class="row-start-2 overflow-y-auto border-r border-border bg-bg-elev p-3">
        <div class="mb-3 text-[11px] font-medium uppercase tracking-wider text-fg-faint">
          Sessions
        </div>
        <div class="text-fg-muted">— no sessions yet —</div>
      </aside>

      {/* Center pane — transcript + prompt */}
      <main class="row-start-2 flex flex-col">
        <div class="flex-1 overflow-y-auto p-6 text-fg-muted">
          <div class="mx-auto max-w-3xl">
            <h1 class="mb-2 text-lg font-semibold text-fg">Codeoid web</h1>
            <p>Solid + Vite + Tailwind 4 scaffold loaded. Wire-up coming next.</p>
          </div>
        </div>
        <footer class="border-t border-border bg-bg-elev p-3 text-xs text-fg-faint">
          prompt area placeholder
        </footer>
      </main>

      {/* Right pane — file viewer (collapsed by default; the column width is 0fr until a file opens) */}
      <aside class="row-start-2 overflow-hidden border-l border-border bg-bg-elev" />
    </div>
  );
};

export default App;
