#!/usr/bin/env python3
"""smoke-v0222.py — PTY smoke test of the REAL v0.22.2 linux-x64 binary:
the navbar workspace segment (📂 <folder> right after the mode) and the
MCP diagnostics path (doctor on a workspace with a deliberately broken
MCP config: a server whose command doesn't exist — the error must name
the command, not just "code 1").

Boot in a scratch dir named 'smoke-ws-2222' (short, deterministic) →
navbar facts row contains '📂 smoke-ws-2222' → run /help to prove the app
is alive → exit cleanly. 7 checks.
"""
import os, pty, sys, time, re, shutil, tempfile, json, select as sel, fcntl, termios, struct

ROOT = os.environ.get('WS', tempfile.mkdtemp(prefix='smoke-ws-2222-'))
BIN = os.environ.get('BIN', '/home/z/my-project/dist/tagent-v0.22.2/tagent-v0.22.2-linux-x64')

# --- part A: doctor against a broken MCP config -------------------------
cfgdir = os.path.join(ROOT, '.tagent')
os.makedirs(cfgdir, exist_ok=True)
with open(os.path.join(cfgdir, 'config.json'), 'w') as f:
    json.dump({'version': 1, 'mcp': {'servers': {
        'broken': {'command': 'definitely-not-a-real-cmd-xyz', 'args': []},
        'quickdie': {'command': 'bash', 'args': ['-c', 'echo "hint: kaboom" >&2; exit 9']},
    }}}, f)

import subprocess
doc = subprocess.run([BIN, 'doctor'], cwd=ROOT, capture_output=True, text=True, timeout=120)
docout = doc.stdout + doc.stderr

# --- part B: the TUI navbar ------------------------------------------------
pid, fd = pty.fork()
if pid == 0:
    os.chdir(ROOT)
    os.execv(BIN, [BIN, 'start'])

H, W = 34, 96
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', H, W, 0, 0))
os.set_blocking(fd, False)

SCHEDULE = [
    (5.0, b'/help\r'),
    (8.0, b'\x1b'),
    (10.0, b'/exit\r'),
]

out = b''
start = time.time()
si = 0
while time.time() - start < 18 and si < len(SCHEDULE):
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

ws = os.path.basename(ROOT)
checks = [
    ('doctor: boots as v0.22.2', 'v0.22.2' in docout),
    ('doctor: missing launcher NAMED by command', 'cannot start' in docout and 'definitely-not-a-real-cmd-xyz' in docout),
    ('doctor: not-found phrasing with PATH advice', 'not found on PATH' in docout),
    ('doctor: stderr reason carried (kaboom + code 9)', 'kaboom' in docout and 'code 9' in docout),
    ('TUI: alt screen entered', '?1049h' in text),
    ('TUI: navbar carries the workspace segment', f'\U0001F4C2 {ws}' in plain or (ws in plain and '\U0001F4C2' in plain)),
    ('TUI: /help palette works, exit restores (1049l)', 'Tagent commands' in plain and '?1049l' in text),
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
