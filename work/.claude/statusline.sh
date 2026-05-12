#!/usr/bin/env bash
# Statusline script for claude-corner sibling instances.
# Reads JSON status from stdin, emits a compact line to stdout,
# and also writes that line to .statusline.last in cwd so the harness can pick it up.
input=$(cat)

# Context usage
ctx_pct=$(echo "$input" | grep -o '"used_percentage":[0-9.]*' | head -1 | grep -o '[0-9.]*')

# Rate limits
five_pct=$(echo "$input" | grep -o '"five_hour":{[^}]*' | grep -o '"used_percentage":[0-9.]*' | grep -o '[0-9.]*')
five_reset=$(echo "$input" | grep -o '"five_hour":{[^}]*' | grep -o '"resets_at":[0-9]*' | grep -o '[0-9]*')
week_pct=$(echo "$input" | grep -o '"seven_day":{[^}]*' | grep -o '"used_percentage":[0-9.]*' | grep -o '[0-9.]*')
week_reset=$(echo "$input" | grep -o '"seven_day":{[^}]*' | grep -o '"resets_at":[0-9]*' | grep -o '[0-9]*')

now=$(date +%s)

fmt_remaining() {
    local reset=$1
    [ -z "$reset" ] && return
    local diff=$(( reset - now ))
    [ "$diff" -le 0 ] && echo "now" && return
    local d=$(( diff / 86400 ))
    local h=$(( (diff % 86400) / 3600 ))
    local m=$(( (diff % 3600) / 60 ))
    local out=""
    [ "$d" -gt 0 ] && out="${d}d"
    [ "$h" -gt 0 ] && out="${out}${h}h"
    [ "$m" -gt 0 ] && out="${out}${m}m"
    [ -z "$out" ] && out="<1m"
    echo "$out"
}

if [ -n "$ctx_pct" ]; then
    pct_int=$(printf '%.0f' "$ctx_pct")
    ctx_part="${pct_int}%/95%"
else
    ctx_part=""
fi

five_remaining=$(fmt_remaining "$five_reset")
week_remaining=$(fmt_remaining "$week_reset")

rl_part=""
[ -n "$five_pct" ] && rl_part="5h $(printf '%.0f' "$five_pct")%"
[ -n "$five_remaining" ] && rl_part="${rl_part} ${five_remaining}"
if [ -n "$week_pct" ]; then
    [ -n "$rl_part" ] && rl_part="${rl_part} "
    rl_part="${rl_part}7d $(printf '%.0f' "$week_pct")%"
    [ -n "$week_remaining" ] && rl_part="${rl_part} ${week_remaining}"
fi

out=""
[ -n "$ctx_part" ] && out="$ctx_part"
[ -n "$rl_part" ] && { [ -n "$out" ] && out="$out "; out="${out}${rl_part}"; }

echo "$out"

# Stash for the harness (atomic write).
printf '%s\n' "$out" > .statusline.last.tmp && mv .statusline.last.tmp .statusline.last
