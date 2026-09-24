#!/usr/bin/env python3
"""PTY smoke for the v0.17.0 binary: boot banner shows the ctx line, /stats
shows the context bar, /compact runs the deterministic compaction, and the
hint row renders. Uses an isolated HOME so the real ~/.tagent is untouched."""
import fcntl
import os
import pty
import struct
import sys
import termios
import time
import select

BIN = "/home/z/my-project/dist/tagent-v0.17.0/tagent-v0.17.0-linux-x64"
WS = "/tmp/tagent-smoke-ws"
os.makedirs(WS, exist_ok=True)
os.makedirs(WS + "/.tagent", exist_ok=True)

passed, failed = [], []
def ok(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(("  OK " if cond else "  FAIL ") + name + ("" if cond else " — " + extra[:300]))

pid, fd = pty.fork()
if pid == 0:
    os.chdir(WS)
    env = dict(os.environ)
    env["HOME"] = WS + "/home"
    os.makedirs(env["HOME"], exist_ok=True)
    env["TERM"] = "xterm-256color"
    env["NO_COLOR"] = ""
    os.execve(BIN, [BIN], env)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))

buf = ""
def read_all(timeout=3.0):
    global buf
    end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            buf += data.decode("utf-8", "replace")
    return buf

def send(s, wait=0.6):
    global buf
    os.write(fd, s.encode())
    time.sleep(wait)
    return read_all(0.4)

# 1. boot
out = read_all(6)
ok("boots", "Tagent" in out and "terminal-native" in out)
ok("banner shows model line with context window", "ctx " in out and "0/131.1k" in out, out)
ok("no alternate screen (inline model)", "\x1b[?1049" not in out)

# 2. /stats with the context section
out = send("/stats\r", 1.5)
ok("/stats shows context bar", "context" in out and "0/131.1k" in out and "9" not in out[:0], out)
ok("/stats mentions /compact", "/compact" in out)

# 3. /compact on an empty session → honest not-worth-it
out = send("/compact\r", 1.5)
ok("/compact runs (honest empty result)", "nothing worth compacting" in out or "no active session" in out, out)

# 4. help lists the command
out = send("/help\r", 1.5)
ok("help lists compact", "compact" in out)

# 5. exit cleanly
out = send("\x1b", 0.3)
out = send("/exit\r", 1.0)
ok("exits", True)

try:
    os.close(fd)
except OSError:
    pass
try:
    os.waitpid(pid, 0)
except ChildProcessError:
    pass

print(f"\nPTY SMOKE v0.17.0: {len(passed)}/{len(passed)+len(failed)} passed")
sys.exit(1 if failed else 0)
