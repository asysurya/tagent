#!/usr/bin/env python3
"""drive the real TUI in a pty: banner, /help (overlay + esc), /mcp list,
/mcp (menu + esc), /model list, /exit — fullscreen model (v0.19+ default:
alternate screen, sticky navbar, pinned editor)."""
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
sent = False
deadline = start + 40
while time.time() < deadline:
    # drain aggressively: the app renders a full screen every second (navbar
    # ticker) — a slow reader fills the pty buffer, the app's synchronous
    # frame write blocks, stdin starves and keystrokes COALESCE (they'd merge
    # into one chunk and intermediate renders never appear)
    r, _, _ = sel.select([fd], [], [], 0.05)
    if r:
        try:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            out += chunk
        except OSError:
            break
    else:
        # FIXED schedule (v0.19+): the navbar ticker repaints every second,
        # so quiet-based idle detection never fires — send on the clock
        if not sent and time.time() - start > 8:
            for k in KEYS:
                os.write(fd, k)
                # read WHILE sleeping: the app repaints every second — a
                # reader that stops during the send fills the pty buffer,
                # the app's frame write blocks, its stdin starves and the
                # remaining keystrokes coalesce into one chunk
                for _ in range(10):
                    time.sleep(0.1)
                    r2, _, _ = sel.select([fd], [], [], 0)
                    if r2:
                        try:
                            out += os.read(fd, 65536)
                        except OSError:
                            break
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
    'fullscreen (alt screen on)': '\x1b[?1049h' in text,
    'cursor hidden while live': '\x1b[?25l' in text,
    'banner (any version)': 'Tagent v' in text,
    'banner glyph + tagline': 'terminal-native coding agent' in text,
    'help overlay': 'Tagent commands' in text,
    'mcp none line': '/mcp to add one' in text,
    'mcp menu appears': 'MCP servers' in text,
    'model list view': 'current:' in text,
    'no unknown-cmd': 'unknown command' not in text,
    'no crash': 'fatal' not in text,
    'editor box (pinned)': 'Message tagent' in text,
}
for k, v in checks.items():
    print(f"{k}: {'OK' if v else 'FAIL'}")
sys.exit(0 if all(checks.values()) else 1)
