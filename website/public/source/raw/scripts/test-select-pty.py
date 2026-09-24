#!/usr/bin/env python3
"""drive test-select.ts inside a pty: arrow down twice, enter, then y, enter"""
import os, pty, sys, time, select as sel

KEYS = [
    b'\x1b[B', b'\x1b[B', b'\r',   # menu: down, down, enter -> cherry
    b'y', b'\r',                    # confirm: y (sets true), enter -> True
]

pid, fd = pty.fork()
if pid == 0:
    os.execvp('bun', ['bun', 'run', '/home/z/my-project/scripts/test-select.ts'])

os.set_blocking(fd, False)
out = b''
start = time.time()
sent = False
deadline = start + 30
while time.time() < deadline:
    r, _, _ = sel.select([fd], [], [], 0.3)
    if r:
        try:
            chunk = os.read(fd, 4096)
            if not chunk:
                break
            out += chunk
        except OSError:
            break
    if not sent and time.time() - start > 1.5:
        for k in KEYS:
            os.write(fd, k)
            time.sleep(0.25)
        sent = True
    # stop when the test printed its final marker
    if b'CONFIRM=' in out:
        time.sleep(0.3)
        try:
            os.kill(pid, 15)
        except ProcessLookupError:
            pass
        break

text = out.decode('utf8', 'replace')
tail = text.replace('\x1b', 'ESC')
print(tail[-600:])
for marker in ('CHOICE=cherry', 'CONFIRM=true'):
    print(f"{marker}: {'OK' if marker in text else 'MISSING'}")
sys.exit(0 if ('CHOICE=cherry' in text and 'CONFIRM=true' in text) else 1)
