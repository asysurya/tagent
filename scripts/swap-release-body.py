#!/usr/bin/env python3
"""swap gh-release.sh BODY to the v0.22.1 story (raw-paste fallback)"""
import re
import sys

P = '/home/z/my-project/scripts/gh-release.sh'
src = open(P, encoding='utf-8').read()

NEW = """## v__VER__ — pastes that paste, in every terminal

v0.22.0 made bare enter send, which exposed a corner: in terminals
without bracketed-paste support, a pasted multi-line blob arrived as raw
keystrokes and the first line's newline submitted the composer. The new
raw-paste heuristic recognizes that burst and reroutes it into the editor
as text. Typed input is untouched — a bare enter at the end of its own
keystroke burst still sends.

```
╭─ ✻ Tagent v__VER__ ── 💬 pasting the migration notes ────╮
╰─ 🤖 build · glm-4.7 · 🔌 2✓ 31 · ◉ laptop-b25 online ────╯

  ❯ (paste: 40 lines of YAML with blank lines)
    all 40 lines sit in the composer, newlines intact — nothing sent
? shortcuts · / commands · @ files       build · glm-4.7 · ⎇ you/api ⇅15s
```

### Raw-paste fallback (no bracketed paste needed)

- terminals that ignore the bracketed-paste mode (older conhost, some
  SSH/IDE consoles) send pastes as one burst of raw keys with a bare
  carriage-return at each line end — that burst is now detected and
  inserted as text instead of parsed as keys
- CRLF, CR-only, and LF-only pastes all land with their line structure
  intact; a CRLF pair becomes one newline and blank lines survive
- a single trailing newline (the select-copy artifact) drops, and pasted
  CSI/escape bytes — the coloring codes that ride along when you copy
  terminal output — never reach the composer

### Typing stays typing

- a bare enter as the last key of its burst still submits — fast typists
  and coalesced chunks included
- modified enters are never mistaken for pastes: alt+enter and kitty
  shift/ctrl+enter keep inserting newlines mid-chunk
- menus, dialogs, the ask-form notes box: paste lands in whichever editor
  owns input, same as bracketed pastes always did

---
"""

m = re.search(r"(BODY=\$\(cat <<'EOF'\n)(.*?)(## Single-file binaries)", src, re.S)
if not m:
    print('PATTERN NOT FOUND')
    sys.exit(1)
src = src[:m.start(2)] + NEW + src[m.start(2):][:0] + src[m.end(2):]
open(P, 'w', encoding='utf-8').write(src)
print('BODY swapped ok')
