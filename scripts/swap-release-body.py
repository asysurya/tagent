#!/usr/bin/env python3
"""swap gh-release.sh BODY to the v0.24.0 story (config sync + multi-key)."""
import re
import sys

P = '/home/z/my-project/scripts/gh-release.sh'
src = open(P, encoding='utf-8').read()

NEW = """## v__VER__ — Config sync: one private repo, every device

Log in once and tagent now creates a private `tagent-config` repo that
carries your WHOLE global config — providers, api keys, MCP servers,
models, permissions, theme — sealed with AES-256-GCM and identical on
every device. `/config` is the new cockpit (push · pull · add mcp ·
add provider · keys), providers can hold SEVERAL named api keys, and
`tagent start` warns every boot if the repo gets deleted on GitHub.

```
\\u2699 config sync \\u2014 pushed \\u2192 octocat/tagent-config
\\u2570\\u2500 \\U0001F916 build \\u00b7 \\U0001F4C2 tagent-proyek \\u00b7 glm-4.7 \\u00b7 \\U0001F50C 2\\u2713 31 \\u00b7 4m \\u2500\\u256f
```

### The config repo — auto-created on auth

- `tagent auth` (terminal, TUI /auth, web GUI) ensures a PRIVATE
  login/tagent-config repo and pushes the global config into it —
  the GitHub token never leaves the device's credential store
- the vault carries everything: default provider/model, api keys,
  the keychain, custom providers, MCP servers, permissions, fallback
  chain, theme, caveman, compact, cache, diagnostics
- pull = remote wins per key; push = local wins; conflicts abort
  with "nothing was lost" — a defaults-only device can never
  clobber a richer remote (every bootstrap pulls first)

### /config — the global cockpit

- `/config push` \\u00b7 `/config pull` \\u2014 explicit whole-config sync;
  `/config status` shows repo health (exists / deleted / offline),
  last push & pull, key counts per provider
- `/config add mcp` \\u2014 global servers (every project, hot-loads in the
  current one too); `/config add provider`; `/config use <prov>/<model>`
  sets the global default
- `/config keys` \\u2014 the multi-key manager: \\u25cf active / \\u25cb idle,
  switch, remove, or stack a key into the fallback chain

### Multi-key everywhere

- several named keys per provider ("work", "backup", "free tier");
  the ACTIVE one stays apiKeys[provider] so every resolution path
  works untouched
- `/model` asks which key to use when a provider has several;
  `/apikey` registers every key into the keychain (first = "main")
- the keychain rides the config repo AND the project vault, so it
  shows up on every device

### Boot health + doctor

- every `tagent start`: repo deleted \\u2192 yellow banner (until
  /config push recreates it); remote moved \\u2192 pulled + applied;
  local moved \\u2192 pushed \\u2014 devices converge with zero clicks
- offline stays silent, the next start checks again; existing
  installs bootstrap the repo lazily after upgrading
- `tagent doctor` reports the config repo + the keychain
"""

BODY_RE = re.compile(r"BODY=\$\(cat <<'EOF'\n[\s\S]*?\nEOF\n\)", re.M)
if not BODY_RE.search(src):
    print('BODY block not found'); sys.exit(1)

src = BODY_RE.sub(lambda m: "BODY=$(cat <<'EOF'\n" + NEW + "EOF\n)", src, count=1)
open(P, 'w', encoding='utf-8').write(src)
print('gh-release.sh BODY swapped to the v0.24.0 story')
