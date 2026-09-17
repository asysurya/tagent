# Contributing to Tagent

Thanks for your interest in making Tagent better! This project is young and
there's plenty of room to shape it.

## Getting started

```bash
git clone https://github.com/asysurya/tagent.git
cd tagent
bash scripts/setup-ubuntu.sh        # or: bun install
bun packages/cli/src/index.ts demo-workspace --no-open   # try it
```

See the README for architecture and the repository layout. The demo-workspace
contains a tiny app with planted bugs — fixing them via the GUI is the fastest
way to feel how the agent behaves.

## Where to help

- **Roadmap items** in the README (streaming tokens, workspace switcher, MEGA
  sync UI, native tool-calling, relay mode…)
- **Providers** — `packages/core/src/providers/` — new BYOK providers welcome
- **Tools** — `packages/core/src/tools/` — ideas: structured grep output,
  ripgrep mode, language-aware edits
- **Skills** — `builtin-skills/` — self-contained SKILL.md playbooks
- **Plugins** — `packages/core/src/plugins.ts` — the plugin API surface
- **Mobile layout** — `src/components/tagent/mobile-shell.tsx` (UserLAnd users!)
- **Docs** — clearer onboarding, screenshots, translations

## Development loop

```bash
bun run dev        # Next.js GUI dev server on :3000 (hot reload)
bun mini-services/tagent-daemon   # daemon on :3001 for the GUI
bun scripts/debug-rpc.ts 3001 /   # RPC smoke test against the daemon
bun run build:gui  # rebuild the static bundle (gui-dist/) before committing UI changes
```

Pull requests that change the GUI must include an updated `gui-dist/` build
(run `bun run build:gui`) — the daemon serves the committed bundle.

## Conventions

- TypeScript everywhere; bun as the runtime (no package-lock, just bun.lock)
- The engine (`packages/core`) stays dependency-free — only `node:` builtins
- Every write tool must go through the permission manager — never bypass it
- File tools are jailed to the workspace root — keep it that way
- One PR per feature; keep diffs reviewable
- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`…)

## Reporting bugs

Open an issue with: what you did, what happened, what you expected, and logs
from the daemon terminal. For crashes, the session file
(`<workspace>/.tagent/sessions/*.json`) helps too — redact API keys first.

## Security

Found something exploitable? Please see SECURITY.md and do not open a public
issue for it.
