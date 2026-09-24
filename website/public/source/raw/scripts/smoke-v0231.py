#!/usr/bin/env python3
"""smoke-v0231.py — PTY smoke test of the REAL v0.23.1 linux-x64 binary:
the chips — bg-badge report headers, status pills, and live theme
recoloring of both. HOME points at a sandbox so nothing touches a
real ~/.tagent. 8 checks.

NOTE: run in a color-capable terminal — an SGR-stripping wrapper
(some sandboxes pipe output through a color filter that eats
\[..m params while keeping other CSI) will fail every color check.
"""
import os, pty, sys, time, re, tempfile, select as sel, fcntl, termios, struct

BIN = os.environ.get('BIN', '/home/z/my-project/dist/tagent-v0.23.1/tagent-v0.23.1-linux-x64')
SANDBOX_HOME = tempfile.mkdtemp(prefix='smoke-home-0231-')
WS = os.environ.get('WS', '/home/z/my-project/demo-workspace')

os.environ.pop('NO_COLOR', None)
os.environ['TERM'] = 'xterm-256color'

pid, fd = pty.fork()
if pid == 0:
    os.environ['HOME'] = SANDBOX_HOME
    os.chdir(WS)
    os.execv(BIN, [BIN, 'start'])

H, W = 34, 96
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', H, W, 0, 0))
os.set_blocking(fd, False)

# direct commands only — no model needed: /repo status always prints the
# ⎇ sync chip, /theme always confirms through a green pill
SCHEDULE = [
    (5.0, b'/repo status\r'),          # dark-theme cyan chip: 46;30
    (9.0, b'/theme tokyo-night\r'),    # green pill in tokyo palette: 48;5;156
    (13.0, b'/repo status\r'),         # chip now tokyo cyan: 48;5;117;38;5;17
    (17.0, b'/exit\r'),
]

out = b''
start = time.time()
si = 0
while time.time() - start < 26 and si < len(SCHEDULE):
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
try:
    os.waitpid(pid, 0)
except Exception:
    pass

txt = out.decode('utf-8', 'replace')
checks = [
    ('boots as v0.23.1', 'v0.23.1' in txt),
    ('alt screen entered (fullscreen default)', '\x1b[?1049h' in txt),
    ('repo status rides the sync chip (dark 46;30)', '\x1b[46;30m \u23c7 sync \x1b[0m' in txt),
    ('report body present (project line)', 'project' in txt),
    ('/theme tokyo-night confirms through a green pill', '\x1b[48;5;156;38;5;17m \u2714' in txt or '\x1b[48;5;156;38;5;17m' in txt),
    ('theme confirmation text present', 'Tokyo Night' in txt),
    ('chips recolor with the theme (48;5;117 cyan)', '\x1b[48;5;117;38;5;17m \u23c7 sync \x1b[0m' in txt),
    ('/exit restores the terminal (1049l)', '\x1b[?1049l' in txt),
]

fails = 0
for name, ok in checks:
    print(('PASS ' if ok else 'FAIL ') + name)
    if not ok:
        fails += 1
print(f'({len(checks) - fails}/{len(checks)} passed, bytes={len(out)})')
sys.exit(1 if fails else 0)
