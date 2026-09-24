# Tagent on your phone — UserLAnd (Android, no root)

Run the full Tagent agent engine + web GUI on an Android phone via
[UserLAnd](https://userland.tech). UserLAnd runs a real Ubuntu filesystem on top
of Android (using proot — no root required), and because it shares the network
namespace with Android, the GUI is reachable from your phone browser at
`localhost:4020`.

```
┌─ Chrome on Android ──── http://localhost:4020 ─┐
│  mobile web GUI (chat, files, terminal, …)      │
└───────────────────┬─────────────────────────────┘
                    │ localhost (shared netns)
┌─ UserLAnd Ubuntu ─▼────────────────────────────┐
│  tagent daemon (bun) — agent loop + static GUI  │
└─────────────────────────────────────────────────┘
```

## Requirements

- Android 7+ phone with **2 GB+ free RAM** (4 GB+ device recommended)
- ~1.5 GB free storage (repo + dependencies)
- No root needed. No Playwright/Chromium on the phone (skip `--with-browser`).

## Step by step

### 1. Install UserLAnd

Install **UserLAnd** from the Play Store or F-Droid.

### 2. Create an Ubuntu session

Open UserLAnd → **Apps** → **Ubuntu** (under Filesystems pick Ubuntu if asked).
Set a username + password (you'll use them only for the session terminal; the
default user has `sudo`). Wait for the filesystem to download and boot.

### 3. Bootstrap (inside the UserLAnd Ubuntu terminal)

```bash
sudo apt-get update && sudo apt-get install -y git curl
```

### 4. Clone and set up Tagent

```bash
git clone https://github.com/asysurya/tagent.git
cd tagent
bash scripts/setup-ubuntu.sh
```

The script detects that it's on a phone (`/proc/version` mentions Android) and
adapts: it skips the heavy browser tool and prints mobile-specific hints.
`bun install` takes a few minutes on a phone — that's normal. The web GUI is
**pre-built and committed** (`gui-dist/`), so nothing needs to be compiled on
the phone.

### 5. Start the agent

```bash
bun packages/cli/src/index.ts ~/my-project --no-open
```

> Create a workspace first if you like: `mkdir -p ~/my-project`

The daemon binds to `127.0.0.1:4020` and prints its banner. Keep this terminal
session open (or move it into the background — see tips below).

### 6. Open the GUI on your phone

Switch to Chrome (or any browser) on the same phone and open:

```
http://localhost:4020
```

You get the full mobile layout: bottom tabs for **Chat, Files, Terminal,
Memory, Skills**, permission prompts, the model picker and settings — the same
engine as on desktop.

## Tips for phones

- **Battery**: Android freezes background apps aggressively. Exempt UserLAnd
  from battery optimization (Settings → Battery → Unrestricted for UserLAnd),
  and keep the screen on for long agent runs.
- **Background**: to close the UserLAnd terminal without killing the daemon:
  ```bash
  nohup bun packages/cli/src/index.ts ~/my-project --no-open > ~/tagent.log 2>&1 &
  ```
  Then reopen it later with `tail -f ~/tagent.log`, and stop it with
  `pkill -f "packages/cli"`.
- **Memory**: if `bun install` is killed, the phone is out of RAM — close other
  apps and retry; bun resumes quickly.
- **The `browser` tool** (Playwright) is not practical on phones. Tagent
  detects this and keeps working without it — `web_fetch` and `ddg_search`
  still work fine.
- **API keys**: add them via the GUI (Settings → gear icon). They are stored in
  `~/.tagent/config.json` on the phone only.
- **External keyboard / SSH**: UserLAnd also exposes an SSH server on port 2022
  — handy for typing from a laptop.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `localhost:4020` won't load | Is the daemon still running in the UserLAnd terminal? Re-run step 5. |
| `bun: command not found` after install | `export PATH="$HOME/.bun/bin:$PATH"` (or restart the session and re-login). |
| `bun install` dies mid-way | Out of RAM — close apps, retry. |
| Port already in use | `bun packages/cli/src/index.ts ~/my-project --port 4021 --no-open` |
| Very slow | proot adds syscall overhead; the agent loop itself is network-bound, so it's mostly fine — installs are the slow part. |

## iOS?

iOS has no UserLAnd equivalent with local ports. Run Tagent on a PC/Raspberry
Pi/VPS and open `http://<its-ip>:4020` from the phone browser (start the daemon
with `--host 0.0.0.0`). Use a VPN or SSH tunnel on untrusted networks.
