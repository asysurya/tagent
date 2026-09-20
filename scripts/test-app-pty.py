#!/usr/bin/env python3
"""tagent app TUI — pty regression suite (v0.13.0 core UX).

Covers the owner's bug reports + the new work items end-to-end:
  - alt-screen boot, banner, header, footer keys, clean exit
  - persistent stats row (model · mode · tokens · elapsed · workspace)
  - slash palette: open with '/', arrows select, Enter SUBMITS the command
  - model picker flow: search/filter + pinned "+ add custom provider" CTA,
    custom provider wizard entry (and esc-cancel)
  - @file completion: Enter inserts the highlighted file
  - scroll mode: pgup then arrows scroll the transcript ONE LINE at a time
    (instead of walking history); typing jumps back to the bottom
  - lone-ESC detection (50ms disambiguation timer) and the idle esc notice,
    plus esc-esc (double tap) no longer being swallowed, and esc clearing
    editor text
  - editor frame alignment at W=100, odd W=41 and with CJK content
  - ctrl+x menu still renders and esc closes it

Harness notes: reads are non-blocking; EAGAIN is EXPECTED (fd drained) and
must CONTINUE, not break — breaking the read loop lets the pty buffer fill
up and the app's synchronous TTY writes block, freezing it (looked like an
app bug but was a harness artifact). One frame = one '\x1b[H'-prefixed
write; the last frame in the stream is the current screen. The pty line
discipline has ONLCR set, so every '\n' the app writes arrives as '\r\n' —
row parsing must strip the trailing '\r' or every width measurement is off
by one. (esc-while-running is covered headless in scripts/test-tui-md.ts —
the pty cannot fake a live model run deterministically.)
"""
import os, pty, re, sys, time, errno, struct, fcntl, termios, unicodedata
import select as sel

CWD = '/home/z/my-project/demo-workspace'
APP = '/home/z/my-project/packages/cli/src/index.ts'
ROWS, COLS = 28, 100

ANSI_RE = re.compile(r'\x1b(?:\[[0-9;:<>?]*[A-Za-z~]|\][^\x07\x1b]*(?:\x07|\x1b\\))')


def strip_ansi(s: str) -> str:
    return ANSI_RE.sub('', s)


def dwidth(s: str) -> int:
    """east-asian display width — mirrors the app's cpWidth closely enough
    (CJK wide=2; box-drawing/arrows/bullets are ambiguous=1 in both)"""
    return sum(2 if unicodedata.east_asian_width(ch) in 'WF' else 1 for ch in s)


class App:
    def __init__(self, rows=ROWS, cols=COLS):
        self.rows, self.cols = rows, cols
        self.buf = b''
        self.dead = False
        self.status = None
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(CWD)
            os.environ['TERM'] = 'xterm-256color'
            os.execvp('bun', ['bun', APP, 'start'])
        self.setsize(rows, cols)
        os.set_blocking(self.fd, False)

    def setsize(self, rows, cols):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        self.rows, self.cols = rows, cols

    def _read_once(self):
        while True:
            try:
                chunk = os.read(self.fd, 65536)
            except OSError as e:
                if e.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                    break
                if e.errno == errno.EIO:
                    self.dead = True
                    break
                raise
            if not chunk:
                self.dead = True
                break
            self.buf += chunk

    def pump(self, dur=0.25):
        end = time.time() + dur
        while time.time() < end:
            if sel.select([self.fd], [], [], 0.05)[0]:
                self._read_once()

    def send(self, data, settle=0.35):
        if isinstance(data, str):
            data = data.encode()
        os.write(self.fd, data)
        self.pump(settle)

    def wait_for(self, needle, timeout=25, step=0.1):
        if isinstance(needle, str):
            needle = needle.encode()
        end = time.time() + timeout
        while time.time() < end:
            self._read_once()
            if needle in self.buf:
                return True
            if self.dead:
                break
            sel.select([self.fd], [], [], step)
        return needle in self.buf

    def screen(self):
        """last rendered frame → list of ANSI-stripped row strings.

        The app writes '\x1b[?25l\x1b[H' then '\r\x1b[2K<row>\n' per row;
        ONLCR turns each '\n' into '\r\n', so split parts carry a trailing
        '\r' that MUST be stripped (width math) and the element before the
        first '\r\x1b[2K' is the frame prefix, not a row.
        """
        idx = self.buf.rfind(b'\x1b[H')
        if idx < 0:
            return []
        frame = self.buf[idx:].replace(b'\x1b[?25l', b'')
        rows = []
        for part in frame.split(b'\r\x1b[2K')[1:]:
            rows.append(strip_ansi(part.decode('utf8', 'replace')).rstrip('\r\n'))
        return rows

    def editor_box(self):
        """the editor frame rows (top border → bottom border, inclusive)"""
        rows = self.screen()
        for i, r in enumerate(rows):
            if r.startswith('╭'):
                for j in range(i + 1, len(rows)):
                    if rows[j].startswith('╰'):
                        return rows[i:j + 1]
        return []

    def transcript_rows(self):
        """rows between the header and the status row above the editor box
        (no overlay is open when this is used)"""
        rows = self.screen()
        box_top = next((i for i, r in enumerate(rows) if r.startswith('╭')), len(rows))
        return rows[1:max(1, box_top - 1)]

    def close(self):
        try:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid == 0:
                os.kill(self.pid, 9)
                os.waitpid(self.pid, 0)
                self.status = -1
            else:
                self.status = status
        except OSError:
            self.status = -1


RESULTS = []


def check(name, cond):
    RESULTS.append((name, bool(cond)))
    print(('PASS ' if cond else 'FAIL ') + name, flush=True)


app = App()

# ---- 1. boot ---------------------------------------------------------------
check('app alive after boot', not app.dead)
check('banner renders', app.wait_for('terminal-native coding agent', timeout=40))
app.pump(1.0)  # let the startup update check land before interacting
if b'update now?' in app.buf:  # esc = skip — never let it eat the interactions
    app.send('\x1b', 0.5)
    check('update prompt dismissed (skipped)', True)
check('alt screen entered', b'\x1b[?1049h' in app.buf)
rows = app.screen()
check('header renders (workspace)', bool(rows) and 'demo-workspace' in rows[0])
check('footer keys (esc stop/clear)', any('esc stop/clear' in r for r in rows))
check('stats row renders (model · mode · … · ws)',
      any(r.rstrip().endswith('demo-workspace') and (' · build · ' in r or ' · plan · ' in r) for r in rows))

box = app.editor_box()
widths = [dwidth(r) for r in box]
check('editor box aligned at W=100', len(box) >= 4 and len(set(widths)) == 1 and widths[0] == COLS)
check('all rows fit W=100', all(dwidth(r) <= COLS for r in rows))

# ---- 2. ctrl+x menu ----------------------------------------------------------
app.send('\x18', 0.5)
rows = app.screen()
check('ctrl+x menu renders (box)', any('menu — ctrl+x' in r for r in rows))
check('ctrl+x menu renders (Continue item)', any('Continue' in r for r in rows))
app.send('\x1b', 0.5)
check('esc closes the menu', not any('menu — ctrl+x' in r for r in app.screen()))

# ---- 3. slash palette: '/' → arrow → Enter SUBMITS ---------------------------
app.send('/', 0.5)
check("typing '/' opens the palette", any('commands' in r for r in app.screen()))
check('palette lists /help', any('/help' in r for r in app.screen()))
app.send('\x1b[B', 0.3)  # arrow down
app.send('\r', 0.8)      # enter → the highlighted command runs (/new)
check('palette Enter submits (picker opens)',
      any('new session' in r for r in app.screen()) and any('↑↓ move' in r for r in app.screen()))
app.send('\x1b', 0.5)
check('picker esc cancels', any('cancelled' in r for r in app.screen()))

# ---- 4. /model flow: search + custom provider wizard -------------------------
app.send('/mod', 0.3)
app.send('\x1b[B', 0.3)  # 'mode' → 'model'
app.send('\r', 0.8)
scr = app.screen()
check('/model opens the provider picker', any('↑↓ move' in r for r in scr))
check('custom provider CTA visible', any('add custom provider' in r for r in scr))
app.send('zzz', 0.5)  # search with no matches — CTA stays pinned
scr = app.screen()
check('picker search filters (no matches state)', any('no matches' in r for r in scr))
check('CTA pinned through empty search', any('add custom provider' in r for r in scr))
app.send('\r', 0.8)  # enter on the CTA → wizard
scr = app.screen()
check('custom provider wizard opens', any('add a custom provider' in r for r in scr))
check('wizard asks for the label', any('label' in r for r in scr))
app.send('\x1b', 0.5)
check('wizard esc cancels', any('cancelled' in r for r in app.screen()))

# ---- 5. @file completion: Enter inserts --------------------------------------
app.send('@rea', 0.6)
check('@file completion opens', any('@ files' in r for r in app.screen()))
check('README.md offered', any('README.md' in r for r in app.screen()))
app.send('\r', 0.5)
scr = app.screen()
check('file completion Enter inserts the path',
      any('README.md' in r for r in app.editor_box()) and not any('@ files' in r for r in scr))
app.send('\x1b', 0.5)
check('esc clears the editor text', any('Message tagent' in r for r in app.editor_box())
      and not any('README.md' in r for r in app.editor_box()))

# ---- 6. scroll mode: arrows scroll ONE line, not history ----------------------
app.send('/settings\r', 1.2)
app.send('/settings\r', 1.2)
# the dump is longer than the viewport and renders as one debounced frame, so
# the early keys (defaultProvider/defaultModel) never hit the wire — assert
# the late keys that the visible window actually ends on
check('settings dumped to the transcript',
      any('autoCheckpoint' in r for r in app.screen()) and any('maxTurns' in r for r in app.screen()))
app.send('\x1b[5~', 0.6)  # pgup
check('pgup scrolls (scrolled indicator)', any('scrolled' in r for r in app.screen()))
t0 = app.transcript_rows()
app.send('\x1b[A', 0.4)  # up — must scroll ONE line
t1 = app.transcript_rows()
check('up-arrow scrolls a single line', bool(t0) and bool(t1) and t1[0] != t0[0] and t1[1:] == t0[:-1])
app.send('\x1b[B', 0.4)  # down — one line back
t2 = app.transcript_rows()
check('down-arrow steps back one line', t2 == t0)
check('arrows did not recall history into the editor',
      not any('/settings' in r for r in app.editor_box()))
app.send('x', 0.5)
check('typing jumps back to the bottom', not any('scrolled' in r for r in app.screen()))
check('typed key landed in the editor', not any('Message tagent' in r for r in app.editor_box()))

# ---- 7. ESC detection (timer) + idle notice -----------------------------------
app.send('\x1b\x1b', 0.7)  # double-tap: both escs fire, nothing is swallowed
check('esc-esc detected (idle notice)', any('nothing to cancel' in r for r in app.screen()))
app.send('y', 0.4)  # any key clears the notice
check('notice clears on the next key', not any('nothing to cancel' in r for r in app.screen()))
app.send('\x15', 0.4)  # ctrl+u clears the 'y'
app.send('\x1b', 0.7)  # lone esc: must fire via the 50ms disambiguation timer
check('lone esc detected (idle notice)', any('nothing to cancel' in r for r in app.screen()))

# ---- 8. odd width + CJK border alignment --------------------------------------
app.setsize(24, 41)
app.pump(1.0)
rows = app.screen()
check('resize: every row fits W=41', all(dwidth(r) <= 41 for r in rows))
box = app.editor_box()
widths = [dwidth(r) for r in box]
check('resize: editor box aligned at odd W=41', len(box) >= 4 and len(set(widths)) == 1 and widths[0] == 41)
app.send('你好世界', 0.6)
box = app.editor_box()
widths = [dwidth(r) for r in box]
check('CJK: editor box stays aligned', len(box) >= 4 and len(set(widths)) == 1 and widths[0] == 41)
check('CJK: text rendered in the editor', any('你好世界' in r for r in box))
app.send('\x1b', 0.5)

# ---- 9. exit -------------------------------------------------------------------
app.send('/exit\r', 3.0)
check('alt screen restored', b'\x1b[?1049l' in app.buf)
app.close()
check('app exited cleanly (status 0)', app.status == 0)

failed = [n for n, ok in RESULTS if not ok]
print(f'({len(RESULTS) - len(failed)}/{len(RESULTS)} passed, bytes={len(app.buf)})')
if failed:
    print('FAILED:', *failed, sep='\n  - ')
    sys.exit(1)
print('ALL PASS')
