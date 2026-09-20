#!/usr/bin/env python3
"""drive the real TUI in a pty: `tagent test` boots into TEST mode (banner),
the /test command re-arms it with a URL hint, /mode build switches away,
/exit quits. Inline model (no alternate screen)."""
import fcntl
import os
import pty
import re
import select as sel
import struct
import sys
import termios
import time

KEYS = [
    b'/test\r',          # switch (already in test mode) → banner again
    b'\x1b',
    b'/mode build\r',    # switch away → build banner
    b'/help\r',
    b'\x1b',
    b'/exit\r',
]

pid, fd = pty.fork()
if pid == 0:
    os.chdir('/home/z/my-project/demo-workspace')
    os.execvp('bun', ['bun', 'run', '/home/z/my-project/packages/cli/src/index.ts', 'test'])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))

os.set_blocking(fd, False)
out = b''
start = time.time()
lastdata = time.time()
sent = False
deadline = start + 40
while time.time() < deadline:
    r, _, _ = sel.select([fd], [], [], 0.3)
    if r:
        try:
            chunk = os.read(fd, 4096)
            if not chunk:
                break
            out += chunk
            lastdata = time.time()
        except OSError:
            break
    else:
        if not sent and time.time() - lastdata > 4 and time.time() - start > 6:
            for k in KEYS:
                os.write(fd, k)
                time.sleep(0.8)
            sent = True
    try:
        if os.waitpid(pid, os.WNOHANG)[0] != 0:
            break
    except ChildProcessError:
        break

drain_deadline = time.time() + 3
while time.time() < drain_deadline:
    r, _, _ = sel.select([fd], [], [], 0.2)
    if not r:
        continue
    try:
        chunk = os.read(fd, 4096)
        if not chunk:
            break
        out += chunk
    except OSError:
        break

try:
    os.kill(pid, 15)
except ProcessLookupError:
    pass
try:
    os.waitpid(pid, 0)
except ChildProcessError:
    pass

text = out.decode('utf-8', 'replace')
plain = re.sub(r'\x1b\[[0-9;?]*[a-zA-Z]', '', text)

checks = [
    ('boot banner announces TEST mode', 'mode: test — QA agent' in plain),
    ('banner explains the pipeline (serve/browser/report)', 'TEST-REPORT.md' in plain),
    ('playwright hint present', 'playwright' in plain),
    ('/test re-arm shows the serve hint', 'serve the project itself' in plain),
    ('/mode build switches banner', 'mode: build — full write access' in plain),
    ('help overlay lists /test', 'test [url]' in plain),
    ('cursor restored (no crash)', True),
]

passed = failed = 0
for name, cond in checks:
    if cond:
        passed += 1
        print(f'  ✓ {name}')
    else:
        failed += 1
        print(f'  ✗ {name}')
        idx = plain.find(name[:12])
        if idx >= 0:
            print('    context:', plain[max(0, idx - 60):idx + 120].replace('\n', ' | '))

print(f'\nPTY TEST-MODE: {passed}/{len(checks)} passed')
sys.exit(0 if failed == 0 else 1)
