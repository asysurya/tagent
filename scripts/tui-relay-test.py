#!/usr/bin/env python3
"""TUI /relay pty test: drives the real interactive TUI in a pseudo-tty,
runs /relay (on-demand daemon), /relay list, then exits."""
import json, os, pty, re, select, shutil, signal, subprocess, sys, time, urllib.request

TMP = "/tmp/tagent-tui-relay-test"
shutil.rmtree(TMP, ignore_errors=True)
os.makedirs(f"{TMP}/.tagent", exist_ok=True)
os.makedirs(f"{TMP}/.tagent/sessions", exist_ok=True)

cfg = {
    "version": 1, "defaultProvider": "zai", "defaultModel": "glm-4.7",
    "apiKeys": {}, "customProviders": [],
    "permissions": {"defaultMode": "ask", "tools": {}},
    "tools": {"bash": True, "browser": False},
    "github": {}, "mega": {"enabled": False},
    "autoCheckpoint": True, "maxTurns": 40, "nativeTools": True,
    "worklog": {"enabled": True},
}
with open(f"{TMP}/.tagent/config.json", "w") as f:
    json.dump(cfg, f)

# a session so /relay has something to share
sid = "tuitest1234"
sess = {
    "id": sid, "workspaceId": TMP, "title": "tui relay test", "model": "glm-4.7",
    "mode": "build", "createdAt": int(time.time() * 1000), "updatedAt": int(time.time() * 1000),
    "messageCount": 1,
    "messages": [{"id": "m1", "role": "user", "content": "hi", "createdAt": int(time.time() * 1000)}],
    "todos": [],
}
with open(f"{TMP}/.tagent/sessions/{sid}.json", "w") as f:
    json.dump(sess, f)

master, slave = pty.openpty()
proc = subprocess.Popen(
    ["bun", "packages/cli/src/index.ts", TMP],
    stdin=slave, stdout=slave, stderr=slave,
    cwd="/home/z/my-project", preexec_fn=os.setsid,
)
os.close(slave)

buf = ""
def read_until(pattern, timeout=25):
    global buf
    t0 = time.time()
    while time.time() - t0 < timeout:
        r, _, _ = select.select([master], [], [], 0.5)
        if r:
            try:
                data = os.read(master, 65536).decode("utf-8", "replace")
            except OSError:
                break
            buf += data
            m = re.search(pattern, buf)
            if m:
                return m
        if proc.poll() is not None:
            break
    print("--- OUTPUT SO FAR ---"); print(buf[-2000:]); sys.exit(1)

try:
    read_until(r"/help lists every command")
    print("✓ TUI banner shown")
    time.sleep(0.5)
    os.write(master, b"/relay\n")
    m = read_until(r"live relay for .tui relay test.", 30)
    print("✓ /relay created a live relay for the session")
    # grab the url line
    url = re.search(r"(http://127\.0\.0\.1:\d+/relay/[a-z0-9]+)", buf)
    assert url, "no relay url printed"
    print("✓ relay url printed:", url.group(1))
    # the page must be fetchable
    page = urllib.request.urlopen(url.group(1), timeout=5)
    body = page.read().decode()
    assert page.status == 200 and "doctype" in body
    print("✓ viewer page served by the on-demand daemon")
    os.write(master, b"/relay list\n")
    read_until(r"live relays \(1\)")
    print("✓ /relay list shows the relay")
    os.write(master, b"/relay stop " + url.group(1).split("/")[-1].encode() + b"\n")
    read_until(r"relay [a-z0-9]+ ended")
    print("✓ /relay stop revokes it")
    time.sleep(0.3)
    try:
        urllib.request.urlopen(url.group(1), timeout=5)
        after = 200
    except urllib.error.HTTPError as e:
        after = e.code
    assert after == 404, f"expected 404 after revoke, got {after}"
    print("✓ viewer page 404 after revoke")
    print("\nTUI RELAY TEST ALL OK")
finally:
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except Exception:
        pass
    time.sleep(0.5)
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except Exception:
        pass
    os.close(master)
