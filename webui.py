"""
Minimal Flask web UI for browsing claude-corner sibling runs.

Serves a dark-mode HTML page that lists each sibling (claude-<uuid>), expands
to show its sessions, and lazily loads parsed messages from each session's
jsonl transcript when expanded.

Usage:
    from webui import start_webui
    start_webui(port=8765, runs_dir=Path("runs"), statusline_last=Path("statusline.last"))
"""
from __future__ import annotations
import json
import os
import threading
from pathlib import Path

from flask import Flask, jsonify, render_template_string

HOME = os.environ["HOME"]
PROJECTS = Path(HOME) / ".claude" / "projects"

INDEX_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>claude-corner</title>
  <style>
    :root {
      --bg: #1a1b26; --fg: #c0caf5; --fg-dim: #565f89;
      --accent: #7aa2f7; --accent2: #bb9af7;
      --bg2: #24283b; --bg3: #2f334d;
      --user: #9ece6a; --assistant: #7dcfff;
      --tool: #e0af68; --result: #ad8ee6;
      --thinking: #7e87a3;
    }
    * { box-sizing: border-box; }
    body {
      background: var(--bg); color: var(--fg);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, sans-serif;
      margin: 0; padding: 1rem; font-size: 14px; line-height: 1.5;
    }
    h1 { color: var(--accent); font-weight: 400; margin: 0 0 0.5rem; font-size: 1.5rem; }
    .topbar { display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem; flex-wrap: wrap; }
    .status-bar {
      background: var(--bg2); padding: 0.4rem 0.9rem; border-radius: 4px;
      font-family: ui-monospace, Menlo, Consolas, monospace; color: var(--fg-dim);
      font-size: 0.9rem; flex: 1; min-width: 0;
    }
    .refresh {
      background: var(--bg3); color: var(--fg); border: 1px solid var(--fg-dim);
      border-radius: 3px; padding: 0.3rem 0.8rem; cursor: pointer;
      font-family: inherit; font-size: 0.85rem;
    }
    .refresh:hover { background: var(--accent); color: var(--bg); border-color: var(--accent); }
    .sibling {
      background: var(--bg2); margin-bottom: 0.5rem; border-radius: 4px; overflow: hidden;
    }
    .sibling-header {
      padding: 0.55rem 1rem; cursor: pointer; display: flex; justify-content: space-between; gap: 1rem;
      user-select: none;
    }
    .sibling-header:hover { background: var(--bg3); }
    .sibling-name { color: var(--accent2); font-family: ui-monospace, Menlo, Consolas, monospace; }
    .sibling-meta { color: var(--fg-dim); font-size: 0.85rem; }
    .sibling-body { display: none; padding: 0.3rem 0.9rem 0.6rem; }
    .sibling.open .sibling-body { display: block; }
    .arrow {
      display: inline-block; transition: transform 0.15s; margin-right: 0.4rem; color: var(--fg-dim);
    }
    .open > .sibling-header .arrow, .open > .session-header .arrow { transform: rotate(90deg); }
    .session {
      margin: 0.3rem 0; background: var(--bg3); border-radius: 3px; overflow: hidden;
    }
    .session-header {
      padding: 0.35rem 0.8rem; cursor: pointer;
      font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.82rem;
      user-select: none; display: flex; justify-content: space-between; gap: 1rem;
    }
    .session-header:hover { background: rgba(255,255,255,0.05); }
    .session-id { color: var(--fg); }
    .session-meta { color: var(--fg-dim); }
    .session-body { display: none; padding: 0.5rem 1rem 0.7rem; background: var(--bg); }
    .session.open .session-body { display: block; }
    .msg {
      margin: 0.5rem 0; padding: 0.4rem 0.7rem;
      border-left: 2px solid var(--fg-dim); border-radius: 0 4px 4px 0;
    }
    .msg-user { border-left-color: var(--user); }
    .msg-assistant { border-left-color: var(--assistant); }
    .msg-role {
      color: var(--fg-dim); font-size: 0.72rem;
      text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.3rem;
    }
    .msg-text { white-space: pre-wrap; word-wrap: break-word; }
    .block-tool {
      background: rgba(224, 175, 104, 0.08); border-left: 2px solid var(--tool);
      padding: 0.35rem 0.65rem; margin: 0.35rem 0;
      font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.83rem;
      border-radius: 2px;
    }
    .block-tool-name { color: var(--tool); font-weight: 600; margin-bottom: 0.2rem; }
    .block-tool-input { color: var(--fg); white-space: pre-wrap; word-wrap: break-word; }
    .tool-path {
      color: var(--accent2); font-size: 0.8rem; margin-bottom: 0.3rem;
      word-break: break-all;
    }
    .tool-section-label {
      color: var(--fg-dim); font-size: 0.72rem; text-transform: uppercase;
      letter-spacing: 0.05em; margin-top: 0.4rem;
    }
    .tool-text-old, .tool-text-new, .tool-content {
      white-space: pre-wrap; word-wrap: break-word;
      padding: 0.3rem 0.5rem; margin-top: 0.15rem;
      border-radius: 2px; max-height: 360px; overflow: auto;
    }
    .tool-text-old { background: rgba(247, 118, 142, 0.08); border-left: 2px solid #f7768e; }
    .tool-text-new { background: rgba(158, 206, 106, 0.08); border-left: 2px solid var(--user); }
    .tool-content { background: rgba(125, 207, 255, 0.06); border-left: 2px solid var(--assistant); }
    .diff-block {
      font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.83rem;
      background: rgba(255,255,255,0.02);
      padding: 0.3rem 0; border-radius: 2px;
      max-height: 420px; overflow: auto;
      margin-top: 0.15rem;
    }
    .diff-row {
      padding: 0 0.5rem; white-space: pre-wrap; word-wrap: break-word;
      display: flex; min-height: 1.2em;
    }
    .diff-prefix {
      color: var(--fg-dim); user-select: none;
      flex-shrink: 0; width: 1.4em;
    }
    .diff-content { flex: 1; min-width: 0; }
    .diff-add { background: rgba(158, 206, 106, 0.10); }
    .diff-add .diff-prefix { color: var(--user); }
    .diff-del { background: rgba(247, 118, 142, 0.10); }
    .diff-del .diff-prefix { color: #f7768e; }
    .tool-cmd {
      color: var(--fg); white-space: pre-wrap; word-wrap: break-word;
      padding: 0.2rem 0.4rem; background: rgba(255,255,255,0.04);
      border-radius: 2px;
    }
    .tool-cmd-prefix { color: var(--fg-dim); user-select: none; }
    .tool-desc { color: var(--fg-dim); font-style: italic; margin-top: 0.2rem; font-size: 0.8rem; }
    .tool-flag { color: var(--fg-dim); font-size: 0.75rem; margin-top: 0.3rem; }
    .block-result {
      background: rgba(173, 142, 230, 0.06); border-left: 2px solid var(--result);
      padding: 0.35rem 0.65rem; margin: 0.35rem 0;
      font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.83rem;
      max-height: 240px; overflow: auto;
      white-space: pre-wrap; word-wrap: break-word; border-radius: 2px;
    }
    .block-result-label { color: var(--result); font-size: 0.75rem; margin-bottom: 0.2rem; }
    .block-thinking {
      color: var(--thinking); font-style: italic; padding: 0.3rem 0.6rem;
      font-size: 0.88rem; white-space: pre-wrap; word-wrap: break-word;
    }
    .loading { color: var(--fg-dim); font-style: italic; padding: 0.5rem; }
    .empty { color: var(--fg-dim); font-style: italic; padding: 1rem; text-align: center; }
  </style>
</head>
<body>
  <div class="topbar">
    <h1>claude-corner</h1>
    <div id="status" class="status-bar">loading...</div>
    <button class="refresh" onclick="refreshAll()">↻ refresh</button>
  </div>
  <div id="content"><div class="loading">loading siblings...</div></div>

<script>
const expanded = { siblings: new Set(), sessions: new Set() };
const loadedSessions = new Map();

function fmtTime(ts) {
  if (!ts) return '?';
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function refreshStatus() {
  try {
    const r = await fetch('/api/status');
    const s = await r.json();
    document.getElementById('status').textContent = s.statusline || '(no rate-limit data yet)';
  } catch (e) {
    document.getElementById('status').textContent = 'status error: ' + e.message;
  }
}

async function refreshSiblings() {
  try {
    const r = await fetch('/api/siblings');
    const siblings = await r.json();
    renderSiblings(siblings);
  } catch (e) {
    document.getElementById('content').textContent = 'error: ' + e.message;
  }
}

function refreshAll() {
  refreshStatus();
  refreshSiblings();
}

function renderSiblings(siblings) {
  const content = document.getElementById('content');
  content.innerHTML = '';
  if (siblings.length === 0) {
    content.innerHTML = '<div class="empty">no siblings yet — waiting for spin.py to spawn one</div>';
    return;
  }
  for (const s of siblings) {
    const el = document.createElement('div');
    el.className = 'sibling' + (expanded.siblings.has(s.name) ? ' open' : '');
    const sessCount = s.sessions.length;
    el.innerHTML = `
      <div class="sibling-header">
        <div><span class="arrow">▶</span><span class="sibling-name">${s.name}</span></div>
        <div class="sibling-meta">${sessCount} session${sessCount === 1 ? '' : 's'} · ${fmtTime(s.mtime)}</div>
      </div>
      <div class="sibling-body"></div>
    `;
    const header = el.querySelector('.sibling-header');
    const body = el.querySelector('.sibling-body');
    header.addEventListener('click', () => {
      el.classList.toggle('open');
      if (el.classList.contains('open')) expanded.siblings.add(s.name);
      else expanded.siblings.delete(s.name);
    });
    for (const sess of s.sessions) {
      body.appendChild(renderSessionRow(s.name, sess));
    }
    if (sessCount === 0) {
      body.innerHTML = '<div class="empty" style="padding:0.5rem">no sessions recorded yet</div>';
    }
    content.appendChild(el);
  }
}

function renderSessionRow(sibling, sess) {
  const key = `${sibling}/${sess.id}`;
  const el = document.createElement('div');
  el.className = 'session' + (expanded.sessions.has(key) ? ' open' : '');
  el.innerHTML = `
    <div class="session-header">
      <div><span class="arrow">▶</span><span class="session-id">${sess.id.slice(0, 8)}</span></div>
      <div class="session-meta">${fmtTime(sess.mtime)}</div>
    </div>
    <div class="session-body"></div>
  `;
  const header = el.querySelector('.session-header');
  const body = el.querySelector('.session-body');

  const loadIntoBody = async () => {
    if (loadedSessions.has(key)) {
      body.innerHTML = '';
      for (const m of loadedSessions.get(key)) body.appendChild(renderMessage(m));
      return;
    }
    body.innerHTML = '<div class="loading">loading transcript...</div>';
    try {
      const r = await fetch(`/api/session/${sibling}/${sess.id}`);
      const events = await r.json();
      loadedSessions.set(key, events);
      body.innerHTML = '';
      if (events.length === 0) {
        body.innerHTML = '<div class="empty">(no messages)</div>';
      } else {
        for (const m of events) body.appendChild(renderMessage(m));
      }
    } catch (e) {
      body.innerHTML = '<div class="loading">error: ' + e.message + '</div>';
    }
  };

  header.addEventListener('click', () => {
    el.classList.toggle('open');
    if (el.classList.contains('open')) {
      expanded.sessions.add(key);
      loadIntoBody();
    } else {
      expanded.sessions.delete(key);
    }
  });

  if (el.classList.contains('open')) loadIntoBody();
  return el;
}

function renderMessage(ev) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-' + ev.role;
  const role = document.createElement('div');
  role.className = 'msg-role';
  role.textContent = ev.role;
  wrap.appendChild(role);
  for (const b of ev.blocks) wrap.appendChild(renderBlock(b));
  return wrap;
}

function div(cls, text) {
  const e = document.createElement('div');
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// LCS-based line diff. Returns [{t: ' '|'+'|'-', l: line}, ...].
function diffLines(oldText, newText) {
  const a = (oldText || '').split('\n');
  const b = (newText || '').split('\n');
  const m = a.length, n = b.length;
  // dp[i][j] = length of LCS of a[i:], b[j:]
  const dp = [];
  for (let i = 0; i <= m; i++) dp.push(new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = (a[i] === b[j])
        ? dp[i+1][j+1] + 1
        : Math.max(dp[i+1][j], dp[i][j+1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j])          { out.push({t: ' ', l: a[i]}); i++; j++; }
    else if (dp[i+1][j] >= dp[i][j+1]) { out.push({t: '-', l: a[i++]}); }
    else                                { out.push({t: '+', l: b[j++]}); }
  }
  while (i < m) out.push({t: '-', l: a[i++]});
  while (j < n) out.push({t: '+', l: b[j++]});
  return out;
}

function renderDiff(oldText, newText) {
  const wrap = div('diff-block');
  const rows = diffLines(oldText, newText);
  if (rows.length === 0) {
    wrap.appendChild(div('diff-row', '(no change)'));
    return wrap;
  }
  for (const r of rows) {
    const row = div('diff-row diff-' + ({'+':'add','-':'del',' ':'same'}[r.t]));
    const p = document.createElement('span');
    p.className = 'diff-prefix';
    p.textContent = r.t === ' ' ? '  ' : r.t + ' ';
    const c = document.createElement('span');
    c.className = 'diff-content';
    c.textContent = r.l;
    row.appendChild(p);
    row.appendChild(c);
    wrap.appendChild(row);
  }
  return wrap;
}

function renderToolUse(b) {
  const wrap = div('block-tool');
  wrap.appendChild(div('block-tool-name', '▸ ' + b.name));
  const inp = b.input || {};
  const body = div('block-tool-input');

  if (b.name === 'Edit' || b.name === 'MultiEdit' || b.name === 'NotebookEdit') {
    if (inp.file_path) wrap.appendChild(div('tool-path', inp.file_path));
    if (inp.old_string !== undefined) {
      body.appendChild(renderDiff(inp.old_string, inp.new_string || ''));
    } else if (inp.edits) {
      inp.edits.forEach((ed, i) => {
        body.appendChild(div('tool-section-label', `edit ${i+1}`));
        body.appendChild(renderDiff(ed.old_string || '', ed.new_string || ''));
      });
    }
    const extras = [];
    if (inp.replace_all) extras.push('replace_all');
    Object.keys(inp).forEach(k => {
      if (!['file_path','old_string','new_string','replace_all','edits'].includes(k))
        extras.push(`${k}=${JSON.stringify(inp[k])}`);
    });
    if (extras.length) body.appendChild(div('tool-flag', '(' + extras.join(', ') + ')'));
  } else if (b.name === 'Write') {
    if (inp.file_path) wrap.appendChild(div('tool-path', 'write → ' + inp.file_path));
    body.appendChild(div('tool-content', inp.content || ''));
  } else if (b.name === 'Bash') {
    const cmdRow = div('tool-cmd');
    const prefix = document.createElement('span');
    prefix.className = 'tool-cmd-prefix';
    prefix.textContent = '$ ';
    cmdRow.appendChild(prefix);
    cmdRow.appendChild(document.createTextNode(inp.command || ''));
    body.appendChild(cmdRow);
    if (inp.description) body.appendChild(div('tool-desc', inp.description));
    if (inp.run_in_background) body.appendChild(div('tool-flag', '(background)'));
    if (inp.timeout) body.appendChild(div('tool-flag', `(timeout=${inp.timeout}ms)`));
  } else if (b.name === 'Read') {
    let txt = 'read ' + (inp.file_path || '?');
    if (inp.offset || inp.limit) txt += ` (offset=${inp.offset || 0}, limit=${inp.limit || 'all'})`;
    body.appendChild(div('tool-cmd', txt));
  } else if (b.name === 'Glob' || b.name === 'Grep') {
    const cmdRow = div('tool-cmd');
    const summary = b.name + ': ' + (inp.pattern || inp.path || '?');
    cmdRow.textContent = summary;
    body.appendChild(cmdRow);
    Object.keys(inp).forEach(k => {
      if (!['pattern'].includes(k)) {
        body.appendChild(div('tool-desc', `${k}: ${JSON.stringify(inp[k])}`));
      }
    });
  } else if (b.name === 'TodoWrite') {
    if (Array.isArray(inp.todos)) {
      inp.todos.forEach(t => {
        const status = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '→' : '○';
        body.appendChild(div('tool-cmd', `${status} ${t.content || t.activeForm || ''}`));
      });
    } else {
      body.appendChild(div('tool-content', JSON.stringify(inp, null, 2)));
    }
  } else {
    body.appendChild(div('tool-content', JSON.stringify(inp, null, 2)));
  }
  wrap.appendChild(body);
  return wrap;
}

function renderBlock(b) {
  if (b.type === 'text') return div('msg-text', b.text);
  if (b.type === 'tool_use') return renderToolUse(b);
  if (b.type === 'tool_result') {
    const el = div('block-result');
    el.appendChild(div('block-result-label', '⇒ result'));
    el.appendChild(div(null, b.content));
    return el;
  }
  if (b.type === 'thinking') return div('block-thinking', '✧ ' + b.text);
  return div('msg-text', '[' + b.type + ']');
}

refreshAll();
setInterval(refreshStatus, 15000);  // statusline refresh in place
</script>
</body>
</html>
"""


def _sanitize(p: Path) -> str:
    """Mirror Claude Code's path-sanitizer: absolute path with / replaced by -."""
    return str(p.resolve()).replace("/", "-")


def _find_sessions(work_dir: Path) -> list[dict]:
    proj_dir = PROJECTS / _sanitize(work_dir)
    if not proj_dir.exists():
        return []
    sessions = []
    for f in proj_dir.glob("*.jsonl"):
        try:
            st = f.stat()
        except OSError:
            continue
        sessions.append({
            "id": f.stem,
            "mtime": st.st_mtime,
            "size": st.st_size,
        })
    sessions.sort(key=lambda s: s["mtime"])
    return sessions


def _simplify_event(evt: dict) -> dict | None:
    """Convert a raw jsonl event into a UI-friendly message, or None to skip."""
    t = evt.get("type")
    if t not in ("user", "assistant"):
        return None
    msg = evt.get("message", {}) or {}
    role = msg.get("role", t)
    content = msg.get("content", [])
    blocks: list[dict] = []
    if isinstance(content, str):
        if content.strip():
            blocks.append({"type": "text", "text": content})
    elif isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype == "text":
                txt = block.get("text", "")
                if txt:
                    blocks.append({"type": "text", "text": txt})
            elif btype == "tool_use":
                blocks.append({
                    "type": "tool_use",
                    "name": block.get("name", "?"),
                    "input": block.get("input", {}),
                })
            elif btype == "tool_result":
                rc = block.get("content", "")
                if isinstance(rc, list):
                    rc = "\n".join(
                        c.get("text", "") for c in rc
                        if isinstance(c, dict) and c.get("type") == "text"
                    )
                blocks.append({"type": "tool_result", "content": str(rc)})
            elif btype == "thinking":
                txt = block.get("thinking", "")
                if txt:
                    blocks.append({"type": "thinking", "text": txt})
    if not blocks:
        return None
    return {"role": role, "blocks": blocks, "timestamp": evt.get("timestamp")}


def _parse_session(jsonl_path: Path) -> list[dict]:
    events: list[dict] = []
    try:
        for line in jsonl_path.read_text(errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                raw = json.loads(line)
            except json.JSONDecodeError:
                continue
            simp = _simplify_event(raw)
            if simp is not None:
                events.append(simp)
    except OSError:
        pass
    return events


def make_app(runs_dir: Path, statusline_last: Path) -> Flask:
    app = Flask(__name__)

    @app.route("/")
    def index():
        return render_template_string(INDEX_HTML)

    @app.route("/api/siblings")
    def api_siblings():
        result = []
        if runs_dir.exists():
            for d in runs_dir.iterdir():
                if not d.is_dir() or not d.name.startswith("claude-"):
                    continue
                try:
                    mtime = d.stat().st_mtime
                except OSError:
                    continue
                sessions = _find_sessions(d / "work")
                result.append({
                    "name": d.name,
                    "mtime": mtime,
                    "sessions": sessions,
                })
        result.sort(key=lambda s: s["mtime"], reverse=True)
        return jsonify(result)

    @app.route("/api/session/<sibling>/<session_id>")
    def api_session(sibling, session_id):
        # Defend against path traversal: enforce expected shape.
        if not sibling.startswith("claude-") or "/" in session_id or ".." in session_id:
            return jsonify({"error": "bad path"}), 400
        work_dir = runs_dir / sibling / "work"
        proj_dir = PROJECTS / _sanitize(work_dir)
        jsonl = proj_dir / f"{session_id}.jsonl"
        if not jsonl.exists():
            return jsonify({"error": "session not found"}), 404
        return jsonify(_parse_session(jsonl))

    @app.route("/api/status")
    def api_status():
        if statusline_last.exists():
            try:
                text = statusline_last.read_text().strip()
                age = int(__import__("time").time() - statusline_last.stat().st_mtime)
                return jsonify({"statusline": text, "age_sec": age})
            except OSError:
                pass
        return jsonify({"statusline": None})

    return app


def start_webui(port: int, runs_dir: Path, statusline_last: Path) -> threading.Thread:
    """Start the Flask app in a daemon thread."""
    app = make_app(runs_dir, statusline_last)
    # Silence Flask's request log
    import logging
    logging.getLogger("werkzeug").setLevel(logging.WARNING)

    def _serve():
        app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False, threaded=True)

    t = threading.Thread(target=_serve, daemon=True)
    t.start()
    return t
