/**
 * test-updater-source.ts — verifies the v0.13.1 updater fix.
 *
 * The bug (reported live by the owner): `tagent update` on a *source* install
 * printed "✔ source updated" but `tagent --version` stayed old. Root cause:
 * v0.13.0 and earlier ran `git pull` in the CURRENT DIRECTORY — when the user
 * runs the command from anywhere else (their own repo, a second clone), the
 * wrong tree gets pulled (or the user's own repo!) and success is printed
 * anyway.
 *
 * The fix: the updater resolves the checkout that provides the RUNNING code
 * (realpath of argv[1] walked up to a tagent-shaped repo with our remote),
 * pulls THAT, and verifies the version file afterwards. PATH shadowing is
 * warned about.
 *
 * Scenarios:
 *   A. stale clone on PATH via wrapper, cwd = unrelated repo → stale clone is
 *      updated to the new version; the unrelated repo is untouched.
 *   B. running from a non-tagent location → graceful "can't locate checkout",
 *      the unrelated repo is untouched.
 *
 * Hermetic: git remotes are redirected with `url.<dir>.insteadOf`, the update
 * feed is a local file:// latest.json, and a `bun` shim in PATH swallows
 * `bun install` (no network, no node_modules churn).
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ROOT = '/home/z/my-project'
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-upd-'))
const ORIGIN = path.join(WORK, 'origin')
const CLONE = path.join(WORK, 'tagent-A') // the stale install the user "runs"
const DECOY = path.join(WORK, 'user-project') // the repo the user stands in
const SHIM = path.join(WORK, 'shim')
const FEED = path.join(WORK, 'latest.json')

let pass = 0
let fail = 0
function ok(cond: boolean, label: string, extra = ''): void {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`) }
}
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`)
  return r.stdout.trim()
}
function sh(cmd: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): { code: number | null; out: string } {
  const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', ...opts })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/* ---------------- setup ---------------- */
console.log('setting up fixtures (origin · stale clone · decoy repo)…')

// 1. origin: a copy of this repo's history, plus two commits on top:
//    STALE (v0.11.0 marker) ← FRESH (v0.13.0 marker)  [main]
sh(`git clone -q ${ROOT} ${ORIGIN}`)
const OLD = '0.11.0'
const NEW = '0.13.0'
function setVersion(dir: string, v: string): void {
  const f = path.join(dir, 'packages/core/src/version.ts')
  const src = fs.readFileSync(f, 'utf8')
  fs.writeFileSync(f, src.replace(/CURRENT_VERSION = '[^']+'/, `CURRENT_VERSION = '${v}'`))
}
setVersion(ORIGIN, OLD)
git(ORIGIN, 'add', '-A'); git(ORIGIN, 'commit', '-qm', 'chore: marker stale v0.11.0')
setVersion(ORIGIN, NEW)
git(ORIGIN, 'add', '-A'); git(ORIGIN, 'commit', '-qm', 'chore: marker fresh v0.13.0')
const STALE_SHA = git(ORIGIN, 'rev-parse', 'HEAD~1')

// 2. the stale clone the user actually runs (wrapper in PATH → bun <clone>)
sh(`git clone -q ${ORIGIN} ${CLONE}`)
git(CLONE, 'reset', '--hard', STALE_SHA) // main sits at STALE, tracks origin/main=FRESH
// make the remote LOOK like github (what the updater requires) but redirect via insteadOf
git(CLONE, 'remote', 'set-url', 'origin', 'https://github.com/asysurya/tagent.git')
git(CLONE, 'config', `url.${ORIGIN}.insteadOf`, 'https://github.com/asysurya/tagent.git')
// minimal node_modules so the clone can actually RUN: its own workspace core
// (version = STALE) + the runtime deps borrowed from the real install
fs.mkdirSync(path.join(CLONE, 'node_modules/@tagent'), { recursive: true })
fs.symlinkSync('../../packages/core', path.join(CLONE, 'node_modules/@tagent/core'))
/** link every package of src/node_modules into dst/node_modules (skip
 *  .bin and any scopes in `skipScopes`) */
const linkAll = (src: string, dst: string, skipScopes: string[] = []): void => {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src)) {
    if (e === '.bin' || e === '.cache') continue
    if (e.startsWith('@') && skipScopes.includes(e)) continue
    const from = path.join(src, e)
    const t = path.join(dst, e)
    if (e.startsWith('@')) {
      fs.mkdirSync(t, { recursive: true })
      for (const sub of fs.readdirSync(from)) {
        const ts = path.join(t, sub)
        if (!fs.existsSync(ts)) fs.symlinkSync(path.join(from, sub), ts)
      }
    } else if (!fs.existsSync(t)) fs.symlinkSync(from, t)
  }
}
try {
  // workspace root hoist (socket.io and friends)
  linkAll(path.join(ROOT, 'node_modules'), path.join(CLONE, 'node_modules'))
  // v0.18+ runs on real TUI deps (string-width, figures, cli-boxes, …) which
  // bun installs into packages/cli/node_modules — link those too, EXCEPT the
  // @tagent scope: those are workspace links to the REAL core and would make
  // the "stale" clone run the fresh core (version comes from @tagent/core)
  linkAll(path.join(ROOT, 'packages/cli/node_modules'), path.join(CLONE, 'packages/cli/node_modules'), ['@tagent'])
} catch { /* best-effort — missing deps surface as a clear error below */ }

// 3. the decoy: the user's own repo they run the update from
fs.mkdirSync(DECOY, { recursive: true })
git(DECOY, 'init', '-q', '-b', 'main')
fs.writeFileSync(path.join(DECOY, 'project.txt'), 'user data\n')
git(DECOY, 'add', '-A'); git(DECOY, 'commit', '-qm', 'user project')
const DECOY_HEAD = git(DECOY, 'rev-parse', 'HEAD')

// 4. bun shim: swallow `bun install` (records it via marker), exec real bun otherwise
const BUN_MARKER = path.join(WORK, 'bun-install.ran')
fs.mkdirSync(SHIM, { recursive: true })
fs.writeFileSync(path.join(SHIM, 'bun'), [
  '#!/bin/sh',
  `if [ "$1" = "install" ]; then echo ran >> ${JSON.stringify(BUN_MARKER)}; exit 0; fi`,
  `exec ${process.execPath} "$@"`,
  '',
].join('\n'))
fs.chmodSync(path.join(SHIM, 'bun'), 0o755)

// 5. `tagent` wrapper in PATH → runs the STALE clone (argv[1] lands in the clone)
const BIN = path.join(WORK, 'bin')
fs.mkdirSync(BIN, { recursive: true })
fs.writeFileSync(path.join(BIN, 'tagent'), [
  '#!/bin/sh',
  `exec bun ${path.join(CLONE, 'packages/cli/src/index.ts')} "$@"`,
  '',
].join('\n'))
fs.chmodSync(path.join(BIN, 'tagent'), 0o755)

// 6. local update feed
fs.writeFileSync(FEED, JSON.stringify({ version: NEW, date: '2026-09-20', notes: 'test feed', url: 'https://x' }))

const CHILD_ENV = {
  ...process.env,
  PATH: `${BIN}:${SHIM}:${process.env.PATH}`,
  TAGENT_UPDATE_URL: `file://${FEED}`,
  HOME: path.join(WORK, 'home'), // isolated ~/.tagent
}
fs.mkdirSync(CHILD_ENV.HOME, { recursive: true })

/* ---------------- scenario A: user's exact bug ---------------- */
console.log('\nscenario A — stale clone on PATH, update run from the user’s repo:')
const A = sh('tagent update --yes', { cwd: DECOY, env: CHILD_ENV })
const cloneVer = /CURRENT_VERSION\s*=\s*'([^']+)'/.exec(
  fs.readFileSync(path.join(CLONE, 'packages/core/src/version.ts'), 'utf8'),
)?.[1]
const decoyHeadAfter = git(DECOY, 'rev-parse', 'HEAD')
ok(A.code === 0, 'update exits 0', `code=${A.code}\n${A.out}`)
ok(A.out.includes(`source updated → v${NEW}`), 'reports the real new version', A.out)
ok(A.out.includes('tagent-A'), 'names the checkout it updated', A.out)
ok(cloneVer === NEW, `stale clone bumped ${OLD} → ${cloneVer}`, `clone version.ts = ${cloneVer}`)
ok(decoyHeadAfter === DECOY_HEAD, 'decoy repo untouched')
ok(fs.existsSync(BUN_MARKER), 'bun install ran (shimmed)')

// and the version command now reads the updated tree
const V = sh('tagent --version', { cwd: DECOY, env: CHILD_ENV })
ok(V.out.trim().endsWith(NEW), 'tagent --version now reports the new version', V.out)

/* ---------------- scenario B: no checkout anywhere ---------------- */
console.log('\nscenario B — updater can’t find a checkout (runs from a foreign dir):')
// a driver whose argv[1] lives in the decoy (not a tagent checkout) — the
// updater must refuse gracefully instead of pulling the decoy
const driver = path.join(DECOY, 'run-update.ts')
fs.writeFileSync(driver, `import { selfUpdate } from '${ROOT}/packages/cli/src/updater.ts'\nconst ok = await selfUpdate({ current: '${OLD}', latest: '${NEW}', url: '', notes: '' } as never)\nprocess.exit(ok ? 0 : 1)\n`)
const B = sh(`bun ${driver}`, { cwd: DECOY, env: CHILD_ENV })
ok(B.code === 1, 'refuses (exit 1) when no checkout is found', `code=${B.code}\n${B.out}`)
ok(B.out.includes("can't locate your tagent source checkout"), 'prints the manual fix', B.out)
ok(git(DECOY, 'rev-parse', 'HEAD') === DECOY_HEAD, 'decoy still untouched')

/* ---------------- scenario C: dirty tree auto-stashes ---------------- */
console.log('\nscenario C — dirty checkout (local edits + bun.lock churn) auto-stashes:')
// the owner's exact live failure: local changes to bun.lock + a source file
// made `git pull` abort with "would be overwritten by merge".
const NEW2 = '0.14.0'
setVersion(ORIGIN, NEW2)
// the incoming commit must touch the SAME files the user edited locally —
// that is exactly what made git refuse with "would be overwritten by merge"
fs.appendFileSync(path.join(ORIGIN, 'bun.lock'), `# upstream change ${NEW2}\n`)
fs.appendFileSync(path.join(ORIGIN, 'packages/cli/src/index.ts'), `// upstream change ${NEW2}\n`)
git(ORIGIN, 'add', '-A'); git(ORIGIN, 'commit', '-qm', `chore: marker v${NEW2} (touches files the user also edited)`)
fs.writeFileSync(FEED, JSON.stringify({ version: NEW2, date: '2026-09-20', notes: 'test feed 2', url: 'https://x' }))
fs.appendFileSync(path.join(CLONE, 'bun.lock'), '# local churn\n')
fs.appendFileSync(path.join(CLONE, 'packages/cli/src/index.ts'), '// local edit\n')
const C = sh('tagent update --yes', { cwd: DECOY, env: CHILD_ENV })
const cloneVer2 = /CURRENT_VERSION\s*=\s*'([^']+)'/.exec(
  fs.readFileSync(path.join(CLONE, 'packages/core/src/version.ts'), 'utf8'),
)?.[1]
const stashList = git(CLONE, 'stash', 'list')
const stashShow = sh(`git -C ${CLONE} stash show -p`, {}).out
const cloneIndex = fs.readFileSync(path.join(CLONE, 'packages/cli/src/index.ts'), 'utf8')
ok(C.code === 0, 'update exits 0 despite the dirty tree', `code=${C.code}\n${C.out}`)
ok(C.out.includes('stashed'), 'tells the user the changes were stashed', C.out)
ok(cloneVer2 === NEW2, `clone bumped ${NEW} → ${cloneVer2}`, `clone version.ts = ${cloneVer2}`)
ok(/tagent update v0\.14\.0/.test(stashList), 'stash entry labelled for recovery', stashList)
ok(stashShow.includes('# local churn'), 'bun.lock edits preserved in the stash', stashShow.slice(0, 300))
ok(stashShow.includes('// local edit'), 'index.ts edits preserved in the stash', stashShow.slice(0, 300))
ok(cloneIndex.includes('// upstream change 0.14.0') && !cloneIndex.includes('// local edit'), 'working tree is the clean updated file')
ok(git(DECOY, 'rev-parse', 'HEAD') === DECOY_HEAD, 'decoy untouched again')

/* ---------------- scenario D: unmerged index (the "bun.lock: needs merge" live failure) ---------------- */
console.log('\nscenario D — stuck conflicted merge blocks even `git stash`:')
// the owner's exact NEW failure: a merge was started, conflicted, and left
// unmerged — `git stash push -u` dies with "bun.lock: needs merge / could not
// write index" and `git pull` refuses with "you have unmerged files".
const NEW3 = '0.15.0'
setVersion(ORIGIN, NEW3)
fs.writeFileSync(path.join(ORIGIN, 'CONFLICT.txt'), 'upstream version\n')
git(ORIGIN, 'add', '-A'); git(ORIGIN, 'commit', '-qm', `chore: marker v${NEW3} + add/add conflict file`)
// the feed advertises a version one ahead of origin's tip — that mirrors the
// real world (releases can be ahead of a branch) and guarantees the updater
// actually triggers even though the half-merged tree already carries NEW3
fs.writeFileSync(FEED, JSON.stringify({ version: '0.16.0', date: '2026-09-20', notes: 'test feed 3', url: 'https://x' }))
// local commit: SAME path with different content → AA conflict (version.ts
// itself must stay parseable — the CLI has to boot to run the update)
fs.writeFileSync(path.join(CLONE, 'CONFLICT.txt'), 'local version\n')
git(CLONE, 'add', '-A'); git(CLONE, 'commit', '-qm', 'chore: local add/add conflict file')
git(CLONE, 'fetch', 'origin')
const doomedMerge = sh(`git -C ${CLONE} merge origin/main`)
ok(doomedMerge.code !== 0, 'fixture: the merge conflicts (add/add)', doomedMerge.out)
const unmergedBefore = sh(`git -C ${CLONE} ls-files --unmerged`)
ok(unmergedBefore.out.includes('CONFLICT.txt'), 'fixture: unmerged index entries exist', unmergedBefore.out)
const stashBlocked = sh(`git -C ${CLONE} stash push -u -m x`)
ok(stashBlocked.code !== 0, 'fixture: plain `git stash` refuses (needs merge)', stashBlocked.out)
// user data must survive: seed ~/.tagent before the update
const HOME_TAGENT = path.join(CHILD_ENV.HOME!, '.tagent')
fs.mkdirSync(HOME_TAGENT, { recursive: true })
fs.writeFileSync(path.join(HOME_TAGENT, 'credentials.json'), JSON.stringify({ v: 1, creds: { github: 'ghp_test' } }))
fs.writeFileSync(path.join(HOME_TAGENT, 'config.json'), JSON.stringify({ version: 1, defaultProvider: 'zai', mcp: { servers: { x: { command: 'npx' } } } }))
const D = sh('tagent update --yes', { cwd: DECOY, env: CHILD_ENV })
const cloneVer3 = /CURRENT_VERSION\s*=\s*'([^']+)'/.exec(
  fs.readFileSync(path.join(CLONE, 'packages/core/src/version.ts'), 'utf8'),
)?.[1]
const Dstatus = sh(`git -C ${CLONE} status --porcelain`)
ok(D.code === 0, 'update exits 0 despite the stuck merge', `code=${D.code}\n${D.out}`)
ok(/recovering/.test(D.out), 'tells the user the conflict state was recovered', D.out)
ok(cloneVer3 === NEW3, `clone bumped ${NEW2} → ${cloneVer3}`, `clone version.ts = ${cloneVer3}`)
ok(Dstatus.out.trim() === '', 'checkout left clean after the update', Dstatus.out)
ok(/diverged/.test(D.out), 'divergence handled by fetch+reset (reflog note printed)', D.out)
ok(D.out.includes('user data backed up'), 'announces the ~/.tagent backup', D.out)
const backupDirs = fs.existsSync(path.join(HOME_TAGENT, 'backups'))
  ? fs.readdirSync(path.join(HOME_TAGENT, 'backups')).filter((d) => d.startsWith('update-'))
  : []
ok(backupDirs.length >= 1, 'backup dir created under ~/.tagent/backups', backupDirs.join(','))
const lastBackup = backupDirs.sort().at(-1)!
ok(!!lastBackup, 'backup dir name sane')
const backedUp = fs.readdirSync(path.join(HOME_TAGENT, 'backups', lastBackup))
ok(backedUp.includes('credentials.json') && backedUp.includes('config.json'), 'auth + mcp config are in the backup', backedUp.join(','))
ok(fs.existsSync(path.join(HOME_TAGENT, 'credentials.json')), 'credentials.json still in place after the update')
ok(fs.readFileSync(path.join(HOME_TAGENT, 'credentials.json'), 'utf8').includes('ghp_test'), 'credential content intact')
ok(git(DECOY, 'rev-parse', 'HEAD') === DECOY_HEAD, 'decoy untouched (again)')

/* ---------------- report ---------------- */
console.log(`\nupdater-source tests: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
