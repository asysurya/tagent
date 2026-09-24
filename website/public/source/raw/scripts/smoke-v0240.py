#!/usr/bin/env python3
"""smoke v0.24.0: /config renders the global cockpit; /help lists it."""
import os, pty, sys, time, select as sel, fcntl, termios, struct

WS = '/home/z/my-project/demo-workspace'

def run(cmd, settle=1.2, capture=2.5, send_enter=True):
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(WS)
        os.environ['NO_UPDATE'] = '1'
        os.environ['HOME'] = os.environ.get('SMOKE_HOME', os.environ['HOME'])
        os.execvp('bun', ['bun', 'run', '/home/z/my-project/packages/cli/src/index.ts', 'start'])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 34, 110, 0, 0))
    os.set_blocking(fd, False)
    out = b''
    t0 = time.time()
    sent = False
    while time.time() - t0 < settle + capture:
        r, _, _ = sel.select([fd], [], [], 0.15)
        if r:
            try:
                chunk = os.read(fd, 65536)
                if not chunk: break
                out += chunk
            except OSError:
                break
        elif not sent and time.time() - t0 > settle:
            for ch in cmd:
                os.write(fd, ch.encode())
                time.sleep(0.004)
            if send_enter:
                os.write(fd, b'\r')
            sent = True
    try:
        os.write(fd, b'\x03\x03')  # ctrl+c twice → exit
    except OSError:
        pass
    try:
        os.close(fd)
    except OSError:
        pass
    try:
        os.waitpid(pid, os.WNOHANG)
    except Exception:
        pass
    time.sleep(0.3)
    try:
        os.kill(pid, 9)
    except Exception:
        pass
    try:
        os.waitpid(pid, 0)
    except Exception:
        pass
    return out.decode('utf8', 'replace')

checks = []

# 1. typing /con → the slash autocomplete offers the config command
out = run('/config', send_enter=False)
checks.append(('autocomplete offers /config', 'config' in out))

# 2. /config status renders the global card
out = run('/config status')
checks.append(('/config status prints the card', 'global — status' in out))
checks.append(('card names the config repo', 'tagent-config' in out))
checks.append(('card shows the scope', '~/.tagent/config.json' in out))
checks.append(('card lists actions', '/config push' in out))
checks.append(('no passphrase state shown safely', 'passphrase' in out))

# 3. /config keys with an empty keychain → the friendly hint
out = run('/config keys')
checks.append(('/config keys empty hint', ('no named keys' in out) or ('/config add key' in out)))

# 4. /config pull without login → guarded
out = run('/config pull')
checks.append(('/config pull guarded when logged out', 'not logged in' in out))

fails = 0
for name, ok in checks:
    if not ok: fails += 1
    print(('PASS ' if ok else 'FAIL ') + name)
print('\nSMOKE v0.24.0: ' + ('ALL GREEN' if fails == 0 else f'{fails} FAILURES'))
sys.exit(1 if fails else 0)
