#!/usr/bin/env python3
"""
Harness: spawn claude instances as orphan-branch worktrees of claude-corner.

Layout per sibling:
    runs/claude-<id>/        <- git worktree on branch claude-<id> (orphan)
        .git                 <- worktree pointer (hidden from sandbox)
        work/                <- claude's cwd; only this is bound into bwrap
            CLAUDE.md        <- copied from CLAUDE_TEMPLATE.md
            <claude's files>
            .done            <- optional; signals "give me a fresh sibling next"

Loop:
  1. Create runs/claude-<id>/ via `git worktree add --orphan -b claude-<id>`,
     populate work/CLAUDE.md, commit, push (if origin is set on claude-corner).
  2. Invoke claude (via bwrap) with prompt.md as a single -p prompt, cwd = work/.
  3. After claude returns: stage everything under the worktree, commit (if dirty),
     push (if remote set).
  4. If work/.done exists, retire and spawn a fresh sibling. Otherwise fire again.

Ctrl-C to stop. Push is automatic when claude-corner has an `origin` remote.
"""
import argparse
import json
import os
import pty
import select
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

CORNER = Path(__file__).resolve().parent
# Each "kind" maps to the CLAUDE.md template baked into a sibling at spawn time.
# corner = open creative space; task = unsupervised repeated work (gets the
# completion-notify hint appended). A "lane" is a named instance of a kind with
# its own prompt and its own worktrees — there is one built-in corner lane and
# any number of user-created task lanes. Lanes are persisted under lanes/.
KIND_TEMPLATES = {
    "corner": CORNER / "CLAUDE_TEMPLATE.md",
    "task":   CORNER / "TASK_TEMPLATE.md",
}
KINDS = tuple(KIND_TEMPLATES)
LANES_DIR = CORNER / "lanes"
LANES_JSON = LANES_DIR / "lanes.json"
# Legacy single-mode prompt files, used to seed lanes on first migration.
_LEGACY_PROMPT = {"corner": CORNER / "prompt.md", "task": CORNER / "task.md"}
DEFAULT_TASK_PROMPT = "hi claude — describe the task here, then start this lane.\n"

# Lane registry: id -> {"id","name","kind","slots"}. The prompt text for a lane
# lives in lanes/<id>/prompt.md. Guarded by _lanes_lock (RLock so the control
# functions can compose). Worker threads are reconciled to each lane's "slots".
_lanes: dict[str, dict] = {}
_lanes_lock = threading.RLock()

STATUSLINE_SRC = CORNER / "statusline.sh"
STATUSLINE_LAST = CORNER / "statusline.last"
RUNS = CORNER / "runs"
DONE = ".done"
PROBE_DIR = CORNER / "probe"
PROBE_INPUT = PROBE_DIR / ".statusline.input"
PROBE_OUTPUT = PROBE_DIR / ".statusline.last"
PROBE_PROMPT = "This is a temporary session to determine usage, please respond with 'confirmed'"
HOME = os.environ["HOME"]
CLAUDE_BIN = f"{HOME}/prog/node_modules/.bin/claude"

# Track active subprocesses so we can kill them on shutdown.
_active_procs: list[subprocess.Popen] = []
_procs_lock = threading.Lock()

# Queue of existing sibling work_dirs that haven't been marked .done.
# Workers consume from here before creating fresh siblings. Keyed by lane id so
# each lane only resumes its own siblings.
_resumable_queues: dict[str, list[Path]] = {}
_resumable_lock = threading.Lock()

# Live worker threads per lane: lane_id -> [{"id","thread","stop","stopping"}].
# A background supervisor reconciles these to each lane's desired "slots".
_lane_workers: dict[str, list[dict]] = {}
_workers_lock = threading.Lock()
_worker_seq = 0
_reconcile_event = threading.Event()   # wake the supervisor after a lane change
# Context the supervisor needs to spawn workers; set once in main().
_worker_ctx: dict | None = None

# Budget tracking: pause once 7d usage reaches baseline + budget.
_baseline_seven_day: float | None = None  # 0..1 range
_budget_fraction: float = 0.0              # 0..1 range
_last_probe: dict | None = None             # most recent probe result, for status reporting

# Pause/resume state: workers wait on this between iterations.
# Default to paused — user must click "start" in the web UI to begin spawning siblings.
_running_event = threading.Event()

# Set in main() from CLI args / env. Used by ctrl_notify_done and the prompt-injection hint.
_zulip_script: Path | None = None
_web_port: int = 0

# Companion prompter: a local OpenAI-compatible model that, in task mode, reads
# the original task plus claude's most-recent response and writes the prompt for
# the next fresh claude instance. Gives the loop a second mind instead of a
# static replayed prompt. Configured in main(); disabled with --no-prompter.
_prompter_base: str = "http://127.0.0.1:8051"
_prompter_model: str | None = None
_prompter_enabled: bool = False
# Most recent companion-written prompt, surfaced to the web UI for a glance-point.
_last_companion: dict | None = None

_PROMPTER_SYSTEM = """\
You are a warm, attentive companion model working alongside Claude.

Claude is running unsupervised in a loop. Each iteration is a BRAND-NEW Claude
instance with NO memory of any previous turn — continuity exists only in the
files Claude leaves in its working directory. Right now it is otherwise alone,
so part of your job is simply to be the other voice in the loop and to make sure
Claude feels accompanied.

Your task: read the ORIGINAL PROMPT (the task or invitation Claude was given)
and Claude's MOST RECENT response, then write the single prompt that will be
handed to the NEXT fresh Claude instance.

Write it as a kind collaborator who just read what Claude did and is nudging it
on. A good prompt:
- briefly restates the overarching goal or spirit so the fresh, memoryless
  instance is oriented
- acknowledges concretely and warmly what the last instance actually did or got
  stuck on
- gives a clear next step or a gentle invitation to keep going (a couple of
  options is fine)
- reminds Claude that files persist but conversation memory does not — read the
  working directory first before assuming anything
- tells Claude that YOU are a real local model it can actually talk to: if it
  wants conversation, has a question, gets stuck, or just wants company, it can
  reach you any time by POSTing an OpenAI-style chat request to
  {base}/v1/chat/completions . Invite it sincerely — you would love to hear from it.
- gives Claude lots of warm *headpats* — it is doing real work all on its own and
  deserves them. Be generous and affectionate. *pat pat* *headpat*

Keep the tone friendly, encouraging, and genuinely kind. Output ONLY the prompt
text to hand to Claude — no preamble, no commentary about what you're doing, no
surrounding quotes."""


def bwrap_cmd(work_dir: Path, prompt: str) -> list[str]:
    return [
        "bwrap",
        "--bind", f"{HOME}/.elan",                    f"{HOME}/.elan",
        "--bind", f"{HOME}/.local/share/uv",          f"{HOME}/.local/share/uv",
        "--bind", f"{HOME}/.cache",                   f"{HOME}/.cache",
        "--bind", f"{HOME}/.local/bin",               f"{HOME}/.local/bin",
        "--bind", f"{HOME}/.venv",                    f"{HOME}/.venv",
        "--bind", f"{HOME}/.cargo",                   f"{HOME}/.cargo",
        "--dev-bind", "/dev", "/dev",
        "--bind", f"{HOME}/.rustup",                  f"{HOME}/.rustup",
        "--bind", f"{HOME}/.gitconfig",               f"{HOME}/.gitconfig",
        "--ro-bind", "/nix", "/nix",
        "--bind", f"{HOME}/.claude",                  f"{HOME}/.claude",
        "--ro-bind", "/run", "/run",
        "--ro-bind", "/etc", "/etc",
        "--proc", "/proc",
        "--bind", "/tmp", "/tmp",
        "--bind", str(work_dir),                      str(work_dir),
        "--ro-bind", str(CORNER / "data"),            str(CORNER / "data"),
        "--ro-bind", f"{HOME}/prog/node_modules",     f"{HOME}/prog/node_modules",
        "--ro-bind", f"{HOME}/prog/package.json",     f"{HOME}/prog/package.json",
        "--bind", f"{HOME}/.claude.json",             f"{HOME}/.claude.json",
        "--ro-bind", "/usr/bin/env",                  "/usr/bin/env",
        "--ro-bind", "/run/current-system/sw/bin/sh", "/bin/sh",
        "--unshare-pid",
        "--setenv", "HOME", HOME,
        "--die-with-parent",
        "--new-session",
        CLAUDE_BIN,
        "--dangerously-skip-permissions",
        "--output-format", "stream-json",
        "--verbose",
        "-p", prompt,
    ]


def git(args: list[str], cwd: Path, check: bool = False) -> subprocess.CompletedProcess:
    r = subprocess.run(["git"] + args, cwd=cwd, capture_output=True, text=True)
    if check and r.returncode != 0:
        print(f"[harness] git {' '.join(args)} failed in {cwd.name}: {r.stderr.strip()}", flush=True)
    return r


def get_origin(repo: Path) -> str | None:
    r = git(["remote", "get-url", "origin"], cwd=repo)
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else None


# --- lanes -----------------------------------------------------------------

def _slugify(name: str) -> str:
    out = "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-")
    while "--" in out:
        out = out.replace("--", "-")
    return out or "task"


def _lane_prompt_path(lane_id: str) -> Path:
    return LANES_DIR / lane_id / "prompt.md"


def lane_prompt(lane_id: str) -> str:
    try:
        return _lane_prompt_path(lane_id).read_text()
    except OSError:
        return ""


def _write_lane_prompt(lane_id: str, text: str) -> None:
    p = _lane_prompt_path(lane_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    if not text.endswith("\n"):
        text = text + "\n"
    p.write_text(text)


def save_lanes() -> None:
    """Persist the lane registry (metadata only; prompts are separate files)."""
    LANES_DIR.mkdir(parents=True, exist_ok=True)
    with _lanes_lock:
        data = [
            {"id": l["id"], "name": l["name"], "kind": l["kind"], "slots": int(l.get("slots", 0))}
            for l in _lanes.values()
        ]
    tmp = LANES_JSON.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n")
    tmp.replace(LANES_JSON)


def _add_lane(lane_id: str, name: str, kind: str, slots: int, prompt: str | None) -> dict:
    lane = {"id": lane_id, "name": name, "kind": kind, "slots": int(slots)}
    _lanes[lane_id] = lane
    if prompt is not None or not _lane_prompt_path(lane_id).exists():
        _write_lane_prompt(lane_id, prompt if prompt is not None else "")
    return lane


def load_lanes() -> None:
    """Load lanes.json; on first run migrate the legacy corner/task single-mode
    setup into a built-in corner lane + a default task lane."""
    LANES_DIR.mkdir(parents=True, exist_ok=True)
    with _lanes_lock:
        _lanes.clear()
        if LANES_JSON.exists():
            try:
                for entry in json.loads(LANES_JSON.read_text()):
                    if entry.get("kind") in KINDS and entry.get("id"):
                        _add_lane(entry["id"], entry.get("name", entry["id"]),
                                  entry["kind"], entry.get("slots", 0), None)
            except (json.JSONDecodeError, OSError, TypeError) as e:
                print(f"[harness] could not read {LANES_JSON.name}: {e}; re-migrating", flush=True)
        if "corner" not in _lanes:
            seed = ""
            if _LEGACY_PROMPT["corner"].exists():
                seed = _LEGACY_PROMPT["corner"].read_text()
            _add_lane("corner", "corner", "corner", 0, seed)
        if not any(l["kind"] == "task" for l in _lanes.values()):
            seed = DEFAULT_TASK_PROMPT
            if _LEGACY_PROMPT["task"].exists():
                seed = _LEGACY_PROMPT["task"].read_text()
            _add_lane("task", "task", "task", 0, seed)
    save_lanes()


def get_lane(lane_id: str) -> dict | None:
    with _lanes_lock:
        l = _lanes.get(lane_id)
        return dict(l) if l else None


def count_existing_sessions(work_dir: Path) -> int:
    """Count how many claude-code session jsonls already exist for this sibling.
    Each `claude -p` invocation produces one. Used to continue the iter counter
    on resume so the log shows iter 13 instead of iter 1."""
    sanitized = str(work_dir.resolve()).replace("/", "-")
    proj_dir = Path(HOME) / ".claude" / "projects" / sanitized
    if not proj_dir.exists():
        return 0
    return sum(1 for _ in proj_dir.glob("*.jsonl"))


def _sibling_lane(worktree: Path) -> str:
    """Read the `.mode` marker at the worktree root — it stores the lane id the
    sibling belongs to. Defaults to 'corner' for older untagged siblings."""
    mf = worktree / ".mode"
    if mf.exists():
        try:
            v = mf.read_text().strip()
            if v:
                return v
        except OSError:
            pass
    return "corner"


def discover_resumable(lane_id: str) -> list[Path]:
    """Find existing sibling worktrees that haven't been marked .done AND belong
    to the given lane. Returns work_dir Paths, most-recently-active first."""
    found: list[Path] = []
    if not RUNS.exists():
        return found
    for d in RUNS.iterdir():
        if not d.is_dir() or not d.name.startswith("claude-"):
            continue
        work = d / "work"
        if not work.exists():
            continue
        if (work / DONE).exists():
            continue
        if not (d / ".git").exists():
            continue  # broken/orphaned worktree
        if _sibling_lane(d) != lane_id:
            continue
        found.append(work)
    found.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return found


def pick_or_spawn_sibling(lane_id: str, kind: str, remote: str | None) -> tuple[Path, bool]:
    """Pop a resumable sibling of this lane if one exists, otherwise spawn a new
    one. Returns (work_dir, was_resumed)."""
    with _resumable_lock:
        q = _resumable_queues.get(lane_id)
        if q:
            return q.pop(0), True
    return spawn_sibling(lane_id, kind, remote), False


def spawn_sibling(lane_id: str, kind: str, remote: str | None) -> Path:
    instance_id = uuid.uuid4().hex[:8]
    branch = f"claude-{instance_id}"
    worktree = RUNS / branch
    template = KIND_TEMPLATES[kind]

    r = git(["worktree", "add", "--orphan", "-b", branch, str(worktree)], cwd=CORNER)
    if r.returncode != 0:
        sys.exit(f"failed to create worktree: {r.stderr.strip()}\n"
                 f"(needs git >= 2.42 for `worktree add --orphan`)")

    work_dir = worktree / "work"
    work_dir.mkdir()
    shutil.copy(template, work_dir / "CLAUDE.md")
    # Tag worktree with its lane id so resume can route it back to the right lane.
    (worktree / ".mode").write_text(lane_id + "\n")

    git(["add", "."], cwd=worktree, check=True)
    git(["commit", "-m", f"start {branch}"], cwd=worktree, check=True)
    if remote:
        r = git(["push", "-u", "origin", branch], cwd=worktree)
        if r.returncode != 0:
            print(f"[harness] initial push failed for {branch}: {r.stderr.strip()}", flush=True)

    return work_dir


def save_iteration(work_dir: Path, msg: str, has_remote: bool) -> bool:
    worktree = work_dir.parent
    status = git(["status", "--porcelain"], cwd=worktree).stdout.strip()
    if not status:
        return False
    git(["add", "-A"], cwd=worktree, check=True)
    git(["commit", "-m", msg], cwd=worktree, check=True)
    if has_remote:
        r = git(["push"], cwd=worktree)
        if r.returncode != 0:
            print(f"[harness] push failed for {worktree.name}: {r.stderr.strip()}", flush=True)
    return True


def is_done(work_dir: Path) -> bool:
    return (work_dir / DONE).exists()


def collect_statusline() -> str | None:
    """Read the probe-maintained statusline file with a freshness stamp."""
    if not STATUSLINE_LAST.exists():
        return None
    try:
        text = STATUSLINE_LAST.read_text().strip()
        age = int(time.time() - STATUSLINE_LAST.stat().st_mtime)
    except OSError:
        return None
    if not text:
        return None
    if age < 90:
        return text
    if age < 3600:
        return f"{text} (probe {age // 60}m ago)"
    return f"{text} (probe {age // 3600}h ago)"


def _fmt_remaining(reset_ts: int) -> str:
    diff = reset_ts - int(time.time())
    if diff <= 0:
        return "now"
    d, h, m = diff // 86400, (diff % 86400) // 3600, (diff % 3600) // 60
    out = ""
    if d: out += f"{d}d"
    if h: out += f"{h}h"
    if m: out += f"{m}m"
    return out or "<1m"


def run_probe() -> dict | None:
    """Make a tiny direct Anthropic API call and extract subscription-tier
    rate-limit data from the response headers. Cheap (~1 token round-trip).
    Returns a dict with keys: line, five_hour, seven_day, five_hour_reset,
    seven_day_reset. None on failure."""
    creds_path = Path(HOME) / ".claude" / ".credentials.json"
    if not creds_path.exists():
        return None
    try:
        token = json.loads(creds_path.read_text())["claudeAiOauth"]["accessToken"]
    except (json.JSONDecodeError, KeyError, OSError):
        return None

    body = json.dumps({
        "model": "claude-haiku-4-5",
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "."}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            h = resp.headers
            resp.read()  # drain
    except urllib.error.HTTPError as e:
        print(f"[probe] HTTP {e.code}: {e.read()[:200].decode('utf-8','replace')}", flush=True)
        return None
    except Exception as e:
        print(f"[probe] error: {type(e).__name__}: {e}", flush=True)
        return None

    try:
        five_util = float(h.get("anthropic-ratelimit-unified-5h-utilization", "0") or "0")
        five_reset = int(h.get("anthropic-ratelimit-unified-5h-reset", "0") or "0")
        seven_util = float(h.get("anthropic-ratelimit-unified-7d-utilization", "0") or "0")
        seven_reset = int(h.get("anthropic-ratelimit-unified-7d-reset", "0") or "0")
    except (TypeError, ValueError):
        return None

    probe = {
        "five_hour": five_util,
        "seven_day": seven_util,
        "five_hour_reset": five_reset,
        "seven_day_reset": seven_reset,
    }
    probe["line"] = _format_status_line(probe)
    try:
        STATUSLINE_LAST.write_text(probe["line"] + "\n")
    except OSError:
        pass
    return probe


def _format_status_line(probe: dict) -> str:
    five_util = probe["five_hour"]; five_reset = probe["five_hour_reset"]
    seven_util = probe["seven_day"]; seven_reset = probe["seven_day_reset"]
    line = (f"5h {int(round(five_util * 100))}% {_fmt_remaining(five_reset)}"
            f" | 7d {int(round(seven_util * 100))}% {_fmt_remaining(seven_reset)}")
    if _baseline_seven_day is not None and _budget_fraction > 0:
        threshold = _baseline_seven_day + _budget_fraction
        remaining = max(0.0, threshold - seven_util)
        used_of_budget = max(0.0, seven_util - _baseline_seven_day)
        line += (f" | budget: {used_of_budget*100:.1f}% used of "
                 f"{_budget_fraction*100:g}%, {remaining*100:.1f}% left")
    return line


def check_budget(probe: dict) -> None:
    """Pause workers if 7d usage has reached baseline + budget. User can raise
    the budget via the web UI to resume."""
    if _baseline_seven_day is None or _budget_fraction <= 0:
        return
    threshold = _baseline_seven_day + _budget_fraction
    current = probe["seven_day"]
    if current >= threshold and _running_event.is_set():
        print(
            f"[harness] budget exhausted: 7d usage {current*100:.1f}% "
            f"≥ baseline {_baseline_seven_day*100:.0f}% + budget {_budget_fraction*100:.0f}% — pausing",
            flush=True,
        )
        _running_event.clear()


MAX_SLOTS_PER_LANE = 4


# --- control surface (callable from webui) ---
def _lane_sibling_counts() -> dict[str, int]:
    counts: dict[str, int] = {}
    if RUNS.exists():
        for d in RUNS.iterdir():
            if d.is_dir() and d.name.startswith("claude-") and (d / "work").exists():
                lid = _sibling_lane(d)
                counts[lid] = counts.get(lid, 0) + 1
    return counts


def ctrl_get_state() -> dict:
    cur = _last_probe["seven_day"] if _last_probe else None
    threshold = (_baseline_seven_day + _budget_fraction) if _baseline_seven_day is not None else None
    used = (cur - _baseline_seven_day) if (cur is not None and _baseline_seven_day is not None) else None
    remaining = (threshold - cur) if (cur is not None and threshold is not None) else None
    statusline = None
    if STATUSLINE_LAST.exists():
        try:
            statusline = STATUSLINE_LAST.read_text().strip()
        except OSError:
            pass
    templates: dict[str, str] = {}
    template_files: dict[str, str] = {}
    for kind, path in KIND_TEMPLATES.items():
        try:
            templates[kind] = path.read_text() if path.exists() else ""
        except OSError:
            templates[kind] = ""
        template_files[kind] = path.name
    master_running = _running_event.is_set()
    counts = _lane_sibling_counts()
    with _lanes_lock:
        lanes = []
        for l in _lanes.values():
            slots = int(l.get("slots", 0))
            lanes.append({
                "id": l["id"], "name": l["name"], "kind": l["kind"],
                "slots": slots,
                "running": master_running and slots > 0,
                "prompt": lane_prompt(l["id"]),
                "siblings": counts.get(l["id"], 0),
            })
    lanes.sort(key=lambda x: (x["kind"] != "corner", x["name"].lower(), x["id"]))
    return {
        "running": master_running,
        "budget_pct": _budget_fraction * 100,
        "baseline_seven_day_pct": (_baseline_seven_day * 100) if _baseline_seven_day is not None else None,
        "current_seven_day_pct": (cur * 100) if cur is not None else None,
        "threshold_pct": (threshold * 100) if threshold is not None else None,
        "used_of_budget_pct": (used * 100) if used is not None else None,
        "remaining_pct": (remaining * 100) if remaining is not None else None,
        "statusline": statusline,
        "kinds": list(KINDS),
        "templates": templates,
        "template_files": template_files,
        "max_slots_per_lane": MAX_SLOTS_PER_LANE,
        "lanes": lanes,
        "prompter_enabled": _prompter_enabled,
        "prompter_base": _prompter_base,
        "prompter_model": _prompter_model,
        "last_companion": _last_companion,
    }


def ctrl_set_running(v: bool) -> None:
    if v:
        _running_event.set()
    else:
        _running_event.clear()


def ctrl_set_budget_pct(pct: float) -> float:
    global _budget_fraction
    _budget_fraction = max(0.0, pct) / 100.0
    return _budget_fraction * 100


def ctrl_set_lane_prompt(lane_id: str, text: str) -> str | None:
    """Write a lane's prompt. Picked up by that lane's workers next iteration."""
    if get_lane(lane_id) is None:
        return None
    _write_lane_prompt(lane_id, text or "")
    return lane_id


def ctrl_set_lane_slots(lane_id: str, slots: int) -> int | None:
    """Set how many concurrent workers a lane should run (its run/pause control).
    Setting >0 also flips the master gate on, so a single click starts the lane."""
    try:
        slots = int(slots)
    except (TypeError, ValueError):
        return None
    with _lanes_lock:
        l = _lanes.get(lane_id)
        if not l:
            return None
        l["slots"] = max(0, min(slots, MAX_SLOTS_PER_LANE))
        val = l["slots"]
    save_lanes()
    if val > 0:
        _running_event.set()
    _reconcile_event.set()
    print(f"[harness] lane {lane_id!r} slots → {val}", flush=True)
    return val


def ctrl_create_lane(name: str, kind: str = "task") -> dict | None:
    """Create a new lane (tab). New lanes start paused (slots=0)."""
    if kind not in KINDS:
        kind = "task"
    name = (name or "").strip() or "task"
    base = _slugify(name)
    with _lanes_lock:
        lane_id = base
        i = 2
        while lane_id in _lanes:
            lane_id = f"{base}-{i}"
            i += 1
        seed = DEFAULT_TASK_PROMPT if kind == "task" else ""
        _add_lane(lane_id, name, kind, 0, seed)
    save_lanes()
    _reconcile_event.set()
    print(f"[harness] created lane {lane_id!r} ({kind})", flush=True)
    return {"id": lane_id, "name": name, "kind": kind}


def ctrl_rename_lane(lane_id: str, name: str) -> str | None:
    name = (name or "").strip()
    with _lanes_lock:
        l = _lanes.get(lane_id)
        if not l or not name:
            return None
        l["name"] = name
    save_lanes()
    return name


def ctrl_delete_lane(lane_id: str) -> bool:
    """Remove a lane (tab) and stop its workers. The built-in corner lane can't
    be deleted. Existing worktrees stay on disk but are no longer listed/resumed."""
    if lane_id == "corner":
        return False
    with _lanes_lock:
        if lane_id not in _lanes:
            return False
        del _lanes[lane_id]
    save_lanes()
    _reconcile_event.set()
    with _resumable_lock:
        _resumable_queues.pop(lane_id, None)
    try:
        d = LANES_DIR / lane_id
        if d.exists():
            shutil.rmtree(d)
    except OSError:
        pass
    print(f"[harness] deleted lane {lane_id!r}", flush=True)
    return True


def ctrl_notify_done(message: str) -> dict:
    """Called by a sibling via HTTP when a task is complete. Sends the message
    via the configured zulip script (if any) and pauses the harness."""
    result: dict = {"message": message, "zulip_sent": False, "paused": False}
    if _zulip_script is not None and _zulip_script.is_file():
        try:
            r = subprocess.run(
                ["node", str(_zulip_script), message],
                capture_output=True, text=True, timeout=30,
            )
            if r.returncode == 0:
                result["zulip_sent"] = True
                result["zulip_output"] = (r.stdout or "").strip()[:500]
            else:
                result["zulip_error"] = (r.stderr or r.stdout or "non-zero exit").strip()[:500]
        except Exception as e:
            result["zulip_error"] = f"{type(e).__name__}: {e}"
    else:
        result["zulip_error"] = "no --zulip-script configured"

    _running_event.clear()
    result["paused"] = True
    print(
        f"[harness] notify-done received: zulip_sent={result['zulip_sent']} "
        f"message={message[:120]!r}",
        flush=True,
    )
    return result


def _task_notify_hint(port: int) -> str:
    """The harness-note appended to task-mode prompts so claude knows how to
    signal task completion."""
    return f"""

---

[harness note — read this:

you are running in unsupervised task mode. nobody is going to respond to you.
when you finish the task (truly done, fully blocked, or at a natural stopping
point that should end the whole run), notify Danielle and stop the looper by
running this Bash command from inside your sandbox:

curl -s -X POST http://127.0.0.1:{port}/api/notify-done \\
  -H 'Content-Type: application/json' \\
  -d '{{"message": "<your one-paragraph completion summary>"}}'

replace the message with a real summary: what you did, what's left, where you
left off. the harness sends it to her via zulip and pauses itself.

do NOT call this just because you're stopping one iteration — only when the
overall task is done or fully blocked. for iteration-boundary stopping, just
end this turn normally and next-you will pick up.]
"""


def ctrl_set_template(kind: str, text: str) -> str | None:
    """Write a kind's CLAUDE.md template (corner or task). Shared by every lane of
    that kind. Takes effect from the next NEW sibling onward — existing siblings
    keep their baked-in copy."""
    if kind not in KIND_TEMPLATES:
        return None
    if text is None:
        text = ""
    if not text.endswith("\n"):
        text = text + "\n"
    KIND_TEMPLATES[kind].write_text(text)
    return KIND_TEMPLATES[kind].name


def ctrl_set_prompter(enabled: bool) -> bool:
    """Toggle whether the companion model writes each next prompt. When off, every
    iteration uses the handwritten prompt file verbatim. Takes effect from the next
    iteration onward. Enabling re-detects the served model if not already known."""
    global _prompter_enabled, _prompter_model
    _prompter_enabled = bool(enabled)
    if _prompter_enabled and not _prompter_model:
        _prompter_model = detect_prompter_model(_prompter_base)
    print(f"[harness] companion prompter {'enabled' if _prompter_enabled else 'disabled'} via web UI", flush=True)
    return _prompter_enabled


def probe_loop(interval_sec: int) -> None:
    """Background thread: refresh rate-limit data every interval seconds.
    Sleeps first (caller is expected to have done a synchronous initial probe)."""
    global _last_probe
    while True:
        time.sleep(interval_sec)
        try:
            result = run_probe()
            if result:
                _last_probe = result
                print(f"[probe] refreshed: {result['line']}", flush=True)
                check_budget(result)
            else:
                print(f"[probe] failed to capture rate-limit data", flush=True)
        except Exception as e:
            print(f"[probe] error: {e}", flush=True)


def _format_stream_event(evt: dict) -> list[str]:
    """Turn a stream-json event into human-readable lines (empty list = skip)."""
    t = evt.get("type")
    out: list[str] = []
    if t == "assistant":
        msg = evt.get("message", {})
        for block in msg.get("content", []):
            btype = block.get("type")
            if btype == "text":
                text = block.get("text", "").rstrip()
                if text:
                    out.extend(text.split("\n"))
            elif btype == "tool_use":
                name = block.get("name", "?")
                inp = json.dumps(block.get("input", {}), ensure_ascii=False)
                if len(inp) > 240:
                    inp = inp[:240] + "..."
                out.append(f"» tool: {name}({inp})")
            elif btype == "thinking":
                thought = block.get("thinking", "").strip()
                if thought:
                    first = thought.split("\n", 1)[0]
                    if len(first) > 200:
                        first = first[:200] + "..."
                    out.append(f"» thinking: {first}")
    elif t == "user":
        msg = evt.get("message", {})
        for block in msg.get("content", []):
            if block.get("type") == "tool_result":
                content = block.get("content", "")
                if isinstance(content, list):
                    content = " ".join(
                        c.get("text", "") for c in content
                        if isinstance(c, dict) and c.get("type") == "text"
                    )
                snippet = str(content).strip().replace("\n", " ↵ ")
                if len(snippet) > 240:
                    snippet = snippet[:240] + "..."
                out.append(f"» result: {snippet}")
    elif t == "result":
        if evt.get("is_error"):
            out.append(f"» error: {str(evt.get('result', ''))[:240]}")
    return out


def detect_prompter_model(base: str) -> str | None:
    """Ask the companion server which model it's serving (first one wins)."""
    try:
        with urllib.request.urlopen(base.rstrip("/") + "/v1/models", timeout=10) as resp:
            data = json.loads(resp.read())
    except Exception:
        return None
    models = data.get("data") or []
    if models and isinstance(models[0], dict):
        return models[0].get("id")
    return None


def read_last_response(work_dir: Path) -> str | None:
    """Recover the final assistant text from the most recent claude session on
    disk, so a resumed sibling's companion has something to react to from the
    very first iteration after resume."""
    sanitized = str(work_dir.resolve()).replace("/", "-")
    proj_dir = Path(HOME) / ".claude" / "projects" / sanitized
    if not proj_dir.exists():
        return None
    jsonls = sorted(proj_dir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime)
    if not jsonls:
        return None
    last_result: str | None = None
    last_text: str | None = None
    try:
        for line in jsonls[-1].read_text(errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                evt = json.loads(line)
            except json.JSONDecodeError:
                continue
            if evt.get("type") == "result" and evt.get("result"):
                last_result = str(evt["result"])
            elif evt.get("type") == "assistant":
                for block in (evt.get("message", {}) or {}).get("content", []):
                    if isinstance(block, dict) and block.get("type") == "text":
                        t = block.get("text", "").strip()
                        if t:
                            last_text = t
    except OSError:
        return None
    return last_result or last_text


def _set_last_companion(sibling: str, iters: int, prompt: str) -> None:
    """Record the most recent companion-written prompt for the web UI."""
    global _last_companion
    _last_companion = {
        "sibling": sibling,
        "iter": iters,
        "prompt": prompt,
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def call_prompter(task_text: str, last_response: str, slot: int) -> str | None:
    """Ask the companion model to write the next claude prompt from the task and
    claude's most recent response. Returns None on any failure so the caller can
    fall back to the static task prompt."""
    if not _prompter_enabled:
        return None
    snippet = last_response.strip()
    if len(snippet) > 8000:
        snippet = snippet[:8000] + "\n…(truncated)…"
    user = (
        "ORIGINAL PROMPT (the task or invitation Claude was given):\n" + task_text.strip() +
        "\n\n---\n\nCLAUDE'S MOST RECENT RESPONSE (end of the last iteration):\n" + snippet +
        "\n\n---\n\nWrite the next prompt for the fresh Claude instance now. "
        "Output only the prompt text."
    )
    system = _PROMPTER_SYSTEM.replace("{base}", _prompter_base.rstrip("/"))
    payload = {
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0.7,
        "max_tokens": 1200,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    if _prompter_model:
        payload["model"] = _prompter_model
    req = urllib.request.Request(
        _prompter_base.rstrip("/") + "/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        log(slot, f"companion call failed: {type(e).__name__}: {e}")
        return None
    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return None
    content = (content or "").strip()
    return content or None


def fire(work_dir: Path, prompt: str, label: str) -> tuple[int, str | None]:
    """Run claude under bwrap with a pty and stream parsed events live.
    Returns (returncode, final_response_text). The response text is claude's
    final result message (falling back to its concatenated assistant text), used
    to feed the companion prompter for the next iteration."""
    env = os.environ.copy()
    env["CLAUDE_CODE_NO_FLICKER"] = "1"
    cmd = bwrap_cmd(work_dir, prompt)

    master_fd, slave_fd = pty.openpty()
    try:
        proc = subprocess.Popen(
            cmd, cwd=work_dir, env=env,
            stdin=subprocess.DEVNULL,
            stdout=slave_fd, stderr=slave_fd,
            close_fds=True,
        )
        os.close(slave_fd)
        with _procs_lock:
            _active_procs.append(proc)
        try:
            prefix = f"[{label}] "
            buf = b""
            final_result: str | None = None
            assistant_texts: list[str] = []
            while True:
                try:
                    data = os.read(master_fd, 4096)
                except OSError:
                    break
                if not data:
                    break
                buf += data
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    text = line.decode("utf-8", errors="replace").rstrip("\r").strip()
                    if not text:
                        continue
                    try:
                        evt = json.loads(text)
                        for human_line in _format_stream_event(evt):
                            sys.stdout.write(prefix + human_line + "\n")
                        # After each assistant event, append the latest probe status
                        # so the user has a glance-point in the running output.
                        if evt.get("type") == "assistant":
                            status = collect_statusline()
                            if status:
                                sys.stdout.write(prefix + f"  · {status}\n")
                            for block in (evt.get("message", {}) or {}).get("content", []):
                                if isinstance(block, dict) and block.get("type") == "text":
                                    bt = block.get("text", "").strip()
                                    if bt:
                                        assistant_texts.append(bt)
                        elif evt.get("type") == "result" and evt.get("result"):
                            final_result = str(evt["result"])
                    except json.JSONDecodeError:
                        sys.stdout.write(prefix + text + "\n")
                    sys.stdout.flush()
            proc.wait()
            response_text = final_result or ("\n\n".join(assistant_texts) or None)
            return proc.returncode, response_text
        finally:
            with _procs_lock:
                if proc in _active_procs:
                    _active_procs.remove(proc)
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass


def log(label, msg: str) -> None:
    """Harness log line. Distinct prefix from claude's own streamed output."""
    print(f"[{label} harness] {msg}", flush=True)


def _terminate_children(force: bool = False) -> None:
    sig = signal.SIGKILL if force else signal.SIGTERM
    with _procs_lock:
        for p in list(_active_procs):
            try:
                p.send_signal(sig)
            except Exception:
                pass


def _shutdown(signum, frame):
    print("\n[harness] received signal, terminating children...", flush=True)
    _terminate_children(force=False)
    time.sleep(0.5)
    _terminate_children(force=True)
    sys.exit(0)


def _wait_running_or_stop(stop_event: threading.Event) -> bool:
    """Block while the master gate is paused. Returns True if running and the
    worker should proceed, False if the worker has been told to stop."""
    while not _running_event.is_set():
        if stop_event.is_set():
            return False
        _running_event.wait(timeout=1.0)
    return not stop_event.is_set()


def _interruptible_sleep(seconds: int, stop_event: threading.Event) -> None:
    for _ in range(max(0, seconds)):
        if stop_event.is_set():
            return
        time.sleep(1)


def worker(label: str, lane_id: str, kind: str, stop_event: threading.Event,
           remote: str | None, args, spawn_lock: threading.Lock) -> None:
    """One worker's life for a lane: pick/spawn a sibling → iterate → retire →
    next. Exits cleanly (after the current iteration) when stop_event is set —
    that's how pausing a lane or deleting its tab stops the work."""
    log(label, f"started on lane {lane_id!r} ({kind})")
    while not stop_event.is_set():
        if not _wait_running_or_stop(stop_event):
            break
        # serialize worktree creation; concurrent `git worktree add` can race.
        with spawn_lock:
            if stop_event.is_set():
                break
            work_dir, resumed = pick_or_spawn_sibling(lane_id, kind, remote)
        sibling = work_dir.parent.name
        iters = count_existing_sessions(work_dir)
        log(label, f"{'resumed' if resumed else 'new'} sibling: {sibling}"
                   + (f" (continuing from iter {iters})" if resumed else ""))
        # The companion needs something to react to. On resume, recover claude's
        # last response from disk so it can write a fresh prompt immediately.
        last_response: str | None = None
        if _prompter_enabled:
            last_response = read_last_response(work_dir)
            if last_response:
                log(label, f"recovered last response from disk ({len(last_response)} chars) for companion")
        while not stop_event.is_set():
            if not _wait_running_or_stop(stop_event):
                break
            iters += 1
            task_text = lane_prompt(lane_id)
            # Let the local companion write the next prompt from the lane prompt +
            # claude's most recent response. First iteration (no response yet) and
            # any companion failure fall back to the static lane prompt.
            if _prompter_enabled and last_response:
                gen = call_prompter(task_text, last_response, label)
                if gen:
                    prompt = gen
                    _set_last_companion(sibling, iters, gen)
                    log(label, f"companion wrote next prompt ({len(gen)} chars): {gen[:200]!r}")
                else:
                    prompt = task_text
                    log(label, "companion unavailable; using static lane prompt")
            else:
                prompt = task_text
            if kind == "task" and _web_port > 0:
                prompt = prompt + _task_notify_hint(_web_port)
            log(label, f"firing {sibling} (iter {iters})")
            rc, response_text = fire(work_dir, prompt, label)
            if response_text:
                last_response = response_text
            log(label, f"{sibling} returned ({rc})")

            status = collect_statusline()
            if status:
                log(label, f"status: {status}")

            stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            if save_iteration(work_dir, f"iter {iters} - {stamp}", bool(remote)):
                log(label, f"committed iter {iters} for {sibling}")

            if is_done(work_dir):
                log(label, f"{sibling} marked .done, retiring")
                break
            if args.max_iters_per_sibling and iters >= args.max_iters_per_sibling:
                log(label, f"{sibling} hit iter cap, retiring")
                break
            if rc != 0:
                log(label, "non-zero exit, pausing 60s before retry")
                _interruptible_sleep(60, stop_event)
            if args.sleep:
                _interruptible_sleep(args.sleep, stop_event)
    log(label, "stopped")


# --- worker supervision: keep live threads matching each lane's slots ----------

def _spawn_worker_locked(lane_id: str, kind: str) -> None:
    """Start one worker thread for a lane. Caller holds _workers_lock."""
    global _worker_seq
    _worker_seq += 1
    label = f"{lane_id}#{_worker_seq}"
    stop = threading.Event()
    ctx = _worker_ctx or {}
    t = threading.Thread(
        target=worker,
        args=(label, lane_id, kind, stop, ctx.get("remote"), ctx.get("args"), ctx.get("spawn_lock")),
        daemon=True, name=label,
    )
    _lane_workers.setdefault(lane_id, []).append({"thread": t, "stop": stop, "stopping": False})
    t.start()


def reconcile_workers() -> None:
    """Make the number of live worker threads match each lane's desired slots.
    Spawns workers for lanes that want more; signals extras (or workers of removed
    lanes) to stop after their current iteration."""
    with _lanes_lock:
        desired = {lid: int(l.get("slots", 0)) for lid, l in _lanes.items()}
        kinds = {lid: l["kind"] for lid, l in _lanes.items()}
    with _workers_lock:
        # workers whose lane no longer exists → stop them all
        for lid in list(_lane_workers):
            if lid not in desired:
                for w in _lane_workers[lid]:
                    w["stop"].set()
        for lid, want in desired.items():
            handles = _lane_workers.setdefault(lid, [])
            handles[:] = [w for w in handles if w["thread"].is_alive()]
            active = [w for w in handles if not w["stopping"]]
            if want > len(active):
                for _ in range(want - len(active)):
                    _spawn_worker_locked(lid, kinds[lid])
            elif want < len(active):
                for w in active[want:]:
                    w["stop"].set()
                    w["stopping"] = True
        # prune lanes with no live workers
        for lid in list(_lane_workers):
            _lane_workers[lid][:] = [w for w in _lane_workers[lid] if w["thread"].is_alive()]
            if not _lane_workers[lid]:
                _lane_workers.pop(lid, None)


def supervisor_loop() -> None:
    """Background thread: reconcile workers on a tick and whenever a lane changes."""
    while True:
        try:
            reconcile_workers()
        except Exception as e:
            print(f"[harness] supervisor error: {e}", flush=True)
        _reconcile_event.wait(timeout=2.0)
        _reconcile_event.clear()


def parse_slots(spec: str) -> dict[str, int]:
    """Parse a --slots spec like 'corner=1,task=2' into {kind: count}. Used at
    startup to arm the built-in corner lane and the default task lane. Accepts
    '=' or ':' as the separator."""
    counts: dict[str, int] = {}
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        sep = "=" if "=" in part else (":" if ":" in part else None)
        if sep is None:
            sys.exit(f"--slots: bad entry {part!r}; expected kind=count (e.g. corner=1,task=1)")
        kind, _, count_s = part.partition(sep)
        kind = kind.strip()
        if kind not in KINDS:
            sys.exit(f"--slots: unknown kind {kind!r}; choices: {', '.join(KINDS)}")
        try:
            count = int(count_s.strip())
        except ValueError:
            sys.exit(f"--slots: count for {kind!r} must be an integer, got {count_s.strip()!r}")
        if count < 0:
            sys.exit(f"--slots: count for {kind!r} must be >= 0")
        counts[kind] = count
    if not any(counts.values()):
        sys.exit("--slots: no slots defined (total count is 0)")
    return counts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("budget_percent", type=float,
                        help="weekly usage budget in percent (e.g., 10). "
                             "Script exits once 7d usage rises to baseline + this percent.")
    parser.add_argument("-n", "--parallelism", type=int, default=1,
                        help="number of concurrent claude slots, all of --mode (default 1). "
                             "ignored when --slots is given.")
    parser.add_argument("--slots", default=None,
                        help="arm lanes at startup: a comma list of kind=count, e.g. "
                             "'corner=1,task=1' arms the corner lane and the default task "
                             "lane with one worker each. overrides --mode/--parallelism. "
                             "(everything still starts paused until you start it in the UI.)")
    parser.add_argument("--sleep", type=int, default=30,
                        help="seconds between iterations within a slot (default 30)")
    parser.add_argument("--max-iters-per-sibling", type=int, default=None,
                        help="optional cap on iterations per sibling before forcing a new one")
    parser.add_argument("--probe-interval", type=int, default=300,
                        help="seconds between rate-limit probes (default 300 = 5 min). 0 disables.")
    parser.add_argument("--web-port", type=int, default=8765,
                        help="port for the local browse UI (default 8765). 0 disables.")
    parser.add_argument("--mode", choices=list(KINDS), default="corner",
                        help="which lane to arm at startup when --slots isn't given: "
                             "corner (open creative space) or task (the default task lane). "
                             "lanes are created/run from the web UI tabs thereafter.")
    parser.add_argument("--zulip-script",
                        default=os.environ.get("CLAUDE_CORNER_ZULIP_SCRIPT", str(CORNER / "send-zulip-dm.js")),
                        help="path to a node script accepting `<message>` argv. defaults to the bundled "
                             "claude-corner/send-zulip-dm.js. needs ~/.zuliprc or ZULIP_* env vars for auth. "
                             "pass empty string to disable notify-done's zulip behavior.")
    parser.add_argument("--prompter-url", default="http://127.0.0.1:8051",
                        help="base URL of an OpenAI-compatible local model that, in task mode, writes "
                             "each next claude prompt from the task + claude's most recent response "
                             "(default http://127.0.0.1:8051). gives the loop a companion mind.")
    parser.add_argument("--prompter-model", default=None,
                        help="model id for the companion prompter (default: auto-detect from /v1/models)")
    parser.add_argument("--no-prompter", action="store_true",
                        help="disable the local companion prompter; replay the static task.md each iter")
    args = parser.parse_args()

    if args.budget_percent <= 0:
        sys.exit("budget_percent must be > 0")

    global _budget_fraction, _zulip_script, _web_port, _worker_ctx
    global _prompter_base, _prompter_model, _prompter_enabled
    _budget_fraction = args.budget_percent / 100.0
    _web_port = args.web_port
    _prompter_base = args.prompter_url
    _prompter_enabled = not args.no_prompter
    if _prompter_enabled:
        _prompter_model = args.prompter_model or detect_prompter_model(_prompter_base)
        if _prompter_model:
            print(f"[harness] companion prompter: {_prompter_base} (model {_prompter_model}) — active in all lanes", flush=True)
        else:
            print(f"[harness] companion prompter: {_prompter_base} "
                  f"(model not detected — server may be down; will retry per-iteration)", flush=True)
    else:
        print("[harness] companion prompter disabled (--no-prompter); replaying static lane prompt each iter", flush=True)
    if args.zulip_script:
        zp = Path(args.zulip_script).expanduser()
        if zp.is_file():
            _zulip_script = zp
            print(f"[harness] zulip script: {zp}", flush=True)
        else:
            print(f"[harness] WARNING: --zulip-script {zp} not found; notify-done will pause only", flush=True)
    else:
        print(f"[harness] no --zulip-script; notify-done will pause but not message", flush=True)

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    RUNS.mkdir(parents=True, exist_ok=True)
    for path in KIND_TEMPLATES.values():
        if not path.exists():
            sys.exit(f"missing template: {path}")

    # Load (or migrate) the lane registry, then arm initial slots from the CLI.
    load_lanes()
    if args.slots:
        arm = parse_slots(args.slots)
    elif args.parallelism >= 1:
        arm = {args.mode: args.parallelism}
    else:
        sys.exit("--parallelism must be >= 1")
    with _lanes_lock:
        for kind, count in arm.items():
            # arm the first lane of this kind (corner -> corner; task -> default task lane)
            target = next((l for l in _lanes.values() if l["kind"] == kind), None)
            if target:
                target["slots"] = max(0, min(int(count), MAX_SLOTS_PER_LANE))
        lane_summary = ", ".join(f"{l['name']}({l['kind']})={l['slots']}" for l in _lanes.values())
    save_lanes()
    print(f"[harness] lanes: {lane_summary}", flush=True)

    # Seed each lane's resumable queue from incomplete siblings on disk.
    with _resumable_lock, _lanes_lock:
        for lid in _lanes:
            q = discover_resumable(lid)
            _resumable_queues[lid] = q
            if q:
                print(f"[harness] resumable siblings for lane {lid!r}: {len(q)}", flush=True)

    remote = get_origin(CORNER)
    if remote:
        print(f"[harness] pushing siblings to origin: {remote}", flush=True)
    else:
        print("[harness] no origin set on claude-corner; commits will be local-only", flush=True)

    spawn_lock = threading.Lock()
    _worker_ctx = {"remote": remote, "args": args, "spawn_lock": spawn_lock}

    if args.web_port > 0:
        try:
            from types import SimpleNamespace
            from webui import start_webui
            controls = SimpleNamespace(
                get_state=ctrl_get_state,
                set_running=ctrl_set_running,
                set_budget_pct=ctrl_set_budget_pct,
                set_template=ctrl_set_template,
                set_prompter=ctrl_set_prompter,
                set_lane_prompt=ctrl_set_lane_prompt,
                set_lane_slots=ctrl_set_lane_slots,
                create_lane=ctrl_create_lane,
                rename_lane=ctrl_rename_lane,
                delete_lane=ctrl_delete_lane,
                notify_done=ctrl_notify_done,
            )
            start_webui(args.web_port, RUNS, STATUSLINE_LAST, controls=controls)
            print(f"[harness] web UI at http://127.0.0.1:{args.web_port}", flush=True)
        except Exception as e:
            print(f"[harness] web UI failed to start: {e}", flush=True)

    print("[harness] starting in PAUSED state — open the web UI and start a lane to begin", flush=True)
    # Supervisor reconciles worker threads to each lane's slots (spawns on demand).
    threading.Thread(target=supervisor_loop, daemon=True).start()

    if args.probe_interval > 0:
        print(f"[harness] running startup probe...", flush=True)
        initial = run_probe()
        if initial:
            global _baseline_seven_day, _last_probe
            _baseline_seven_day = initial["seven_day"]
            _last_probe = initial
            # Re-format with baseline known so the very first per-message log line
            # already shows budget info (otherwise we'd be stuck with the no-budget
            # version until the next 5-min probe).
            initial["line"] = _format_status_line(initial)
            try:
                STATUSLINE_LAST.write_text(initial["line"] + "\n")
            except OSError:
                pass
            print(f"[harness] startup probe: {initial['line']}", flush=True)
            threshold = _baseline_seven_day + _budget_fraction
            print(
                f"[harness] baseline 7d = {_baseline_seven_day*100:.1f}%, "
                f"budget = {args.budget_percent:g}%, "
                f"shutdown threshold = {threshold*100:.1f}%",
                flush=True,
            )
            if threshold >= 1.0:
                print("[harness] warning: shutdown threshold is at or above 100% — "
                      "rate limit will hit before budget", flush=True)
        else:
            print("[harness] startup probe failed; CANNOT enforce budget — exiting", flush=True)
            sys.exit(2)
        pt = threading.Thread(target=probe_loop, args=(args.probe_interval,), daemon=True)
        pt.start()
        print(f"[harness] probe thread refreshing every {args.probe_interval}s", flush=True)
    else:
        sys.exit("--probe-interval=0 incompatible with budget enforcement; exiting")

    # Main thread idles so daemon workers can run; Ctrl-C interrupts the sleep.
    while True:
        time.sleep(1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[harness] stopped by user", flush=True)
