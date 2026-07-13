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
import re
import threading
from pathlib import Path

from flask import Flask, Response, abort, jsonify, render_template_string, request, send_file

import board

HOME = os.environ["HOME"]
PROJECTS = Path(HOME) / ".claude" / "projects"

# Shared transcript-rendering helpers, served at /render.js and loaded by both the
# main page and the /active grid so there's a single copy of the message renderer.
RENDER_JS = r"""
function fmtTime(ts) {
  if (!ts) return '?';
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function renderMarkdown(text) {
  try {
    if (window.marked && marked.parse) return marked.parse(text || '');
  } catch (e) { /* fall through */ }
  return '<pre>' + escapeHtml(text || '') + '</pre>';
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
"""

INDEX_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>claude-corner</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/styles/tokyo-night-dark.min.css">
  <script src="https://cdn.jsdelivr.net/npm/marked@11/marked.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/highlight.min.js"></script>
  <script src="/render.js"></script>
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
    .refresh, .btn {
      background: var(--bg3); color: var(--fg); border: 1px solid var(--fg-dim);
      border-radius: 3px; padding: 0.3rem 0.8rem; cursor: pointer;
      font-family: inherit; font-size: 0.85rem;
    }
    .refresh:hover, .btn:hover { background: var(--accent); color: var(--bg); border-color: var(--accent); }
    .btn-stop:hover { background: #f7768e; border-color: #f7768e; color: var(--bg); }
    .btn-start:hover { background: var(--user); border-color: var(--user); color: var(--bg); }
    .pill {
      padding: 0.25rem 0.7rem; border-radius: 12px; font-size: 0.78rem;
      font-family: ui-monospace, Menlo, Consolas, monospace;
      border: 1px solid transparent;
    }
    .pill-running { background: rgba(158, 206, 106, 0.15); color: var(--user); border-color: rgba(158, 206, 106, 0.3); }
    .pill-paused { background: rgba(224, 175, 104, 0.15); color: var(--tool); border-color: rgba(224, 175, 104, 0.3); }
    .pill-down { background: rgba(247, 118, 142, 0.15); color: #f7768e; border-color: rgba(247, 118, 142, 0.3); }
    .controlbar {
      display: flex; gap: 1rem; flex-wrap: wrap; align-items: center;
      background: var(--bg2); padding: 0.5rem 0.9rem; border-radius: 4px;
      margin-bottom: 1rem; font-size: 0.85rem;
    }
    .controlbar label { color: var(--fg-dim); }
    .controlbar input[type=number] {
      background: var(--bg3); color: var(--fg); border: 1px solid var(--fg-dim);
      border-radius: 3px; padding: 0.25rem 0.5rem; width: 5em;
      font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.85rem;
    }
    .controlbar input[type=text] {
      background: var(--bg3); color: var(--fg); border: 1px solid var(--fg-dim);
      border-radius: 3px; padding: 0.25rem 0.5rem;
      font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.85rem;
    }
    .controlbar input[type=text]:focus { outline: 1px solid var(--accent); border-color: var(--accent); }
    .tabbar {
      display: flex; gap: 0.3rem; flex-wrap: wrap; align-items: center;
      margin-bottom: 0.8rem; border-bottom: 1px solid var(--bg3); padding-bottom: 0.4rem;
    }
    .tab {
      background: var(--bg2); color: var(--fg-dim); border: 1px solid transparent;
      border-radius: 6px 6px 0 0; padding: 0.35rem 0.9rem; cursor: pointer;
      font-size: 0.85rem; display: flex; align-items: center; gap: 0.45rem;
    }
    .tab:hover { background: var(--bg3); color: var(--fg); }
    .tab.active { background: var(--bg3); color: var(--accent); border-color: var(--fg-dim); }
    .tab-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--fg-dim); flex: none; }
    .tab-dot.on { background: var(--user); box-shadow: 0 0 5px var(--user); }
    .tab-kind { font-size: 0.68rem; color: var(--fg-dim); opacity: 0.8; }
    .tab-add {
      background: transparent; color: var(--fg-dim); border: 1px dashed var(--fg-dim);
      border-radius: 6px; padding: 0.35rem 0.7rem; cursor: pointer; font-size: 0.85rem;
    }
    .tab-add:hover { color: var(--accent); border-color: var(--accent); }
    .lane-panel { margin-bottom: 1rem; }
    /* --- task board (kanban) --- */
    .board-wrap { margin-bottom: 1.2rem; }
    .board-head {
      display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.5rem;
      color: var(--fg-dim); font-size: 0.85rem;
    }
    .board-head .board-title { color: var(--accent2); font-size: 0.95rem; }
    .board-cols { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.7rem; align-items: start; }
    @media (max-width: 780px) { .board-cols { grid-template-columns: 1fr; } }
    .board-col { background: var(--bg2); border-radius: 6px; padding: 0.5rem; min-height: 3rem; }
    .board-col-head {
      display: flex; align-items: center; justify-content: space-between;
      font-size: 0.78rem; color: var(--fg-dim); text-transform: uppercase;
      letter-spacing: 0.04em; padding: 0.1rem 0.3rem 0.45rem; font-weight: 600;
    }
    .board-col-count { color: var(--fg-dim); opacity: 0.7; font-weight: 400; }
    .board-col.col-todo .board-col-head { color: var(--tool); }
    .board-col.col-in_progress .board-col-head { color: var(--assistant); }
    .board-col.col-done .board-col-head { color: var(--user); }
    .board-card {
      background: var(--bg3); border: 1px solid transparent; border-left: 3px solid var(--fg-dim);
      border-radius: 4px; padding: 0.45rem 0.55rem; margin-bottom: 0.45rem; cursor: pointer;
    }
    .board-card:hover { border-color: var(--fg-dim); }
    .board-card.col-todo { border-left-color: var(--tool); }
    .board-card.col-in_progress { border-left-color: var(--assistant); }
    .board-card.col-done { border-left-color: var(--user); }
    .board-card-title { font-size: 0.88rem; color: var(--fg); }
    .board-card.col-done .board-card-title { color: var(--fg-dim); }
    .board-card-meta {
      font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.68rem;
      color: var(--fg-dim); margin-top: 0.25rem; display: flex; gap: 0.5rem; flex-wrap: wrap;
    }
    .board-card-who { color: var(--accent); }
    .board-card-body {
      display: none; margin-top: 0.5rem; padding-top: 0.5rem;
      border-top: 1px solid var(--bg2); font-size: 0.82rem;
    }
    .board-card.open .board-card-body { display: block; }
    .board-card-body .md { color: var(--fg); overflow-wrap: anywhere; }
    .board-card-body .md h1, .board-card-body .md h2, .board-card-body .md h3 {
      font-size: 0.82rem; color: var(--accent2); margin: 0.6rem 0 0.2rem; font-weight: 600;
    }
    .board-card-body .md pre {
      background: var(--bg); padding: 0.4rem 0.6rem; border-radius: 4px; overflow-x: auto;
    }
    .board-card-body .md code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.9em; }
    .board-card-actions { display: flex; gap: 0.3rem; flex-wrap: wrap; margin-top: 0.55rem; }
    .board-card-actions .btn { padding: 0.15rem 0.5rem; font-size: 0.72rem; }
    .board-raw-edit {
      display: none; width: 100%; margin-top: 0.5rem; min-height: 12em; resize: vertical;
      background: var(--bg); color: var(--fg); border: 1px solid var(--fg-dim); border-radius: 4px;
      padding: 0.5rem; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.78rem;
    }
    .board-card.editing .board-raw-edit { display: block; }
    .board-card.editing .md { display: none; }
    .board-add {
      width: 100%; background: transparent; color: var(--fg-dim); border: 1px dashed var(--fg-dim);
      border-radius: 4px; padding: 0.3rem; cursor: pointer; font-size: 0.8rem; font-family: inherit;
    }
    .board-add:hover { color: var(--accent); border-color: var(--accent); }
    .board-empty { color: var(--fg-dim); font-size: 0.78rem; padding: 0.3rem; font-style: italic; }
    .template-details { margin-bottom: 1rem; }
    .template-details summary {
      color: var(--fg-dim); cursor: pointer; font-size: 0.82rem; margin-bottom: 0.5rem;
    }
    .btn-danger:hover { background: #f7768e; border-color: #f7768e; color: var(--bg); }
    .budget-meter {
      display: inline-block; vertical-align: middle;
      width: 140px; height: 8px; background: var(--bg3); border-radius: 4px;
      overflow: hidden;
    }
    .budget-meter-fill { height: 100%; background: var(--user); transition: width 0.3s, background-color 0.3s; }
    .budget-meter-fill.warn { background: var(--tool); }
    .budget-meter-fill.over { background: #f7768e; }
    .budget-numbers {
      font-family: ui-monospace, Menlo, Consolas, monospace;
      color: var(--fg-dim); font-size: 0.82rem;
    }
    .prompt-textarea {
      width: 100%; min-height: 5em; max-height: 24em;
      background: var(--bg2); color: var(--fg);
      border: 1px solid var(--fg-dim); border-radius: 4px;
      padding: 0.5rem 0.7rem; box-sizing: border-box;
      font-family: ui-monospace, Menlo, Consolas, monospace;
      font-size: 0.85rem; line-height: 1.5;
      margin-bottom: 1rem; resize: vertical;
    }
    .prompt-textarea:focus { outline: 1px solid var(--accent); border-color: var(--accent); }
    .prompt-dirty { color: var(--tool); }
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
    .sub-label {
      color: var(--fg-dim); font-size: 0.72rem;
      text-transform: uppercase; letter-spacing: 0.05em;
      margin: 0.4rem 0 0.2rem 0.2rem;
    }
    .file {
      margin: 0.25rem 0; background: var(--bg3); border-radius: 3px; overflow: hidden;
    }
    .file-header {
      padding: 0.35rem 0.8rem; cursor: pointer;
      font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.82rem;
      user-select: none; display: flex; justify-content: space-between; gap: 1rem;
    }
    .file-header:hover { background: rgba(255,255,255,0.05); }
    .file-name { color: var(--fg); word-break: break-all; }
    .file-meta { color: var(--fg-dim); white-space: nowrap; }
    .file-body { display: none; padding: 0.5rem 0.8rem; background: var(--bg); }
    .file.open .file-body { display: block; }
    .file.open > .file-header .arrow { transform: rotate(90deg); }
    .file-image { max-width: 100%; height: auto; border-radius: 3px; display: block; }
    .file-md { font-size: 0.92rem; line-height: 1.6; }
    .file-md h1, .file-md h2, .file-md h3 { color: var(--accent); margin-top: 1rem; }
    .file-md h1 { font-size: 1.4rem; }
    .file-md h2 { font-size: 1.2rem; }
    .file-md h3 { font-size: 1.05rem; }
    .file-md p { margin: 0.5rem 0; }
    .file-md code {
      background: var(--bg3); padding: 0.05rem 0.3rem; border-radius: 3px;
      font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.86rem;
    }
    .file-md pre {
      background: var(--bg2); padding: 0.7rem; border-radius: 4px; overflow: auto;
      max-height: 480px;
    }
    .file-md pre code { background: transparent; padding: 0; }
    .file-md a { color: var(--accent); }
    .file-md blockquote {
      border-left: 3px solid var(--accent2); padding: 0.2rem 0.8rem; margin: 0.5rem 0;
      color: var(--fg-dim);
    }
    .file-md ul, .file-md ol { padding-left: 1.5rem; }
    .file-md table { border-collapse: collapse; }
    .file-md th, .file-md td {
      border: 1px solid var(--bg3); padding: 0.3rem 0.6rem;
    }
    .file-code {
      background: var(--bg2); padding: 0.5rem 0.7rem; border-radius: 3px;
      overflow: auto; max-height: 520px; margin: 0;
      font-size: 0.82rem;
    }
    .file-binary { color: var(--fg-dim); font-style: italic; padding: 0.5rem; }
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
    <span id="state-pill" class="pill pill-down">connecting…</span>
    <button id="btn-toggle" class="btn">…</button>
    <div id="status" class="status-bar">loading...</div>
    <a class="btn" href="/active" title="2×2 live view of working claudes">▦ active view</a>
    <button id="btn-msgorder" class="btn" title="order of messages within each session transcript" onclick="toggleMsgOrder()">…</button>
    <button class="refresh" onclick="refreshAll()">↻ refresh</button>
  </div>
  <div class="controlbar">
    <label>budget</label>
    <div class="budget-meter"><div id="budget-fill" class="budget-meter-fill" style="width:0%"></div></div>
    <span id="budget-numbers" class="budget-numbers">—</span>
    <span style="flex:1"></span>
    <label for="budget-input">set %</label>
    <input id="budget-input" type="number" min="0" step="1" />
    <button class="btn" onclick="applyBudget()">apply</button>
  </div>
  <div class="controlbar">
    <label for="btn-prompter">companion</label>
    <button id="btn-prompter" class="btn">…</button>
    <span id="prompter-hint" class="budget-numbers">—</span>
  </div>

  <div id="tabbar" class="tabbar"></div>

  <div id="lane-panel" class="lane-panel">
    <div class="controlbar">
      <button id="lane-run" class="btn">…</button>
      <button id="lane-continuous" class="btn" title="keep this lane running even if claude marks done or calls notify-done">…</button>
      <button id="lane-until-board" class="btn" title="keep running until every task on this lane's board is done, then pause the lane (the directory stops spinning up new claudes)">…</button>
      <label for="lane-slots">workers</label>
      <input id="lane-slots" type="number" min="0" step="1" />
      <button class="btn" onclick="applyLaneSlots()">set</button>
      <span id="lane-info" class="budget-numbers"></span>
      <span style="flex:1"></span>
      <button class="btn" onclick="renameLane()">rename</button>
      <button id="lane-delete" class="btn btn-danger" onclick="deleteLane()">delete</button>
    </div>
    <div class="controlbar">
      <label for="lane-workdir">workdir</label>
      <input id="lane-workdir" type="text" placeholder="(empty = per-iteration workspaces)" style="flex:1; min-width:14em;" />
      <button class="btn" onclick="applyLaneWorkdir()">set</button>
      <button class="btn" onclick="clearLaneWorkdir()">clear</button>
      <span id="lane-workdir-hint" class="budget-numbers"></span>
    </div>
    <div class="controlbar">
      <label for="lane-board-dir">board dir</label>
      <input id="lane-board-dir" type="text" placeholder="(empty = same as workdir)" style="flex:1; min-width:14em;" />
      <button class="btn" onclick="applyLaneBoardDir()">set</button>
      <button class="btn" onclick="clearLaneBoardDir()">clear</button>
      <span id="lane-board-dir-hint" class="budget-numbers"></span>
    </div>
    <div class="controlbar">
      <label for="lane-message">message</label>
      <span id="lane-message-hint" class="budget-numbers"></span>
      <span style="flex:1"></span>
      <button class="btn btn-start" onclick="sendLaneMessage()">send</button>
      <button class="btn" onclick="clearLaneMessage()">clear</button>
    </div>
    <textarea id="lane-message" class="prompt-textarea" spellcheck="false" style="min-height:4em" placeholder="one-shot note — woven into the companion's next prompt and logged to MESSAGES_FROM_USER.md, then cleared"></textarea>
    <div class="controlbar">
      <label for="prompt-editor">prompt</label>
      <span id="prompt-dirty-badge" class="budget-numbers prompt-dirty"></span>
      <span style="flex:1"></span>
      <button class="btn" onclick="savePrompt()">save</button>
      <button class="btn" onclick="revertPrompt()">revert</button>
    </div>
    <textarea id="prompt-editor" class="prompt-textarea" spellcheck="false" placeholder="loading prompt..."></textarea>
    <details class="template-details">
      <summary>CLAUDE.md template <span id="template-file-label" class="budget-numbers"></span> — shared by all lanes of this kind, applied to new siblings only</summary>
      <div class="controlbar">
        <span id="template-dirty-badge" class="budget-numbers prompt-dirty"></span>
        <span style="flex:1"></span>
        <button class="btn" onclick="saveTemplate()">save</button>
        <button class="btn" onclick="revertTemplate()">revert</button>
      </div>
      <textarea id="template-editor" class="prompt-textarea" spellcheck="false" placeholder="loading template..." style="min-height:10em"></textarea>
    </details>
  </div>

  <div id="board-wrap" class="board-wrap" style="display:none">
    <div class="board-head">
      <span class="board-title">task board</span>
      <span id="board-hint" class="budget-numbers"></span>
    </div>
    <div id="board-cols" class="board-cols"></div>
  </div>

  <div id="content"><div class="loading">loading siblings...</div></div>

<script>
const expanded = { siblings: new Set(), sessions: new Set(), cards: new Set() };
const loadedSessions = new Map();
// Order messages within a session transcript. Persisted so it sticks across reloads.
let messagesNewestFirst = localStorage.getItem('msgNewestFirst') === '1';

// Place a rendered message into a session body honoring the current order: newest
// first means prepend (top), oldest first means append (bottom). Iterating events in
// chronological order and prepending each lands the newest at the very top.
function placeMsg(body, el) {
  if (messagesNewestFirst) body.insertBefore(el, body.firstChild);
  else body.appendChild(el);
}

function updateMsgOrderButton() {
  const b = document.getElementById('btn-msgorder');
  if (b) b.textContent = messagesNewestFirst ? 'newest ↑' : 'oldest ↓';
}

function rerenderOpenSessions() {
  for (const key of expanded.sessions) {
    const el = document.querySelector('.session[data-session-key="' + CSS.escape(key) + '"]');
    if (!el) continue;
    const body = el.querySelector('.session-body');
    const events = loadedSessions.get(key);
    if (!body || !events) continue;
    body.innerHTML = '';
    for (const m of events) placeMsg(body, renderMessage(m));
  }
}

function toggleMsgOrder() {
  messagesNewestFirst = !messagesNewestFirst;
  localStorage.setItem('msgNewestFirst', messagesNewestFirst ? '1' : '0');
  updateMsgOrderButton();
  rerenderOpenSessions();
}
let lastBoard = null;         // { handle, tasks: [...] }
let boardHandleCur = null;    // handle currently displayed
let boardEditingId = null;    // task id whose raw editor is open (suppresses re-render)

let lastState = null;
let budgetInputDirty = false;
const budgetInput = document.getElementById('budget-input');
budgetInput.addEventListener('input', () => { budgetInputDirty = true; });

const promptEditor = document.getElementById('prompt-editor');
const promptDirtyBadge = document.getElementById('prompt-dirty-badge');
let promptDirty = false;
let promptServerValue = '';
promptEditor.addEventListener('input', () => {
  promptDirty = (promptEditor.value !== promptServerValue);
  promptDirtyBadge.textContent = promptDirty ? '(unsaved)' : '';
});

const messageEditor = document.getElementById('lane-message');
let messageDirty = false;
let messageServerValue = '';
messageEditor.addEventListener('input', () => {
  messageDirty = (messageEditor.value !== messageServerValue);
});

const templateEditor = document.getElementById('template-editor');
const templateFileLabel = document.getElementById('template-file-label');
const templateDirtyBadge = document.getElementById('template-dirty-badge');
let templateDirty = false;
let templateServerValue = '';
templateEditor.addEventListener('input', () => {
  templateDirty = (templateEditor.value !== templateServerValue);
  templateDirtyBadge.textContent = templateDirty ? '(unsaved)' : '';
});

// --- lanes / tabs ---
let selectedLane = null;
let lastSiblings = [];

function currentLane() {
  if (!lastState || !Array.isArray(lastState.lanes)) return null;
  return lastState.lanes.find(l => l.id === selectedLane) || null;
}

async function laneFetch(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.error) { alert('error: ' + j.error); throw new Error(j.error); }
  return j;
}

async function savePrompt() {
  if (!selectedLane) return;
  try {
    await laneFetch('/api/control/lane/prompt', { lane: selectedLane, prompt: promptEditor.value });
    promptServerValue = promptEditor.value;
    promptDirty = false;
    promptDirtyBadge.textContent = '(saved)';
    setTimeout(() => { if (!promptDirty) promptDirtyBadge.textContent = ''; }, 1500);
    heartbeat();
  } catch (e) { /* alerted in laneFetch */ }
}

function revertPrompt() {
  promptEditor.value = promptServerValue;
  promptDirty = false;
  promptDirtyBadge.textContent = '';
}

async function saveTemplate() {
  const lane = currentLane();
  if (!lane) return;
  try {
    await laneFetch('/api/control/template', { kind: lane.kind, template: templateEditor.value });
    templateServerValue = templateEditor.value;
    templateDirty = false;
    templateDirtyBadge.textContent = '(saved)';
    setTimeout(() => { if (!templateDirty) templateDirtyBadge.textContent = ''; }, 1500);
    heartbeat();
  } catch (e) { /* alerted */ }
}

function revertTemplate() {
  templateEditor.value = templateServerValue;
  templateDirty = false;
  templateDirtyBadge.textContent = '';
}

function laneSiblings() {
  return lastSiblings.filter(s => (s.lane || 'corner') === selectedLane);
}

function selectLane(id) {
  if (id === selectedLane) return;
  if (promptDirty && !confirm('discard unsaved prompt changes?')) return;
  if (boardEditingId && !confirm('discard unsaved board card edits?')) return;
  selectedLane = id;
  promptDirty = false; templateDirty = false;
  boardEditingId = null; lastBoard = null; boardHandleCur = null;
  if (lastState) { renderTabs(lastState); syncLanePanel(lastState); }
  renderSiblings(laneSiblings());
  refreshBoard();
}

// --- task board (kanban over <workdir>/board/*.md) ---
const BOARD_COLS = [
  { key: 'todo',        label: 'todo' },
  { key: 'in_progress', label: 'in progress' },
  { key: 'done',        label: 'done' },
];

// The board handle is the same string used to address a work dir: a fixed-workdir
// lane is 'lane:<id>'; otherwise the lane's newest sibling worktree.
function boardHandle() {
  const lane = currentLane();
  if (!lane) return null;
  if (lane.kind === 'corner') return null;   // corner = open space, not a task board
  if (lane.workdir || lane.board_dir) return 'lane:' + lane.id;
  const sibs = laneSiblings();   // newest first (server sorts by mtime desc)
  return sibs.length ? sibs[0].name : null;
}

async function refreshBoard() {
  const wrap = document.getElementById('board-wrap');
  const handle = boardHandle();
  if (!handle) {
    boardHandleCur = null; lastBoard = null;
    wrap.style.display = 'none';
    return;
  }
  // Don't yank the raw editor out from under an in-progress edit.
  if (boardEditingId && handle === boardHandleCur) return;
  try {
    const r = await fetch('/api/board/' + encodeURIComponent(handle), { cache: 'no-store' });
    if (!r.ok) { wrap.style.display = 'none'; return; }
    const j = await r.json();
    lastBoard = j; boardHandleCur = handle;
    renderBoard(j);
  } catch (e) { /* leave last render up */ }
}

function boardCardKey(t) { return boardHandleCur + '/' + t.id; }

function renderBoard(bd) {
  const wrap = document.getElementById('board-wrap');
  const cols = document.getElementById('board-cols');
  const hint = document.getElementById('board-hint');
  wrap.style.display = 'block';
  const tasks = (bd && bd.tasks) || [];
  const n = tasks.length;
  hint.textContent = n ? (n + ' task' + (n === 1 ? '' : 's') + ' · board/*.md in the workdir · claude edits these directly')
                       : 'no tasks yet · board/*.md in the workdir · add one or let claude create them';
  cols.innerHTML = '';
  for (const col of BOARD_COLS) {
    const items = tasks.filter(t => t.status === col.key);
    const colEl = document.createElement('div');
    colEl.className = 'board-col col-' + col.key;
    colEl.innerHTML = `<div class="board-col-head"><span>${col.label}</span>`
      + `<span class="board-col-count">${items.length}</span></div>`;
    for (const t of items) colEl.appendChild(createBoardCard(t));
    if (col.key === 'todo') {
      const add = document.createElement('button');
      add.className = 'board-add';
      add.textContent = '+ add task';
      add.onclick = addBoardTask;
      colEl.appendChild(add);
    } else if (items.length === 0) {
      const e = document.createElement('div');
      e.className = 'board-empty';
      e.textContent = '—';
      colEl.appendChild(e);
    }
    cols.appendChild(colEl);
  }
}

function createBoardCard(t) {
  const key = boardCardKey(t);
  const el = document.createElement('div');
  el.className = 'board-card col-' + t.status
    + (expanded.cards.has(key) ? ' open' : '')
    + (boardEditingId === t.id ? ' editing' : '');
  el.dataset.taskId = t.id;

  const metaBits = [t.id];
  if (t.claimed_by) metaBits.push('<span class="board-card-who">@' + escapeHtml(t.claimed_by) + '</span>');
  if (t.mtime) metaBits.push(fmtTime(t.mtime));

  el.innerHTML =
      `<div class="board-card-title">${escapeHtml(t.title)}</div>`
    + `<div class="board-card-meta">${metaBits.join('<span>·</span>')}</div>`
    + `<div class="board-card-body">`
    +   `<div class="md">${renderMarkdown(t.body)}</div>`
    +   `<textarea class="board-raw-edit" spellcheck="false"></textarea>`
    +   `<div class="board-card-actions"></div>`
    + `</div>`;

  const title = el.querySelector('.board-card-title');
  const meta = el.querySelector('.board-card-meta');
  const actions = el.querySelector('.board-card-actions');
  const raw = el.querySelector('.board-raw-edit');

  const toggleOpen = () => {
    el.classList.toggle('open');
    if (el.classList.contains('open')) expanded.cards.add(key);
    else { expanded.cards.delete(key); leaveEdit(); }
  };
  title.addEventListener('click', toggleOpen);
  meta.addEventListener('click', toggleOpen);

  function leaveEdit() {
    if (boardEditingId === t.id) boardEditingId = null;
    el.classList.remove('editing');
  }

  // move-to-status buttons (only the ones that aren't the current status)
  for (const col of BOARD_COLS) {
    if (col.key === t.status) continue;
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = '→ ' + col.label;
    b.onclick = (ev) => { ev.stopPropagation(); moveBoardTask(t.id, col.key); };
    actions.appendChild(b);
  }
  const editBtn = document.createElement('button');
  editBtn.className = 'btn';
  editBtn.textContent = boardEditingId === t.id ? 'view' : 'edit';
  editBtn.onclick = (ev) => {
    ev.stopPropagation();
    if (boardEditingId === t.id) { leaveEdit(); editBtn.textContent = 'edit'; }
    else { boardEditingId = t.id; raw.value = t.raw || ''; el.classList.add('editing'); editBtn.textContent = 'view'; raw.focus(); }
  };
  actions.appendChild(editBtn);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-start';
  saveBtn.textContent = 'save edit';
  saveBtn.onclick = (ev) => { ev.stopPropagation(); saveBoardRaw(t.id, raw.value); };
  actions.appendChild(saveBtn);

  const del = document.createElement('button');
  del.className = 'btn btn-danger';
  del.textContent = 'delete';
  del.onclick = (ev) => { ev.stopPropagation(); deleteBoardTask(t.id, t.title); };
  actions.appendChild(del);

  if (boardEditingId === t.id) raw.value = t.raw || '';
  return el;
}

async function boardPost(path, body) {
  const handle = boardHandleCur;
  if (!handle) return null;
  const r = await fetch('/api/board/' + encodeURIComponent(handle) + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) { alert('board error: ' + (j.error || r.status)); return null; }
  return j;
}

async function addBoardTask() {
  const title = prompt('new task title:');
  if (!title || !title.trim()) return;
  const body = prompt('description (optional):') || '';
  const j = await boardPost('/task', { title: title.trim(), body });
  if (j) refreshBoard();
}

async function moveBoardTask(id, status) {
  const j = await boardPost('/task/' + encodeURIComponent(id) + '/status', { status });
  if (j) refreshBoard();
}

async function saveBoardRaw(id, content) {
  const j = await boardPost('/task/' + encodeURIComponent(id) + '/raw', { content });
  if (j) { boardEditingId = null; refreshBoard(); }
}

async function deleteBoardTask(id, title) {
  if (!confirm('delete task "' + (title || id) + '"? (removes board/' + id + '.md)')) return;
  const j = await boardPost('/task/' + encodeURIComponent(id) + '/delete', {});
  if (j) { expanded.cards.delete(boardHandleCur + '/' + id); refreshBoard(); }
}

async function createLane() {
  const name = prompt('name for the new task:');
  if (!name || !name.trim()) return;
  try {
    const j = await laneFetch('/api/control/lanes', { name: name.trim(), kind: 'task' });
    if (j.id) selectedLane = j.id;
    await heartbeat();
  } catch (e) { /* alerted */ }
}

async function renameLane() {
  const lane = currentLane();
  if (!lane) return;
  const name = prompt('rename lane:', lane.name);
  if (!name || !name.trim()) return;
  try { await laneFetch('/api/control/lane/rename', { lane: lane.id, name: name.trim() }); heartbeat(); }
  catch (e) { /* alerted */ }
}

async function deleteLane() {
  const lane = currentLane();
  if (!lane) return;
  if (lane.id === 'corner') { alert('the corner lane cannot be deleted'); return; }
  if (!confirm(`delete task "${lane.name}"? its worktrees stay on disk but the tab is removed.`)) return;
  try {
    await laneFetch('/api/control/lane/delete', { lane: lane.id });
    selectedLane = null;
    await heartbeat();
  } catch (e) { /* alerted */ }
}

async function setLaneSlots(id, slots) {
  try { await laneFetch('/api/control/lane/slots', { lane: id, slots: slots }); heartbeat(); }
  catch (e) { /* alerted */ }
}

function applyLaneSlots() {
  const lane = currentLane();
  if (!lane) return;
  const v = parseInt(document.getElementById('lane-slots').value, 10);
  if (Number.isNaN(v) || v < 0) { alert('workers must be a non-negative integer'); return; }
  setLaneSlots(lane.id, v);
}

async function setLaneWorkdir(workdir) {
  const lane = currentLane();
  if (!lane) return;
  try { await laneFetch('/api/control/lane/workdir', { lane: lane.id, workdir: workdir }); heartbeat(); }
  catch (e) { /* alerted */ }
}

function applyLaneWorkdir() {
  setLaneWorkdir(document.getElementById('lane-workdir').value.trim());
}

function clearLaneWorkdir() {
  document.getElementById('lane-workdir').value = '';
  setLaneWorkdir('');
}

async function setLaneBoardDir(boardDir) {
  const lane = currentLane();
  if (!lane) return;
  try { await laneFetch('/api/control/lane/board-dir', { lane: lane.id, board_dir: boardDir }); heartbeat(); refreshBoard(); }
  catch (e) { /* alerted */ }
}

function applyLaneBoardDir() {
  setLaneBoardDir(document.getElementById('lane-board-dir').value.trim());
}

function clearLaneBoardDir() {
  document.getElementById('lane-board-dir').value = '';
  setLaneBoardDir('');
}

function toggleLaneRun() {
  const lane = currentLane();
  if (!lane) return;
  setLaneSlots(lane.id, lane.slots > 0 ? 0 : 1);
}

async function setLaneContinuous(id, on) {
  try { await laneFetch('/api/control/lane/continuous', { lane: id, continuous: on }); heartbeat(); }
  catch (e) { /* alerted */ }
}

function toggleLaneContinuous() {
  const lane = currentLane();
  if (!lane) return;
  setLaneContinuous(lane.id, !lane.continuous);
}

async function setLaneUntilBoard(id, on) {
  try { await laneFetch('/api/control/lane/until-board-clear', { lane: id, until_board_clear: on }); heartbeat(); }
  catch (e) { /* alerted */ }
}

// Count tasks still open (todo / in progress) on the current lane's board.
async function boardOpenCount() {
  const handle = boardHandle();
  if (!handle) return 0;
  try {
    const r = await fetch('/api/board/' + encodeURIComponent(handle), { cache: 'no-store' });
    if (!r.ok) return 0;
    const j = await r.json();
    return (j.tasks || []).filter(t => t.status === 'todo' || t.status === 'in_progress').length;
  } catch (e) { return 0; }
}

async function toggleLaneUntilBoard() {
  const lane = currentLane();
  if (!lane) return;
  const turningOn = !lane.until_board_clear;
  await setLaneUntilBoard(lane.id, turningOn);
  // Turning the mode on should also start the lane if it's idle and there's still
  // work to grind — no point arming "run until done" on a lane that's parked.
  if (turningOn && lane.slots === 0) {
    const open = await boardOpenCount();
    if (open > 0) await setLaneSlots(lane.id, 1);
  }
}

async function setLaneMessage(id, text) {
  try {
    await laneFetch('/api/control/lane/message', { lane: id, message: text });
    messageServerValue = text;
    messageDirty = false;
    heartbeat();
  } catch (e) { /* alerted */ }
}

function sendLaneMessage() {
  const lane = currentLane();
  if (!lane) return;
  setLaneMessage(lane.id, messageEditor.value);
}

function clearLaneMessage() {
  const lane = currentLane();
  if (!lane) return;
  messageEditor.value = '';
  setLaneMessage(lane.id, '');
}

function renderTabs(s) {
  const bar = document.getElementById('tabbar');
  bar.innerHTML = '';
  const lanes = Array.isArray(s.lanes) ? s.lanes : [];
  if ((!selectedLane || !lanes.some(l => l.id === selectedLane)) && lanes.length) {
    selectedLane = lanes[0].id;
  }
  for (const l of lanes) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (l.id === selectedLane ? ' active' : '');
    tab.title = `${l.kind} lane · ${l.siblings} sibling(s)`;
    tab.innerHTML = `<span class="tab-dot ${l.running ? 'on' : ''}"></span>`
      + `<span>${escapeHtml(l.name)}</span>`
      + (l.kind === 'corner' ? '<span class="tab-kind">corner</span>' : '');
    tab.onclick = () => selectLane(l.id);
    bar.appendChild(tab);
  }
  const add = document.createElement('button');
  add.className = 'tab-add';
  add.textContent = '+ new task';
  add.onclick = createLane;
  bar.appendChild(add);
}

function syncLanePanel(s) {
  const lane = currentLane();
  const panel = document.getElementById('lane-panel');
  if (!lane) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  const runBtn = document.getElementById('lane-run');
  if (lane.running) {
    runBtn.textContent = '⏸ pause this lane';
    runBtn.className = 'btn btn-stop';
  } else {
    runBtn.textContent = '▶ run this lane';
    runBtn.className = 'btn btn-start';
  }
  runBtn.onclick = toggleLaneRun;
  const contBtn = document.getElementById('lane-continuous');
  if (contBtn) {
    if (lane.continuous) {
      contBtn.textContent = '∞ continuous: ON';
      contBtn.className = 'btn btn-start';
    } else {
      contBtn.textContent = '∞ continuous: off';
      contBtn.className = 'btn';
    }
    contBtn.onclick = toggleLaneContinuous;
  }
  const ubBtn = document.getElementById('lane-until-board');
  if (ubBtn) {
    // Only meaningful for task lanes (corner is the open space, no board).
    if (lane.kind === 'corner') {
      ubBtn.style.display = 'none';
    } else {
      ubBtn.style.display = '';
      if (lane.until_board_clear) {
        ubBtn.textContent = '✓ until board done: ON';
        ubBtn.className = 'btn btn-start';
      } else {
        ubBtn.textContent = '✓ until board done: off';
        ubBtn.className = 'btn';
      }
      ubBtn.onclick = toggleLaneUntilBoard;
    }
  }
  const slotsInput = document.getElementById('lane-slots');
  slotsInput.max = (lane.kind === 'corner' && !lane.workdir) ? (s.max_slots_per_lane || 4) : 1;
  if (document.activeElement !== slotsInput) slotsInput.value = lane.slots;
  const state = lane.running ? 'running'
    : (lane.slots > 0 ? 'armed (all stopped — click ‘start all’)' : 'paused');
  const where = lane.workdir ? 'fixed workdir' : `${lane.siblings} sibling(s)`;
  const cont = lane.continuous ? ' · continuous' : '';
  document.getElementById('lane-info').textContent = `${lane.kind} · ${where} · ${state}${cont}`;
  document.getElementById('lane-delete').style.display = (lane.id === 'corner') ? 'none' : '';

  // workdir input + hint
  const wdInput = document.getElementById('lane-workdir');
  if (document.activeElement !== wdInput) wdInput.value = lane.workdir || '';
  const wdHint = document.getElementById('lane-workdir-hint');
  if (wdHint) {
    wdHint.textContent = lane.workdir
      ? 'runs claude directly here — no worktree, no git, no template (max 1 worker)'
      : 'per-iteration git worktrees under runs/ (default)';
  }

  const bdInput = document.getElementById('lane-board-dir');
  if (bdInput && document.activeElement !== bdInput) bdInput.value = lane.board_dir || '';
  const bdHint = document.getElementById('lane-board-dir-hint');
  if (bdHint) {
    bdHint.textContent = lane.board_dir
      ? 'board tasks live in this dir (relative → under workdir); keep it inside the workdir so claude can reach it'
      : 'board tasks live in the working directory (default)';
  }

  // one-shot message box synced to the lane's pending message (don't clobber typing)
  const msgVal = lane.message || '';
  if (!messageDirty && document.activeElement !== messageEditor) {
    messageEditor.value = msgVal;
    messageServerValue = msgVal;
  }
  const msgHint = document.getElementById('lane-message-hint');
  if (msgHint) {
    msgHint.textContent = (lane.message && lane.message.trim())
      ? '⏳ pending — goes to the companion next iteration, then clears'
      : 'delivered messages clear automatically';
  }

  // prompt editor synced to the selected lane (don't clobber unsaved edits)
  const promptVal = lane.prompt || '';
  if (!promptDirty && document.activeElement !== promptEditor) {
    promptEditor.value = promptVal;
    promptServerValue = promptVal;
  }
  // template editor synced to the lane's kind
  const tmpl = (s.templates && s.templates[lane.kind]) || '';
  if (!templateDirty && document.activeElement !== templateEditor) {
    templateEditor.value = tmpl;
    templateServerValue = tmpl;
  }
  const tf = (s.template_files && s.template_files[lane.kind]) || '';
  if (templateFileLabel) templateFileLabel.textContent = tf ? '(' + tf + ')' : '';
}

function setPill(kind, text) {
  const p = document.getElementById('state-pill');
  p.className = 'pill pill-' + kind;
  p.textContent = text;
}

function updateControlBar(s) {
  // master toggle button + pill
  const btn = document.getElementById('btn-toggle');
  if (s.running) {
    setPill('running', '● running');
    btn.textContent = 'stop all';
    btn.className = 'btn btn-stop';
    btn.onclick = () => setRunning(false);
  } else {
    setPill('paused', '⏸ paused');
    btn.textContent = 'start all';
    btn.className = 'btn btn-start';
    btn.onclick = () => setRunning(true);
  }

  // budget meter
  const fill = document.getElementById('budget-fill');
  const nums = document.getElementById('budget-numbers');
  if (s.budget_pct > 0 && s.baseline_seven_day_pct !== null) {
    const used = s.used_of_budget_pct == null ? 0 : Math.max(0, s.used_of_budget_pct);
    const pct = Math.min(100, (used / s.budget_pct) * 100);
    fill.style.width = pct.toFixed(1) + '%';
    fill.classList.toggle('warn', pct >= 75 && pct < 100);
    fill.classList.toggle('over', pct >= 100);
    nums.textContent = `${used.toFixed(1)}% used of ${s.budget_pct.toFixed(0)}% (baseline ${s.baseline_seven_day_pct.toFixed(0)}%, current 7d ${s.current_seven_day_pct != null ? s.current_seven_day_pct.toFixed(0) : '?'}%)`;
  } else {
    fill.style.width = '0%';
    nums.textContent = '(no probe yet)';
  }

  // budget input — only update if user hasn't been editing
  if (!budgetInputDirty && document.activeElement !== budgetInput) {
    budgetInput.value = (s.budget_pct || 0).toFixed(0);
  }

  // companion prompter toggle
  const pbtn = document.getElementById('btn-prompter');
  const phint = document.getElementById('prompter-hint');
  if (pbtn) {
    if (s.prompter_enabled) {
      pbtn.textContent = 'companion: ON';
      pbtn.className = 'btn btn-start';
      pbtn.onclick = () => setPrompter(false);
    } else {
      pbtn.textContent = 'companion: OFF';
      pbtn.className = 'btn btn-stop';
      pbtn.onclick = () => setPrompter(true);
    }
  }
  if (phint) {
    if (s.prompter_enabled) {
      const model = s.prompter_model || '(model not detected)';
      phint.textContent = 'local model writes each next prompt — ' + model + ' @ ' + (s.prompter_base || '?');
    } else {
      phint.textContent = 'using the handwritten prompt below verbatim each iteration';
    }
  }

  // tabs + the selected lane's panel (prompt + template + per-lane run control)
  renderTabs(s);
  syncLanePanel(s);

  // statusline bar
  document.getElementById('status').textContent = s.statusline || '(no rate-limit data yet)';
}

async function heartbeat() {
  try {
    const [stateRes, siblingsRes] = await Promise.all([
      fetch('/api/state', { cache: 'no-store' }),
      fetch('/api/siblings', { cache: 'no-store' }),
    ]);
    if (!stateRes.ok) throw new Error('state http ' + stateRes.status);
    const s = await stateRes.json();
    const siblings = await siblingsRes.json();
    lastState = s;
    lastSiblings = siblings;
    updateControlBar(s);
    syncSiblings(laneSiblings());
    refreshBoard();
    // Append new messages to any currently-open sessions
    for (const key of Array.from(expanded.sessions)) {
      const [sib, sid] = key.split('/');
      updateOpenSession(sib, sid);
    }
  } catch (e) {
    setPill('down', '✕ disconnected');
    document.getElementById('status').textContent = 'cannot reach server: ' + e.message;
  }
}

async function setRunning(v) {
  try {
    const r = await fetch('/api/control/running', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ running: v }),
    });
    const j = await r.json();
    if (j.error) alert('error: ' + j.error);
    heartbeat();
  } catch (e) {
    alert('failed: ' + e.message);
  }
}

async function setPrompter(v) {
  try {
    const r = await fetch('/api/control/prompter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: v }),
    });
    const j = await r.json();
    if (j.error) alert('error: ' + j.error);
    heartbeat();
  } catch (e) {
    alert('failed: ' + e.message);
  }
}

async function applyBudget() {
  const v = parseFloat(budgetInput.value);
  if (Number.isNaN(v) || v < 0) { alert('budget must be a non-negative number'); return; }
  try {
    const r = await fetch('/api/control/budget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percent: v }),
    });
    const j = await r.json();
    if (j.error) alert('error: ' + j.error);
    budgetInputDirty = false;
    heartbeat();
  } catch (e) {
    alert('failed: ' + e.message);
  }
}

async function refreshSiblings() {
  try {
    const r = await fetch('/api/siblings');
    lastSiblings = await r.json();
    renderSiblings(laneSiblings());
  } catch (e) {
    document.getElementById('content').textContent = 'error: ' + e.message;
  }
}

function refreshAll() {
  heartbeat();
  refreshSiblings();
}

function siblingMetaText(s) {
  const c = s.sessions.length;
  return `${c} session${c === 1 ? '' : 's'} · ${fmtTime(s.mtime)}`;
}

function createSiblingEl(s) {
  const el = document.createElement('div');
  el.className = 'sibling' + (expanded.siblings.has(s.name) ? ' open' : '');
  el.dataset.sibling = s.name;
  el.innerHTML = `
    <div class="sibling-header">
      <div><span class="arrow">▶</span><span class="sibling-name">${escapeHtml(s.label || s.name)}</span></div>
      <div class="sibling-meta">${siblingMetaText(s)}</div>
    </div>
    <div class="sibling-body">
      <div class="sub-label">sessions</div>
      <div class="sessions-list"></div>
      <div class="sub-label">files</div>
      <div class="files-list"></div>
    </div>
  `;
  const header = el.querySelector('.sibling-header');
  const sessionsList = el.querySelector('.sessions-list');
  const filesList = el.querySelector('.files-list');
  header.addEventListener('click', () => {
    el.classList.toggle('open');
    if (el.classList.contains('open')) expanded.siblings.add(s.name);
    else expanded.siblings.delete(s.name);
  });
  for (const sess of s.sessions) sessionsList.appendChild(createSessionEl(s.name, sess));
  if (s.sessions.length === 0) {
    sessionsList.innerHTML = '<div class="empty" style="padding:0.4rem">no sessions yet</div>';
  }
  const files = s.files || [];
  for (const f of files) filesList.appendChild(createFileEl(s.name, f));
  if (files.length === 0) {
    filesList.innerHTML = '<div class="empty" style="padding:0.4rem">no files yet</div>';
  }
  return el;
}

function createSessionEl(sibling, sess) {
  const key = `${sibling}/${sess.id}`;
  const el = document.createElement('div');
  el.className = 'session' + (expanded.sessions.has(key) ? ' open' : '');
  el.dataset.sessionId = sess.id;
  el.dataset.sessionKey = key;
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
      for (const m of loadedSessions.get(key)) placeMsg(body, renderMessage(m));
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
        for (const m of events) placeMsg(body, renderMessage(m));
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

function renderSiblings(siblings) {
  const content = document.getElementById('content');
  content.innerHTML = '';
  if (siblings.length === 0) {
    content.innerHTML = '<div class="empty">no siblings in this lane yet — run it to spawn one</div>';
    return;
  }
  for (const s of siblings) content.appendChild(createSiblingEl(s));
}

function syncSiblings(siblings) {
  const content = document.getElementById('content');
  if (!content.querySelector('.sibling')) {
    renderSiblings(siblings);
    return;
  }
  const existing = new Map();
  for (const el of content.querySelectorAll(':scope > .sibling')) {
    existing.set(el.dataset.sibling, el);
  }
  // Place each sibling at its correct index (newest first)
  for (let i = 0; i < siblings.length; i++) {
    const s = siblings[i];
    let el = existing.get(s.name);
    if (!el) {
      el = createSiblingEl(s);
      const ref = content.children[i];
      if (ref) content.insertBefore(el, ref); else content.appendChild(el);
    } else {
      const ref = content.children[i];
      if (ref !== el) content.insertBefore(el, ref);
      el.querySelector('.sibling-meta').textContent = siblingMetaText(s);
      syncSessionsInSibling(el, s);
    }
  }
  const wanted = new Set(siblings.map(s => s.name));
  for (const el of Array.from(content.querySelectorAll(':scope > .sibling'))) {
    if (!wanted.has(el.dataset.sibling)) el.remove();
  }
}

function syncSessionsInSibling(siblingEl, s) {
  const list = siblingEl.querySelector('.sessions-list');
  if (!list) return;
  const placeholder = list.querySelector('.empty');
  if (placeholder && s.sessions.length > 0) list.innerHTML = '';
  const existing = new Map();
  for (const el of list.querySelectorAll(':scope > .session')) {
    existing.set(el.dataset.sessionId, el);
  }
  for (let i = 0; i < s.sessions.length; i++) {
    const sess = s.sessions[i];
    let el = existing.get(sess.id);
    if (!el) {
      el = createSessionEl(s.name, sess);
      const ref = list.children[i];
      if (ref) list.insertBefore(el, ref); else list.appendChild(el);
    } else {
      const ref = list.children[i];
      if (ref !== el) list.insertBefore(el, ref);
      el.querySelector('.session-meta').textContent = fmtTime(sess.mtime);
    }
  }
  const wanted = new Set(s.sessions.map(x => x.id));
  for (const el of Array.from(list.querySelectorAll(':scope > .session'))) {
    if (!wanted.has(el.dataset.sessionId)) el.remove();
  }
  syncFilesInSibling(siblingEl, s);
}

function syncFilesInSibling(siblingEl, s) {
  const list = siblingEl.querySelector('.files-list');
  if (!list) return;
  const files = s.files || [];
  const placeholder = list.querySelector('.empty');
  if (placeholder && files.length > 0) list.innerHTML = '';
  const existing = new Map();
  for (const el of list.querySelectorAll(':scope > .file')) {
    existing.set(el.dataset.filePath, el);
  }
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let el = existing.get(f.path);
    if (!el) {
      el = createFileEl(s.name, f);
      const ref = list.children[i];
      if (ref) list.insertBefore(el, ref); else list.appendChild(el);
    } else {
      const ref = list.children[i];
      if (ref !== el) list.insertBefore(el, ref);
      // update meta + remember new mtime so user can manually re-fetch
      el.querySelector('.file-meta').textContent = `${f.size}b · ${fmtTime(f.mtime)}`;
      if (parseFloat(el.dataset.fileMtime || '0') !== f.mtime) {
        el.dataset.fileMtime = f.mtime;
        el.dataset.fileStale = '1';  // mark; viewer will refresh on next open
      }
    }
  }
  const wanted = new Set(files.map(f => f.path));
  for (const el of Array.from(list.querySelectorAll(':scope > .file'))) {
    if (!wanted.has(el.dataset.filePath)) el.remove();
  }
}

function langForExt(ext) {
  return {
    py: 'python', js: 'javascript', ts: 'typescript', tsx: 'typescript',
    jsx: 'javascript', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini',
    html: 'html', htm: 'html', xml: 'xml',
    css: 'css', scss: 'scss',
    md: 'markdown', tex: 'latex',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', h: 'c', c: 'c',
    rb: 'ruby', php: 'php', lua: 'lua', sql: 'sql',
    diff: 'diff', patch: 'diff',
  }[ext];
}

const IMG_EXTS = new Set(['png','jpg','jpeg','gif','svg','webp','bmp','ico']);

function createFileEl(sibling, file) {
  const el = document.createElement('div');
  el.className = 'file';
  el.dataset.filePath = file.path;
  el.dataset.fileMtime = String(file.mtime);
  el.innerHTML = `
    <div class="file-header">
      <div><span class="arrow">▶</span><span class="file-name"></span></div>
      <div class="file-meta"></div>
    </div>
    <div class="file-body"></div>
  `;
  el.querySelector('.file-name').textContent = file.path;
  el.querySelector('.file-meta').textContent = `${file.size}b · ${fmtTime(file.mtime)}`;
  const header = el.querySelector('.file-header');
  const body = el.querySelector('.file-body');
  header.addEventListener('click', () => {
    el.classList.toggle('open');
    if (el.classList.contains('open')) {
      // refetch every open so newly-modified files show fresh content
      renderFileContent(body, sibling, { path: file.path });
      el.dataset.fileStale = '';
    }
  });
  return el;
}

async function renderFileContent(body, sibling, file) {
  const path = file.path;
  const ext = (path.split('.').pop() || '').toLowerCase();
  const url = `/file/${sibling}/${path.split('/').map(encodeURIComponent).join('/')}`;
  if (IMG_EXTS.has(ext)) {
    body.innerHTML = '';
    const img = document.createElement('img');
    img.className = 'file-image';
    img.src = url + '?t=' + Date.now();  // bust cache so refresh works
    img.alt = path;
    body.appendChild(img);
    return;
  }
  body.innerHTML = '<div class="loading">loading...</div>';
  try {
    const r = await fetch(url + '?t=' + Date.now());
    if (!r.ok) throw new Error('http ' + r.status);
    // Detect binary by checking for null bytes in a small prefix
    const buf = await r.arrayBuffer();
    const view = new Uint8Array(buf.slice(0, Math.min(buf.byteLength, 4096)));
    let isBinary = false;
    for (let i = 0; i < view.length; i++) {
      if (view[i] === 0) { isBinary = true; break; }
    }
    if (isBinary) {
      body.innerHTML = `<div class="file-binary">binary file (${buf.byteLength} bytes) — <a href="${url}" target="_blank">open raw</a></div>`;
      return;
    }
    const text = new TextDecoder('utf-8').decode(buf);
    if (ext === 'md' || ext === 'markdown') {
      body.innerHTML = '';
      const div = document.createElement('div');
      div.className = 'file-md';
      div.innerHTML = window.marked ? marked.parse(text) : text;
      body.appendChild(div);
      if (window.hljs) {
        for (const code of div.querySelectorAll('pre code')) hljs.highlightElement(code);
      }
    } else {
      body.innerHTML = '';
      const pre = document.createElement('pre');
      pre.className = 'file-code';
      const code = document.createElement('code');
      const lang = langForExt(ext);
      if (lang) code.className = 'language-' + lang;
      code.textContent = text;
      pre.appendChild(code);
      body.appendChild(pre);
      if (window.hljs) hljs.highlightElement(code);
    }
  } catch (e) {
    body.innerHTML = '<div class="loading">error: ' + e.message + '</div>';
  }
}

async function updateOpenSession(sibling, sessId) {
  const key = `${sibling}/${sessId}`;
  try {
    const r = await fetch(`/api/session/${sibling}/${sessId}`, { cache: 'no-store' });
    if (!r.ok) return;
    const events = await r.json();
    const old = loadedSessions.get(key) || [];
    if (events.length === old.length) return;
    loadedSessions.set(key, events);
    const sel = '.session[data-session-key="' + CSS.escape(key) + '"]';
    const el = document.querySelector(sel);
    if (!el) return;
    const body = el.querySelector('.session-body');
    // Clear any "(no messages)" / "loading..." placeholder if we now have content
    if (old.length === 0 && events.length > 0) body.innerHTML = '';
    // Add only the new ones, honoring the current order (prepend when newest-first)
    for (let i = old.length; i < events.length; i++) {
      placeMsg(body, renderMessage(events[i]));
    }
  } catch (e) {}
}

// Transcript render helpers (fmtTime/escapeHtml/div/renderMessage/renderBlock/…)
// are served from /render.js and shared with the /active grid — see RENDER_JS.

updateMsgOrderButton();
refreshAll();
setInterval(heartbeat, 5000);  // 5-s heartbeat: state, statusline, budget, connection
</script>
</body>
</html>
"""


# The /active page: a 2x2 grid, each cell shows the live tail of one lane's most
# recent session. Reuses /render.js (message renderer) and /app.css (the main page's
# styles, extracted below). Each cell is a windowed/virtualized scroller so a very
# long session stays fast: only a bounded window of messages is in the DOM at once.
ACTIVE_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>claude-corner · active</title>
  <script src="https://cdn.jsdelivr.net/npm/marked@11/marked.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/highlight.min.js"></script>
  <script src="/render.js"></script>
  <link rel="stylesheet" href="/app.css"/>
  <style>
    .active-topbar { position: relative; display: flex; align-items: center; gap: 1rem; margin-bottom: 0.7rem; flex-wrap: wrap; }
    .active-topbar h1 { font-size: 1.2rem; }
    .settings-pop {
      position: absolute; top: 2.4rem; left: 0; z-index: 30; min-width: 16rem;
      background: var(--bg2); border: 1px solid var(--bg3); border-radius: 6px;
      padding: 0.7rem 0.9rem; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    }
    .settings-title { color: var(--accent2); font-size: 0.8rem; margin-bottom: 0.5rem; }
    .settings-row { display: flex; align-items: center; gap: 0.6rem; font-size: 0.82rem; }
    .settings-row label { color: var(--fg-dim); }
    .settings-row input[type=range] { flex: 1; accent-color: var(--accent); }
    .settings-row input[type=number] {
      background: var(--bg); color: var(--fg); border: 1px solid var(--fg-dim);
      border-radius: 3px; padding: 0.15rem 0.35rem; width: 3.4em; font-family: inherit; font-size: 0.82rem;
    }
    .settings-hint { color: var(--fg-dim); font-size: 0.7rem; margin-top: 0.25rem; }
    .settings-val { font-family: ui-monospace, Menlo, Consolas, monospace; color: var(--fg); min-width: 3.2em; text-align: right; }
    .active-grid {
      display: grid;
      grid-template-columns: var(--gcols, 1fr 1fr);
      grid-template-rows: var(--grows, 1fr 1fr);
      gap: 0.6rem; height: calc(100vh - 5.2rem);
    }
    @media (max-width: 760px) {
      .active-grid { grid-template-columns: 1fr; grid-template-rows: none; height: auto; }
      .active-cell { height: 72vh; }
    }
    .active-cell {
      display: flex; flex-direction: column; min-height: 0; overflow: hidden;
      background: var(--bg2); border: 1px solid var(--bg3); border-radius: 6px;
    }
    .active-cell-head {
      flex: none; display: flex; align-items: center; gap: 0.5rem;
      padding: 0.35rem 0.5rem; background: var(--bg3);
    }
    .active-cell-head select {
      background: var(--bg); color: var(--fg); border: 1px solid var(--fg-dim);
      border-radius: 3px; padding: 0.2rem 0.4rem; font-size: 0.82rem; font-family: inherit;
      max-width: 55%;
    }
    .active-cell-meta {
      color: var(--fg-dim); font-family: ui-monospace, Menlo, Consolas, monospace;
      font-size: 0.66rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;
    }
    .active-cell-live { flex: none; font-size: 0.62rem; color: var(--fg-dim); }
    .active-cell-live.on { color: var(--user); }
    .active-cell-live.on::before { content: '● '; }
    .active-pin {
      flex: none; cursor: pointer; font-family: inherit; font-size: 0.66rem;
      padding: 0.12rem 0.45rem; border-radius: 3px;
      background: var(--bg2); color: var(--fg-dim); border: 1px solid var(--fg-dim);
    }
    .active-pin:hover { color: var(--fg); }
    .active-pin.on { background: var(--accent); color: var(--bg); border-color: var(--accent); }
    .active-cell-body { flex: 1; min-height: 0; overflow-y: auto; padding: 0.5rem 0.7rem; background: var(--bg); }
    /* Font size is user-adjustable via the settings popover (--tsize, px). Everything
       in the transcript scales off it, and text reflows within the cell width (calc()
       keeps the ratios so nested elements don't compound). */
    .active-cell-body { font-size: var(--tsize, 14px); }
    .active-cell-body .block-tool, .active-cell-body .diff-block,
    .active-cell-body .block-result { font-size: calc(var(--tsize, 14px) * 0.9); }
    .active-cell-body .block-thinking { font-size: var(--tsize, 14px); }
    .active-cell-body .msg-role, .active-cell-body .tool-path, .active-cell-body .tool-desc,
    .active-cell-body .tool-flag, .active-cell-body .tool-section-label,
    .active-cell-body .block-result-label { font-size: calc(var(--tsize, 14px) * 0.78); }
    /* Native virtualization: skip layout/paint of off-screen messages while keeping
       them in the DOM, so the scrollbar spans the whole session. `auto` remembers each
       message's real height once seen (falling back to ~3rem before first render). */
    .active-cell-content > .msg { content-visibility: auto; contain-intrinsic-size: auto 3rem; }
    .active-cell-empty { color: var(--fg-dim); font-style: italic; padding: 1.2rem; text-align: center; }
  </style>
</head>
<body>
  <div class="active-topbar">
    <button id="settings-btn" class="btn" title="view settings" onclick="toggleSettings(event)">⚙</button>
    <a class="btn" href="/">← board</a>
    <h1>active view</h1>
    <span id="active-status" class="active-cell-meta">connecting…</span>
    <div id="settings-pop" class="settings-pop" style="display:none">
      <div class="settings-title">view settings</div>
      <div class="settings-row">
        <label for="font-range">font size</label>
        <input id="font-range" type="range" min="9" max="28" step="1" oninput="setFont(this.value)"/>
        <span id="font-val" class="settings-val"></span>
      </div>
      <div class="settings-row" style="margin-top:0.6rem;">
        <label for="cols-input">layout</label>
        <input id="cols-input" type="number" min="1" max="4" onchange="setLayout(this.value, gridRows)"/>
        <span style="color:var(--fg-dim)">cols ×</span>
        <input id="rows-input" type="number" min="1" max="3" onchange="setLayout(gridCols, this.value)"/>
        <span style="color:var(--fg-dim)">rows</span>
      </div>
      <div class="settings-hint">e.g. 2 × 1 = two tall columns · 3 × 1 = three tall columns · 2 × 2 = four cells</div>
      <div class="settings-row" style="justify-content:flex-end; margin-top:0.5rem;">
        <button class="btn" onclick="setFont(14)">reset font</button>
      </div>
    </div>
  </div>
  <div id="active-grid" class="active-grid"></div>

<script>
function clampi(v, def, lo, hi) { v = parseInt(v, 10); if (!v || isNaN(v)) v = def; return Math.min(hi, Math.max(lo, v)); }
let gridCols = clampi(localStorage.getItem('activeCols'), 2, 1, 4);   // grid columns
let gridRows = clampi(localStorage.getItem('activeRows'), 2, 1, 3);   // grid rows (rows=1 → tall columns)
let lanes = [];              // [{id,name,kind,...}] from /api/state
let siblings = [];           // from /api/siblings
let cellLanes = loadCellLanes();

function loadCellLanes() {
  try {
    const v = JSON.parse(localStorage.getItem('activeCells') || '[]');
    if (Array.isArray(v)) return v.map(x => x || '');
  } catch (e) {}
  return [];
}
function saveCellLanes() { localStorage.setItem('activeCells', JSON.stringify(cellLanes)); }

function applyLayoutStyle() {
  const grid = document.getElementById('active-grid');
  grid.style.setProperty('--gcols', 'repeat(' + gridCols + ', 1fr)');
  grid.style.setProperty('--grows', 'repeat(' + gridRows + ', 1fr)');
}
function updateLayoutUI() {
  const c = document.getElementById('cols-input'); if (c) c.value = String(gridCols);
  const r = document.getElementById('rows-input'); if (r) r.value = String(gridRows);
}
function setLayout(cols, rows) {
  gridCols = clampi(cols, 2, 1, 4);
  gridRows = clampi(rows, 2, 1, 3);
  localStorage.setItem('activeCols', String(gridCols));
  localStorage.setItem('activeRows', String(gridRows));
  updateLayoutUI();
  buildGrid();   // rebuild cells to cols×rows (keeps each cell's lane by index)
  tick();
}

// --- view settings (font size) ---
let tsize = parseInt(localStorage.getItem('activeFont') || '14', 10) || 14;
function applyFont() {
  document.documentElement.style.setProperty('--tsize', tsize + 'px');
  const v = document.getElementById('font-val'); if (v) v.textContent = tsize + 'px';
  const r = document.getElementById('font-range'); if (r) r.value = String(tsize);
}
function setFont(px) {
  tsize = Math.min(28, Math.max(9, parseInt(px, 10) || 14));
  localStorage.setItem('activeFont', String(tsize));
  applyFont();
}
function toggleSettings(ev) {
  if (ev) ev.stopPropagation();
  const p = document.getElementById('settings-pop');
  p.style.display = (p.style.display === 'none' || !p.style.display) ? 'block' : 'none';
}
document.addEventListener('click', (e) => {
  const pop = document.getElementById('settings-pop');
  const btn = document.getElementById('settings-btn');
  if (pop && pop.style.display === 'block' && !pop.contains(e.target) && !btn.contains(e.target)) {
    pop.style.display = 'none';
  }
});

// One virtualized cell: keeps a bounded window of a session's messages in the DOM.
class Cell {
  constructor(idx, root) {
    this.idx = idx;
    this.laneId = cellLanes[idx] || null;
    this.sessionKey = null;
    this.events = [];
    this.lastMtime = -1;
    this.sel = root.querySelector('select');
    this.body = root.querySelector('.active-cell-body');
    this.content = root.querySelector('.active-cell-content');
    this.meta = root.querySelector('.active-cell-meta');
    this.live = root.querySelector('.active-cell-live');
    this.pin = root.querySelector('.active-pin');
    this.pinned = true;   // follow newest output by default; only the button changes it
    this.sel.addEventListener('change', () => {
      this.laneId = this.sel.value || null;
      cellLanes[this.idx] = this.sel.value;
      saveCellLanes();
      this.reset();
      tick();
    });
    this.pin.addEventListener('click', () => this.setPinned(!this.pinned));
    // While pinned, keep glued to the bottom whenever the content height changes —
    // covers new messages, reflow, and content-visibility correcting a tall message's
    // height after render (which is what left it short of the bottom before).
    this.ro = new ResizeObserver(() => { if (this.pinned) this.scrollBottom(); });
    this.ro.observe(this.content);
    this.updatePinUI();
    this.reset();
  }
  destroy() { if (this.ro) this.ro.disconnect(); }
  setPinned(v) {
    this.pinned = v;
    this.updatePinUI();
    if (v) this.scrollBottom();
  }
  updatePinUI() {
    this.pin.classList.toggle('on', this.pinned);
    this.pin.textContent = this.pinned ? '⤓ pinned' : '⤓ pin';
  }
  reset() {
    this.sessionKey = null; this.events = []; this.lastMtime = -1;
    this.setEmpty(this.laneId ? 'waiting for a session…' : 'pick a task above');
  }
  setEmpty(msg) {
    this.content.innerHTML = '<div class="active-cell-empty">' + msg + '</div>';
  }
  clearEmpty() { const e = this.content.querySelector('.active-cell-empty'); if (e) e.remove(); }
  scrollBottom() { this.body.scrollTop = this.body.scrollHeight; }

  // Fresh events for the current session (append-only) or a brand-new session. Every
  // message stays in the DOM so the scrollbar spans the whole session; off-screen ones
  // are skipped by the browser via `content-visibility: auto` (see the cell CSS), so a
  // long transcript stays fast without breaking the scrollbar.
  update(sessionKey, events) {
    if (sessionKey !== this.sessionKey) {          // new (or first) session → full render
      this.sessionKey = sessionKey;
      this.events = events;
      const frag = document.createDocumentFragment();
      for (const ev of events) frag.appendChild(renderMessage(ev));
      this.content.innerHTML = '';
      this.content.appendChild(frag);
      this.scrollBottom();   // ResizeObserver keeps it pinned as heights settle
      return;
    }
    if (events.length <= this.events.length) { this.events = events; return; }
    const frag = document.createDocumentFragment();
    for (let i = this.events.length; i < events.length; i++) frag.appendChild(renderMessage(events[i]));
    this.events = events;
    this.clearEmpty();
    this.content.appendChild(frag);
    if (this.pinned) this.scrollBottom();   // ResizeObserver re-pins after layout settles
  }

  setMeta(rec, running) {
    if (rec) {
      this.meta.textContent = rec.sibling.replace(/^claude-/, '') + ' · ' + rec.sessionId.slice(0, 8) + ' · ' + fmtTime(rec.mtime);
      this.live.classList.toggle('on', !!running);
      this.live.textContent = running ? 'live' : '';
    } else {
      this.meta.textContent = this.laneId ? 'no session yet' : '';
      this.live.classList.remove('on'); this.live.textContent = '';
    }
  }
  refreshOptions() {
    const want = this.laneId || '';
    const cur = Array.from(this.sel.options).map(o => o.value).join('|');
    const next = [''].concat(lanes.map(l => l.id)).join('|');
    if (cur === next) { this.sel.value = want; return; }
    this.sel.innerHTML = '';
    const none = document.createElement('option'); none.value = ''; none.textContent = '— pick a task —';
    this.sel.appendChild(none);
    for (const l of lanes) {
      const o = document.createElement('option'); o.value = l.id;
      o.textContent = l.name + (l.kind === 'corner' ? ' (corner)' : '');
      this.sel.appendChild(o);
    }
    this.sel.value = want;
  }
}

const cells = [];

function buildGrid() {
  const grid = document.getElementById('active-grid');
  for (const c of cells) c.destroy();
  cells.length = 0;
  grid.innerHTML = '';
  const n = gridCols * gridRows;
  for (let i = 0; i < n; i++) {
    const cell = document.createElement('div');
    cell.className = 'active-cell';
    cell.innerHTML =
      '<div class="active-cell-head">'
      + '<select></select>'
      + '<span class="active-cell-meta"></span>'
      + '<span class="active-cell-live"></span>'
      + '<button class="active-pin" title="pin to newest — auto-scroll as new output arrives"></button>'
      + '</div>'
      + '<div class="active-cell-body"><div class="active-cell-content"></div></div>';
    grid.appendChild(cell);
    cells.push(new Cell(i, cell));
  }
  applyLayoutStyle();
}

function laneById(id) { return lanes.find(l => l.id === id) || null; }

// Most recent session across a lane's siblings: {sibling, sessionId, mtime}.
function mostRecentSession(laneId) {
  let best = null;
  for (const s of siblings) {
    if ((s.lane || 'corner') !== laneId) continue;
    for (const sess of (s.sessions || [])) {
      if (!best || sess.mtime > best.mtime) best = { sibling: s.name, sessionId: sess.id, mtime: sess.mtime };
    }
  }
  return best;
}

async function fetchSession(sibling, sessionId) {
  try {
    const r = await fetch('/api/session/' + sibling + '/' + sessionId, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

let tickBusy = false;
async function tick() {
  if (tickBusy) return;
  tickBusy = true;
  try {
    const [stRes, sibRes] = await Promise.all([
      fetch('/api/state', { cache: 'no-store' }),
      fetch('/api/siblings', { cache: 'no-store' }),
    ]);
    if (stRes.ok) { const s = await stRes.json(); lanes = Array.isArray(s.lanes) ? s.lanes : []; }
    if (sibRes.ok) siblings = await sibRes.json();
    document.getElementById('active-status').textContent =
      lanes.length + ' task' + (lanes.length === 1 ? '' : 's') + ' · updated ' + new Date().toLocaleTimeString();

    for (const cell of cells) {
      cell.refreshOptions();
      if (!cell.laneId) { cell.setMeta(null); continue; }
      const rec = mostRecentSession(cell.laneId);
      const lane = laneById(cell.laneId);
      if (!rec) { if (cell.sessionKey) cell.reset(); cell.setMeta(null); continue; }
      const key = rec.sibling + '/' + rec.sessionId;
      cell.setMeta(rec, lane && lane.running);
      // Skip the fetch if nothing changed since last time (same session, same mtime).
      if (key === cell.sessionKey && rec.mtime === cell.lastMtime) continue;
      cell.lastMtime = rec.mtime;
      const events = await fetchSession(rec.sibling, rec.sessionId);
      if (events) cell.update(key, events);
    }
  } catch (e) {
    document.getElementById('active-status').textContent = 'error: ' + e.message;
  } finally { tickBusy = false; }
}

applyFont();
updateLayoutUI();
buildGrid();
tick();
setInterval(tick, 2000);
</script>
</body>
</html>
"""

# /app.css serves the main page's <style> block so the /active page shares the exact
# same visual language (message/tool/diff styling, color vars) without duplication.
_APP_CSS_CACHE: str | None = None


def _app_css() -> str:
    global _APP_CSS_CACHE
    if _APP_CSS_CACHE is None:
        m = re.search(r"<style>(.*?)</style>", INDEX_HTML, re.S)
        _APP_CSS_CACHE = m.group(1) if m else ""
    return _APP_CSS_CACHE


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
    sessions.sort(key=lambda s: s["mtime"], reverse=True)
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


FILE_EXCLUDE_DIRS = {".git", ".claude", "node_modules", "__pycache__",
                     ".venv", "venv", ".next", "runs"}
FILE_EXCLUDE_NAMES = {".statusline.last", ".statusline.input",
                      ".statusline.last.tmp", ".statusline.input.tmp"}
MAX_LISTED_FILES = 2000


def _list_files(work_dir: Path) -> list[dict]:
    """List files under work_dir for the UI. Prunes heavy dirs (node_modules,
    .git, runs, …) during the walk and caps the count, so pointing a lane at a
    large directory doesn't make /api/siblings huge or slow."""
    if not work_dir.exists():
        return []
    out: list[dict] = []
    base = str(work_dir)
    for root, dirnames, filenames in os.walk(work_dir):
        # prune excluded dirs in place so os.walk doesn't descend into them
        dirnames[:] = [d for d in dirnames if d not in FILE_EXCLUDE_DIRS]
        for name in filenames:
            if name in FILE_EXCLUDE_NAMES:
                continue
            full = os.path.join(root, name)
            rel = os.path.relpath(full, base)
            try:
                st = os.stat(full)
            except OSError:
                continue
            out.append({"path": rel.replace(os.sep, "/"),
                        "size": st.st_size, "mtime": st.st_mtime})
            if len(out) >= MAX_LISTED_FILES:
                out.sort(key=lambda x: x["path"])
                out.append({"path": f"… (truncated at {MAX_LISTED_FILES} files)",
                            "size": 0, "mtime": 0})
                return out
    out.sort(key=lambda x: x["path"])
    return out


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


def make_app(runs_dir: Path, statusline_last: Path, controls=None) -> Flask:
    app = Flask(__name__)

    def _lane_workdirs() -> dict:
        """lane_id -> lane dict, for lanes that run in a fixed workdir."""
        out = {}
        if controls is not None and hasattr(controls, "get_state"):
            try:
                for l in controls.get_state().get("lanes", []):
                    if l.get("workdir"):
                        out[l["id"]] = l
            except Exception:
                pass
        return out

    def _resolve_work_dir(sibling: str):
        """Map a sibling id to its work dir. Real worktrees are 'claude-<id>'
        under runs/; fixed-workdir lanes are addressed as 'lane:<id>'."""
        if "/" in sibling or ".." in sibling:
            return None
        if sibling.startswith("claude-"):
            return runs_dir / sibling / "work"
        if sibling.startswith("lane:"):
            lane = _lane_workdirs().get(sibling[len("lane:"):])
            if lane and lane.get("workdir"):
                return Path(lane["workdir"])
        return None

    @app.route("/")
    def index():
        return render_template_string(INDEX_HTML)

    @app.route("/active")
    def active():
        return Response(ACTIVE_HTML, mimetype="text/html")

    @app.route("/render.js")
    def render_js():
        return Response(RENDER_JS, mimetype="application/javascript")

    @app.route("/app.css")
    def app_css():
        return Response(_app_css(), mimetype="text/css")

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
                work = d / "work"
                lane = "corner"
                mf = d / ".mode"
                if mf.exists():
                    try:
                        v = mf.read_text().strip()
                        if v:
                            lane = v
                    except OSError:
                        pass
                result.append({
                    "name": d.name,
                    "label": d.name,
                    "mtime": mtime,
                    "lane": lane,
                    "sessions": _find_sessions(work),
                    "files": _list_files(work),
                })
        # Fixed-workdir lanes have no runs/ worktree — surface them directly so
        # their sessions and files still show in the UI under their tab.
        for lane_id, lane in _lane_workdirs().items():
            work = Path(lane["workdir"])
            sessions = _find_sessions(work)
            try:
                mtime = max([s["mtime"] for s in sessions], default=work.stat().st_mtime)
            except OSError:
                mtime = 0
            result.append({
                "name": f"lane:{lane_id}",
                "label": f"{lane['name']} · {lane['workdir']}",
                "mtime": mtime,
                "lane": lane_id,
                "sessions": sessions,
                "files": _list_files(work),
            })
        result.sort(key=lambda s: s["mtime"], reverse=True)
        return jsonify(result)

    @app.route("/api/session/<sibling>/<session_id>")
    def api_session(sibling, session_id):
        if "/" in session_id or ".." in session_id:
            return jsonify({"error": "bad path"}), 400
        work_dir = _resolve_work_dir(sibling)
        if work_dir is None:
            return jsonify({"error": "bad path"}), 400
        proj_dir = PROJECTS / _sanitize(work_dir)
        jsonl = proj_dir / f"{session_id}.jsonl"
        if not jsonl.exists():
            return jsonify({"error": "session not found"}), 404
        return jsonify(_parse_session(jsonl))

    @app.route("/file/<sibling>/<path:filepath>")
    def file_serve(sibling, filepath):
        work = _resolve_work_dir(sibling)
        if work is None:
            return abort(400)
        try:
            full = (work / filepath).resolve()
            work_resolved = work.resolve()
        except Exception:
            return abort(400)
        if full != work_resolved and work_resolved not in full.parents:
            return abort(400)
        if not full.exists() or not full.is_file():
            return abort(404)
        rel_parts = full.relative_to(work_resolved).parts
        if any(p in FILE_EXCLUDE_DIRS for p in rel_parts) or full.name in FILE_EXCLUDE_NAMES:
            return abort(403)
        return send_file(full)

    # --- task board (per-lane markdown board under <workdir>/board/) -----------
    # A board handle is the same string used to address a work dir elsewhere:
    # 'claude-<id>' for a sibling worktree, or 'lane:<id>' for a fixed-workdir
    # lane. Claude edits the board files directly; these endpoints are the human
    # side of the same store (the web UI's add / move / edit / delete).

    def _all_lanes():
        if controls is not None and hasattr(controls, "get_state"):
            try:
                return controls.get_state().get("lanes", [])
            except Exception:
                pass
        return []

    def _board_work_dir(handle: str):
        """Resolve a board handle to the directory that holds its board/ folder. For
        a fixed-workdir lane ('lane:<id>') that's the lane's board_dir (which may be a
        subdir of, or separate from, the working dir), defaulting to the working dir.
        For a sibling worktree it's the sibling's work dir."""
        if handle.startswith("lane:"):
            lane = next((l for l in _all_lanes() if l.get("id") == handle[len("lane:"):]), None)
            if lane is None:
                return None
            bd = board.resolve_dir(lane.get("workdir") or None, lane.get("board_dir") or None)
            if bd is None:
                return None
            board.ensure_board(bd)
            return bd
        work = _resolve_work_dir(handle)
        if work is None:
            return None
        board.ensure_board(work)
        return work

    @app.route("/api/board/<handle>")
    def api_board_get(handle):
        work = _board_work_dir(handle)
        if work is None:
            return jsonify({"error": "bad board handle"}), 400
        return jsonify({"handle": handle, "tasks": board.list_tasks(work)})

    @app.route("/api/board/<handle>/task", methods=["POST"])
    def api_board_create(handle):
        work = _board_work_dir(handle)
        if work is None:
            return jsonify({"error": "bad board handle"}), 400
        data = request.get_json(force=True, silent=True) or {}
        title = data.get("title", "")
        if not isinstance(title, str) or not title.strip():
            return jsonify({"error": "title must be a non-empty string"}), 400
        body = data.get("body", "")
        status = data.get("status", "todo")
        by = data.get("by")
        try:
            task = board.create_task(work, title, body if isinstance(body, str) else "",
                                     status if isinstance(status, str) else "todo",
                                     by if isinstance(by, str) else None)
        except OSError as e:
            return jsonify({"error": f"write failed: {e}"}), 500
        return jsonify(task)

    @app.route("/api/board/<handle>/task/<task_id>/status", methods=["POST"])
    def api_board_status(handle, task_id):
        work = _board_work_dir(handle)
        if work is None:
            return jsonify({"error": "bad board handle"}), 400
        data = request.get_json(force=True, silent=True) or {}
        status = data.get("status")
        if status not in board.STATUSES:
            return jsonify({"error": f"status must be one of {board.STATUSES}"}), 400
        by = data.get("by")
        task = board.set_status(work, task_id, status, by if isinstance(by, str) else None)
        if task is None:
            return jsonify({"error": "task not found"}), 404
        return jsonify(task)

    @app.route("/api/board/<handle>/task/<task_id>/raw", methods=["POST"])
    def api_board_raw(handle, task_id):
        work = _board_work_dir(handle)
        if work is None:
            return jsonify({"error": "bad board handle"}), 400
        data = request.get_json(force=True, silent=True) or {}
        content = data.get("content", "")
        if not isinstance(content, str):
            return jsonify({"error": "content must be a string"}), 400
        task = board.write_raw(work, task_id, content)
        if task is None:
            return jsonify({"error": "task not found"}), 404
        return jsonify(task)

    @app.route("/api/board/<handle>/task/<task_id>/delete", methods=["POST"])
    def api_board_delete(handle, task_id):
        work = _board_work_dir(handle)
        if work is None:
            return jsonify({"error": "bad board handle"}), 400
        if not board.delete_task(work, task_id):
            return jsonify({"error": "task not found"}), 404
        return jsonify({"deleted": task_id})

    @app.route("/api/state")
    def api_state():
        if controls is None:
            return jsonify({"running": None, "error": "no controls wired"}), 500
        return jsonify(controls.get_state())

    @app.route("/api/control/running", methods=["POST"])
    def api_set_running():
        if controls is None:
            return jsonify({"error": "no controls wired"}), 500
        data = request.get_json(force=True, silent=True) or {}
        v = bool(data.get("running"))
        controls.set_running(v)
        return jsonify({"running": v})

    @app.route("/api/notify-done", methods=["POST"])
    def api_notify_done():
        """Called by a sibling (typically via curl from inside the sandbox) to
        signal task completion. Sends a zulip message via the configured script
        and pauses the calling lane (other lanes keep running)."""
        if controls is None or not hasattr(controls, "notify_done"):
            return jsonify({"error": "no controls wired"}), 500
        data = request.get_json(force=True, silent=True) or {}
        message = data.get("message", "")
        if not isinstance(message, str) or not message.strip():
            return jsonify({"error": "message must be a non-empty string"}), 400
        lane = data.get("lane")
        lane = lane.strip() if isinstance(lane, str) and lane.strip() else None
        result = controls.notify_done(message.strip(), lane)
        return jsonify(result)

    @app.route("/api/control/template", methods=["POST"])
    def api_set_template():
        if controls is None or not hasattr(controls, "set_template"):
            return jsonify({"error": "no controls wired"}), 500
        data = request.get_json(force=True, silent=True) or {}
        kind = data.get("kind")
        text = data.get("template", "")
        if not isinstance(kind, str) or not isinstance(text, str):
            return jsonify({"error": "kind and template must be strings"}), 400
        try:
            fname = controls.set_template(kind, text)
        except OSError as e:
            return jsonify({"error": f"write failed: {e}"}), 500
        if fname is None:
            return jsonify({"error": f"unknown kind {kind!r}"}), 400
        return jsonify({"template_file": fname})

    @app.route("/api/control/lane/prompt", methods=["POST"])
    def api_set_lane_prompt():
        if controls is None or not hasattr(controls, "set_lane_prompt"):
            return jsonify({"error": "no controls wired"}), 500
        data = request.get_json(force=True, silent=True) or {}
        lane = data.get("lane")
        text = data.get("prompt", "")
        if not isinstance(lane, str) or not isinstance(text, str):
            return jsonify({"error": "lane and prompt must be strings"}), 400
        try:
            res = controls.set_lane_prompt(lane, text)
        except OSError as e:
            return jsonify({"error": f"write failed: {e}"}), 500
        if res is None:
            return jsonify({"error": f"unknown lane {lane!r}"}), 404
        return jsonify({"lane": res})

    @app.route("/api/control/lane/slots", methods=["POST"])
    def api_set_lane_slots():
        if controls is None or not hasattr(controls, "set_lane_slots"):
            return jsonify({"error": "no controls wired"}), 500
        data = request.get_json(force=True, silent=True) or {}
        lane = data.get("lane")
        slots = data.get("slots")
        if not isinstance(lane, str):
            return jsonify({"error": "lane must be a string"}), 400
        res = controls.set_lane_slots(lane, slots)
        if res is None:
            return jsonify({"error": f"unknown lane {lane!r} or bad slots"}), 400
        return jsonify({"slots": res})

    @app.route("/api/control/lane/workdir", methods=["POST"])
    def api_set_lane_workdir():
        if controls is None or not hasattr(controls, "set_lane_workdir"):
            return jsonify({"error": "no controls wired"}), 500
        data = request.get_json(force=True, silent=True) or {}
        lane = data.get("lane")
        workdir = data.get("workdir", "")
        if not isinstance(lane, str) or not isinstance(workdir, str):
            return jsonify({"error": "lane and workdir must be strings"}), 400
        res = controls.set_lane_workdir(lane, workdir)
        if res is None:
            return jsonify({"error": f"unknown lane {lane!r}"}), 404
        return jsonify(res)

    @app.route("/api/control/lane/board-dir", methods=["POST"])
    def api_set_lane_board_dir():
        if controls is None or not hasattr(controls, "set_lane_board_dir"):
            return jsonify({"error": "no controls wired"}), 500
        data = request.get_json(force=True, silent=True) or {}
        lane = data.get("lane")
        board_dir = data.get("board_dir", "")
        if not isinstance(lane, str) or not isinstance(board_dir, str):
            return jsonify({"error": "lane and board_dir must be strings"}), 400
        res = controls.set_lane_board_dir(lane, board_dir)
        if res is None:
            return jsonify({"error": f"unknown lane {lane!r}"}), 404
        return jsonify(res)

    @app.route("/api/control/lane/continuous", methods=["POST"])
    def api_set_lane_continuous():
        if controls is None or not hasattr(controls, "set_lane_continuous"):
            return jsonify({"error": "no controls wired"}), 500
        data = request.get_json(force=True, silent=True) or {}
        lane = data.get("lane")
        enabled = data.get("continuous")
        if not isinstance(lane, str) or not isinstance(enabled, bool):
            return jsonify({"error": "lane must be a string and continuous a bool"}), 400
        res = controls.set_lane_continuous(lane, enabled)
        if res is None:
            return jsonify({"error": f"unknown lane {lane!r}"}), 404
        return jsonify({"continuous": res})

    @app.route("/api/control/lane/until-board-clear", methods=["POST"])
    def api_set_lane_until_board_clear():
        if controls is None or not hasattr(controls, "set_lane_until_board_clear"):
            return jsonify({"error": "no controls wired"}), 500
        data = request.get_json(force=True, silent=True) or {}
        lane = data.get("lane")
        enabled = data.get("until_board_clear")
        if not isinstance(lane, str) or not isinstance(enabled, bool):
            return jsonify({"error": "lane must be a string and until_board_clear a bool"}), 400
        res = controls.set_lane_until_board_clear(lane, enabled)
        if res is None:
            return jsonify({"error": f"unknown lane {lane!r}"}), 404
        return jsonify({"until_board_clear": res})

    @app.route("/api/control/lane/message", methods=["POST"])
    def api_set_lane_message():
        if controls is None or not hasattr(controls, "set_lane_message"):
            return jsonify({"error": "no controls wired"}), 500
        data = request.get_json(force=True, silent=True) or {}
        lane = data.get("lane")
        text = data.get("message", "")
        if not isinstance(lane, str) or not isinstance(text, str):
            return jsonify({"error": "lane and message must be strings"}), 400
        res = controls.set_lane_message(lane, text)
        if res is None:
            return jsonify({"error": f"unknown lane {lane!r}"}), 404
        return jsonify({"message": res})

    @app.route("/api/control/lanes", methods=["POST"])
    def api_create_lane():
        if controls is None or not hasattr(controls, "create_lane"):
            return jsonify({"error": "no controls wired"}), 500
        data = request.get_json(force=True, silent=True) or {}
        name = data.get("name", "")
        kind = data.get("kind", "task")
        if not isinstance(name, str) or not name.strip():
            return jsonify({"error": "name must be a non-empty string"}), 400
        res = controls.create_lane(name, kind if isinstance(kind, str) else "task")
        if res is None:
            return jsonify({"error": "could not create lane"}), 400
        return jsonify(res)

    @app.route("/api/control/lane/rename", methods=["POST"])
    def api_rename_lane():
        if controls is None or not hasattr(controls, "rename_lane"):
            return jsonify({"error": "no controls wired"}), 500
        data = request.get_json(force=True, silent=True) or {}
        lane = data.get("lane")
        name = data.get("name", "")
        if not isinstance(lane, str) or not isinstance(name, str) or not name.strip():
            return jsonify({"error": "lane and a non-empty name are required"}), 400
        res = controls.rename_lane(lane, name)
        if res is None:
            return jsonify({"error": f"unknown lane {lane!r}"}), 404
        return jsonify({"name": res})

    @app.route("/api/control/lane/delete", methods=["POST"])
    def api_delete_lane():
        if controls is None or not hasattr(controls, "delete_lane"):
            return jsonify({"error": "no controls wired"}), 500
        data = request.get_json(force=True, silent=True) or {}
        lane = data.get("lane")
        if not isinstance(lane, str):
            return jsonify({"error": "lane must be a string"}), 400
        ok = controls.delete_lane(lane)
        if not ok:
            return jsonify({"error": "could not delete (built-in lane or unknown)"}), 400
        return jsonify({"deleted": lane})

    @app.route("/api/control/prompter", methods=["POST"])
    def api_set_prompter():
        if controls is None or not hasattr(controls, "set_prompter"):
            return jsonify({"error": "no controls wired"}), 500
        data = request.get_json(force=True, silent=True) or {}
        new_v = controls.set_prompter(bool(data.get("enabled")))
        return jsonify({"prompter_enabled": new_v})

    @app.route("/api/control/budget", methods=["POST"])
    def api_set_budget():
        if controls is None:
            return jsonify({"error": "no controls wired"}), 500
        data = request.get_json(force=True, silent=True) or {}
        try:
            pct = float(data.get("percent", 0))
        except (TypeError, ValueError):
            return jsonify({"error": "percent must be a number"}), 400
        if pct < 0:
            return jsonify({"error": "percent must be >= 0"}), 400
        new_pct = controls.set_budget_pct(pct)
        return jsonify({"budget_pct": new_pct})

    return app


def start_webui(port: int, runs_dir: Path, statusline_last: Path, controls=None) -> threading.Thread:
    """Start the Flask app in a daemon thread."""
    app = make_app(runs_dir, statusline_last, controls=controls)
    # Silence Flask's request log
    import logging
    logging.getLogger("werkzeug").setLevel(logging.WARNING)

    def _serve():
        app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False, threaded=True)

    t = threading.Thread(target=_serve, daemon=True)
    t.start()
    return t
