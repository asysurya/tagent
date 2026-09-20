#!/usr/bin/env python3
"""One-shot: rewrite the BODY heredoc in scripts/gh-release.sh for v0.13.1
(updater honesty fix), with a dynamic __VER__ placeholder so future releases
only bump $VERSION. Also updates the release name in the jq line."""
import re
import sys

SCRIPT = "scripts/gh-release.sh"
src = open(SCRIPT, encoding="utf-8").read()

NEW_BODY = """# ---------------------------------------------------------- 2. the release --
BODY=$(cat <<'EOF'
## v__VER__ — updater honesty fix (source installs)

`tagent update` on a **source install** could lie: it pulled whatever repo
happened to be the current directory, printed "✔ source updated", and left the
running tagent untouched (caught from a live report — thanks!). v__VER__
updates the checkout that actually provides the running code — and proves it.

### What changed
- The updater walks up from the **running entry file** (through symlinks and
  wrappers — `bun link`, `~/.local/bin/tagent`) to find the tagent checkout and
  pulls **that**, never whatever repo you happen to be standing in
- After pulling it reads the new version back and prints it — a stale branch
  or a second install can no longer fake a successful update
- When `which tagent` resolves somewhere else than the updated checkout, a
  warning names both paths (old installs can be removed with `tagent uninstall`)
- **UserLAnd / proot**: updates run `bun install --linker=hoisted` so socket.io
  loads correctly afterwards
- Not near a tagent checkout? The updater says so and prints the manual fix
  instead of touching the repo you are in

### Getting this fix when you're on v0.13.0 or older
The old updater is the broken part — update once manually:

```bash
cd <your tagent clone> && git pull && bun install
tagent --version   # -> 0.13.1
```

(or download a single-file binary below and skip source entirely)

---

## Single-file binaries: download, run, done

One self-contained executable per platform — like the Node.js/Python
downloads. No runtime, no install, no clone: grab the file for your OS,
run it, and both the TUI and the browser GUI just work (the web GUI is
embedded inside the binary and self-extracts on first run).

| File | Platform |
| --- | --- |
| `tagent-v__VER__-windows-x64.exe` | Windows 10+ (64-bit) |
| `tagent-v__VER__-windows-arm64.exe` | Windows 10+ on ARM |
| `tagent-v__VER__-linux-x64` | Linux (glibc, 64-bit) |
| `tagent-v__VER__-linux-arm64` | Linux ARM64 (incl. Raspberry Pi 5) |
| `tagent-v__VER__-macos-x64` | macOS Intel |
| `tagent-v__VER__-macos-arm64` | macOS Apple silicon |

Native edition (Go):

| File | Platform |
| --- | --- |
| `tagent-native-windows-386.exe` | **Windows 7/8/8.1/10/11 — 32-bit & 64-bit** |
| `tagent-native-windows-amd64.exe` | Windows 7+ (64-bit, lightweight) |
| `tagent-native-linux-amd64` | Linux (static — any distro, any glibc) |
| `tagent-native-linux-arm64` | Linux ARM64 (static) |

| `SHA256SUMS.txt` | checksums for everything above |

Also linked from the website's [download page](https://tagent-website.vercel.app/download),
which auto-detects your platform — 32-bit Windows visitors get the native
edition automatically.

### Native Windows — no WSL needed
- The full builds run the full stack natively: TUI, daemon, web GUI, relay, the 40-provider catalog
- The bash tool uses Git for Windows' bash.exe (auto-detected, override with `TAGENT_BASH`); `tagent doctor` tells you if it's missing
- Home/config/sessions live in the real Windows user profile (`~/.tagent` via USERPROFILE)
- Windows 7/8/32-bit: use the native edition above — it has the same app TUI

**Install / upgrade**

```bash
# Linux / macOS
chmod +x tagent-v__VER__-linux-x64 && ./tagent-v__VER__-linux-x64 doctor
# Windows (PowerShell) — the .exe runs as-is
.\\tagent-v__VER__-windows-x64.exe doctor
# Windows 7 / 32-bit — native edition (just run it: the app TUI opens)
.\\tagent-native-windows-386.exe
```

**Verify a download**

```bash
sha256sum --check SHA256SUMS.txt   # certutil -hashfile <file> SHA256 on Windows
```
EOF
)
BODY=${BODY//__VER__/$VERSION}"""

# replace from the section-2 marker through the closing of the heredoc
pattern = re.compile(
    r"# -+ 2\. the release --.*?\nEOF\n\)\n",
    re.S,
)
if not pattern.search(src):
    print("could not find the BODY heredoc block")
    sys.exit(1)
src = pattern.sub(NEW_BODY + "\n", src, count=1)

# dynamic release name + __VER__ interpolation note in the jq call
src = src.replace(
    '--arg name "v$VERSION — GitHub login & project sync, markdown in the terminal, TUI polish"',
    '--arg name "v$VERSION — updater honesty fix (source installs update the checkout that runs)"',
)

open(SCRIPT, "w", encoding="utf-8").write(src)
print("patched scripts/gh-release.sh → v0.13.1 body with __VER__ placeholder")
