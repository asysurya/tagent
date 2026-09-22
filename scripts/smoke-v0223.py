#!/usr/bin/env python3
"""smoke-v0223.py — PTY smoke test of the REAL v0.22.3 linux-x64 binary:
MCP failure reasons a human can read (the exact shapes the user reported:
a node-style crash that used to summarize as "} | Node.js v24.20.0" and a
uv-style "No space left on device"), the actionable hints, the doctor
disk-space line, and /mcp list in the live TUI.

Workspace 'smoke-ws-2223' with three broken servers:
  nodecrash  — fake npx dumping a node MODULE_NOT_FOUND crash (banner junk)
  diskfull   — fake uvx dumping uv's ENOSPC + hint essay
  quickdie   — bash, "hint: kaboom", exit 9 (v0.22.2 regression)

Doctor must name module + code (no banner), name the disk full (no essay),
attach both hints, and show the disk-space check. The TUI's /mcp list must
print the → hint lines. 11 checks.
"""
import os, pty, sys, time, re, shutil, tempfile, json, select as sel, fcntl, termios, struct

ROOT = os.environ.get('WS', tempfile.mkdtemp(prefix='smoke-ws-2223-'))
BIN = os.environ.get('BIN', '/home/z/my-project/dist/tagent-v0.22.3/tagent-v0.22.3-linux-x64')

NODE_CRASH = "\n".join([
    "node:internal/modules/cjs/loader:1143",
    "  throw err;",
    "  ^",
    "",
    "Error: Cannot find module 'zod'",
    "Require stack:",
    "- /home/u/.npm/_npx/abc/node_modules/@modelcontextprotocol/server-memory/dist/index.js",
    "    at Module._resolveFilename (node:internal/modules/cjs/loader:1143:15)",
    "  code: 'MODULE_NOT_FOUND',",
    "  ]",
    "}",
    "Node.js v24.20.0",
]) + "\n"
UV_CRASH = "\n".join([
    "error: failed to prepare `duckduckgo-mcp-server` (v0.7)",
    "No space left on device (os error 28)",
    "hint: `jsonschema-specifications` (v2025.9.1) was included because `duckduckgo-mcp-server` (v0.7) depends on `jsonschema` directly",
]) + "\n"

# fake launchers so the failures come from "npx" / "uvx" (hint routing)
bindir = os.path.join(ROOT, 'bin')
os.makedirs(os.path.join(ROOT, '.tagent'), exist_ok=True)
os.makedirs(bindir, exist_ok=True)
with open(os.path.join(bindir, 'npx'), 'w') as f:
    f.write("#!/bin/sh\ncat <<'XEOF' >&2\n" + NODE_CRASH + "XEOF\nexit 1\n")
with open(os.path.join(bindir, 'uvx'), 'w') as f:
    f.write("#!/bin/sh\ncat <<'XEOF' >&2\n" + UV_CRASH + "XEOF\nexit 1\n")
os.chmod(os.path.join(bindir, 'npx'), 0o755)
os.chmod(os.path.join(bindir, 'uvx'), 0o755)

with open(os.path.join(ROOT, '.tagent', 'config.json'), 'w') as f:
    json.dump({'version': 1, 'mcp': {'servers': {
        'nodecrash': {'command': 'npx', 'args': ['-y', '@modelcontextprotocol/server-memory']},
        'diskfull': {'command': 'uvx', 'args': ['duckduckgo-mcp-server']},
        'quickdie': {'command': 'bash', 'args': ['-c', 'echo "hint: kaboom" >&2; exit 9']},
    }}}, f)

import subprocess
ENV = dict(os.environ)
ENV['PATH'] = bindir + ':' + ENV['PATH']
doc = subprocess.run([BIN, 'doctor'], cwd=ROOT, capture_output=True, text=True, timeout=180, env=ENV)
docout = doc.stdout + doc.stderr

# --- part B: the TUI /mcp list --------------------------------------------
pid, fd = pty.fork()
if pid == 0:
    os.chdir(ROOT)
    # execve (not execv): the fake npx/uvx must win the PATH lookup
    os.execve(BIN, [BIN, 'start'], ENV)

H, W = 34, 96
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', H, W, 0, 0))
os.set_blocking(fd, False)

SCHEDULE = [
    (6.0, b'/mcp list\r'),
    (10.0, b'/exit\r'),
]

out = b''
start = time.time()
si = 0
while time.time() - start < 16 and si < len(SCHEDULE):
    now = time.time() - start
    while si < len(SCHEDULE) and now >= SCHEDULE[si][0]:
        os.write(fd, SCHEDULE[si][1])
        si += 1
    r, _, _ = sel.select([fd], [], [], 0.1)
    if r:
        try:
            c = os.read(fd, 8192)
            if not c:
                break
            out += c
        except OSError:
            break
    try:
        if os.waitpid(pid, os.WNOHANG)[0] != 0:
            break
    except ChildProcessError:
        break
t2 = time.time()
while time.time() - t2 < 2:
    r, _, _ = sel.select([fd], [], [], 0.2)
    if not r:
        continue
    try:
        c = os.read(fd, 8192)
        if not c:
            break
        out += c
    except OSError:
        break

text = out.decode('utf8', 'replace')
plain = re.sub(r'\x1b(?:\[[0-9;:<>?]*[A-Za-z~]|\][^\x07\x1b]*(?:\x07|\x1b\\))', '', text)
if os.environ.get('SMOKE_DUMP'):
    with open('/home/z/my-project/.scratch-tui.txt', 'w') as f:
        f.write(plain)
    with open('/home/z/my-project/.scratch-doctor.txt', 'w') as f:
        f.write(docout)

checks = [
    ('doctor: boots as v0.22.3', 'v0.22.3' in docout),
    ('doctor: disk-space check line present', re.search(r'disk space: [\d.]+ (GB|MB) free', docout) is not None),
    ('doctor: node crash names the module', "Cannot find module 'zod'" in docout and 'MODULE_NOT_FOUND' in docout),
    ('doctor: node-crash banner junk dropped', 'Node.js v24.20.0' not in docout),
    ('doctor: npx-cache hint attached', '~/.npm/_npx' in docout),
    ('doctor: ENOSPC named as disk full', 'No space left on device (os error 28) — disk full' in docout),
    ('doctor: uv hint essay dropped', 'jsonschema' not in docout),
    ('doctor: v0.22.2 quickdie regression kept (kaboom, code 9)', 'kaboom' in docout and 'code 9' in docout),
    ('TUI: alt screen entered', '?1049h' in text),
    ('TUI: /mcp list prints the server states', 'MCP servers (3)' in plain and 'nodecrash' in plain),
    ('TUI: /mcp list prints the → hint lines', 'free disk space' in plain and 'npm cache clean' in plain and '/mcp reload' in plain),
    ('TUI: exit restores (1049l)', '?1049l' in text),
]

fails = 0
for name, ok_ in checks:
    print(('PASS ' if ok_ else 'FAIL ') + name)
    fails += 0 if ok_ else 1
print(f'({len(checks) - fails}/{len(checks)} passed, doctor-exit={doc.returncode}, tui-bytes={len(out)})')
try:
    os.kill(pid, 9)
    os.waitpid(pid, 0)
except Exception:
    pass
shutil.rmtree(ROOT, ignore_errors=True)
sys.exit(1 if fails else 0)
