#!/usr/bin/env python3
"""PTY smoke test for the tagent-native TUI (linux build).

Drives the app through a real pseudo-terminal: checks the first frame
(header, editor box, footer), opens the ctrl+x menu, closes it, opens the
slash palette, dismisses it, types text, and exits cleanly with Ctrl+C.
"""
import os, pty, sys, time, select, re, fcntl, termios, struct

BIN = "/tmp/tnt-linux"
WS = "/tmp/tnt-ws"

pid, fd = pty.fork()
if pid == 0:
    os.chdir(WS)
    os.environ["TERM"] = "xterm-256color"
    os.execv(BIN, [BIN])

# give the pty a real size (default 0x0 falls back to 80x24)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 110, 0, 0))

def read_all(timeout=1.2):
    out = b""
    end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.15)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
    return out

def send(s, wait=0.35):
    os.write(fd, s)
    time.sleep(wait)

failures = []

def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)

# 1. first frame
frame = read_all(1.5).decode("utf-8", "replace")
check("header shows tagent banner", "tagent-native" in frame)
check("header NATIVE chip", "NATIVE" in frame)
check("editor box top", "╭" in frame and "─" in frame)
check("editor box bottom", "╯" in frame)
check("editor placeholder", "Message tagent" in frame)
check("footer hints", "enter send" in frame)
check("no-key warning", "no api key" in frame)

# 2. ctrl+x menu
send(b"\x18")  # ctrl+x
frame = read_all(0.8).decode("utf-8", "replace")
check("menu opens", "menu — ctrl+x" in frame)
check("menu items", "switch model" in frame and "diagnostics" in frame)
check("menu cursor", "❯" in frame)

# navigate down twice then select diagnostics
send(b"\x1b[B")  # down
send(b"\x1b[B")  # down
send(b"\r")      # enter -> diagnostics
frame = read_all(0.8).decode("utf-8", "replace")
check("diag overlay", "diagnostics" in frame and "workspace" in frame)
send(b"\x1b")    # esc closes
frame = read_all(0.6).decode("utf-8", "replace")

# 3. slash palette
send(b"/")
frame = read_all(0.8).decode("utf-8", "replace")
check("palette appears", "commands" in frame)
check("palette items", "/model" in frame and "/help" in frame)
send(b"\x1b[C")  # right arrow (dismiss via typing path? just add chars)
send(b"hel")
frame = read_all(0.6).decode("utf-8", "replace")
check("palette filters to /help", "help" in frame and "diag" not in frame.split("commands")[-1][:400])
send(b"\r")  # enter -> run /help
frame = read_all(0.8).decode("utf-8", "replace")
check("help overlay opens", "keys" in frame and "alt+enter" in frame)
send(b"\x1b")  # close

# 4. typing + esc clear
send(b"hello world")
frame = read_all(0.6).decode("utf-8", "replace")
check("typed text visible", "hello world" in frame)
check("cursor reversed", "\x1b[0;7m" in frame or "\x1b[7" in frame)
send(b"\x1b")  # esc clears editor
frame = read_all(0.6).decode("utf-8", "replace")
check("esc cleared editor", "hello world" not in frame[-2000:])

# 5. multi-line: alt+enter
send(b"line one\x1b\rline two")
frame = read_all(0.6).decode("utf-8", "replace")
check("alt+enter newline", "line one" in frame and "line two" in frame)
send(b"\x15")  # ctrl+u clears line

# 6. esc on empty = nothing; ctrl+c exits
send(b"\x03")
time.sleep(0.4)
try:
    os.close(fd)
except OSError:
    pass
_, status = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(status)
check("ctrl+c exits cleanly", code == 0)

print()
if failures:
    print(f"{len(failures)} FAILED: {failures}")
    sys.exit(1)
print("ALL PTY TESTS PASS")
