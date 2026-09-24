#!/usr/bin/env python3
"""capture-visual-0230.py — drive the real v0.23.0 binary through a themed
session and save the raw ANSI stream for pyte rendering (visual eyeball)."""
import os, pty, sys, time, tempfile, select as sel, fcntl, termios, struct

BIN = os.environ.get('BIN', '/home/z/my-project/dist/tagent-v0.23.0/tagent-v0.23.0-linux-x64')
SANDBOX_HOME = tempfile.mkdtemp(prefix='vis-home-0230-')
os.environ.pop('NO_COLOR', None)
os.environ['TERM'] = 'xterm-256color'

pid, fd = pty.fork()
if pid == 0:
    os.environ['HOME'] = SANDBOX_HOME
    os.chdir('/home/z/my-project/demo-workspace')
    os.execv(BIN, [BIN, 'start'])

H, W = 34, 110
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', H, W, 0, 0))
os.set_blocking(fd, False)

SCHEDULE = [
    (5.0, b'/theme\r'),        # open the theme picker (swatches + badges)
    (9.0, b'\x1b[B\x1b[B'),   # cursor down ×2 → Tokyo Night
    (10.5, b'\r'),             # apply it
    (13.0, b'/mode\r'),        # mode picker with digit badges
    (15.0, b'2'),              # digit pick → plan
    (17.0, b'hi there this is a visual check of the new theme and boxes\r'),  # a user card
    (21.0, b'\x1b[<0;10;20M'), # a harmless tap
    (24.0, b'/exit\r'),
]

out = b''
start = time.time()
si = 0
while time.time() - start < 32 and si < len(SCHEDULE):
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

open('/tmp/tui-visual.ansi', 'wb').write(out)
print(f'captured {len(out)} bytes → /tmp/tui-visual.ansi')
try:
    os.kill(pid, 9)
    os.waitpid(pid, 0)
except Exception:
    pass
