# Security policy

Tagent runs an agent with shell/file access on **your machine**. We take that
seriously.

## Scope

- The daemon (`packages/cli`) and engine (`packages/core`)
- The web GUI and its websocket protocol
- How API keys and credentials are stored

## Threat model (read this before running it)

- Tagent executes model-chosen commands and file edits in the workspace you
  point it at. Permissions gate every risky action — keep `ask` defaults for
  `bash`/`write_file` unless you understand the trade-off.
- The daemon binds to `127.0.0.1` by default. `--host 0.0.0.0` exposes it to
  your LAN — there is no authentication layer yet; treat it as you would an
  open SSH socket.
- API keys live in `~/.tagent/config.json` and workspace `.tagent/config.json`
  (gitignored). MEGA vault keys are client-side encrypted; the server never
  stores plaintext.
- The `browser` tool runs Playwright Chromium headless.

## Reporting a vulnerability

Please report privately: open a GitHub **security advisory** on this repo
(Security → Report a vulnerability). If that's not possible, open an issue
titled "security contact" and we'll share a private channel.

Include: description, impact, reproduction steps, affected versions. Please do
not test against other people's deployments.

We aim to respond within 72 hours.

## Disclosure

Once fixed, we publish an advisory and credit the reporter (unless they prefer
to stay anonymous).
