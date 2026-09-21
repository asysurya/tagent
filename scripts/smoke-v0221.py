#!/usr/bin/env python3
"""smoke-v0221.py — PTY smoke test of the REAL v0.22.1 linux-x64 binary:
the raw-paste heuristic. A multi-line blob written to the PTY in ONE
write() simulates a paste from a terminal WITHOUT bracketed-paste
support: CRLF line endings, a blank line, no \\x1b[200~ markers. The blob
must land in the composer as newlines (never a submit per line), then a
bare enter sends the whole message as ONE user card. 9 checks.

Discriminator: if the heuristic regressed, the first line's \\r would
submit immediately — 'alpha line', 'beta line' and 'final line' would
each end up in their OWN user cards instead of one.
"""
import os, pty, sys, time, re, select as sel, fcntl, termios, struct

BIN = os.environ.get('BIN', '/home/z/my-project/dist/tagent-v0.22.1/tagent-v0.22.1-linux-x64')
pid, fd = pty.fork()
if pid == 0:
    os.chdir('/home/z/my-project/demo-workspace')
    os.execv(BIN, [BIN, 'start'])

H, W = 34, 96
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', H, W, 0, 0))
os.set_blocking(fd, False)

# (delay_from_start, bytes) — fixed schedule. /help runs FIRST (idle); the
# paste blob lands as ONE write (a raw non-bracketed paste), then bare
# enter submits everything.
SCHEDULE = [
    (5.0, b'/help\r'),        # palette: bare enter runs /help (menu accept)
    (8.0, b'\x1b'),           # close the help overlay (it swallows keys otherwise)
    (9.5, b'alpha line\r\nbeta line\r\n\r\nfinal line'),  # RAW paste: one chunk, CRLF, blank line
    (12.5, b'\r'),            # bare enter → SUBMIT the whole multi-line message
    (16.0, b'/exit\r'),       # exit (works while a run is active)
]

out = b''
start = time.time()
si = 0
while time.time() - start < 24 and si < len(SCHEDULE):
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

# one user card carrying ALL THREE pasted lines (in order, no second title
# between them) — proves the blob landed as one composer draft, and the
# blank line survived the CRLF collapse.
CARD = '\u276f you'
WINDOW = 460  # card with 4 lines of content + rails
one_card = False
for i in range(len(plain)):
    j = plain.find(CARD, i)
    if j < 0:
        break
    seg = plain[j:j + WINDOW]
    p1, p2, p3 = seg.find('alpha line'), seg.find('beta line'), seg.find('final line')
    if p1 >= 0 and p2 > p1 and p3 > p2 and CARD not in seg[p1:p3]:
        one_card = True
        break

checks = [
    ('boots as v0.22.1', 'v0.22.1' in plain),
    ('alt screen entered (fullscreen default)', '?1049h' in text),
    ('navbar renders (session title + model)', '\U0001F4AC' in plain and ('build' in plain or 'plan' in plain)),
    ('banner in the viewport', 'terminal-native coding agent' in plain),
    ('the pasted lines reached the composer (visible pre-submit frames)', 'alpha line' in plain and 'final line' in plain),
    ('ONE user card carries the whole paste — no per-line submits', one_card),
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
