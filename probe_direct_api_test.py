#!/usr/bin/env python3
"""
Test: make a tiny direct Anthropic API call with the OAuth token from
~/.claude/.credentials.json and inspect response headers for rate-limit
data. Goal: see whether subscription-tier limits (five_hour/seven_day)
come through this path, or only the standard API-tier headers.
"""
import json
import urllib.request
import urllib.error

CREDS = "/home/bepis/.claude/.credentials.json"
creds = json.load(open(CREDS))
token = creds["claudeAiOauth"]["accessToken"]

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

def show_headers(headers):
    print("--- all headers (rate-limit + anthropic-*): ---")
    for k, v in headers.items():
        if "limit" in k.lower() or "anthropic" in k.lower() or "x-" in k.lower():
            print(f"  {k}: {v}")

try:
    with urllib.request.urlopen(req) as resp:
        print(f"HTTP {resp.status} OK")
        show_headers(resp.headers)
        text = resp.read()[:300].decode("utf-8", "replace")
        print(f"\nbody (first 300): {text}")
except urllib.error.HTTPError as e:
    print(f"HTTP {e.code}")
    show_headers(e.headers)
    text = e.read()[:500].decode("utf-8", "replace")
    print(f"\nerror body: {text}")
except Exception as e:
    print(f"failed: {type(e).__name__}: {e}")
