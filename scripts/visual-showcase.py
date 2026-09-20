#!/usr/bin/env python3
"""visual showcase: boot → typing → / palette → ? shortcuts → exit."""
import os, pty, sys, time, select as sel, fcntl, termios, struct

pid, fd = pty.fork()
if pid == 0:
    os.chdir('/home/z/my-project/demo-workspace')
    os.execvp('bun', ['bun', 'run', '/home/z/my-project/packages/cli/src/index.ts', 'start'])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
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
    # quiet → next phase
    if time.time() - max(lastdata, sent_at) > 1.6 and time.time() - start > 4:
        phase += 1
        if phase == 1:
            os.write(fd, b'build me a ')
        elif phase == 2:
            os.write(fd, b'web scraper')
        elif phase == 3:
            for _ in range(24):
                os.write(fd, b'\x7f')
        elif phase == 4:
            os.write(fd, b'/m')
        elif phase == 5:
            os.write(fd, b'\x03')  # ctrl+c clears the line... actually esc
            os.write(fd, b'\x1b')
        elif phase == 6:
            os.write(fd, b'?')
        elif phase == 7:
            os.write(fd, b'\x1b')
        elif phase == 8:
            os.write(fd, b'\x03\x03')
        sent_at = time.time()
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
sys.stdout.write(out.decode('utf-8', 'replace'))
