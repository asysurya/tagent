#!/usr/bin/env python3
"""drive the full-screen app TUI in a pty: alt-screen entry, render, ctrl+x menu, /exit

Harness notes: reads are non-blocking; EAGAIN is EXPECTED (fd drained) and must
CONTINUE, not break — breaking the read loop lets the pty buffer fill up and
the app's synchronous TTY writes block, freezing it (looked like an app bug).
"""
import os, pty, sys, time, errno, select as sel, fcntl, termios, struct

KEYS = [b'\x18', b'\x1b', b'/exit\r']

pid, fd = pty.fork()
if pid == 0:
    os.chdir('/home/z/my-project/demo-workspace')
    os.environ['TERM'] = 'xterm-256color'
    os.execvp('bun', ['bun', '/home/z/my-project/packages/cli/src/index.ts', 'start'])

# give the pty a real window size (pty.fork() defaults to 0×0)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
os.set_blocking(fd, False)

out = b''
slave_closed = False
start = time.time()
lastdata = time.time()
sent = False
deadline = start + 45
while time.time() < deadline:
    r, _, _ = sel.select([fd], [], [], 0.05)   # poll fast, drain greedily
    if r:
        while True:                            # drain until EAGAIN
            try:
                chunk = os.read(fd, 65536)
            except OSError as e:
                if e.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                    break                      # drained for now — keep going
                if e.errno == errno.EIO:
                    slave_closed = True        # child exited — normal end
                    break
                raise                          # EBADF etc → real error
            if not chunk:
                slave_closed = True
                break
            out += chunk
            lastdata = time.time()
        if slave_closed:
            break
    else:
        if not sent and time.time() - lastdata > 4 and time.time() - start > 8:
            for k in KEYS:
                os.write(fd, k)
                # drain while waiting between keys — the pty buffer is small and
                # the app's TTY writes are synchronous; a blind sleep here
                # fills the buffer and freezes the app (harness artifact)
                for _ in range(10):
                    if sel.select([fd], [], [], 0.05)[0]:
                        try:
                            chunk = os.read(fd, 65536)
                            if chunk:
                                out += chunk
                                lastdata = time.time()
                        except OSError:
                            pass
            sent = True
        if sent and time.time() - lastdata > 4:
            break

time.sleep(0.5)
try:
    pid2, status = os.waitpid(pid, os.WNOHANG)
    if pid2 == 0:
        os.kill(pid, 9)
        os.waitpid(pid, 0)
        status = -1
except OSError:
    status = -1

text = out.decode('utf8', 'replace')
checks = {
    'alt screen entered': '\x1b[?1049h' in text,
    'header renders (Tagent)': 'Tagent' in text,
    'ctrl+x menu renders': ('Continue' in text and 'menu' in text),
    'alt screen restored': '\x1b[?1049l' in text,
    'footer shortcuts': ('ctrl+x' in text),
}
failed = [k for k, v in checks.items() if not v]
for k, v in checks.items():
    print(('PASS ' if v else 'FAIL ') + k)
print(f'(bytes={len(out)}, exit={status})')
if failed or status != 0:
    sys.exit(1)
print('ALL PASS')
