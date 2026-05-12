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
TEMPLATE = CORNER / "CLAUDE_TEMPLATE.md"
PROMPT_FILE = CORNER / "prompt.md"
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

# Budget tracking: terminate once 7d usage reaches baseline + budget.
_baseline_seven_day: float | None = None  # 0..1 range
_budget_fraction: float = 0.0              # 0..1 range


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


def discover_resumable() -> list[Path]:
    """Find existing sibling worktrees that haven't been marked .done.
    Returns a list of work_dir Paths, sorted most-recently-active first."""
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
        found.append(work)
    found.sort(key=lambda p: p.stat().st_mtime, reverse=True)
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
    """Trigger graceful shutdown if 7d usage has reached baseline + budget."""
    if _baseline_seven_day is None or _budget_fraction <= 0:
        return
    threshold = _baseline_seven_day + _budget_fraction
    current = probe["seven_day"]
    if current >= threshold:
        print(
            f"[harness] budget exhausted: 7d usage {current*100:.1f}% "
            f"≥ baseline {_baseline_seven_day*100:.0f}% + budget {_budget_fraction*100:.0f}%",
            flush=True,
        )
        print("[harness] sending shutdown signal", flush=True)
        os.kill(os.getpid(), signal.SIGTERM)


def probe_loop(interval_sec: int) -> None:
    """Background thread: refresh rate-limit data every interval seconds.
    Sleeps first (caller is expected to have done a synchronous initial probe)."""
    while True:
        time.sleep(interval_sec)
        try:
            result = run_probe()
            if result:
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


def fire(work_dir: Path, prompt: str, slot: int) -> int:
    """Run claude under bwrap with a pty and stream parsed events live."""
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
                    except json.JSONDecodeError:
                        sys.stdout.write(prefix + text + "\n")
                    sys.stdout.flush()
            proc.wait()
            return proc.returncode
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
        # serialize worktree creation; concurrent `git worktree add` can race.
        # pick_or_spawn_sibling prefers an existing un-done sibling.
        with spawn_lock:
            work_dir, resumed = pick_or_spawn_sibling(remote)
        sibling = work_dir.parent.name
        log(slot, f"{'resumed' if resumed else 'new'} sibling: {sibling}")
        iters = 0
        while True:
            iters += 1
            prompt = PROMPT_FILE.read_text()
            log(slot, f"firing {sibling} (iter {iters})")
            rc = fire(work_dir, prompt, slot)
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
    args = parser.parse_args()

    if args.parallelism < 1:
        sys.exit("--parallelism must be >= 1")
    if args.budget_percent <= 0:
        sys.exit("budget_percent must be > 0")

    global _budget_fraction
    _budget_fraction = args.budget_percent / 100.0

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
            from webui import start_webui
            start_webui(args.web_port, RUNS, STATUSLINE_LAST)
            print(f"[harness] web UI at http://127.0.0.1:{args.web_port}", flush=True)
        except Exception as e:
            print(f"[harness] web UI failed to start: {e}", flush=True)

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
            global _baseline_seven_day
            _baseline_seven_day = initial["seven_day"]
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
