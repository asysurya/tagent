#!/usr/bin/env python3
"""visual boot check: start the TUI in a pty, capture 2s of frames, exit."""
import os, pty, sys, time, select as sel, fcntl, termios, struct

pid, fd = pty.fork()
if pid == 0:
    os.chdir('/home/z/my-project/demo-workspace')
    os.environ['NO_UPDATE'] = '1'
    os.execvp('bun', ['bun', 'run', '/home/z/my-project/packages/cli/src/index.ts', 'start'])

# 100x30 window
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))

os.set_blocking(fd, False)
out = b''
start = time.time()
sent = False
while time.time() - start < 6:
    r, _, _ = sel.select([fd], [], [], 0.2)
    if r:
        try:
            chunk = os.read(fd, 8192)
            if not chunk:
                break
            out += chunk
        except OSError:
            break
    else:
        if not sent and time.time() - start > 3.5:
            # type a bit to see the editor
            os.write(fd, b'hello from the new inline tui')
            sent = True
    if sent and time.time() - start > 5:
        break
try:
    os.write(fd, b'\x03\x03')  # ctrl+c twice → exit
except OSError:
    pass
time.sleep(0.5)
try:
    while True:
        r, _, _ = sel.select([fd], [], [], 0.2)
        if not r:
            break
        d = os.read(fd, 8192)
        if not d:
            break
        out += d
except OSError:
    pass
os.close(fd)
try:
    os.waitpid(pid, 0)
except ChildProcessError:
    pass
sys.stdout.write(out.decode('utf-8', 'replace'))
