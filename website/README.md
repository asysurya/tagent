# Tagent website

The docs / release site for Tagent — deployed on Vercel.

## Run locally

```bash
bun install          # from the repo root (workspace deps)
cd website
bun run dev          # http://localhost:3100
```

## Deploy to Vercel

1. Push the repo to GitHub (it already is).
2. On Vercel: **Add New… → Project** → import `asysurya/tagent`.
3. **Root Directory** → set to `website` (important — the repo root is the
   product GUI, the site lives here).
4. Framework preset: Next.js (auto-detected). Build command `next build`
   is standard. Deploy.
5. Optionally attach a domain (e.g. `tagent.dev`) in Project Settings.

## Keeping releases in sync

- Changelog lives in `src/data/releases.ts` (newest first).
- **Preparing a release before it is cut**: add the entry at the top with
  `unreleased: true` and leave `LATEST` at the shipped version — the site
  shows the entry as "upcoming" and links nothing that does not exist yet.
- **At release time**: bump `LATEST` to the new version, remove the
  `unreleased` flag, run `bun scripts/sync-latest.ts` (regenerates
  `public/latest.json` — the CLI update-check endpoint), then
  `git tag vX.Y.Z && git push --tags` so the archive links resolve.

## Pages

- `/` landing (hero, screenshots, features, architecture)
- `/docs` install (laptop + phone), first run, usage, config, updates
- `/releases` full changelog
- `/download` platform matrix + per-release source archives
- `/api/latest` JSON "latest release" endpoint
