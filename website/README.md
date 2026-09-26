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
- `/source` source browser — file tree, search (files + symbols),
  syntax highlighting, line anchors; every file also served raw + JSON
  for agents (see below)
- `/api/latest` JSON "latest release" endpoint

## The `/source` snapshot — an API for agents

The whole repo source is snapshotted into static files that both humans
and agents can fetch (no auth, no rate limits — it's just static hosting),
plus a queryable `/source/ls` API on top of it:

```
GET /source/ls?path=/&…        ls one folder — like ls in a terminal.
                                Query params: path (default /) ·
                                recursive (nested tree) · depth (default 1,
                                max 8) · detail (path · lastModified ·
                                rawUrl/jsonUrl + dir aggregates) · layer
                                (core|cli|gui|website|native|scripts) ·
                                all (list the never-included dir names).
                                Plain text with Accept: text/plain
                                (or ?format=text) — a tree you can read.
GET /source/ls/find?q=…        find files & folders by name (layer, limit)
GET /source/ls/stat?path=…     one file: size · lines · language ·
                                lastModified · JSDoc-header summary · URLs
GET /source/ls/quickref        the curated where-is-what map (validated
                                against the snapshot; stale entries reported)
GET /source/tree.json           the whole tree in ONE fetch — dir nodes carry
                                files/dirs/lines aggregates + dirUrl
GET /source/dir.json            root directory listing (children + sizes)
GET /source/dir/<path>.json     one directory's listing — files carry
                                rawUrl/jsonUrl, dirs carry aggregates +
                                their own dirUrl, plus a parent link
GET /source/index.json          file list + metadata (path · bytes · lines ·
                                language · lastModified · summary · rawUrl ·
                                jsonUrl) + the tree
GET /source/raw/<path>          the raw file contents (text/plain)
GET /source/json/<path>.json    JSON-wrapped: { path, content, language,
                                lines, bytes, lastModified, summary, rawUrl }
GET /source/symbols.json        symbol index (name · file · line · kind)
```

The `/ls` routes are Next.js App Router handlers (`src/app/source/ls/**`)
over `src/lib/source-ls.ts` — they read the build-time snapshot (the same
data as `index.json`, via the generated `src/data/source-snapshot.ts`
module), so there is no filesystem access or per-request rescan; the
`snapshot: { version, generatedAt }` field in every response is the build
stamp. Paths are validated against `.` / `..` / backslashes and only ever
looked up in the in-memory tree — nothing to traverse.

```bash
curl -s "https://tagent-website.vercel.app/source/ls?path=/packages/core/src"
curl -s "…/source/ls?path=/packages/core&recursive=true&depth=2"
curl -H 'Accept: text/plain' -s "…/source/ls?path=/"
curl -s "…/source/ls/find?q=loop"
```

The dir API is walkable with zero state: fetch `dir.json`, follow any
child's `dirUrl` deeper (or `parent` back up), then `rawUrl`/`jsonUrl` to
read a file — a small file system over plain static HTTP.

Regenerate after changing source code (it is committed, like
`public/latest.json`):

```bash
bun scripts/gen-source-snapshot.ts
bun scripts/test-source-site.ts   # hermetic checks: filters, outputs, page
```

Included: `packages/*/src` · the GUI app `src/` · `website/src` ·
`scripts/` · `native/` (Go) · `docs/` · `demo-workspace/` ·
`mini-services/` · `builtin-skills/` · root configs and docs.
Excluded: `node_modules`, lockfiles, `website/public`, build output,
binaries, `.env*`/secrets, files over 512 KB — the full list ships in the
`excluded` field of `index.json`.

Two gotchas already handled:

- `website/tsconfig.json` excludes `public/` — the raw `.ts` copies in
  `public/source/raw/` must never be type-checked or built.
- `next.config.ts` forces `Content-Type: text/plain` on `/source/raw/*`
  (the standard MIME table maps `.ts` → `video/mp2t`).
