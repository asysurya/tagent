#!/usr/bin/env python3
"""replay the captured ANSI stream through a pyte terminal emulator → screen dump."""
import pyte, sys

data = open('/tmp/tui-visual.ansi', 'rb').read().decode('utf-8', 'replace')
H, W = 34, 110
screen = pyte.Screen(W, H)
stream = pyte.Stream(screen)
stream.feed(data)

out = []
for i, line in enumerate(screen.display):
    l = line.rstrip()
    if l.strip():
        print(f'{i:2}| {l}')
