#!/usr/bin/env python3
"""smoke-v0220.py — PTY smoke test of the REAL v0.22.0 linux-x64 binary:
fullscreen boot (navbar + banner) → alt+enter makes a NEWLINE in the editor
→ bare enter submits the multi-line message (the v0.22 convention: enter
send, shift/alt/ctrl+enter newline) → /help lists the commands → exit
restores the scrollback. 8 checks.

Phase machine sends on a FIXED schedule (the navbar redraws every second,
so idle-detection never fires)."""
import os, pty, sys, time, re, select as sel, fcntl, termios, struct

BIN = os.environ.get('BIN', '/home/z/my-project/dist/tagent-v0.22.0/tagent-v0.22.0-linux-x64')
pid, fd = pty.fork()
if pid == 0:
    os.chdir('/home/z/my-project/demo-workspace')
    os.execv(BIN, [BIN, 'start'])

H, W = 34, 96
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', H, W, 0, 0))
os.set_blocking(fd, False)

# (delay_from_start, bytes) — fixed schedule. /help runs FIRST (idle —
# its output prints immediately); the real agent message goes LAST so an
# in-flight run can never eat the command phase.
SCHEDULE = [
    (5.0, b'/help\r'),        # palette: bare enter runs /help (menu accept)
    (8.0, b'\x1b'),           # close the help overlay (it swallows keys otherwise)
    (9.5, b'line one'),       # type the first line
    (11.5, b'\x1b\r'),       # alt+enter → NEWLINE (v0.22 convention)
    (13.0, b'line two'),      # type the second line
    (15.0, b'\r'),            # bare enter → SUBMIT (the real agent run starts)
    (18.5, b'/exit\r'),       # exit (works while a run is active)
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
# drain
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

# the multi-line card: find a '❯ you' title whose following ~320 chars
# contain BOTH lines with no second title between them — frames redraw every
# second, so counting titles across the whole stream is meaningless.
CARD = '\u276f you'
one_card = False
for i in range(len(plain)):
    j = plain.find(CARD, i)
    if j < 0: break
    seg = plain[j:j + 320]
    p1, p2 = seg.find('line one'), seg.find('line two')
    if p1 >= 0 and p2 > p1 and CARD not in seg[p1:p2]:
        one_card = True
        break
checks = [
    ('boots as v0.22.0', 'v0.22.0' in plain),
    ('alt screen entered (fullscreen default)', '?1049h' in text),
    ('navbar renders (session title + model)', '\U0001F4AC' in plain and ('build' in plain or 'plan' in plain)),
    ('banner in the viewport', 'terminal-native coding agent' in plain),
    ('alt+enter made a newline, NOT a submit', 'line one' in plain and 'line two' in plain
        and plain.find('line two') > plain.find('line one')),
    ('ONE user card carries the multi-line message (bare enter sent it)', one_card),
    ('/help palette ran the command (help overlay shown)', 'Tagent commands' in plain and 'session management' in plain and 'memory & history' in plain),
    ('/exit restores the terminal (1049l)', '?1049l' in text),
]

fails = 0
for name, ok_ in checks:
    print(('PASS ' if ok_ else 'FAIL ') + name)
    fails += 0 if ok_ else 1
print(f'({len(checks) - fails}/{len(checks)} passed, bytes={len(out)})')
try:
    os.kill(pid, 9)
    os.waitpid(pid, 0)
except Exception:
    pass
sys.exit(1 if fails else 0)
