/**
 * Web UI frontend plugin.
 *
 * Serves a mobile-first SPA from the daemon's HTTP server at /app/*.
 * The UI connects back to the daemon over WebSocket for real-time streaming.
 *
 * Features:
 * - Session switcher (swipe between sessions)
 * - File browser with tap-to-add-to-context
 * - Inline code viewer with syntax highlighting
 * - Approval buttons (not text yes/no)
 * - Voice input (Web Speech API)
 * - Works as Telegram Mini App or standalone PWA
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Frontend, FrontendContext } from "../types.js";

export class WebFrontend implements Frontend {
  readonly name = "web";

  #html: string | null = null;

  async start(ctx: FrontendContext): Promise<void> {
    const wsUrl = `ws://${ctx.host === "0.0.0.0" ? "localhost" : ctx.host}:${ctx.port}`;

    // Mount HTTP routes
    (ctx as unknown as { daemon: { route: (h: (req: IncomingMessage, res: ServerResponse) => boolean) => void } }).daemon?.route?.(
      (req, res) => this.#handle(req, res, wsUrl),
    );

    // Fallback: store handler for direct use by daemon
    this.#html = buildHtml(wsUrl);
  }

  async stop(): Promise<void> {}

  /**
   * Called by the daemon's HTTP handler. Returns true if this request was handled.
   */
  handleHttp(req: IncomingMessage, res: ServerResponse, wsUrl: string): boolean {
    return this.#handle(req, res, wsUrl);
  }

  #handle(req: IncomingMessage, res: ServerResponse, wsUrl: string): boolean {
    const url = req.url ?? "";

    if (url === "/app" || url === "/app/" || url.startsWith("/app?")) {
      if (!this.#html) this.#html = buildHtml(wsUrl);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(this.#html);
      return true;
    }

    // Manifest for PWA
    if (url === "/app/manifest.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        name: "Codeoid",
        short_name: "Codeoid",
        start_url: "/app",
        display: "standalone",
        background_color: "#0a0a0f",
        theme_color: "#6366f1",
        icons: [],
      }));
      return true;
    }

    return false;
  }
}

// ── HTML builder ──────────────────────────────────────────────────────────────

function buildHtml(wsUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#0a0a0f">
<link rel="manifest" href="/app/manifest.json">
<title>Codeoid</title>
<style>
${CSS}
</style>
</head>
<body>
<div id="app">
  <!-- Auth screen -->
  <div id="auth-screen" class="screen active">
    <div class="auth-card">
      <div class="logo">⚡ Codeoid</div>
      <p class="subtitle">Identity-first agent control</p>
      <input id="auth-input" type="password" placeholder="ZeroID API key (zid_sk_...)" autocomplete="off" />
      <button id="auth-btn" class="btn-primary">Connect</button>
      <p id="auth-error" class="error"></p>
    </div>
  </div>

  <!-- Main screen -->
  <div id="main-screen" class="screen">
    <!-- Top bar -->
    <header id="topbar">
      <div class="topbar-left">
        <button id="menu-btn" class="icon-btn">☰</button>
        <span id="session-name" class="session-title">No session</span>
      </div>
      <div class="topbar-right">
        <span id="session-status" class="status-dot idle"></span>
        <button id="new-session-btn" class="icon-btn">＋</button>
      </div>
    </header>

    <!-- Session drawer -->
    <div id="drawer" class="drawer hidden">
      <div class="drawer-header">Sessions</div>
      <div id="session-list" class="session-list"></div>
    </div>

    <!-- Agent output -->
    <main id="output" class="output"></main>

    <!-- Approval bar (shown when agent needs permission) -->
    <div id="approval-bar" class="approval-bar hidden">
      <div id="approval-info" class="approval-info"></div>
      <div class="approval-actions">
        <button id="approve-btn" class="btn-approve">Approve</button>
        <button id="deny-btn" class="btn-deny">Deny</button>
      </div>
    </div>

    <!-- Input area -->
    <div id="input-area" class="input-area">
      <div class="input-row">
        <button id="files-btn" class="icon-btn" title="Browse files">📁</button>
        <textarea id="prompt-input" rows="1" placeholder="Message your agent..."></textarea>
        <button id="voice-btn" class="icon-btn" title="Voice input">🎤</button>
        <button id="send-btn" class="icon-btn send" title="Send">▶</button>
      </div>
      <div id="context-chips" class="context-chips"></div>
    </div>

    <!-- File browser modal -->
    <div id="file-modal" class="modal hidden">
      <div class="modal-content">
        <div class="modal-header">
          <span id="file-path">Files</span>
          <button id="file-close" class="icon-btn">✕</button>
        </div>
        <div id="file-list" class="file-list"></div>
      </div>
    </div>

    <!-- New session modal -->
    <div id="new-session-modal" class="modal hidden">
      <div class="modal-content">
        <div class="modal-header">
          <span>New Session</span>
          <button id="new-session-close" class="icon-btn">✕</button>
        </div>
        <input id="ns-name" placeholder="Session name (e.g. oracle)" />
        <input id="ns-workdir" placeholder="Working directory (e.g. /Workspace/...)" />
        <button id="ns-create" class="btn-primary">Create</button>
      </div>
    </div>
  </div>
</div>

<script>
${JS(wsUrl)}
</script>
</body>
</html>`;
}

// ── CSS ───────────────────────────────────────────────────────────────────────

const CSS = `
:root {
  --bg: #0a0a0f;
  --bg-surface: #141420;
  --bg-elevated: #1c1c2e;
  --border: #2a2a3e;
  --text: #e4e4ed;
  --text-muted: #8888a0;
  --accent: #6366f1;
  --accent-hover: #818cf8;
  --green: #22c55e;
  --yellow: #eab308;
  --red: #ef4444;
  --radius: 12px;
  --safe-bottom: env(safe-area-inset-bottom, 0px);
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro', 'Segoe UI', system-ui, sans-serif;
  background: var(--bg);
  color: var(--text);
  height: 100dvh;
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}

#app { height: 100dvh; display: flex; flex-direction: column; }

.screen { display: none; height: 100%; flex-direction: column; }
.screen.active { display: flex; }

/* Auth */
.auth-card {
  margin: auto; padding: 2rem; width: min(90vw, 380px);
  display: flex; flex-direction: column; gap: 1rem; text-align: center;
}
.logo { font-size: 2rem; font-weight: 700; letter-spacing: -0.02em; }
.subtitle { color: var(--text-muted); font-size: 0.9rem; }
.error { color: var(--red); font-size: 0.85rem; min-height: 1.2em; }

input, textarea {
  background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px;
  color: var(--text); padding: 0.75rem 1rem; font-size: 1rem; outline: none;
  width: 100%; transition: border-color 0.15s;
}
input:focus, textarea:focus { border-color: var(--accent); }

.btn-primary {
  background: var(--accent); color: white; border: none; border-radius: 10px;
  padding: 0.75rem; font-size: 1rem; font-weight: 600; cursor: pointer;
  transition: background 0.15s;
}
.btn-primary:hover { background: var(--accent-hover); }
.btn-primary:active { transform: scale(0.98); }

/* Top bar */
#topbar {
  display: flex; justify-content: space-between; align-items: center;
  padding: 0.75rem 1rem; background: var(--bg-surface);
  border-bottom: 1px solid var(--border); flex-shrink: 0;
}
.topbar-left, .topbar-right { display: flex; align-items: center; gap: 0.5rem; }
.session-title { font-weight: 600; font-size: 1.1rem; }

.icon-btn {
  background: none; border: none; color: var(--text-muted); font-size: 1.3rem;
  cursor: pointer; padding: 0.25rem 0.4rem; border-radius: 8px;
  transition: background 0.15s, color 0.15s;
}
.icon-btn:hover { background: var(--bg-elevated); color: var(--text); }

.status-dot {
  width: 10px; height: 10px; border-radius: 50%; display: inline-block;
}
.status-dot.idle { background: var(--green); }
.status-dot.working { background: var(--yellow); animation: pulse 1.5s infinite; }
.status-dot.waiting_approval { background: var(--red); animation: pulse 0.8s infinite; }
.status-dot.error { background: var(--red); }

@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

/* Drawer */
.drawer {
  position: absolute; top: 52px; left: 0; right: 0; bottom: 0;
  background: var(--bg); z-index: 50; padding: 1rem;
  transition: transform 0.2s ease-out;
}
.drawer.hidden { display: none; }
.drawer-header { font-weight: 700; font-size: 1.1rem; margin-bottom: 1rem; }
.session-list { display: flex; flex-direction: column; gap: 0.5rem; }

.session-item {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.75rem 1rem; background: var(--bg-surface); border-radius: var(--radius);
  cursor: pointer; border: 1px solid var(--border); transition: border-color 0.15s;
}
.session-item:hover { border-color: var(--accent); }
.session-item.active { border-color: var(--accent); background: var(--bg-elevated); }
.session-item-info { flex: 1; }
.session-item-name { font-weight: 600; }
.session-item-path { font-size: 0.8rem; color: var(--text-muted); }

/* Output area */
.output {
  flex: 1; overflow-y: auto; padding: 1rem; scroll-behavior: smooth;
  -webkit-overflow-scrolling: touch;
}

.msg {
  margin-bottom: 1rem; padding: 0.75rem 1rem; border-radius: var(--radius);
  max-width: 100%; word-break: break-word; line-height: 1.5;
  animation: fadeIn 0.15s ease-out;
}
@keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

.msg-user {
  background: var(--accent); color: white; align-self: flex-end;
  margin-left: 20%; border-bottom-right-radius: 4px;
}
.msg-agent {
  background: var(--bg-surface); border: 1px solid var(--border);
  margin-right: 10%; border-bottom-left-radius: 4px;
}
.msg-tool {
  background: var(--bg-elevated); border: 1px solid var(--border);
  font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.85rem;
  color: var(--text-muted); margin-right: 10%;
}
.msg-system {
  text-align: center; color: var(--text-muted); font-size: 0.85rem;
  background: none; padding: 0.5rem;
}

pre {
  background: var(--bg); border-radius: 8px; padding: 0.75rem; overflow-x: auto;
  font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.85rem;
  margin: 0.5rem 0; border: 1px solid var(--border);
}

/* Approval bar */
.approval-bar {
  background: var(--bg-elevated); border-top: 1px solid var(--border);
  padding: 0.75rem 1rem; flex-shrink: 0;
}
.approval-bar.hidden { display: none; }
.approval-info {
  font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.5rem;
  font-family: 'SF Mono', 'Fira Code', monospace; word-break: break-all;
}
.approval-actions { display: flex; gap: 0.5rem; }
.btn-approve {
  flex: 1; padding: 0.6rem; background: var(--green); color: white;
  border: none; border-radius: 10px; font-weight: 600; font-size: 0.95rem; cursor: pointer;
}
.btn-deny {
  flex: 1; padding: 0.6rem; background: var(--red); color: white;
  border: none; border-radius: 10px; font-weight: 600; font-size: 0.95rem; cursor: pointer;
}

/* Input area */
.input-area {
  background: var(--bg-surface); border-top: 1px solid var(--border);
  padding: 0.5rem 0.75rem; padding-bottom: calc(0.5rem + var(--safe-bottom));
  flex-shrink: 0;
}
.input-row { display: flex; align-items: flex-end; gap: 0.25rem; }
.input-row textarea {
  flex: 1; resize: none; max-height: 120px; border: none; background: var(--bg-elevated);
  border-radius: 20px; padding: 0.6rem 1rem; font-size: 1rem; line-height: 1.4;
}
.icon-btn.send { color: var(--accent); font-size: 1.5rem; }

.context-chips {
  display: flex; flex-wrap: wrap; gap: 0.25rem; padding-top: 0.25rem;
}
.chip {
  background: var(--bg-elevated); border: 1px solid var(--accent);
  border-radius: 16px; padding: 0.2rem 0.6rem; font-size: 0.75rem;
  color: var(--accent); display: flex; align-items: center; gap: 0.3rem;
}
.chip-remove { cursor: pointer; opacity: 0.6; }
.chip-remove:hover { opacity: 1; }

/* Modals */
.modal {
  position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 100;
  display: flex; align-items: flex-end; justify-content: center;
}
.modal.hidden { display: none; }
.modal-content {
  background: var(--bg-surface); border-radius: var(--radius) var(--radius) 0 0;
  width: 100%; max-width: 500px; max-height: 80dvh; overflow-y: auto;
  padding: 1.25rem; padding-bottom: calc(1.25rem + var(--safe-bottom));
  display: flex; flex-direction: column; gap: 0.75rem;
  animation: slideUp 0.2s ease-out;
}
@keyframes slideUp { from { transform: translateY(100%); } to { transform: none; } }

.modal-header {
  display: flex; justify-content: space-between; align-items: center;
  font-weight: 700; font-size: 1.1rem;
}

/* File browser */
.file-list { display: flex; flex-direction: column; }
.file-item {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.6rem 0.25rem; border-bottom: 1px solid var(--border);
  cursor: pointer; transition: background 0.1s;
}
.file-item:hover { background: var(--bg-elevated); }
.file-item:active { background: var(--bg-elevated); }
.file-icon { font-size: 1.2rem; width: 1.5rem; text-align: center; flex-shrink: 0; }
.file-name { flex: 1; font-size: 0.9rem; }
.file-add {
  color: var(--accent); font-size: 0.8rem; padding: 0.2rem 0.5rem;
  border: 1px solid var(--accent); border-radius: 12px; flex-shrink: 0;
}
`;

// ── JavaScript ────────────────────────────────────────────────────────────────

function JS(wsUrl: string): string {
  return `
(function() {
  'use strict';

  const WS_URL = ${JSON.stringify(wsUrl)};
  let ws = null;
  let authToken = null;
  let currentSessionId = null;
  let currentSessionName = null;
  let contextFiles = [];
  let sessions = [];
  let msgIdCounter = 0;

  // ── Elements ──────────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const authScreen = $('#auth-screen');
  const mainScreen = $('#main-screen');
  const authInput = $('#auth-input');
  const authBtn = $('#auth-btn');
  const authError = $('#auth-error');
  const output = $('#output');
  const promptInput = $('#prompt-input');
  const sendBtn = $('#send-btn');
  const voiceBtn = $('#voice-btn');
  const filesBtn = $('#files-btn');
  const menuBtn = $('#menu-btn');
  const sessionName = $('#session-name');
  const sessionStatus = $('#session-status');
  const drawer = $('#drawer');
  const sessionList = $('#session-list');
  const approvalBar = $('#approval-bar');
  const approvalInfo = $('#approval-info');
  const approveBtn = $('#approve-btn');
  const denyBtn = $('#deny-btn');
  const fileModal = $('#file-modal');
  const fileList = $('#file-list');
  const filePath = $('#file-path');
  const fileClose = $('#file-close');
  const contextChips = $('#context-chips');
  const newSessionBtn = $('#new-session-btn');
  const newSessionModal = $('#new-session-modal');
  const nsName = $('#ns-name');
  const nsWorkdir = $('#ns-workdir');
  const nsCreate = $('#ns-create');
  const nsClose = $('#new-session-close');

  // ── Auth ──────────────────────────────────────────────────────────
  authBtn.onclick = async () => {
    const key = authInput.value.trim();
    if (!key) return;
    authError.textContent = '';
    authBtn.textContent = 'Connecting...';
    authBtn.disabled = true;

    try {
      // If it's a ZeroID API key, exchange for JWT first
      if (key.startsWith('zid_sk_')) {
        // Get the ZeroID URL from the daemon's health endpoint
        const health = await fetch('/health').then(r => r.json());
        // For now, use a convention: ZeroID URL is set during token exchange
        // The daemon handles JWT verification, so we pass the key and let
        // the daemon's auth handle the rest
      }
      authToken = key;
      connectWs();
    } catch (err) {
      authError.textContent = err.message;
      authBtn.textContent = 'Connect';
      authBtn.disabled = false;
    }
  };

  authInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') authBtn.click();
  });

  // ── WebSocket ─────────────────────────────────────────────────────
  function connectWs() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      ws.send(JSON.stringify({ token: authToken }));
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      handleMessage(msg);
    };

    ws.onclose = (e) => {
      if (e.code === 4001 || e.code === 4003) {
        authError.textContent = 'Authentication failed';
        authBtn.textContent = 'Connect';
        authBtn.disabled = false;
      }
    };

    ws.onerror = () => {
      authError.textContent = 'Connection error';
      authBtn.textContent = 'Connect';
      authBtn.disabled = false;
    };
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function newId() { return 'msg-' + (++msgIdCounter); }

  // ── Message handler ───────────────────────────────────────────────
  function handleMessage(msg) {
    switch (msg.type) {
      case 'auth.ok':
        authScreen.classList.remove('active');
        mainScreen.classList.add('active');
        // Fetch session list
        send({ type: 'session.list', id: newId() });
        break;

      case 'session.list.result':
        sessions = msg.sessions;
        renderSessions();
        break;

      case 'response.ok':
        if (msg.data && msg.data.id) {
          // Session created — refresh list and attach
          send({ type: 'session.list', id: newId() });
          attachSession(msg.data.id, msg.data.name);
          newSessionModal.classList.add('hidden');
        }
        break;

      case 'response.error':
        addMessage('system', msg.error);
        break;

      case 'agent.output':
        if (msg.sessionId === currentSessionId) {
          addMessage('agent', msg.content);
        }
        break;

      case 'agent.tool_call':
        if (msg.sessionId === currentSessionId) {
          addMessage('tool', '🔧 ' + msg.tool);
        }
        break;

      case 'agent.approval_request':
        if (msg.sessionId === currentSessionId) {
          approvalInfo.textContent = msg.tool + ': ' + msg.input.slice(0, 200);
          approvalBar.classList.remove('hidden');
        }
        break;

      case 'agent.status_change':
        if (msg.sessionId === currentSessionId) {
          sessionStatus.className = 'status-dot ' + msg.status;
          if (msg.status === 'idle' || msg.status === 'error') {
            approvalBar.classList.add('hidden');
          }
        }
        // Update session list
        const s = sessions.find(s => s.id === msg.sessionId);
        if (s) s.status = msg.status;
        renderSessions();
        break;
    }
  }

  // ── Session management ────────────────────────────────────────────
  function renderSessions() {
    sessionList.innerHTML = sessions.map(s => {
      const icon = s.status === 'idle' ? '🟢' : s.status === 'working' ? '🟡' : '🔴';
      const active = s.id === currentSessionId ? 'active' : '';
      return '<div class="session-item ' + active + '" data-id="' + s.id + '" data-name="' + s.name + '">'
        + '<span>' + icon + '</span>'
        + '<div class="session-item-info">'
        + '<div class="session-item-name">' + esc(s.name) + '</div>'
        + '<div class="session-item-path">' + esc(s.workdir) + '</div>'
        + '</div></div>';
    }).join('');

    sessionList.querySelectorAll('.session-item').forEach(el => {
      el.onclick = () => {
        attachSession(el.dataset.id, el.dataset.name);
        drawer.classList.add('hidden');
      };
    });
  }

  function attachSession(id, name) {
    if (currentSessionId) {
      send({ type: 'session.detach', id: newId(), sessionId: currentSessionId });
    }
    currentSessionId = id;
    currentSessionName = name;
    sessionName.textContent = name;
    output.innerHTML = '';
    addMessage('system', 'Attached to ' + name);

    send({ type: 'session.attach', id: newId(), sessionId: id });
  }

  // ── Output rendering ─────────────────────────────────────────────
  function addMessage(type, content) {
    const div = document.createElement('div');
    div.className = 'msg msg-' + type;

    // Basic markdown-like rendering for code blocks
    let html = esc(content);
    html = html.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre>$1</pre>');
    html = html.replace(/\`([^\`]+)\`/g, '<code style="background:var(--bg);padding:0.15em 0.4em;border-radius:4px;font-size:0.9em">$1</code>');
    div.innerHTML = html;

    output.appendChild(div);
    output.scrollTop = output.scrollHeight;
  }

  // ── Send message ──────────────────────────────────────────────────
  function sendMessage() {
    const text = promptInput.value.trim();
    if (!text || !currentSessionId) return;

    // Prepend context files if any
    let fullText = text;
    if (contextFiles.length > 0) {
      fullText = 'Context files: ' + contextFiles.join(', ') + '\\n\\n' + text;
      contextFiles = [];
      renderContextChips();
    }

    addMessage('user', text);
    send({ type: 'session.send', id: newId(), sessionId: currentSessionId, text: fullText });
    promptInput.value = '';
    promptInput.style.height = 'auto';
  }

  sendBtn.onclick = sendMessage;
  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize textarea
  promptInput.addEventListener('input', () => {
    promptInput.style.height = 'auto';
    promptInput.style.height = Math.min(promptInput.scrollHeight, 120) + 'px';
  });

  // ── Approvals ─────────────────────────────────────────────────────
  approveBtn.onclick = () => {
    if (!currentSessionId) return;
    send({ type: 'session.approve', id: newId(), sessionId: currentSessionId, approved: true });
    approvalBar.classList.add('hidden');
  };
  denyBtn.onclick = () => {
    if (!currentSessionId) return;
    send({ type: 'session.approve', id: newId(), sessionId: currentSessionId, approved: false });
    approvalBar.classList.add('hidden');
  };

  // ── Drawer ────────────────────────────────────────────────────────
  menuBtn.onclick = () => {
    drawer.classList.toggle('hidden');
    if (!drawer.classList.contains('hidden')) {
      send({ type: 'session.list', id: newId() });
    }
  };

  // ── New session ───────────────────────────────────────────────────
  newSessionBtn.onclick = () => newSessionModal.classList.remove('hidden');
  nsClose.onclick = () => newSessionModal.classList.add('hidden');
  nsCreate.onclick = () => {
    const name = nsName.value.trim();
    const workdir = nsWorkdir.value.trim();
    if (!name || !workdir) return;
    send({ type: 'session.create', id: newId(), name, workdir });
    nsName.value = '';
    nsWorkdir.value = '';
  };

  // ── File browser ──────────────────────────────────────────────────
  filesBtn.onclick = () => {
    if (!currentSessionId) return;
    // Send a message to the agent to list files, then parse the response
    // For now, show a simple input to add file paths manually
    fileModal.classList.remove('hidden');
    filePath.textContent = 'Add files to context';
    fileList.innerHTML =
      '<div style="padding:1rem;color:var(--text-muted);">'
      + '<p>Type a file path and tap + to add it as context for your next message.</p>'
      + '<div style="display:flex;gap:0.5rem;margin-top:0.75rem">'
      + '<input id="file-path-input" placeholder="src/main.ts" style="flex:1" />'
      + '<button id="file-add-btn" class="btn-primary" style="padding:0.5rem 1rem">+</button>'
      + '</div></div>';

    const addBtn = document.getElementById('file-add-btn');
    const pathInput = document.getElementById('file-path-input');
    addBtn.onclick = () => {
      const p = pathInput.value.trim();
      if (p && !contextFiles.includes(p)) {
        contextFiles.push(p);
        renderContextChips();
        pathInput.value = '';
      }
    };
    pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addBtn.click();
    });
  };
  fileClose.onclick = () => fileModal.classList.add('hidden');

  function renderContextChips() {
    contextChips.innerHTML = contextFiles.map((f, i) =>
      '<span class="chip">' + esc(f) + ' <span class="chip-remove" data-idx="' + i + '">✕</span></span>'
    ).join('');
    contextChips.querySelectorAll('.chip-remove').forEach(el => {
      el.onclick = () => {
        contextFiles.splice(parseInt(el.dataset.idx), 1);
        renderContextChips();
      };
    });
  }

  // ── Voice input ───────────────────────────────────────────────────
  let recognition = null;
  if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      promptInput.value += transcript;
      voiceBtn.style.color = '';
    };

    recognition.onend = () => { voiceBtn.style.color = ''; };
  }

  voiceBtn.onclick = () => {
    if (!recognition) {
      alert('Speech recognition not supported in this browser.');
      return;
    }
    voiceBtn.style.color = 'var(--red)';
    recognition.start();
  };

  // ── Helpers ───────────────────────────────────────────────────────
  function esc(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ── Telegram Mini App integration ─────────────────────────────────
  if (window.Telegram && window.Telegram.WebApp) {
    const tg = window.Telegram.WebApp;
    tg.ready();
    tg.expand();
    // Use Telegram's theme
    document.documentElement.style.setProperty('--bg', tg.themeParams.bg_color || '#0a0a0f');
    document.documentElement.style.setProperty('--bg-surface', tg.themeParams.secondary_bg_color || '#141420');
    document.documentElement.style.setProperty('--text', tg.themeParams.text_color || '#e4e4ed');
    document.documentElement.style.setProperty('--accent', tg.themeParams.button_color || '#6366f1');
  }

  // ── Check for stored token ────────────────────────────────────────
  const stored = localStorage.getItem('codeoid_token');
  if (stored) {
    authToken = stored;
    connectWs();
  }
})();
`;
}
