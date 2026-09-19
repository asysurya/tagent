#!/usr/bin/env python3
"""drive the real TUI in a pty: /help, /mcp (menu + esc), /model list, /exit"""
import os, pty, sys, time, select as sel

KEYS = [
    b'/help\r',
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
                time.sleep(0.5)
            sent = True
    try:
        if os.waitpid(pid, os.WNOHANG)[0] != 0:
            break
    except ChildProcessError:
        break

text = out.decode('utf8', 'replace')
checks = {
    'banner v0.8.0': 'Tagent v0.8.0' in text,
    'help table': '/mcp' in text and '/plugins' in text and '/update' in text,
    'mcp none line': ('no MCP servers' in text),
    'mcp menu appears': 'MCP servers' in text,
    'model list view': 'current:' in text,
    'no unknown-cmd': 'unknown command' not in text,
    'no crash': 'fatal' not in text,
}
for k, v in checks.items():
    print(f"{k}: {'OK' if v else 'FAIL'}")
sys.exit(0 if all(checks.values()) else 1)
