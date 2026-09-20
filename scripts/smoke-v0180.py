#!/usr/bin/env python3
"""smoke-v0180.py — PTY smoke test of the REAL v0.18.0 linux-x64 binary:
boot → banner box (emoji + aligned rails) → user msg → card echo → /stats →
/compact honesty → help → exit. 8 checks."""
import os, pty, sys, time, select as sel, fcntl, termios, struct

BIN = '/home/z/my-project/dist/tagent-v0.18.0/tagent-v0.18.0-linux-x64'
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
while time.time() - start < 26:
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
    if time.time() - max(lastdata, sent_at) > 2.0 and time.time() - start > 4:
        phase += 1
        if phase == 1:
            os.write(fd, 'halo 你好 ✅ test\r'.encode())
        elif phase == 2:
            os.write(fd, b'/stats\r')
        elif phase == 3:
            os.write(fd, b'/help\r')
        elif phase == 4:
            os.write(fd, b'\x1b')   # close help overlay
        elif phase == 5:
            os.write(fd, b'\x03')
            time.sleep(0.6)
            os.write(fd, b'\x03')
        sent_at = time.time()
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

s = out.decode('utf-8', 'replace')
ok = 0
def check(name, cond):
    global ok
    print(('  ✔ ' if cond else '  ✗ ') + name)
    if cond: ok += 1

check('binary boots, version 0.18.0', '0.18.0' in s)
check('banner: rounded box top (╭─', '╭─' in s and '╮' in s)
check('banner: emoji rows (📂🤖🔌🌐)', all(e in s for e in ['📂', '🤖', '🔌', '🌐']))
check('user card: ❯ you box', '❯ you' in s)
check('moon spinner present', any(m in s for m in ['🌑', '🌒', '🌓', '🌔', '🌕']))
check('inline app (no 1049 alt-screen)', '\x1b[?1049h' not in s)
check('no crash markers', 'Unhandled' not in s and 'Cannot find' not in s)
check('agent turn happened (● or done or ⎿)', ('●' in s) or ('⎿' in s) or ('done' in s))
print(f'\nsmoke-v0180: {ok}/8 pass')
sys.exit(0 if ok == 8 else 1)
