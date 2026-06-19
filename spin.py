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
# Per-mode templates (CLAUDE.md content) and prompt files (-p input).
# Switched at startup based on --mode; spawn/resume reference the current pair.
MODE_FILES = {
    "corner": (CORNER / "CLAUDE_TEMPLATE.md", CORNER / "prompt.md"),
    "task":   (CORNER / "TASK_TEMPLATE.md",   CORNER / "task.md"),
}
TEMPLATE = MODE_FILES["corner"][0]   # default; overwritten in main()
PROMPT_FILE = MODE_FILES["corner"][1]
_current_mode = "corner"
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
# Workers consume from here before creating fresh siblings.
_resumable_queue: list[Path] = []
_resumable_lock = threading.Lock()

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


def count_existing_sessions(work_dir: Path) -> int:
    """Count how many claude-code session jsonls already exist for this sibling.
    Each `claude -p` invocation produces one. Used to continue the iter counter
    on resume so the log shows iter 13 instead of iter 1."""
    sanitized = str(work_dir.resolve()).replace("/", "-")
    proj_dir = Path(HOME) / ".claude" / "projects" / sanitized
    if not proj_dir.exists():
        return 0
    return sum(1 for _ in proj_dir.glob("*.jsonl"))


def _sibling_mode(worktree: Path) -> str:
    """Read the `.mode` marker at the worktree root. Defaults to 'corner' for
    older siblings created before mode-tagging existed."""
    mf = worktree / ".mode"
    if mf.exists():
        try:
            v = mf.read_text().strip()
            if v in MODE_FILES:
                return v
        except OSError:
            pass
    return "corner"


def discover_resumable() -> list[Path]:
    """Find existing sibling worktrees that haven't been marked .done AND
    match the current mode. Returns a list of work_dir Paths, sorted
    most-recently-active first."""
    found: list[Path] = []
    skipped_other_mode = 0
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
        if _sibling_mode(d) != _current_mode:
            skipped_other_mode += 1
            continue
        found.append(work)
    found.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    if skipped_other_mode:
        print(f"[harness] {skipped_other_mode} resumable sibling(s) skipped (different mode)", flush=True)
    return found


def pick_or_spawn_sibling(remote: str | None) -> tuple[Path, bool]:
    """Pop a resumable sibling if one exists, otherwise spawn a new one.
    Returns (work_dir, was_resumed)."""
    with _resumable_lock:
        if _resumable_queue:
            return _resumable_queue.pop(0), True
    return spawn_sibling(remote), False


def spawn_sibling(remote: str | None) -> Path:
    instance_id = uuid.uuid4().hex[:8]
    branch = f"claude-{instance_id}"
    worktree = RUNS / branch

    r = git(["worktree", "add", "--orphan", "-b", branch, str(worktree)], cwd=CORNER)
    if r.returncode != 0:
        sys.exit(f"failed to create worktree: {r.stderr.strip()}\n"
                 f"(needs git >= 2.42 for `worktree add --orphan`)")

    work_dir = worktree / "work"
    work_dir.mkdir()
    shutil.copy(TEMPLATE, work_dir / "CLAUDE.md")
    # Tag worktree with current mode so resume can filter correctly.
    (worktree / ".mode").write_text(_current_mode + "\n")

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


# --- control surface (callable from webui) ---
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
    prompt_text = ""
    template_text = ""
    try:
        if PROMPT_FILE.exists():
            prompt_text = PROMPT_FILE.read_text()
    except OSError:
        pass
    try:
        if TEMPLATE.exists():
            template_text = TEMPLATE.read_text()
    except OSError:
        pass
    return {
        "running": _running_event.is_set(),
        "budget_pct": _budget_fraction * 100,
        "baseline_seven_day_pct": (_baseline_seven_day * 100) if _baseline_seven_day is not None else None,
        "current_seven_day_pct": (cur * 100) if cur is not None else None,
        "threshold_pct": (threshold * 100) if threshold is not None else None,
        "used_of_budget_pct": (used * 100) if used is not None else None,
        "remaining_pct": (remaining * 100) if remaining is not None else None,
        "statusline": statusline,
        "mode": _current_mode,
        "available_modes": list(MODE_FILES.keys()),
        "prompt": prompt_text,
        "prompt_file": PROMPT_FILE.name,
        "template": template_text,
        "template_file": TEMPLATE.name,
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


def ctrl_set_prompt(text: str) -> str:
    """Write text to the current mode's prompt file. Takes effect from the
    next iteration onward (workers re-read PROMPT_FILE each iter)."""
    if text is None:
        text = ""
    if not text.endswith("\n"):
        text = text + "\n"
    PROMPT_FILE.write_text(text)
    return PROMPT_FILE.name


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


def ctrl_set_template(text: str) -> str:
    """Write text to the current mode's CLAUDE.md template. Takes effect from
    the next NEW sibling onward — existing siblings keep their baked-in copy."""
    if text is None:
        text = ""
    if not text.endswith("\n"):
        text = text + "\n"
    TEMPLATE.write_text(text)
    return TEMPLATE.name


def ctrl_set_mode(mode: str) -> str:
    """Switch mode at runtime. Affects future sibling spawns only; in-progress
    siblings continue with their original mode (their CLAUDE.md is baked in).
    Re-populates the resumable queue so the new mode's resumables become
    eligible."""
    global _current_mode, TEMPLATE, PROMPT_FILE
    if mode not in MODE_FILES:
        return _current_mode
    if mode == _current_mode:
        return _current_mode
    _current_mode = mode
    TEMPLATE, PROMPT_FILE = MODE_FILES[mode]
    if not TEMPLATE.exists() or not PROMPT_FILE.exists():
        print(f"[harness] WARNING: mode {mode} files missing — {TEMPLATE} / {PROMPT_FILE}", flush=True)
    with _resumable_lock:
        _resumable_queue.clear()
        _resumable_queue.extend(discover_resumable())
    print(f"[harness] mode switched → {mode} (resumable queue: {len(_resumable_queue)})", flush=True)
    return _current_mode


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


def fire(work_dir: Path, prompt: str, slot: int) -> tuple[int, str | None]:
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
            prefix = f"[slot-{slot}] "
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


def log(slot: int, msg: str) -> None:
    """Harness log line. Distinct prefix from claude's own streamed output."""
    print(f"[slot-{slot} harness] {msg}", flush=True)


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


def worker(slot: int, remote: str | None, args, spawn_lock: threading.Lock) -> None:
    """One slot's lifetime: spawn sibling → iterate → retire → spawn next → ..."""
    while True:
        # Block here if the harness is paused (budget exhausted, user clicked stop).
        if not _running_event.is_set():
            log(slot, "paused, waiting for resume...")
            _running_event.wait()
            log(slot, "resumed")
        # serialize worktree creation; concurrent `git worktree add` can race.
        # pick_or_spawn_sibling prefers an existing un-done sibling.
        with spawn_lock:
            work_dir, resumed = pick_or_spawn_sibling(remote)
        sibling = work_dir.parent.name
        iters = count_existing_sessions(work_dir)
        if resumed:
            log(slot, f"resumed sibling: {sibling} (continuing from iter {iters})")
        else:
            log(slot, f"new sibling: {sibling}")
        # The companion needs something to react to. On resume, recover claude's
        # last response from disk so it can write a fresh prompt immediately.
        last_response: str | None = None
        if _prompter_enabled:
            last_response = read_last_response(work_dir)
            if last_response:
                log(slot, f"recovered last response from disk ({len(last_response)} chars) for companion")
        while True:
            if not _running_event.is_set():
                log(slot, "paused mid-sibling, waiting for resume...")
                _running_event.wait()
                log(slot, "resumed")
            iters += 1
            task_text = PROMPT_FILE.read_text()
            # In both modes, let the local companion write the next prompt from the
            # seed prompt + claude's most recent response. First iteration (no
            # response yet) and any companion failure fall back to the static prompt.
            if _prompter_enabled and last_response:
                gen = call_prompter(task_text, last_response, slot)
                if gen:
                    prompt = gen
                    _set_last_companion(sibling, iters, gen)
                    log(slot, f"companion wrote next prompt ({len(gen)} chars): {gen[:200]!r}")
                else:
                    prompt = task_text
                    log(slot, f"companion unavailable; using static {PROMPT_FILE.name}")
            else:
                prompt = task_text
            if _current_mode == "task" and _web_port > 0:
                prompt = prompt + _task_notify_hint(_web_port)
            log(slot, f"firing {sibling} (iter {iters})")
            rc, response_text = fire(work_dir, prompt, slot)
            if response_text:
                last_response = response_text
            log(slot, f"{sibling} returned ({rc})")

            status = collect_statusline()
            if status:
                log(slot, f"status: {status}")

            stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            if save_iteration(work_dir, f"iter {iters} - {stamp}", bool(remote)):
                log(slot, f"committed iter {iters} for {sibling}")

            if is_done(work_dir):
                log(slot, f"{sibling} marked .done, retiring")
                break
            if args.max_iters_per_sibling and iters >= args.max_iters_per_sibling:
                log(slot, f"{sibling} hit iter cap, retiring")
                break
            if rc != 0:
                log(slot, "non-zero exit, pausing 60s before retry")
                time.sleep(60)
            if args.sleep:
                time.sleep(args.sleep)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("budget_percent", type=float,
                        help="weekly usage budget in percent (e.g., 10). "
                             "Script exits once 7d usage rises to baseline + this percent.")
    parser.add_argument("-n", "--parallelism", type=int, default=1,
                        help="number of concurrent claude slots (default 1)")
    parser.add_argument("--sleep", type=int, default=30,
                        help="seconds between iterations within a slot (default 30)")
    parser.add_argument("--max-iters-per-sibling", type=int, default=None,
                        help="optional cap on iterations per sibling before forcing a new one")
    parser.add_argument("--probe-interval", type=int, default=300,
                        help="seconds between rate-limit probes (default 300 = 5 min). 0 disables.")
    parser.add_argument("--web-port", type=int, default=8765,
                        help="port for the local browse UI (default 8765). 0 disables.")
    parser.add_argument("--mode", choices=list(MODE_FILES.keys()), default="corner",
                        help="corner: open creative space using CLAUDE_TEMPLATE.md + prompt.md. "
                             "task: unsupervised one-shot-repeated work using TASK_TEMPLATE.md + task.md.")
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

    if args.parallelism < 1:
        sys.exit("--parallelism must be >= 1")
    if args.budget_percent <= 0:
        sys.exit("budget_percent must be > 0")

    global _budget_fraction, TEMPLATE, PROMPT_FILE, _current_mode, _zulip_script, _web_port
    global _prompter_base, _prompter_model, _prompter_enabled
    _budget_fraction = args.budget_percent / 100.0
    _current_mode = args.mode
    TEMPLATE, PROMPT_FILE = MODE_FILES[args.mode]
    _web_port = args.web_port
    _prompter_base = args.prompter_url
    _prompter_enabled = not args.no_prompter
    if _prompter_enabled:
        _prompter_model = args.prompter_model or detect_prompter_model(_prompter_base)
        if _prompter_model:
            print(f"[harness] companion prompter: {_prompter_base} (model {_prompter_model}) — active in both modes", flush=True)
        else:
            print(f"[harness] companion prompter: {_prompter_base} "
                  f"(model not detected — server may be down; will retry per-iteration)", flush=True)
    else:
        print("[harness] companion prompter disabled (--no-prompter); replaying static task each iter", flush=True)
    if args.zulip_script:
        zp = Path(args.zulip_script).expanduser()
        if zp.is_file():
            _zulip_script = zp
            print(f"[harness] zulip script: {zp}", flush=True)
        else:
            print(f"[harness] WARNING: --zulip-script {zp} not found; notify-done will pause only", flush=True)
    else:
        print(f"[harness] no --zulip-script; notify-done will pause but not message", flush=True)
    print(f"[harness] mode = {args.mode} (CLAUDE.md from {TEMPLATE.name}, prompt from {PROMPT_FILE.name})", flush=True)

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    RUNS.mkdir(parents=True, exist_ok=True)
    for f in (TEMPLATE, PROMPT_FILE):
        if not f.exists():
            sys.exit(f"missing: {f}")

    # Build the resumable queue from any incomplete siblings on disk.
    resumable = discover_resumable()
    if resumable:
        with _resumable_lock:
            _resumable_queue.extend(resumable)
        print(f"[harness] resumable siblings on disk: {len(resumable)}", flush=True)
        for w in resumable[:5]:
            print(f"  · {w.parent.name}", flush=True)
        if len(resumable) > 5:
            print(f"  ... and {len(resumable) - 5} more", flush=True)

    remote = get_origin(CORNER)
    if remote:
        print(f"[harness] pushing siblings to origin: {remote}", flush=True)
    else:
        print("[harness] no origin set on claude-corner; commits will be local-only", flush=True)
    print(f"[harness] running {args.parallelism} concurrent slot(s)", flush=True)

    if args.web_port > 0:
        try:
            from types import SimpleNamespace
            from webui import start_webui
            controls = SimpleNamespace(
                get_state=ctrl_get_state,
                set_running=ctrl_set_running,
                set_budget_pct=ctrl_set_budget_pct,
                set_mode=ctrl_set_mode,
                set_prompt=ctrl_set_prompt,
                set_template=ctrl_set_template,
                notify_done=ctrl_notify_done,
            )
            start_webui(args.web_port, RUNS, STATUSLINE_LAST, controls=controls)
            print(f"[harness] web UI at http://127.0.0.1:{args.web_port}", flush=True)
        except Exception as e:
            print(f"[harness] web UI failed to start: {e}", flush=True)

    print("[harness] starting in PAUSED state — open the web UI and click 'start' to begin", flush=True)
    spawn_lock = threading.Lock()
    threads = []
    for i in range(args.parallelism):
        t = threading.Thread(target=worker, args=(i, remote, args, spawn_lock), daemon=True)
        t.start()
        threads.append(t)

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
