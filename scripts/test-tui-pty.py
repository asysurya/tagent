#!/usr/bin/env python3
"""drive the real TUI in a pty: banner, /help (overlay + esc), /mcp list,
/mcp (menu + esc), /model list, /exit — inline model (no alternate screen)."""
import fcntl
import os
import pty
import re
import select as sel
import struct
import sys
import termios
import time

# overlays capture keys while open — esc closes them between commands
KEYS = [
    b'/help\r',
    b'\x1b',            # esc → close the help overlay
    b'/mcp list\r',
    b'/mcp\r',          # interactive menu
    b'\x1b',            # esc → cancel
    b'/model list\r',
    b'/exit\r',
]

pid, fd = pty.fork()
if pid == 0:
    os.chdir('/home/z/my-project/demo-workspace')
    os.execvp('bun', ['bun', 'run', '/home/z/my-project/packages/cli/src/index.ts', 'start'])

# a sane window size (a bare pty.fork defaults to 0x0)
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
        # banner long done + quiet → send the key sequence
        if not sent and time.time() - lastdata > 4 and time.time() - start > 6:
            for k in KEYS:
                os.write(fd, k)
                time.sleep(0.8)  # the esc-timer (50ms) + render coalescing need room
            sent = True
    try:
        if os.waitpid(pid, os.WNOHANG)[0] != 0:
            break
    except ChildProcessError:
        break

text_raw = out
# bun batches TTY stdout writes — a big chunk of the session output can land
# right around process exit. the child is gone now: drain until EOF/EIO.
drain_deadline = time.time() + 3
while time.time() < drain_deadline:
    r, _, _ = sel.select([fd], [], [], 0.2)
    if not r:
        continue
    try:
        chunk = os.read(fd, 4096)
        if not chunk:
            break
        text_raw += chunk
    except OSError:
        break
try:
    os.close(fd)
except OSError:
    pass
try:
    os.waitpid(pid, 0)
except (ChildProcessError, OSError):
    pass

text = text_raw.decode('utf8', 'replace')
checks = {
    'inline: no alternate screen': '\x1b[?1049h' not in text,
    'cursor hidden + restored': '\x1b[?25l' in text and '\x1b[?25h' in text,
    'banner (any version)': 'Tagent v' in text,
    'banner glyph + tagline': 'terminal-native coding agent' in text,
    'help overlay': 'Tagent commands' in text and 'plugins' in text,
    'mcp none line': '/mcp adds' in text,
    'mcp menu appears': 'MCP servers' in text,
    'model list view': 'current:' in text,
    'no unknown-cmd': 'unknown command' not in text,
    'no crash': 'fatal' not in text,
    'sticky editor box': 'Message tagent' in text,
}
for k, v in checks.items():
    print(f"{k}: {'OK' if v else 'FAIL'}")
sys.exit(0 if all(checks.values()) else 1)
