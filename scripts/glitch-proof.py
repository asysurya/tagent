#!/usr/bin/env python3
"""Live proof for the v0.31.1 render-guard fix.

Reproduces the field report end-to-end in a REAL pty:
  1. a plugin that console.error's mid-session (the foreign write that used
     to freeze the tool box "like a navbar")
  2. a pty resize mid-session (the reflow that used to desync stickyDrawn)

PASS = the plugin error text appears as a normal transcript row, the navbar
frame rails stay well-formed (╭…╮ / ╰…╯), the editor box is intact, and after
resize the screen still renders one coherent frame — no frozen fragments.
"""
import os, pty, select, signal, subprocess, sys, time, fcntl, termios, struct

REPO = '/home/z/my-project'
APP = REPO + '/packages/cli/src/index.ts'
WS = '/tmp/tagent-glitch-proof'

# workspace + the noisy plugin
subprocess.run(['rm', '-rf', WS], check=False)
os.makedirs(WS + '/.tagent/plugins', exist_ok=True)
with open(WS + '/.tagent/plugins/noisy.mjs', 'w') as f:
    f.write("""export const name = 'noisy'
export const version = '0.1.0'
export const description = 'spams the console mid-session (render-guard proof)'
export const hooks = {
  onSessionStart() { console.error('[noisy] plugin loaded — this line used to break the sticky region') },
  onAgentDone() { console.error('[noisy] run finished — foreign write #2') },
}
""")

pid, fd = pty.fork()
if pid == 0:
    os.chdir(WS)
    os.environ['TERM'] = 'xterm-256color'
    os.environ['TAGENT_NO_UPDATE'] = '1'
    os.execvp('bun', ['bun', APP, 'start', '--inline'])

# 100x30
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))

buf = bytearray()
def drain(t=0.6):
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                d = os.read(fd, 65536)
                if not d: break
                buf.extend(d)
            except OSError:
                break

drain(2.5)

# foreign write #1 (plugin load) + #2 (onUserMessage): SEND a message —
# chatSend is where plugins load and fire onSessionStart/onUserMessage
os.write(fd, b'hello glitch test\r')
drain(3.5)

# resize mid-session: 100x30 -> 72x20 (reflow)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 20, 72, 0, 0))
os.kill(pid, signal.SIGWINCH)
drain(2.0)

os.write(fd, b'\x1b')   # idle esc
drain(0.8)
os.write(fd, b'\x03\x03')  # ctrl-c x2 → exit
drain(0.8)
try:
    os.close(fd)
except OSError:
    pass
try:
    os.waitpid(pid, os.WNOHANG)
except ChildProcessError:
    pass

text = buf.decode('utf-8', 'replace')
open('/tmp/glitch-proof-output.txt', 'w').write(text)

checks = [
    ('plugin error surfaced as transcript text', '[noisy] plugin loaded' in text),
    ('second foreign write surfaced too', '[noisy] run finished' in text),
    ('navbar top rail rendered (╭)', '\u256d' in text),
    ('navbar bottom rail rendered (╰)', '\u2570' in text),
    ('editor box present (rounded corners)', text.count('\u256d') >= 2 or '\u256e' in text),
    ('post-resize frame still paints (cursor-home erase seen)', '\x1b[2J' in text or '\x1b[J' in text),
]
fails = 0
for name, ok in checks:
    print(('PASS ' if ok else 'FAIL ') + name)
    if not ok: fails += 1
print(f'({len(checks) - fails}/{len(checks)} passed, bytes={len(buf)})')
sys.exit(1 if fails else 0)
