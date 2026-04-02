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

import type { Frontend, FrontendContext } from "../types.js";
import { ALL_SCOPES_STRING } from "../../protocol/scopes.js";

export class WebFrontend implements Frontend {
  readonly name = "web";

  #html: string | null = null;

  async start(ctx: FrontendContext): Promise<void> {
    const wsUrl = `ws://${ctx.host === "0.0.0.0" ? "localhost" : ctx.host}:${ctx.port}`;
    this.#html = buildHtml(wsUrl, ALL_SCOPES_STRING);
  }

  async stop(): Promise<void> {}

  /**
   * Called by Bun.serve() fetch handler. Returns Response or null if not handled.
   */
  async handleFetch(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/app" || path === "/app/" || path.startsWith("/app?")) {
      return new Response(this.#html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    }

    if (path === "/app/manifest.json") {
      return Response.json({
        name: "Codeoid",
        short_name: "Codeoid",
        start_url: "/app",
        display: "standalone",
        background_color: "#0a0a0f",
        theme_color: "#6366f1",
        icons: [],
      });
    }

    return null;
  }
}

// ── HTML builder ──────────────────────────────────────────────────────────────

function buildHtml(wsUrl: string, scopesString: string): string {
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
/* Prose styling for markdown output */
.msg-assistant h1, .msg-assistant h2, .msg-assistant h3, .msg-assistant h4 { font-weight: 700; margin: 0.75rem 0 0.35rem; }
.msg-assistant h1 { font-size: 1.4rem; }
.msg-assistant h2 { font-size: 1.2rem; }
.msg-assistant h3 { font-size: 1.05rem; }
.msg-assistant h4 { font-size: 0.95rem; }
.msg-assistant p { margin: 0.35rem 0; }
.msg-assistant ul, .msg-assistant ol { margin: 0.25rem 0; padding-left: 1.5rem; }
.msg-assistant li { margin: 0.15rem 0; }
.msg-assistant strong { font-weight: 700; }
.msg-assistant em { font-style: italic; }
.msg-assistant a { color: var(--accent); text-decoration: none; }
.msg-assistant a:hover { text-decoration: underline; }
.msg-assistant code {
  background: var(--bg); padding: 0.15em 0.4em; border-radius: 4px;
  font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.9em;
}
.msg-assistant pre {
  background: var(--bg); border-radius: 8px; padding: 0.75rem; overflow-x: auto;
  font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.85rem;
  margin: 0.5rem 0; border: 1px solid var(--border);
}
.msg-assistant pre code { background: none; padding: 0; font-size: inherit; }
.msg-assistant table { width: 100%; border-collapse: collapse; margin: 0.5rem 0; font-size: 0.9rem; }
.msg-assistant th, .msg-assistant td { border: 1px solid var(--border); padding: 0.4rem 0.6rem; text-align: left; }
.msg-assistant th { font-weight: 700; background: var(--bg); }
.msg-assistant blockquote {
  border-left: 3px solid var(--border); padding-left: 0.75rem;
  color: var(--text-muted); margin: 0.5rem 0; font-style: italic;
}
.msg-assistant hr { border: none; border-top: 1px solid var(--border); margin: 0.5rem 0; }
.msg-assistant img { max-width: 100%; border-radius: 8px; }
</style>
<script src="https://cdn.jsdelivr.net/npm/marked@15/marked.min.js"></script>
<script>window._marked = typeof marked !== 'undefined' ? marked : null;</script>
</head>
<body>
<div id="app">
  <!-- Auth screen -->
  <div id="auth-screen" class="screen active">
    <div class="auth-card">
      <div class="logo">⚡ Codeoid</div>
      <p class="subtitle">Identity-first agent control</p>
      <button id="oauth-btn" class="btn-primary">Login with ZeroID</button>
      <div class="divider"><span>or</span></div>
      <input id="auth-input" type="password" placeholder="API key (zid_sk_...)" autocomplete="off" />
      <button id="auth-btn" class="btn-secondary">Connect with API key</button>
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
${JS(wsUrl, scopesString)}
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
.btn-secondary {
  background: var(--bg-elevated); color: var(--text-muted); border: 1px solid var(--border);
  border-radius: 10px; padding: 0.6rem; font-size: 0.9rem; cursor: pointer;
  transition: border-color 0.15s; width: 100%;
}
.btn-secondary:hover { border-color: var(--accent); color: var(--text); }
.divider {
  display: flex; align-items: center; gap: 0.75rem; color: var(--text-muted); font-size: 0.8rem;
}
.divider::before, .divider::after { content: ''; flex: 1; border-top: 1px solid var(--border); }

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
.msg-assistant {
  background: var(--bg-surface); border: 1px solid var(--border);
  margin-right: 10%; border-bottom-left-radius: 4px;
}
.msg-tool_call {
  background: var(--bg-elevated); border: 1px solid var(--border);
  font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.85rem;
  color: var(--text-muted); margin-right: 10%; padding: 0.5rem 0.75rem;
}
.msg-tool_call .tool-icon { color: var(--yellow); }
.msg-tool_result {
  background: var(--bg-elevated); border: 1px solid var(--border);
  font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.85rem;
  color: var(--text-muted); margin-right: 10%;
}
.msg-system {
  text-align: center; color: var(--text-muted); font-size: 0.85rem;
  background: none; padding: 0.5rem;
}
.msg-info {
  color: var(--text-muted); font-size: 0.8rem;
  background: var(--bg-surface); border: 1px solid var(--border); border-radius: 8px;
  padding: 0.4rem 0.75rem; margin-right: 20%;
}
.msg-info .info-summary {
  cursor: pointer; display: flex; align-items: center; gap: 0.35rem;
}
.msg-info .info-summary::before {
  content: '▸'; font-size: 0.7rem; transition: transform 0.15s; display: inline-block;
}
.msg-info.expanded .info-summary::before { transform: rotate(90deg); }
.msg-info .info-detail {
  display: none; margin-top: 0.35rem; padding-top: 0.35rem; border-top: 1px solid var(--border);
  font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.75rem;
  word-break: break-all; color: var(--text-muted); line-height: 1.5;
}
.msg-info.expanded .info-detail { display: block; }
.msg-thinking {
  color: var(--text-muted); font-style: italic; background: none;
  padding: 0.5rem 0.75rem;
}
.thinking-dots span {
  animation: thinkBlink 1.4s infinite both;
  font-size: 1.2em;
}
.thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
.thinking-dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes thinkBlink { 0%, 80%, 100% { opacity: 0.2; } 40% { opacity: 1; } }

/* Identity badge */
.msg-identity {
  font-size: 0.75rem; color: var(--text-muted); margin-bottom: 0.25rem;
  font-weight: 500;
}

/* Tool states */
.tool-state {
  font-size: 0.7rem; padding: 0.1rem 0.4rem; border-radius: 8px;
  text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;
}
.tool-streaming { background: var(--bg); color: var(--yellow); }
.tool-waiting_confirmation { background: var(--red); color: white; }
.tool-executing { background: var(--yellow); color: var(--bg); animation: pulse 1.5s infinite; }
.tool-completed { background: var(--green); color: white; }
.tool-cancelled { background: var(--text-muted); color: var(--bg); }

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

function JS(wsUrl: string, scopesString: string): string {
  return `
(function() {
  'use strict';

  const WS_URL = ${JSON.stringify(wsUrl)};
  const ALL_SCOPES = ${JSON.stringify(scopesString)};
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

  const oauthBtn = $('#oauth-btn');

  // PKCE helper — generate code_verifier and code_challenge (S256)
  async function generatePKCE() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    const verifier = btoa(String.fromCharCode(...array)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
    return { verifier, challenge };
  }

  // OAuth login — redirect to /auth/authorize with PKCE
  oauthBtn.onclick = async () => {
    const { verifier, challenge } = await generatePKCE();
    const state = Math.random().toString(36).slice(2);

    // Store PKCE verifier for callback page
    sessionStorage.setItem('codeoid_pkce_verifier', verifier);
    sessionStorage.setItem('codeoid_pkce_state', state);

    const params = new URLSearchParams({
      client_id: 'codeoid',
      redirect_uri: window.location.origin + '/auth/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: ALL_SCOPES,
      state: state,
    });

    window.location.href = '/auth/authorize?' + params.toString();
  };

  // API key fallback login
  authBtn.onclick = async () => {
    const key = authInput.value.trim();
    if (!key) return;
    authError.textContent = '';
    authBtn.textContent = 'Connecting...';
    authBtn.disabled = true;

    try {
      let token = key;

      if (key.startsWith('zid_sk_')) {
        const resp = await fetch('/auth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ grant_type: 'api_key', api_key: key, scope: ALL_SCOPES })
        });
        if (!resp.ok) throw new Error('Token exchange failed');
        const data = await resp.json();
        token = data.access_token;
      }

      authToken = token;
      localStorage.setItem('codeoid_token', token);
      connectWs();
    } catch (err) {
      authError.textContent = err.message;
      authBtn.textContent = 'Connect with API key';
      authBtn.disabled = false;
    }
  };

  authInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') authBtn.click();
  });

  // ── Logout helper ─────────────────────────────────────────────────
  function logout(message) {
    localStorage.removeItem('codeoid_token');
    localStorage.removeItem('codeoid_refresh_token');
    localStorage.removeItem('codeoid_user_id');
    authToken = null;
    ws = null;
    currentSessionId = null;
    mainScreen.classList.remove('active');
    authScreen.classList.add('active');
    authError.textContent = message || '';
    authBtn.textContent = 'Connect with API key';
    authBtn.disabled = false;
  }

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
        logout('Session expired — please log in again');
      }
    };

    ws.onerror = () => {
      logout('Connection lost — daemon may be down');
    };
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function newId() { return 'msg-' + (++msgIdCounter); }

  // ── v2 Message handler ─────────────────────────────────────────────
  // Track messages by messageId for delta updates
  const messageElements = {};
  let currentIdentity = null;

  function handleMessage(msg) {
    switch (msg.type) {
      case 'auth.ok':
        currentIdentity = msg.identity;
        authScreen.classList.remove('active');
        mainScreen.classList.add('active');
        send({ type: 'session.list', id: newId() });
        break;

      case 'session.list.result':
        sessions = msg.sessions;
        renderSessions();
        break;

      case 'response.ok':
        if (msg.data && msg.data.id && msg.data.name && msg.data.workdir) {
          sessions.push(msg.data);
          renderSessions();
          attachSession(msg.data.id, msg.data.name);
          newSessionModal.classList.add('hidden');
        }
        break;

      case 'response.error':
        addMessage({ role: 'system', content: msg.error, identity: { name: 'Codeoid', type: 'system' } });
        break;

      case 'session.message':
        if (msg.sessionId !== currentSessionId) break;
        // Skip user messages we sent locally (avoid duplicate)
        if (msg.role === 'user' && msg.identity && currentIdentity && msg.identity.sub === currentIdentity.sub) break;

        handleSessionMessage(msg);
        break;

      case 'session.message.delta':
        if (msg.sessionId !== currentSessionId) break;
        handleDelta(msg);
        break;

      case 'scrollback.replay':
        if (msg.sessionId === currentSessionId && msg.messages) {
          for (const m of msg.messages) {
            handleSessionMessage(m);
          }
        }
        break;

      case 'session.status_change':
        if (msg.sessionId === currentSessionId) {
          sessionStatus.className = 'status-dot ' + msg.status;
          if (msg.status === 'idle' || msg.status === 'error') {
            approvalBar.classList.add('hidden');
            removeThinking();
          }
        }
        const s = sessions.find(function(s) { return s.id === msg.sessionId; });
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
    if (currentSessionId === id) return; // Already attached
    if (currentSessionId) {
      send({ type: 'session.detach', id: newId(), sessionId: currentSessionId });
    }
    currentSessionId = id;
    currentSessionName = name;
    sessionName.textContent = name;
    output.innerHTML = '';
    addMessage({ role: 'info', content: 'Attached to ' + name, identity: { name: 'Codeoid', type: 'system' } });
    send({ type: 'session.attach', id: newId(), sessionId: id });
  }

  // ── v2 Session message handler ────────────────────────────────────
  function handleSessionMessage(msg) {
    if (!msg || !msg.role) return;

    // Tool calls in waiting_confirmation → show approval bar
    if (msg.role === 'tool_call' && msg.tool && msg.tool.state) {
      if (msg.tool.state.phase === 'waiting_confirmation') {
        approvalInfo.textContent = msg.tool.state.description || msg.content;
        approvalBar.classList.remove('hidden');
        approvalBar.dataset.approvalId = msg.tool.state.approvalId || '';
      }
    }

    // Remove thinking indicator when we get substantive content
    if (msg.role === 'assistant' || msg.role === 'tool_call') {
      removeThinking();
    }

    addMessage(msg);
  }

  function handleDelta(delta) {
    const el = messageElements[delta.messageId];
    if (!el) return;

    // Append text content
    if (delta.contentAppend) {
      const contentEl = el.querySelector('.msg-content');
      if (contentEl) {
        // For assistant: re-render markdown with appended text
        el._fullContent = (el._fullContent || '') + delta.contentAppend;
        if (el._role === 'assistant' && window._marked) {
          contentEl.innerHTML = window._marked.parse(el._fullContent, { breaks: true, gfm: true });
        } else {
          contentEl.textContent = el._fullContent;
        }
        output.scrollTop = output.scrollHeight;
      }
    }

    // Update tool state
    if (delta.toolStateUpdate) {
      const stateEl = el.querySelector('.tool-state');
      if (stateEl) {
        stateEl.className = 'tool-state tool-' + delta.toolStateUpdate.phase;
        stateEl.textContent = delta.toolStateUpdate.phase;
      }
      // Hide approval bar if tool moved past confirmation
      if (delta.toolStateUpdate.phase !== 'waiting_confirmation') {
        approvalBar.classList.add('hidden');
      }
    }
  }

  function removeThinking() {
    const thinking = output.querySelector('.msg-thinking');
    if (thinking) thinking.remove();
  }

  // ── Render a SessionMessage ───────────────────────────────────────
  function addMessage(msg) {
    const div = document.createElement('div');
    const role = msg.role || 'system';
    div.className = 'msg msg-' + role;

    // Identity badge
    if (msg.identity && msg.identity.name && role !== 'system' && role !== 'info') {
      const badge = document.createElement('div');
      badge.className = 'msg-identity';
      const typeIcon = { human: '👤', agent: '🤖', subagent: '🔧', system: '⚙️' }[msg.identity.type] || '';
      badge.textContent = typeIcon + ' ' + msg.identity.name;
      div.appendChild(badge);
    }

    // Content
    const contentDiv = document.createElement('div');
    contentDiv.className = 'msg-content';

    switch (role) {
      case 'user':
        contentDiv.textContent = msg.content;
        break;

      case 'assistant':
        if (window._marked) {
          contentDiv.innerHTML = window._marked.parse(msg.content, { breaks: true, gfm: true });
        } else {
          contentDiv.textContent = msg.content;
        }
        break;

      case 'thinking':
        contentDiv.innerHTML = '<span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span> ' + esc(msg.content);
        break;

      case 'tool_call': {
        const toolName = (msg.tool && msg.tool.name) || msg.content;
        const phase = (msg.tool && msg.tool.state && msg.tool.state.phase) || 'executing';
        contentDiv.innerHTML = '<span class="tool-icon">⚡</span> ' + esc(toolName)
          + ' <span class="tool-state tool-' + phase + '">' + phase + '</span>';
        break;
      }

      case 'tool_result':
        contentDiv.textContent = msg.content;
        break;

      case 'system':
        contentDiv.textContent = msg.content;
        break;

      case 'info': {
        const meta = msg.metadata || {};
        const hasDetail = meta.agentUri || meta.subagentUri || meta.event;

        if (hasDetail) {
          const summary = document.createElement('div');
          summary.className = 'info-summary';
          summary.textContent = msg.content;
          summary.onclick = function() { div.classList.toggle('expanded'); };
          contentDiv.appendChild(summary);

          const detail = document.createElement('div');
          detail.className = 'info-detail';
          const lines = [];
          if (meta.event) lines.push('event: ' + meta.event);
          if (meta.agentUri) lines.push('identity: ' + meta.agentUri);
          if (meta.subagentUri) lines.push('sub-agent: ' + meta.subagentUri);
          // Show all metadata keys
          for (const [k, v] of Object.entries(meta)) {
            if (!['event','agentUri','subagentUri'].includes(k)) {
              lines.push(k + ': ' + v);
            }
          }
          detail.innerHTML = lines.map(function(l) { return esc(l); }).join('<br>');
          contentDiv.appendChild(detail);
        } else {
          contentDiv.textContent = msg.content;
        }
        break;
      }

      default:
        contentDiv.textContent = msg.content;
    }

    div.appendChild(contentDiv);

    // Track for delta updates
    if (msg.messageId) {
      div.id = 'msg-' + msg.messageId;
      div._fullContent = msg.content;
      div._role = role;
      messageElements[msg.messageId] = div;
    }

    output.appendChild(div);
    output.scrollTop = output.scrollHeight;
  }

  // ── Send message ──────────────────────────────────────────────────
  function sendMessage() {
    const text = promptInput.value.trim();
    if (!text || !currentSessionId) return;

    let fullText = text;
    if (contextFiles.length > 0) {
      fullText = 'Context files: ' + contextFiles.join(', ') + '\\n\\n' + text;
      contextFiles = [];
      renderContextChips();
    }

    // Local echo as user message
    addMessage({
      role: 'user',
      content: text,
      identity: currentIdentity || { name: 'You', type: 'human' },
    });
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
    send({ type: 'session.approve', id: newId(), sessionId: currentSessionId, approvalId: approvalBar.dataset.approvalId || '', approved: true });
    approvalBar.classList.add('hidden');
  };
  denyBtn.onclick = () => {
    if (!currentSessionId) return;
    send({ type: 'session.approve', id: newId(), sessionId: currentSessionId, approvalId: approvalBar.dataset.approvalId || '', approved: false });
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
