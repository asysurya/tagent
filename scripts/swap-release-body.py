#!/usr/bin/env python3
"""swap gh-release.sh BODY to the v0.22.2 story (MCP diagnostics + navbar workspace)"""
import re
import sys

P = '/home/z/my-project/scripts/gh-release.sh'
src = open(P, encoding='utf-8').read()

NEW = """## v__VER__ — MCP failures that say why, and a navbar that says where

A dead MCP server used to report nothing but "error — server exited
(code 1)": the reason it died (npm network error, old Node, a launcher
that isn't installed) was thrown away because stderr was never read. Now
the full story is captured and surfaced — and a missing npx transparently
falls back to bunx on machines that have bun. The navbar also grew a
workspace segment so you always know which folder the agent is in.

```
\\u276f tagent doctor \\u00b7 v__VER__
  \\u2718 mcp context7: error \\u2014 server exited (code 1): npm ERR! code
    ENOTFOUND \\u2014 full reason above; /mcp reload retries after fixing
\\u2570\\u2500 \\U0001F916 build \\u00b7 \\U0001F4C2 tagent-proyek \\u00b7 glm-4.7 \\u00b7 \\U0001F50C 2\\u2713 31 \\u00b7 4m \\u2500\\u256f
```

### MCP: the failure says why

- server stderr is captured \\u2014 the exit error carries the last lines of
  it, so "code 1" becomes "code 1: npm ERR! code ENOTFOUND"
- a missing launcher is named ("cannot start 'npx' \\u2014 not found on
  PATH") with install advice instead of a bare exit code
- doctor and the /mcp menu show 160 chars of the reason; calls made
  after a death include it too

### MCP: npx \\u2192 bunx fallback

- binary installs ship no Node.js \\u2014 a configured npx may simply not
  exist. When bun is installed, tagent transparently launches the
  server with bunx (runs the very same npm packages)
- the fallback shows as a note ("npx not on PATH \\u2014 using bunx")
  instead of three dead servers; custom launchers are untouched

### Navbar: workspace segment

- the facts row now reads \\U0001F916 build \\u00b7 \\U0001F4C2 my-project \\u00b7 glm-4.7 \\u00b7 \\U0001F50C 2\\u2713 31
  \\u2014 you always know which folder the agent is working in
- truncated to 18 cells so long folder names never push the model or
  MCP status off the bar

---
"""

m = re.search(r"(BODY=\$\(cat <<'EOF'\n)(.*?)(## Single-file binaries)", src, re.S)
if not m:
    print('PATTERN NOT FOUND')
    sys.exit(1)

body = NEW.encode().decode('unicode_escape')
src = src[:m.start(2)] + body + src[m.end(2):]
open(P, 'w', encoding='utf-8').write(src)
print('BODY swapped ok')
