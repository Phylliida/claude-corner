#!/usr/bin/env python3
"""
Probe test v2: spawn interactive Claude in claude-corner, wait briefly for the
UI to render (which should trigger statusline), then kill — no prompt sent,
goal is zero-API-call refresh of rate-limit data.
"""
import os
import pty
import select
import subprocess
import sys
import time
from pathlib import Path

CORNER = Path(__file__).resolve().parent
PROBE_DIR = CORNER / "probe"
INPUT_DUMP = PROBE_DIR / ".statusline.input"
OUTPUT_FILE = PROBE_DIR / ".statusline.last"
CLAUDE_BIN = "/home/bepis/prog/node_modules/.bin/claude"
PROBE_PROMPT = "This is a temporary session to determine usage, please respond with 'confirmed'"

for f in (INPUT_DUMP, OUTPUT_FILE):
    if f.exists():
        f.unlink()

master_fd, slave_fd = pty.openpty()
env = os.environ.copy()
env["TERM"] = "xterm-256color"
env["CLAUDE_CODE_NO_FLICKER"] = "1"

t0 = time.time()
proc = subprocess.Popen(
    [CLAUDE_BIN,
     "--dangerously-skip-permissions",
     "--model", "haiku",
     "--system-prompt", "You are a probe. Respond briefly.",
     "--tools", "",
     "--disable-slash-commands"],
    cwd=str(PROBE_DIR),
    stdin=slave_fd, stdout=slave_fd, stderr=slave_fd,
    env=env,
    close_fds=True,
)
os.close(slave_fd)

print(f"[probe] claude pid={proc.pid}, waiting 8s for UI to fully init...")
time.sleep(8)
print(f"[probe] sending prompt...")
os.write(master_fd, PROBE_PROMPT.encode())
time.sleep(0.5)
os.write(master_fd, b"\r")

# Poll for statusline file, but give it enough time for one API turn to complete
# so rate_limits info is populated.
deadline = time.time() + 60
fired = False
have_rate_limits = False
last_seen_size = 0
import json as _json
while time.time() < deadline:
    r, _, _ = select.select([master_fd], [], [], 0.2)
    if master_fd in r:
        try:
            os.read(master_fd, 4096)
        except OSError:
            break
    if INPUT_DUMP.exists():
        sz = INPUT_DUMP.stat().st_size
        if sz != last_seen_size and sz > 0:
            last_seen_size = sz
            try:
                d = _json.loads(INPUT_DUMP.read_text())
                rl5 = d.get("rate_limits", {}).get("five_hour")
                cost = d.get("cost", {}).get("total_cost_usd", 0)
                print(f"[probe] statusline fire @ t+{time.time()-t0:.1f}s: cost=${cost:.4f} rl5={rl5}")
                fired = True
                if rl5:
                    have_rate_limits = True
                    break
            except Exception as e:
                print(f"[probe] parse error: {e}")

elapsed = time.time() - t0
print(f"[probe] {'statusline fired' if fired else 'TIMEOUT'} after {elapsed:.1f}s; killing claude")
os.write(master_fd, b"\x03\x03")
time.sleep(0.3)
proc.terminate()
try:
    proc.wait(timeout=3)
except subprocess.TimeoutExpired:
    proc.kill()
os.close(master_fd)

print()
print("=" * 60)
print("results:")
print("=" * 60)
if INPUT_DUMP.exists():
    raw = INPUT_DUMP.read_text()
    import json as _json
    try:
        d = _json.loads(raw)
        cost = d.get("cost", {}).get("total_cost_usd", 0)
        api_ms = d.get("cost", {}).get("total_api_duration_ms", 0)
        rl = d.get("rate_limits", {})
        print(f"  total_cost_usd: ${cost:.5f}")
        print(f"  total_api_duration_ms: {api_ms}")
        print(f"  rate_limits.five_hour: {rl.get('five_hour')}")
        print(f"  rate_limits.seven_day: {rl.get('seven_day')}")
    except Exception as e:
        print(f"  (couldn't parse JSON: {e})")
        print(raw[:500])
else:
    print(f"  [MISS] {INPUT_DUMP.name} not created")

if OUTPUT_FILE.exists():
    print(f"  formatted line: {OUTPUT_FILE.read_text().strip()}")
else:
    print(f"  [MISS] {OUTPUT_FILE.name} not created")
