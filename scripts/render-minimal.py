#!/usr/bin/env python3
"""render-minimal.py — replay the captured ANSI stream through a tiny VT
emulator (the subset the TUI emits: \x1b[H · \x1b[2K · \x1b[J · \r · \n ·
cursor-up) and dump the final screen. SGR codes are stripped (layout only)."""
import re, sys

data = open('/tmp/tui-visual.ansi', 'rb').read().decode('utf-8', 'replace')
H, W = 34, 110
rows = [''] * H
cy = cx = 0
i = 0
n = len(data)
while i < n:
    ch = data[i]
    if ch == '\x1b':
        m = re.match(r'\x1b\[([0-9;:<>?]*)([A-Za-z~])', data[i:])
        if m:
            params, fin = m.group(1), m.group(2)
            i += m.end()
            if fin == 'H':
                cy = max(0, (int(params.split(';')[0]) - 1) if params and params.split(';')[0] else 0)
                cx = 0
            elif fin == 'A':
                cy = max(0, cy - (int(params or 1)))
            elif fin == 'B':
                cy = min(H - 1, cy + (int(params or 1)))
            elif fin == 'K' or fin == 'J':
                if fin == 'K':
                    rows[cy] = rows[cy][:cx]
                else:
                    if cy < H:
                        rows[cy] = rows[cy][:cx]
                    for y in range(cy + 1, H):
                        rows[y] = ''
            elif fin == 'M' or fin == 'm' or fin == 'u' or fin == 'h' or fin == 'l':
                pass  # SGR / mouse / mode / kitty — ignored
            continue
        m2 = re.match(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)', data[i:])
        if m2:
            i += m2.end()
            continue
        i += 1
        continue
    if ch == '\r':
        cx = 0
    elif ch == '\n':
        cy = min(H - 1, cy + 1)
        if cy == H - 1 and ch == '\n':
            pass
    else:
        if cy < H and cx < W:
            line = rows[cy]
            if len(line) < cx:
                line += ' ' * (cx - len(line))
            rows[cy] = line[:cx] + ch + line[cx + 1:]
        cx += 1
    i += 1

for idx, line in enumerate(rows):
    l = line.rstrip()
    if l.strip():
        print(f'{idx:2}| {l}')
