#!/usr/bin/env python3
"""smoke the COMPILED binary: `tagent test` boots into TEST mode (banner), /exit."""
import fcntl, os, pty, re, select as sel, struct, sys, termios, time

BIN = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else 'dist/tagent-v0.15.0/tagent-v0.15.0-linux-x64')
pid, fd = pty.fork()
if pid == 0:
    os.chdir('/home/z/my-project/demo-workspace')
    os.execv(BIN, [BIN, 'test'])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
os.set_blocking(fd, False)
out = b''
start = time.time()
sent_exit = False
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
    elif not sent_exit and time.time() - start > 8:
        os.write(fd, b'/exit\r')
        sent_exit = True
    try:
        if os.waitpid(pid, os.WNOHANG)[0] != 0:
            break
    except ChildProcessError:
        break

drain = time.time() + 3
while time.time() < drain:
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
try: os.kill(pid, 15)
except ProcessLookupError: pass
try: os.waitpid(pid, 0)
except ChildProcessError: pass

plain = re.sub(r'\x1b\[[0-9;?]*[a-zA-Z]', '', out.decode('utf-8', 'replace'))
checks = [
    ('banner: mode test — QA agent', 'mode: test — QA agent' in plain),
    ('banner: TEST-REPORT.md pipeline', 'TEST-REPORT.md' in plain),
    ('playwright hint', 'playwright' in plain),
    ('no alternate screen (inline)', '\x1b[?1049h' not in out.decode('utf-8', 'replace')),
    ('cursor hide/restore pair', '\x1b[?25l' in out.decode('utf-8', 'replace')),
]
p = f = 0
for name, cond in checks:
    if cond: p += 1; print(f'  ✓ {name}')
    else: f += 1; print(f'  ✗ {name}')
print(f'\nBINARY SMOKE: {p}/{len(checks)} passed')
sys.exit(0 if f == 0 else 1)
