#!/usr/bin/env python3
"""Patch the v0.9.0 GitHub release with the current body from gh-release.sh.

Extracts the BODY heredoc from scripts/gh-release.sh (between
'BODY=$(cat <<\'EOF\'' and the terminating 'EOF\n)') and PATCHes the release
(name + body). Safe to re-run.

Usage: python3 scripts/patch-release-body.py <token> <version>
"""
import json
import re
import sys
import urllib.request

TOKEN = sys.argv[1]
VERSION = sys.argv[2]
REPO = "asysurya/tagent"
SCRIPT = "scripts/gh-release.sh"

body = open(SCRIPT, encoding="utf-8").read()
m = re.search(r"BODY=\$\(cat <<'EOF'\n(.*?)\nEOF\n\)", body, re.S)
if not m:
    print("could not extract BODY heredoc")
    sys.exit(1)
release_body = m.group(1)
print(f"extracted body: {len(release_body)} chars, head: {release_body[:60]!r}")

name = f"v{VERSION} — plan-interview + PRD flow, fallback chains & the Windows 7/32-bit native edition"

# find the release by tag
req = urllib.request.Request(
    f"https://api.github.com/repos/{REPO}/releases/tags/v{VERSION}",
    headers={"Authorization": f"token {TOKEN}", "Accept": "application/vnd.github+json"},
)
rel = json.load(urllib.request.urlopen(req))
rid = rel["id"]
print(f"release id {rid}, current name: {rel['name']!r}, assets: {len(rel['assets'])}")

data = json.dumps({"name": name, "body": release_body}).encode()
req = urllib.request.Request(
    f"https://api.github.com/repos/{REPO}/releases/{rid}",
    data=data,
    method="PATCH",
    headers={
        "Authorization": f"token {TOKEN}",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
    },
)
out = json.load(urllib.request.urlopen(req))
print(f"patched: {out['html_url']}")
print(f"new name: {out['name']!r}")
print(f"new body: {len(out['body'])} chars, head: {out['body'][:80]!r}")
