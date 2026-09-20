#!/usr/bin/env python3
"""smoke-v0190.py — PTY smoke test of the REAL v0.19.0 linux-x64 binary:
fullscreen boot (navbar + banner) → enter=newline in the editor →
shift+enter sends the multi-line message → /tools lists bg_run → exit
restores the scrollback. 8 checks."""
import os, pty, sys, time, re, select as sel, fcntl, termios, struct

BIN = '/home/z/my-project/dist/tagent-v0.19.0/tagent-v0.19.0-linux-x64'
pid, fd = pty.fork()
if pid == 0:
    os.chdir('/home/z/my-project/demo-workspace')
    os.execv(BIN, [BIN, 'start'])

H, W = 34, 96
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', H, W, 0, 0))
os.set_blocking(fd, False)
out = b''
start = time.time()
lastdata = time.time()
phase = 0
sent_at = 0.0
while time.time() - start < 30:
    r, _, _ = sel.select([fd], [], [], 0.1)
    if r:
        try:
            c = os.read(fd, 8192)
            if not c:
                break
            out += c
            lastdata = time.time()
        except OSError:
            break
        continue
    if time.time() - max(lastdata, sent_at) > 2.2 and time.time() - start > 4:
        phase += 1
        if phase == 1:
            os.write(fd, 'line one'.encode())       # type, no enter yet
        elif phase == 2:
            os.write(fd, b'\r')                     # enter → NEWLINE (v0.19)
        elif phase == 3:
            os.write(fd, 'line two'.encode())
        elif phase == 4:
            os.write(fd, b'\n')                     # ctrl+enter → SUBMIT
        elif phase == 5:
            os.write(fd, b'/tools\r')               # palette enter runs it
        elif phase == 6:
            os.write(fd, b'\x1b')                   # close the tools overlay
        elif phase == 7:
            os.write(fd, b'/exit\r')
        sent_at = time.time()
    try:
        if os.waitpid(pid, os.WNOHANG)[0] != 0:
            break
    except ChildProcessError:
        break

text = out.decode('utf8', 'replace')
plain = re.sub(r'\x1b(?:\[[0-9;:<>?]*[A-Za-z~]|\][^\x07\x1b]*(?:\x07|\x1b\\))', '', text)

checks = [
    ('boots as v0.19.0', 'v0.19.0' in plain),
    ('alt screen entered (fullscreen default)', '?1049h' in text),
    ('navbar renders (session title + model)', 'New session' in plain and 'glm' in plain),
    ('banner in the viewport', 'terminal-native coding agent' in plain),
    ('enter made a newline, NOT a submit', 'line one' in plain and 'line two' in plain
        and plain.find('line two') > plain.find('line one')),
    ('ONE user card for the multi-line message (not two)', plain.count('❯ you') == 1),
    ('/tools lists the background tools', 'bg_run' in plain and 'bg_logs' in plain and 'bg_stop' in plain),
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
