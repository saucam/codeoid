/**
 * Modal — overlay dialogs for new-session, switch-session, destroy confirm,
 * and cross-session search. Intentionally minimal; renders inline at the
 * bottom so it doesn't fight with Ink's single-surface render model.
 */

import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { ModalState, TuiSession } from "../types.js";
import type { SessionSearchHit } from "../../protocol/types.js";

interface Props {
  modal: ModalState;
  sessions: TuiSession[];
  onSubmitNewSession: (name: string, workdir: string) => void;
  onSelectSession: (sessionId: string) => void;
  onConfirmDestroy: (sessionId: string) => void;
  onCancel: () => void;
  /** Run a full-text + semantic session search. Resolves to result hits. */
  onSearch?: (query: string) => Promise<SessionSearchHit[]>;
}

export function Modal(props: Props) {
  switch (props.modal.kind) {
    case "new-session":
      return (
        <NewSessionModal onSubmit={props.onSubmitNewSession} onCancel={props.onCancel} />
      );
    case "switch-session":
      return (
        <SwitchModal
          query={props.modal.query}
          sessions={props.sessions}
          onSelect={props.onSelectSession}
          onCancel={props.onCancel}
        />
      );
    case "confirm-destroy": {
      const targetId = props.modal.sessionId;
      return (
        <ConfirmDestroyModal
          sessionId={targetId}
          session={props.sessions.find((s) => s.info.id === targetId) ?? null}
          onConfirm={() => props.onConfirmDestroy(targetId)}
          onCancel={props.onCancel}
        />
      );
    }
    case "help":
      return <HelpModal onCancel={props.onCancel} />;
    case "search":
      return (
        <SearchModal
          query={props.modal.query}
          onSearch={props.onSearch}
          onSelect={props.onSelectSession}
          onCancel={props.onCancel}
        />
      );
  }
}

function NewSessionModal({
  onSubmit,
  onCancel,
}: {
  onSubmit: (name: string, workdir: string) => void;
  onCancel: () => void;
}) {
  const [stage, setStage] = useState<"name" | "workdir">("name");
  const [name, setName] = useState("");
  const [workdir, setWorkdir] = useState(process.cwd());

  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="cyan"
      paddingX={1}
      paddingY={0}
    >
      <Text bold color="cyan">
        New Session
      </Text>
      <Box marginTop={1}>
        <Text>{stage === "name" ? "name:    " : "name:    "}</Text>
        {stage === "name" ? (
          <TextInput
            value={name}
            onChange={setName}
            onSubmit={() => {
              if (name.trim()) setStage("workdir");
            }}
          />
        ) : (
          <Text>{name}</Text>
        )}
      </Box>
      <Box>
        <Text>workdir: </Text>
        {stage === "workdir" ? (
          <TextInput
            value={workdir}
            onChange={setWorkdir}
            onSubmit={() => {
              if (workdir.trim()) onSubmit(name.trim(), workdir.trim());
            }}
          />
        ) : (
          <Text dimColor>{workdir}</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Enter to advance · Esc to cancel</Text>
      </Box>
    </Box>
  );
}

function SwitchModal({
  query,
  sessions,
  onSelect,
  onCancel,
}: {
  query: string;
  sessions: TuiSession[];
  onSelect: (id: string) => void;
  onCancel: () => void;
}) {
  const [q, setQ] = useState(query);
  const [idx, setIdx] = useState(0);

  const filtered = sessions.filter((s) =>
    s.info.name.toLowerCase().includes(q.toLowerCase()),
  );

  useInput((_input, key) => {
    if (key.escape) onCancel();
    if (key.upArrow) setIdx((i) => Math.max(0, i - 1));
    if (key.downArrow) setIdx((i) => Math.min(filtered.length - 1, i + 1));
    if (key.return && filtered[idx]) onSelect(filtered[idx]!.info.id);
  });

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        Switch Session
      </Text>
      <Box marginTop={1}>
        <Text>{"filter: "}</Text>
        <TextInput value={q} onChange={setQ} onSubmit={() => {}} />
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {filtered.length === 0 ? (
          <Text dimColor>(no matches)</Text>
        ) : (
          filtered.map((s, i) => (
            <Text key={s.info.id} color={i === idx ? "cyan" : "white"}>
              {i === idx ? "▸ " : "  "}
              {s.info.name} · {s.info.status}
            </Text>
          ))
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑↓ to move · Enter to select · Esc to cancel</Text>
      </Box>
    </Box>
  );
}

function ConfirmDestroyModal({
  session,
  onConfirm,
  onCancel,
}: {
  sessionId: string;
  session: TuiSession | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useInput((input, key) => {
    if (key.escape || input === "n" || input === "N") onCancel();
    if (input === "y" || input === "Y" || key.return) onConfirm();
  });

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="red" paddingX={1}>
      <Text bold color="red">
        Destroy Session
      </Text>
      <Box marginTop={1}>
        <Text>Destroy </Text>
        <Text bold>{session?.info.name ?? "(unknown)"}</Text>
        <Text>? This cannot be undone.</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>y to confirm · n/Esc to cancel</Text>
      </Box>
    </Box>
  );
}

// ── Search modal ────────────────────────────────────────────────────────

function SearchModal({
  query,
  onSearch,
  onSelect,
  onCancel,
}: {
  query: string;
  onSearch?: (q: string) => Promise<SessionSearchHit[]>;
  onSelect: (id: string) => void;
  onCancel: () => void;
}) {
  const [q, setQ] = useState(query);
  const [hits, setHits] = useState<SessionSearchHit[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);

  // Debounce — hit the daemon after the user stops typing for 200 ms.
  // Any typing in between cancels prior in-flight requests via a ref
  // guard so old results don't race ahead of new ones.
  const requestSeq = useRef(0);
  useEffect(() => {
    if (!onSearch) return;
    const trimmed = q.trim();
    if (!trimmed) {
      setHits([]);
      setError(null);
      setIsSearching(false);
      return;
    }
    const seq = ++requestSeq.current;
    const timer = setTimeout(async () => {
      setIsSearching(true);
      setError(null);
      try {
        const results = await onSearch(trimmed);
        if (seq !== requestSeq.current) return; // stale response
        setHits(results);
        setIdx(0);
      } catch (err) {
        if (seq !== requestSeq.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setHits([]);
      } finally {
        if (seq === requestSeq.current) setIsSearching(false);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [q, onSearch]);

  useInput((_input, key) => {
    if (key.escape) onCancel();
    if (key.upArrow) setIdx((i) => Math.max(0, i - 1));
    if (key.downArrow) setIdx((i) => Math.min(Math.max(0, hits.length - 1), i + 1));
    if (key.return && hits[idx]) onSelect(hits[idx]!.sessionId);
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="cyan"
      paddingX={1}
    >
      <Text bold color="cyan">
        🔍 Search across sessions
      </Text>
      <Box marginTop={1}>
        <Text>{"query: "}</Text>
        <TextInput value={q} onChange={setQ} onSubmit={() => {}} />
      </Box>

      {error && (
        <Box marginTop={1}>
          <Text color="red">error: {error}</Text>
        </Box>
      )}

      {q.trim().length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>
            Hybrid search (FTS5 keywords + vector + recency). Searches every
            message, tool call, and assistant reply across all sessions in
            this workspace.
          </Text>
        </Box>
      ) : isSearching && hits.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>searching…</Text>
        </Box>
      ) : hits.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>(no matches)</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {hits.map((hit, i) => (
            <SearchHitRow
              key={hit.sessionId}
              hit={hit}
              selected={i === idx}
            />
          ))}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          ↑↓ navigate · Enter to focus session · Esc to close
        </Text>
      </Box>
    </Box>
  );
}

function SearchHitRow({
  hit,
  selected,
}: {
  hit: SessionSearchHit;
  selected: boolean;
}) {
  const bar = selected ? "▸ " : "  ";
  const when = formatAgo(hit.lastMatchAt);
  const top = hit.snippets[0];
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text color={selected ? "cyan" : "white"} bold={selected}>
        {bar}
        {hit.sessionName}
        <Text dimColor>
          {" — " + hit.matchCount + " match" + (hit.matchCount === 1 ? "" : "es") + " · " + when}
        </Text>
      </Text>
      {top && (
        <Text dimColor>
          {"    "}
          {top.kind === "user_turn"
            ? "you: "
            : top.kind === "assistant_turn"
              ? "claude: "
              : top.kind === "tool_call"
                ? (top.toolName ? top.toolName + ": " : "tool: ")
                : "!: "}
          {compactExcerpt(top.excerpt)}
        </Text>
      )}
    </Box>
  );
}

function formatAgo(when: number): string {
  const dt = Math.max(0, Date.now() - when);
  if (dt < 60_000) return "just now";
  if (dt < 3_600_000) return Math.round(dt / 60_000) + "m ago";
  if (dt < 86_400_000) return Math.round(dt / 3_600_000) + "h ago";
  return Math.round(dt / 86_400_000) + "d ago";
}

function compactExcerpt(s: string): string {
  // Collapse internal whitespace + cap length for a single inline row.
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > 120 ? collapsed.slice(0, 117) + "…" : collapsed;
}

function HelpModal({ onCancel }: { onCancel: () => void }) {
  useInput((_input, key) => {
    if (key.escape || key.return) onCancel();
  });
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        Keybindings
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text bold>Ctrl-N</Text> new session
        </Text>
        <Text>
          <Text bold>Ctrl-G</Text> switch session
        </Text>
        <Text>
          <Text bold>Ctrl-D</Text> destroy focused session
        </Text>
        <Text>
          <Text bold>Ctrl-X</Text> interrupt focused session
        </Text>
        <Text>
          <Text bold>y / n</Text> approve/deny pending tool
        </Text>
        <Text>
          <Text bold>Shift-Tab / Ctrl-M</Text> cycle mode (interactive → auto-allow → autonomous)
        </Text>
        <Text>
          <Text bold>?</Text> show this help
        </Text>
        <Text>
          <Text bold>Ctrl-C</Text> quit
        </Text>
        <Text> </Text>
        <Text dimColor>Prompt:</Text>
        <Text>
          <Text bold>Alt-Enter / Ctrl-J / \&lt;Enter&gt;</Text> newline · <Text bold>Up/Down</Text> history
        </Text>
        <Text>
          <Text bold>Ctrl-A/E</Text> line start/end · <Text bold>Ctrl-U/K</Text> clear to start/end · <Text bold>Ctrl-W</Text> delete word
        </Text>
        <Text>
          Type <Text bold>/</Text> for slash commands (Tab completes, Enter runs).
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Esc / Enter to close</Text>
      </Box>
    </Box>
  );
}
