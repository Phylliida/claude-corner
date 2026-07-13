"""
Per-lane task board, stored as plain markdown files in the project directory.

The board for a lane lives in ``<workdir>/board/`` — one markdown file per task,
named ``<id>.md``. Each file has a small frontmatter block and a free markdown
body::

    ---
    title: Add zoom limits
    status: todo            # todo | in_progress | done
    claimed_by:            # who is working on it (a sibling id, or a name)
    created: 2026-07-13T10:00:00Z
    updated: 2026-07-13T10:00:00Z
    ---

    ## Description
    what needs doing…

    ## Progress
    - (2026-07-13T11:00Z) started on renderTile

    ## Writeup
    (filled in when done: findings, how the code works, assumptions made)

Because a task is just a markdown file, Claude edits it directly with its normal
file tools — claim a task by flipping ``status`` to ``in_progress``, finish by
setting ``status: done`` and filling in the writeup. The web UI parses the same
files to draw the kanban board and lets the human add / move / delete cards.

This module is the single writer used by the web UI; it never needs to run inside
the sandbox (Claude just edits files). Everything is stdlib-only.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

BOARD_DIRNAME = "board"
STATUSES = ("todo", "in_progress", "done")
# Files in board/ that are not tasks (docs / housekeeping).
RESERVED = {"readme.md", "index.md"}

_STATUS_SYNONYMS = {
    "todo": "todo", "backlog": "todo", "open": "todo", "new": "todo", "": "todo",
    "in_progress": "in_progress", "in progress": "in_progress", "in-progress": "in_progress",
    "doing": "in_progress", "wip": "in_progress", "active": "in_progress", "started": "in_progress",
    "done": "done", "complete": "done", "completed": "done", "finished": "done", "closed": "done",
}


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def board_dir(workdir: Path) -> Path:
    return Path(workdir) / BOARD_DIRNAME


def resolve_dir(workdir, board_setting=None):
    """The directory that holds a lane's ``board/`` folder. Defaults to the working
    directory; when a board_setting is given it overrides that — an absolute path is
    used as-is, a relative one is taken relative to the working directory (so e.g.
    workdir=/prog/verus-cad + board_setting='claude-corner' -> the board lives in
    /prog/verus-cad/claude-corner/board/). Returns None if there's nothing to resolve
    against (no workdir and no setting)."""
    setting = (str(board_setting).strip() if board_setting else "")
    if not setting:
        return Path(workdir) if workdir else None
    p = Path(setting).expanduser()
    if p.is_absolute():
        return p
    return (Path(workdir) / p) if workdir else p


def _is_task_file(p: Path) -> bool:
    if p.suffix.lower() != ".md":
        return False
    name = p.name.lower()
    if name.startswith(".") or name.startswith("_"):
        return False
    return name not in RESERVED


def _normalize_status(s: str | None) -> str:
    key = (s or "").strip().lower()
    return _STATUS_SYNONYMS.get(key, "todo" if key == "" else key if key in STATUSES else "todo")


def _split_frontmatter(text: str) -> tuple[dict, str]:
    """Split a leading ``---`` fenced ``key: value`` block from the body. Lenient:
    a file with no frontmatter parses to ({}, whole text)."""
    if not text.startswith("---"):
        return {}, text
    lines = text.splitlines()
    # first line is the opening fence (--- possibly with trailing spaces)
    if lines[0].strip() != "---":
        return {}, text
    meta: dict[str, str] = {}
    body_start = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            body_start = i + 1
            break
        m = re.match(r"\s*([A-Za-z0-9_.\- ]+?)\s*:\s*(.*)$", lines[i])
        if m:
            meta[m.group(1).strip().lower()] = m.group(2).strip()
    if body_start is None:
        return {}, text  # no closing fence — treat whole thing as body
    body = "\n".join(lines[body_start:])
    return meta, body.lstrip("\n")


def _derive_title(meta: dict, body: str, stem: str) -> str:
    if meta.get("title"):
        return meta["title"]
    for line in body.splitlines():
        s = line.strip()
        if s.startswith("#"):
            return s.lstrip("#").strip() or stem
        if s:
            return s
    return stem


def parse_task(path: Path) -> dict:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        text = ""
    meta, body = _split_frontmatter(text)
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = 0.0
    return {
        "id": path.stem,
        "file": path.name,
        "title": _derive_title(meta, body, path.stem),
        "status": _normalize_status(meta.get("status")),
        "claimed_by": meta.get("claimed_by", "") or meta.get("claimed by", ""),
        "created": meta.get("created", ""),
        "updated": meta.get("updated", ""),
        "body": body,
        "raw": text,
        "mtime": mtime,
    }


def list_tasks(workdir: Path) -> list[dict]:
    bdir = board_dir(workdir)
    if not bdir.is_dir():
        return []
    tasks = [parse_task(p) for p in bdir.iterdir() if p.is_file() and _is_task_file(p)]
    # newest activity first; the UI buckets them into columns by status.
    tasks.sort(key=lambda t: t["mtime"], reverse=True)
    return tasks


def get_task(workdir: Path, task_id: str) -> dict | None:
    p = _task_path(workdir, task_id)
    if p is None or not p.is_file():
        return None
    return parse_task(p)


def _slugify(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (title or "").lower()).strip("-")
    return (slug[:48] or "task")


def _safe_id(task_id: str) -> str | None:
    """Reject anything that isn't a bare filename stem (no separators / dots)."""
    task_id = (task_id or "").strip()
    if not task_id or "/" in task_id or "\\" in task_id or ".." in task_id:
        return None
    # strip a trailing .md if a caller passed the filename
    if task_id.lower().endswith(".md"):
        task_id = task_id[:-3]
    if not re.fullmatch(r"[A-Za-z0-9._\-]+", task_id):
        return None
    return task_id


def _task_path(workdir: Path, task_id: str) -> Path | None:
    tid = _safe_id(task_id)
    if tid is None:
        return None
    return board_dir(workdir) / f"{tid}.md"


def _unique_path(bdir: Path, stem: str) -> Path:
    cand = bdir / f"{stem}.md"
    n = 2
    while cand.exists():
        cand = bdir / f"{stem}-{n}.md"
        n += 1
    return cand


def render_task_file(meta: dict, body: str) -> str:
    """Compose a task file: canonical frontmatter keys first, then any extras."""
    order = ["title", "status", "claimed_by", "created", "updated"]
    lines = ["---"]
    for k in order:
        if k in meta:
            lines.append(f"{k}: {meta.get(k, '')}")
    for k, v in meta.items():
        if k not in order:
            lines.append(f"{k}: {v}")
    lines.append("---")
    out = "\n".join(lines) + "\n\n" + (body or "").lstrip("\n")
    if not out.endswith("\n"):
        out += "\n"
    return out


def _atomic_write(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def create_task(workdir: Path, title: str, body: str = "", status: str = "todo",
                by: str | None = None) -> dict:
    bdir = board_dir(workdir)
    bdir.mkdir(parents=True, exist_ok=True)
    now = _now()
    meta = {
        "title": (title or "").strip() or "untitled task",
        "status": _normalize_status(status),
        "claimed_by": (by or "").strip(),
        "created": now,
        "updated": now,
    }
    if not body.strip():
        body = ("## Description\n\n"
                "_describe the task here_\n\n"
                "## Progress\n\n"
                "## Writeup\n\n"
                "_when done: findings, how the code works, assumptions made_\n")
    path = _unique_path(bdir, _slugify(meta["title"]))
    _atomic_write(path, render_task_file(meta, body))
    return parse_task(path)


def set_status(workdir: Path, task_id: str, status: str, by: str | None = None) -> dict | None:
    p = _task_path(workdir, task_id)
    if p is None or not p.is_file():
        return None
    meta, body = _split_frontmatter(p.read_text(encoding="utf-8", errors="replace"))
    meta.setdefault("title", _derive_title(meta, body, p.stem))
    meta.setdefault("created", _now())
    meta["status"] = _normalize_status(status)
    if by is not None:
        meta["claimed_by"] = by.strip()
    meta["updated"] = _now()
    _atomic_write(p, render_task_file(meta, body))
    return parse_task(p)


def write_raw(workdir: Path, task_id: str, content: str) -> dict | None:
    """Overwrite a task file with human-edited raw markdown (from the UI editor)."""
    p = _task_path(workdir, task_id)
    if p is None or not p.is_file():
        return None
    _atomic_write(p, content if content.endswith("\n") else content + "\n")
    return parse_task(p)


def delete_task(workdir: Path, task_id: str) -> bool:
    p = _task_path(workdir, task_id)
    if p is None or not p.is_file():
        return False
    try:
        p.unlink()
        return True
    except OSError:
        return False


_README = """\
# Task board

This directory is a simple task board. **One markdown file = one task.** Add,
claim, and finish tasks just by creating and editing these `.md` files with your
normal file tools — no server, no JSON. The web UI reads these same files to draw
the board, so anything you write here shows up there.

## File format

    ---
    title: short title of the task
    status: todo            # todo | in_progress | done
    claimed_by:            # your sibling id, or a name (optional)
    created: <iso8601>
    updated: <iso8601>
    ---

    ## Description
    what the task is / what "done" looks like

    ## Progress
    - (timestamp) a running log of what you tried / found

    ## Writeup
    (fill this in when done: findings, how the code works, and any assumptions
     you made — this is what the human reads to understand what happened)

## Workflow

- **Pick a task:** open a `status: todo` file, set `status: in_progress`, and put
  your id in `claimed_by`. Prefer a task nobody else has claimed.
- **Make a new task:** create `board/<slug>.md` with `status: todo`. Break big
  work into small, checkable tasks.
- **Log progress:** append to `## Progress` as you go, so the next you (and the
  human) can follow the thread.
- **Finish:** set `status: done` and fill in `## Writeup` — findings, how the
  code works, assumptions. Be honest about what's partial or unverified.
- **Commit:** once a task is done, commit your work with git
  (`git add -A && git commit -m "<what you did>"`) so the finished task and its
  writeup are checkpointed.

Files starting with `.` or `_`, plus this README, are ignored by the board.
"""


def _session_file(workdir: Path) -> Path:
    return board_dir(workdir) / ".active_session.json"


def record_session(workdir: Path, session_id: str) -> None:
    """Record which claude session id belongs to this board (i.e. this lane), inside
    board/. When several lanes share a working directory but have different board
    dirs, this is how the UI tells their sessions apart instead of guessing 'most
    recent in the workdir' (which thrashes between the lanes)."""
    if not session_id:
        return
    try:
        bdir = board_dir(workdir)
        bdir.mkdir(parents=True, exist_ok=True)
        _atomic_write(_session_file(workdir),
                      json.dumps({"session_id": session_id, "recorded": _now()}) + "\n")
    except OSError:
        pass


def read_session(workdir: Path) -> dict | None:
    """The session recorded for this board, or None. {"session_id", "recorded"}."""
    try:
        p = _session_file(workdir)
        if not p.is_file():
            return None
        d = json.loads(p.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) and d.get("session_id") else None
    except (OSError, ValueError):
        return None


def ensure_board(workdir: Path) -> None:
    """Create board/ and a README documenting the format, if they don't exist."""
    try:
        bdir = board_dir(workdir)
        bdir.mkdir(parents=True, exist_ok=True)
        readme = bdir / "README.md"
        if not readme.exists():
            readme.write_text(_README, encoding="utf-8")
    except OSError:
        pass


def all_done(workdir: Path) -> bool:
    """True when the board has at least one task and every task is done — i.e. the
    board is 'clear' of open work. An empty board returns False (nothing has been
    completed yet, so a 'run until the board is done' lane keeps running and gives
    claude a chance to populate it)."""
    tasks = list_tasks(workdir)
    if not tasks:
        return False
    return all(t["status"] == "done" for t in tasks)


def counts(workdir: Path) -> dict:
    """{status: n} plus 'total', for status lines / notifications."""
    tasks = list_tasks(workdir)
    out = {s: 0 for s in STATUSES}
    for t in tasks:
        out[t["status"]] = out.get(t["status"], 0) + 1
    out["total"] = len(tasks)
    return out


def open_digest(workdir: Path, max_items: int = 20) -> str:
    """Titles of the tasks that are todo or in progress, for the companion model's
    context. Empty string when there's no board or nothing open (e.g. corner lanes,
    which have no board dir — this never creates one)."""
    open_tasks = [t for t in list_tasks(workdir) if t["status"] in ("todo", "in_progress")]
    if not open_tasks:
        return ""
    # in-progress first, then todo; each keeps its newest-first order from list_tasks
    ordered = ([t for t in open_tasks if t["status"] == "in_progress"]
               + [t for t in open_tasks if t["status"] == "todo"])
    lines: list[str] = []
    for t in ordered[:max_items]:
        label = "in progress" if t["status"] == "in_progress" else "todo"
        who = f" (claimed by {t['claimed_by']})" if t["claimed_by"] else ""
        lines.append(f"- [{label}] {t['title']}{who}")
    if len(ordered) > max_items:
        lines.append(f"- … and {len(ordered) - max_items} more")
    return "\n".join(lines)


def summary(workdir: Path, max_items: int = 12) -> str:
    """A compact text digest of the board for injecting into a prompt."""
    tasks = list_tasks(workdir)
    if not tasks:
        return "(the board is empty — no tasks yet)"
    by_status = {s: [t for t in tasks if t["status"] == s] for s in STATUSES}
    lines: list[str] = []
    counts = " · ".join(f"{len(by_status[s])} {s.replace('_', ' ')}" for s in STATUSES)
    lines.append(f"board: {counts}")
    for s, label in (("in_progress", "in progress"), ("todo", "todo"), ("done", "done")):
        items = by_status[s]
        if not items:
            continue
        shown = items[:max_items]
        lines.append(f"  {label}:")
        for t in shown:
            who = f" [{t['claimed_by']}]" if t["claimed_by"] else ""
            lines.append(f"    - {t['id']}: {t['title']}{who}")
        if len(items) > len(shown):
            lines.append(f"    … and {len(items) - len(shown)} more")
    return "\n".join(lines)
