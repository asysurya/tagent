#!/usr/bin/env python3
"""PTY smoke for a release binary: boots the TUI on the demo workspace with a
real 100x30 window, checks the inline banner, the model from the zai config,
and a clean exit."""
import os, pty, sys, time, fcntl, termios, struct

BIN = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "dist/tagent-v0.16.0/tagent-v0.16.0-linux-x64")
WS = "demo-workspace"

def main():
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ["TAGENT_UPDATE_CHECK"] = "0"
        os.execv(BIN, [BIN, "start", WS])
    # real terminal geometry — the app renders against TIOCSWINSZ
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    out = b""
    deadline = time.time() + 25
    while time.time() < deadline:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
        if b"Message tagent" in out and b"? shortcuts" in out:
            break
        time.sleep(0.2)
    try:
        os.write(fd, b"\x03\x03")  # ctrl+c twice -> exit
        time.sleep(1.0)
        while True:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
            time.sleep(0.1)
    except OSError:
        pass
    try:
        os.close(fd)
    except OSError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    text = out.decode("utf-8", "replace")
    checks = {
        "boots inline (no alt screen)": "\x1b[?1049h" not in text,
        "banner present": "terminal-native coding agent" in text,
        "model from zai config": "glm-4.7" in text,
        "editor box present": "Message tagent" in text,
        "hint row present": "? shortcuts" in text,
        "no crash trace": "FATAL" not in text and "uncaught" not in text.lower(),
    }
    fails = 0
    for name, ok in checks.items():
        print(("PASS " if ok else "FAIL ") + name)
        fails += 0 if ok else 1
    print("SMOKE", "OK" if fails == 0 else f"{fails} FAILING")
    sys.exit(1 if fails else 0)

main()
