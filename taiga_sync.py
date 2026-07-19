"""Two-way sync between per-lane markdown boards and a self-hosted Taiga.

Each lane's ``board/`` directory (see :mod:`board`) is mirrored to one Taiga
project: **one task file = one user story**. Sync runs host-side — sandboxed
Claude instances can't reach the network, they only ever edit the markdown.

Linkage lives in the task's frontmatter, so it survives moves and is visible to
anyone reading the file::

    taiga_id: 42            # user story id
    taiga_version: 7        # Taiga's optimistic-concurrency counter, as of last sync
    synced_hash: a1b2c3…    # fingerprint of the local file, as of last sync

Those three fields make a real three-way diff possible:

===================  ==================  ========================================
local changed?       remote changed?     action
===================  ==================  ========================================
no                   no                  nothing
yes                  no                  PATCH the story
no                   yes                 rewrite the task file
yes                  yes                 **conflict** — see below
===================  ==================  ========================================

A conflict is written *into the task file*: ``sync: conflict`` in frontmatter
plus a ``## Conflict (Taiga)`` block holding the remote side. Claude instances
already read and edit these files as their normal loop, so they resolve a
conflict by merging the prose and deleting the block — no tool surface needed
inside the sandbox. Sync leaves a conflicted task strictly alone until the
marker is gone; on the next pass, the merged local file wins and is pushed.

Deletions can't be inferred from the files alone (a missing file and a
never-synced story look identical), so a ``board/.taiga_sync.json`` sidecar
records which stories this board has seen. It starts with a dot, so
``board._is_task_file`` already skips it.

CLI::

    python3 taiga_sync.py status
    python3 taiga_sync.py link <lane> [--create] [--project <slug>]
    python3 taiga_sync.py sync [lane …] [--dry-run]
    python3 taiga_sync.py conflicts
    python3 taiga_sync.py resolve <lane> <task> --local|--remote

Stdlib only, like the rest of this directory.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import board

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "taiga_config.json"
TOKEN_PATH = HERE / ".taiga_token.json"
LANES_PATH = HERE / "lanes" / "lanes.json"
SIDECAR_NAME = ".taiga_sync.json"

CONFLICT_START = "<!-- taiga-conflict:start -->"
CONFLICT_END = "<!-- taiga-conflict:end -->"

# Frontmatter keys this module owns. Everything else is the board's.
SYNC_KEYS = ("taiga_id", "taiga_version", "synced_hash", "sync")


class TaigaError(Exception):
    """An API call failed in a way the caller should see."""


# --------------------------------------------------------------------------
# API client
# --------------------------------------------------------------------------

class TaigaClient:
    """Thin Taiga REST client. Caches its auth token on disk between runs."""

    def __init__(self, host: str, username: str, password: str,
                 token_path: Path = TOKEN_PATH):
        self.host = host.rstrip("/")
        self.username = username
        self.password = password
        self.token_path = Path(token_path)
        self._token: str | None = None
        self._refresh: str | None = None
        self._load_token()

    # -- token handling ----------------------------------------------------

    def _load_token(self) -> None:
        try:
            cached = json.loads(self.token_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if cached.get("username") == self.username:
            self._token = cached.get("auth_token")
            self._refresh = cached.get("refresh")

    def _save_token(self) -> None:
        payload = {"username": self.username, "auth_token": self._token,
                   "refresh": self._refresh}
        try:
            self.token_path.write_text(json.dumps(payload), encoding="utf-8")
            self.token_path.chmod(0o600)
        except OSError:
            pass  # a non-writable cache is not worth failing a sync over

    def login(self) -> dict:
        data = self._raw("POST", "auth", {
            "type": "normal", "username": self.username, "password": self.password,
        }, auth=False)
        self._token = data["auth_token"]
        self._refresh = data.get("refresh")
        self._save_token()
        return data

    def _try_refresh(self) -> bool:
        if not self._refresh:
            return False
        try:
            data = self._raw("POST", "auth/refresh", {"refresh": self._refresh},
                             auth=False)
        except TaigaError:
            return False
        self._token = data.get("auth_token")
        self._refresh = data.get("refresh", self._refresh)
        self._save_token()
        return bool(self._token)

    # -- requests ----------------------------------------------------------

    def _raw(self, method: str, path: str, data=None, auth: bool = True):
        url = f"{self.host}/api/v1/{path.lstrip('/')}"
        body = json.dumps(data).encode("utf-8") if data is not None else None
        req = urllib.request.Request(url, data=body, method=method)
        req.add_header("Content-Type", "application/json")
        if auth and self._token:
            req.add_header("Authorization", f"Bearer {self._token}")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as exc:
            detail = (exc.read() or b"").decode("utf-8", "replace")
            raise TaigaError(f"{method} {path} -> {exc.code}: {detail[:400]}") from exc
        except urllib.error.URLError as exc:
            raise TaigaError(f"{method} {path} -> unreachable: {exc.reason}") from exc

    def request(self, method: str, path: str, data=None):
        """Authenticated request that re-authenticates once on a 401."""
        if not self._token:
            self.login()
        try:
            return self._raw(method, path, data)
        except TaigaError as exc:
            if "-> 401" not in str(exc):
                raise
            if not self._try_refresh():
                self.login()
            return self._raw(method, path, data)

    # -- endpoints ---------------------------------------------------------

    def me(self) -> dict:
        return self.request("GET", "users/me")

    def projects(self) -> list[dict]:
        return self.request("GET", "projects") or []

    def project(self, project_id: int) -> dict:
        return self.request("GET", f"projects/{project_id}")

    def project_by_slug(self, slug: str) -> dict | None:
        try:
            return self.request("GET", f"projects/by_slug?slug={urllib.parse.quote(slug)}")
        except TaigaError as exc:
            if "-> 404" in str(exc):
                return None
            raise

    def create_project(self, name: str, description: str = "") -> dict:
        return self.request("POST", "projects", {
            "name": name,
            "description": description or name,
            "is_private": True,
            "is_kanban_activated": True,
            "is_backlog_activated": False,
        })

    def stories(self, project_id: int) -> list[dict]:
        return self.request("GET", f"userstories?project={project_id}") or []

    def create_story(self, project_id: int, subject: str, description: str,
                     status_id: int | None, assigned_to: int | None = None) -> dict:
        payload = {"project": project_id, "subject": subject,
                   "description": description or ""}
        if status_id is not None:
            payload["status"] = status_id
        if assigned_to is not None:
            payload["assigned_to"] = assigned_to
        return self.request("POST", "userstories", payload)

    def update_story(self, story_id: int, version: int, **fields) -> dict:
        payload = dict(fields)
        payload["version"] = version
        return self.request("PATCH", f"userstories/{story_id}", payload)

    def delete_story(self, story_id: int) -> None:
        self.request("DELETE", f"userstories/{story_id}")


# --------------------------------------------------------------------------
# Config / lanes
# --------------------------------------------------------------------------

def load_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except OSError:
        raise TaigaError(f"no config at {CONFIG_PATH} — see the module docstring")
    except ValueError as exc:
        raise TaigaError(f"{CONFIG_PATH} is not valid JSON: {exc}")


def save_config(cfg: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")


def client_from(cfg: dict) -> TaigaClient:
    missing = [k for k in ("host", "username", "password") if not cfg.get(k)]
    if missing:
        raise TaigaError(f"config is missing: {', '.join(missing)}")
    return TaigaClient(cfg["host"], cfg["username"], cfg["password"])


def load_lanes() -> list[dict]:
    try:
        return json.loads(LANES_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def lane_board_root(lane: dict) -> Path | None:
    """The directory that *contains* the lane's ``board/`` folder, or None."""
    return board.resolve_dir(lane.get("workdir"), lane.get("board_dir"))


# --------------------------------------------------------------------------
# Status mapping
# --------------------------------------------------------------------------

def build_status_map(project: dict) -> tuple[dict, dict, list[str]]:
    """Map local statuses onto this project's user-story statuses.

    Taiga projects carry an arbitrary, user-configured status list; the local
    board has exactly three. Returns ``(local -> status_id, status_id -> local,
    notes)`` where *notes* explains any judgement call, since the middle states
    ("Ready", "Ready for test") genuinely don't have an obvious home.
    """
    statuses = project.get("us_statuses") or []
    to_local: dict[int, str] = {}
    notes: list[str] = []

    for st in statuses:
        name = (st.get("name") or "").strip().lower()
        sid = st["id"]
        if st.get("is_closed") or name in ("done", "closed", "archived", "finished"):
            to_local[sid] = "done"
        elif "progress" in name or name in ("doing", "wip", "active", "started"):
            to_local[sid] = "in_progress"
        elif "ready for test" in name or name in ("testing", "in review", "review"):
            # Work has been done but isn't accepted — closer to in_progress than done.
            to_local[sid] = "in_progress"
            notes.append(f"{st['name']!r} -> in_progress (post-work, pre-accept)")
        else:
            # New / Ready / Backlog / anything unrecognised parks in todo.
            to_local[sid] = "todo"
            if name not in ("new", "ready", "todo", "backlog", "open"):
                notes.append(f"{st['name']!r} -> todo (unrecognised, defaulted)")

    # Pushing needs one canonical target per local status: the first status that
    # maps to it, in the project's own display order.
    to_taiga: dict[str, int] = {}
    for st in sorted(statuses, key=lambda s: s.get("order", 0)):
        local = to_local.get(st["id"])
        if local and local not in to_taiga:
            to_taiga[local] = st["id"]

    for local in board.STATUSES:
        if local not in to_taiga:
            notes.append(f"no Taiga status maps to {local!r} — those tasks won't push cleanly")

    return to_taiga, to_local, notes


# --------------------------------------------------------------------------
# Local task representation
# --------------------------------------------------------------------------

def read_task_file(path: Path) -> tuple[dict, str]:
    text = path.read_text(encoding="utf-8", errors="replace")
    return board._split_frontmatter(text)


def fingerprint(meta: dict, body: str) -> str:
    """Hash the fields that actually round-trip.

    Deliberately excludes ``updated`` and the sync keys: bumping a timestamp is
    not a content change, and hashing our own bookkeeping would make every sync
    look like a local edit.
    """
    canon = json.dumps({
        "title": (meta.get("title") or "").strip(),
        "status": board._normalize_status(meta.get("status")),
        "claimed_by": (meta.get("claimed_by") or "").strip(),
        "body": (body or "").strip(),
    }, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()[:16]


def strip_conflict_block(body: str) -> str:
    start = body.find(CONFLICT_START)
    end = body.find(CONFLICT_END)
    if start == -1 or end == -1 or end < start:
        return body
    return (body[:start] + body[end + len(CONFLICT_END):]).strip() + "\n"


def has_conflict(meta: dict, body: str) -> bool:
    return (meta.get("sync", "").strip().lower() == "conflict"
            or CONFLICT_START in body)


def write_task(path: Path, meta: dict, body: str) -> None:
    board._atomic_write(path, board.render_task_file(meta, body))


# --------------------------------------------------------------------------
# Sidecar state (deletion detection)
# --------------------------------------------------------------------------

def sidecar_path(root: Path) -> Path:
    return board.board_dir(root) / SIDECAR_NAME


def load_sidecar(root: Path) -> dict:
    try:
        return json.loads(sidecar_path(root).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"seen": {}}


def save_sidecar(root: Path, state: dict) -> None:
    p = sidecar_path(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    board._atomic_write(p, json.dumps(state, indent=2) + "\n")


# --------------------------------------------------------------------------
# Sync
# --------------------------------------------------------------------------

def _remote_body(story: dict) -> str:
    return (story.get("description") or "").strip() + "\n"


def _conflict_block(story: dict, local_status: str) -> str:
    return (
        f"\n{CONFLICT_START}\n"
        "## Conflict (Taiga)\n\n"
        "Both sides changed since the last sync, so nothing was overwritten.\n"
        "Merge anything worth keeping into the sections above, then **delete this\n"
        "whole block and the `sync: conflict` line** from the frontmatter. The next\n"
        "sync will push the merged result.\n\n"
        f"- **Taiga title:** {story.get('subject', '')}\n"
        f"- **Taiga status:** {local_status}\n"
        f"- **Taiga version:** {story.get('version')}\n\n"
        "### Taiga description\n\n"
        f"{_remote_body(story)}\n"
        f"{CONFLICT_END}\n"
    )


def sync_lane(client: TaigaClient, root: Path, project_id: int,
              dry_run: bool = False, on_remote_delete: str = "orphan") -> dict:
    """Reconcile one lane's board with one Taiga project. Returns a report."""
    bdir = board.board_dir(root)
    bdir.mkdir(parents=True, exist_ok=True)

    project = client.project(project_id)
    to_taiga, to_local, status_notes = build_status_map(project)
    members = {m.get("username"): m.get("id") for m in project.get("members", [])
               if m.get("username")}
    member_names = {m.get("id"): m.get("username") for m in project.get("members", [])}

    stories = {s["id"]: s for s in client.stories(project_id)}
    state = load_sidecar(root)
    seen = {int(k): v for k, v in (state.get("seen") or {}).items()}

    report = {"pushed": [], "pulled": [], "created_remote": [], "created_local": [],
              "conflicts": [], "skipped": [], "orphaned": [], "deleted_remote": [],
              "relinked": [], "status_notes": status_notes}

    local_files = [p for p in bdir.iterdir() if p.is_file() and board._is_task_file(p)]
    claimed_remote: set[int] = set()

    for path in local_files:
        meta, body = read_task_file(path)
        title = board._derive_title(meta, body, path.stem)
        meta.setdefault("title", title)

        if has_conflict(meta, body):
            report["conflicts"].append(path.stem)
            report["skipped"].append(f"{path.stem} (unresolved conflict)")
            tid = meta.get("taiga_id")
            if tid and tid.isdigit():
                claimed_remote.add(int(tid))
            continue

        raw_id = (meta.get("taiga_id") or "").strip()
        story = stories.get(int(raw_id)) if raw_id.isdigit() else None

        # A raw edit through the web UI can wipe the frontmatter linkage. Rather
        # than duplicating the story, re-link by exact title match.
        if story is None and not raw_id:
            for s in stories.values():
                if s["id"] not in claimed_remote and \
                        (s.get("subject") or "").strip() == title.strip():
                    story = s
                    report["relinked"].append(f"{path.stem} -> #{s['id']}")
                    break

        local_hash = fingerprint(meta, body)

        # --- no remote counterpart -> create one, or handle a remote deletion
        if story is None:
            if raw_id.isdigit() and int(raw_id) in seen:
                # We synced this before and the story is gone: deleted remotely.
                if on_remote_delete == "delete":
                    if not dry_run:
                        path.unlink()
                    report["deleted_remote"].append(path.stem)
                else:
                    report["orphaned"].append(path.stem)
                    if not dry_run:
                        for k in ("taiga_id", "taiga_version", "synced_hash"):
                            meta.pop(k, None)
                        meta["sync"] = "orphaned"
                        write_task(path, meta, body)
                continue

            report["created_remote"].append(path.stem)
            if dry_run:
                continue
            assigned = members.get((meta.get("claimed_by") or "").strip())
            new = client.create_story(
                project_id, title, body,
                to_taiga.get(board._normalize_status(meta.get("status"))),
                assigned)
            meta["taiga_id"] = str(new["id"])
            meta["taiga_version"] = str(new.get("version", 1))
            meta["synced_hash"] = local_hash
            meta.pop("sync", None)
            write_task(path, meta, body)
            seen[new["id"]] = path.stem
            claimed_remote.add(new["id"])
            continue

        claimed_remote.add(story["id"])
        remote_version = int(story.get("version", 0))
        known_version = int(meta.get("taiga_version") or 0)
        known_hash = (meta.get("synced_hash") or "").strip()

        local_changed = local_hash != known_hash
        remote_changed = remote_version != known_version

        if not local_changed and not remote_changed:
            seen[story["id"]] = path.stem
            continue

        # --- both sides moved -> write the conflict into the file
        if local_changed and remote_changed:
            report["conflicts"].append(path.stem)
            if not dry_run:
                meta["sync"] = "conflict"
                meta["taiga_version"] = str(remote_version)
                remote_local_status = to_local.get(story.get("status"), "todo")
                write_task(path, meta, body.rstrip() + "\n" +
                           _conflict_block(story, remote_local_status))
                seen[story["id"]] = path.stem
            continue

        # --- local only -> push
        if local_changed:
            report["pushed"].append(path.stem)
            if dry_run:
                continue
            fields = {
                "subject": title,
                "description": body,
                "status": to_taiga.get(board._normalize_status(meta.get("status"))),
            }
            who = (meta.get("claimed_by") or "").strip()
            if who in members:
                fields["assigned_to"] = members[who]
            fields = {k: v for k, v in fields.items() if v is not None}
            updated = client.update_story(story["id"], remote_version, **fields)
            meta["taiga_version"] = str(updated.get("version", remote_version + 1))
            meta["synced_hash"] = local_hash
            meta.pop("sync", None)
            write_task(path, meta, body)
            seen[story["id"]] = path.stem
            continue

        # --- remote only -> pull
        report["pulled"].append(path.stem)
        if dry_run:
            continue
        new_body = _remote_body(story)
        meta["title"] = story.get("subject") or title
        meta["status"] = to_local.get(story.get("status"), "todo")
        assignee = member_names.get(story.get("assigned_to"))
        if assignee:
            meta["claimed_by"] = assignee
        meta["updated"] = board._now()
        meta["taiga_version"] = str(remote_version)
        meta["synced_hash"] = fingerprint(meta, new_body)
        meta.pop("sync", None)
        write_task(path, meta, new_body)
        seen[story["id"]] = path.stem

    # --- stories with no local file -----------------------------------------
    for sid, story in stories.items():
        if sid in claimed_remote:
            continue
        if sid in seen:
            # Had a local file once; it's gone -> the local side deleted it.
            report["deleted_remote"].append(f"#{sid} {story.get('subject', '')}")
            if not dry_run:
                client.delete_story(sid)
                seen.pop(sid, None)
            continue

        # Genuinely new on the Taiga side -> create a local task file.
        report["created_local"].append(story.get("subject", f"#{sid}"))
        if dry_run:
            continue
        body = _remote_body(story)
        meta = {
            "title": story.get("subject") or f"story-{sid}",
            "status": to_local.get(story.get("status"), "todo"),
            "claimed_by": member_names.get(story.get("assigned_to")) or "",
            "created": board._now(),
            "updated": board._now(),
            "taiga_id": str(sid),
            "taiga_version": str(story.get("version", 1)),
        }
        meta["synced_hash"] = fingerprint(meta, body)
        path = board._unique_path(bdir, board._slugify(meta["title"]))
        write_task(path, meta, body)
        seen[sid] = path.stem

    if not dry_run:
        state["seen"] = {str(k): v for k, v in seen.items()}
        state["project_id"] = project_id
        save_sidecar(root, state)

    return report


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def _lane_by_id(lane_id: str) -> dict | None:
    for lane in load_lanes():
        if lane.get("id") == lane_id:
            return lane
    return None


def _configured(cfg: dict, lane_id: str) -> dict | None:
    return (cfg.get("lanes") or {}).get(lane_id)


def cmd_status(args) -> int:
    cfg = load_config()
    client = client_from(cfg)
    me = client.me()
    print(f"taiga:  {cfg['host']}  (as {me.get('username')}, id={me.get('id')})")
    projects = {p["id"]: p for p in client.projects()}
    print(f"projects visible: {len(projects)}")
    for p in projects.values():
        print(f"  #{p['id']:<4} {p['slug']:<28} {p['name']}")

    print("\nlanes:")
    for lane in load_lanes():
        link = _configured(cfg, lane["id"])
        root = lane_board_root(lane)
        bdir = board.board_dir(root) if root else None
        n = len(board.list_tasks(root)) if root and bdir and bdir.is_dir() else 0
        where = "unlinked" if not link else f"-> project #{link.get('project_id')}"
        exists = "" if (bdir and bdir.is_dir()) else "  (no board/ yet)"
        print(f"  {lane['id']:<12} {n:>3} tasks  {where}{exists}")
    return 0


def cmd_link(args) -> int:
    cfg = load_config()
    client = client_from(cfg)
    lane = _lane_by_id(args.lane)
    if lane is None:
        print(f"no lane {args.lane!r} in {LANES_PATH}", file=sys.stderr)
        return 1
    root = lane_board_root(lane)
    if root is None:
        print(f"lane {args.lane!r} has no workdir — nothing to sync", file=sys.stderr)
        return 1

    slug = args.project or f"claude-corner-{lane['id']}"
    project = client.project_by_slug(slug)
    if project is None:
        if not args.create:
            print(f"no Taiga project with slug {slug!r}; pass --create to make one",
                  file=sys.stderr)
            return 1
        project = client.create_project(
            args.name or f"claude-corner: {lane['id']}",
            f"Task board for the {lane['id']} lane of claude-corner.")
        print(f"created project #{project['id']} ({project['slug']})")

    cfg.setdefault("lanes", {})[lane["id"]] = {
        "project_id": project["id"], "project_slug": project["slug"],
    }
    save_config(cfg)
    _, _, notes = build_status_map(client.project(project["id"]))
    print(f"linked lane {lane['id']!r} -> project #{project['id']} ({project['slug']})")
    for note in notes:
        print(f"  note: {note}")
    return 0


def cmd_sync(args) -> int:
    cfg = load_config()
    client = client_from(cfg)
    targets = args.lanes or list((cfg.get("lanes") or {}).keys())
    if not targets:
        print("no lanes linked yet — run: taiga_sync.py link <lane> --create",
              file=sys.stderr)
        return 1

    rc = 0
    for lane_id in targets:
        link = _configured(cfg, lane_id)
        lane = _lane_by_id(lane_id)
        if not link or not lane:
            print(f"{lane_id}: not linked, skipping", file=sys.stderr)
            rc = 1
            continue
        root = lane_board_root(lane)
        if root is None:
            print(f"{lane_id}: no workdir, skipping", file=sys.stderr)
            continue
        try:
            rep = sync_lane(client, root, link["project_id"], dry_run=args.dry_run,
                            on_remote_delete=cfg.get("on_remote_delete", "orphan"))
        except TaigaError as exc:
            print(f"{lane_id}: {exc}", file=sys.stderr)
            rc = 1
            continue

        prefix = "would " if args.dry_run else ""
        parts = [f"{k}={len(v)}" for k, v in rep.items()
                 if k != "status_notes" and v]
        print(f"{lane_id}: {prefix}" + (", ".join(parts) or "no changes"))
        for key in ("created_remote", "created_local", "pushed", "pulled",
                    "conflicts", "orphaned", "deleted_remote", "relinked"):
            for item in rep.get(key, []):
                print(f"    {key:<15} {item}")
        for note in rep.get("status_notes", []):
            print(f"    note            {note}")
        if rep.get("conflicts"):
            rc = max(rc, 2)
    return rc


def cmd_conflicts(args) -> int:
    cfg = load_config()
    found = 0
    for lane_id in (cfg.get("lanes") or {}):
        lane = _lane_by_id(lane_id)
        root = lane_board_root(lane) if lane else None
        if root is None:
            continue
        bdir = board.board_dir(root)
        if not bdir.is_dir():
            continue
        for path in sorted(bdir.iterdir()):
            if not (path.is_file() and board._is_task_file(path)):
                continue
            meta, body = read_task_file(path)
            if has_conflict(meta, body):
                found += 1
                print(f"{lane_id}/{path.stem}: {board._derive_title(meta, body, path.stem)}")
    if not found:
        print("no conflicts")
    return 0


def cmd_resolve(args) -> int:
    cfg = load_config()
    lane = _lane_by_id(args.lane)
    root = lane_board_root(lane) if lane else None
    if root is None:
        print(f"no lane {args.lane!r}", file=sys.stderr)
        return 1
    path = board._task_path(root, args.task)
    if path is None or not path.is_file():
        print(f"no task {args.task!r} in lane {args.lane!r}", file=sys.stderr)
        return 1

    meta, body = read_task_file(path)
    if not has_conflict(meta, body):
        print(f"{args.task}: not conflicted")
        return 0

    if args.local:
        # Drop the conflict block; the next sync pushes what's left.
        meta.pop("sync", None)
        write_task(path, meta, strip_conflict_block(body))
        print(f"{args.task}: keeping local; next sync will push it")
        return 0

    # --remote: refetch and overwrite wholesale.
    client = client_from(cfg)
    link = _configured(cfg, args.lane)
    story = client.request("GET", f"userstories/{meta.get('taiga_id')}")
    project = client.project(link["project_id"])
    _, to_local, _ = build_status_map(project)
    new_body = _remote_body(story)
    meta["title"] = story.get("subject") or meta.get("title", "")
    meta["status"] = to_local.get(story.get("status"), "todo")
    meta["updated"] = board._now()
    meta["taiga_version"] = str(story.get("version"))
    meta.pop("sync", None)
    meta["synced_hash"] = fingerprint(meta, new_body)
    write_task(path, meta, new_body)
    print(f"{args.task}: overwritten with the Taiga version")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="show connection, projects and lane linkage") \
        .set_defaults(func=cmd_status)

    p = sub.add_parser("link", help="link a lane to a Taiga project")
    p.add_argument("lane")
    p.add_argument("--project", help="project slug (default claude-corner-<lane>)")
    p.add_argument("--name", help="display name when creating")
    p.add_argument("--create", action="store_true", help="create the project if absent")
    p.set_defaults(func=cmd_link)

    p = sub.add_parser("sync", help="reconcile linked lanes with Taiga")
    p.add_argument("lanes", nargs="*")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_sync)

    sub.add_parser("conflicts", help="list unresolved conflicts") \
        .set_defaults(func=cmd_conflicts)

    p = sub.add_parser("resolve", help="resolve a conflict by picking a side")
    p.add_argument("lane")
    p.add_argument("task")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--local", action="store_true")
    g.add_argument("--remote", action="store_true")
    p.set_defaults(func=cmd_resolve)

    args = ap.parse_args(argv)
    try:
        return args.func(args)
    except TaigaError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
