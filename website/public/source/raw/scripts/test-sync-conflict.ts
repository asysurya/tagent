/**
 * Offline tests for multi-device sync — the "2 devices editing one project"
 * scenario — in packages/core/src/github.ts pushWorkspace:
 *
 *   0. first sync onto a remote that already has commits (user's own repo)
 *   1. two devices edit DIFFERENT files → auto-rebase, both survive, linear
 *   2. two devices edit different regions of ONE file → auto-merge
 *   3. both edit the same region → clear "nothing was lost" error, clean
 *      repo, remote intact — and the manual `git pull --rebase` recovery
 *      from the error message makes the next `tagent sync` succeed
 *   4. true simultaneity (another device pushes mid-flight, push rejected)
 *      → integrate + retry instead of failing
 *   5. a device with no local changes syncs after the remote moved → the
 *      sync doubles as a pull (fast-forward)
 *   6. token never lands anywhere under .git (FETCH_HEAD scrubbed, config clean)
 *
 * Hermetic: HOME is redirected before core loads, no git identity anywhere
 * (exercises the -c fallback for the rebase too), and the "GitHub" remote is
 * a local bare repo reached through a file:// remoteBase. No network.
 *
 * Run: bun scripts/test-sync-conflict.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { TagentConfig } from '../packages/core/src/types'

/* ---- hermetic environment (MUST be set before core is imported) ---- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-sync-conflict-'))
const HOME = path.join(TMP, 'home')
fs.mkdirSync(HOME, { recursive: true })
process.env.HOME = HOME
process.env.USERPROFILE = HOME
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = path.join(TMP, 'empty-gitconfig') // never created → no git identity

const exec = promisify(execFile)
async function git(...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args)
  return stdout.trim()
}

let fails = 0
function assert(cond: boolean, label: string) {
  console.log(cond ? '✓' : '✗', label)
  if (!cond) fails++
}

/* ---- dynamic import AFTER env setup: GLOBAL_DIR is computed at module load ---- */
const core = await import('../packages/core/src/index')

/* ---- world: device A, device B (a clone of A's project), one bare "GitHub" ---- */
const WS_A = path.join(TMP, 'ws-a')
const BARE = path.join(TMP, 'bare', 'repo.git')
fs.mkdirSync(WS_A, { recursive: true })
fs.mkdirSync(path.dirname(BARE), { recursive: true })
await git('init', '--bare', BARE)
await git('-C', BARE, 'symbolic-ref', 'HEAD', 'refs/heads/main') // clones check out main
const REMOTE_BASE = `file://${path.dirname(BARE)}/`

const cfg: TagentConfig = {
  version: 1,
  defaultProvider: 'zai',
  defaultModel: 'glm-4.7',
  apiKeys: {},
  customProviders: [],
  permissions: { defaultMode: 'ask', tools: {} },
  tools: { bash: true, browser: false },
  github: { login: 'testuser', repo: 'repo' },
  mega: { enabled: false },
  autoCheckpoint: true,
  maxTurns: 40,
  nativeTools: true,
  worklog: { enabled: true },
}

core.saveGithubLogin('fake-token', 'testuser') // the "credential" every sync uses

/** git status --porcelain of a repo dir (empty string = clean). */
async function status(dir: string): Promise<string> {
  return await git('-C', dir, 'status', '--porcelain')
}
/** file content at a remote branch, without touching any working copy. */
async function bareShow(file: string): Promise<string> {
  return await git('-C', BARE, 'show', `main:${file}`)
}
async function bareTree(): Promise<string[]> {
  return (await git('-C', BARE, 'ls-tree', '-r', '--name-only', 'main')).split('\n').filter(Boolean)
}
async function mergeCount(): Promise<string> {
  return await git('-C', BARE, 'log', '--merges', '--oneline', 'main')
}
function scanDir(dir: string, needle: string): boolean {
  let found = false
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (scanDir(p, needle)) found = true }
    else { try { if (fs.readFileSync(p, 'utf8').includes(needle)) found = true } catch { /* binary */ } }
  }
  return found
}

/* ============ 0. first sync onto a remote that ALREADY has commits ============ */
{
  const BARE0_DIR = path.join(TMP, 'bare0')
  const BARE0 = path.join(BARE0_DIR, 'repo0.git')
  fs.mkdirSync(BARE0_DIR, { recursive: true })
  await git('init', '--bare', BARE0)
  await git('-C', BARE0, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  // seed the "user's own repo" with a README from a throwaway clone
  const seed = path.join(TMP, 'seed0')
  await git('clone', BARE0, seed)
  fs.writeFileSync(path.join(seed, 'README.md'), 'existing project\n')
  await git('-C', seed, 'add', '-A')
  await git('-C', seed, '-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '-m', 'seed')
  await git('-C', seed, 'push', 'origin', 'main')
  fs.rmSync(seed, { recursive: true, force: true })

  const WS0 = path.join(TMP, 'ws0')
  fs.mkdirSync(WS0, { recursive: true })
  fs.writeFileSync(path.join(WS0, 'my-work.txt'), 'fresh device work\n')
  const res = await core.syncProject(WS0, { ...cfg, github: { ...cfg.github!, repo: 'repo0' } }, {
    remoteBase: `file://${BARE0_DIR}/`,
  })
  const tree0 = (await git('-C', BARE0, 'ls-tree', '-r', '--name-only', 'main')).split('\n')
  assert(res.repo === 'repo0', 'first sync onto an existing repo succeeds')
  assert(tree0.includes('README.md') && tree0.includes('my-work.txt'), 'existing repo content AND fresh work both live on the remote')
  assert((await git('-C', BARE0, 'log', '--merges', '--oneline', 'main')) === '', 'existing-repo sync stays linear (rebase, no merge commit)')
}

/* ============ device A creates the project, device B clones it ============ */
fs.writeFileSync(path.join(WS_A, 'shared.txt'), 'line-1: base\nline-2: middle\nline-3: base\n')
fs.writeFileSync(path.join(WS_A, 'notes-a.md'), 'notes from device A\n')
const logsA: string[] = []
await core.syncProject(WS_A, cfg, { remoteBase: REMOTE_BASE, message: 'device A initial', onLog: (l) => logsA.push(l) })
assert((await bareTree()).includes('shared.txt'), 'device A pushed the initial project')

const WS_B = (await core.restoreProject('restore-token', 'repo', path.join(TMP, 'clone-b'), {
  remoteBase: REMOTE_BASE,
})).root
assert(fs.existsSync(path.join(WS_B, 'shared.txt')), 'device B cloned the project (files came over)')

/* ============ 1. both devices edit DIFFERENT files at the same time ============ */
fs.writeFileSync(path.join(WS_A, 'file-a.txt'), 'edit from device A\n')
await core.syncProject(WS_A, cfg, { remoteBase: REMOTE_BASE, message: 'A: file-a' })
fs.writeFileSync(path.join(WS_B, 'file-b.txt'), 'edit from device B\n')
const logsB: string[] = []
await core.syncProject(WS_B, cfg, { remoteBase: REMOTE_BASE, message: 'B: file-b', onLog: (l) => logsB.push(l) })
const tree1 = await bareTree()
assert(tree1.includes('file-a.txt') && tree1.includes('file-b.txt'), 'BOTH devices\' edits live on the remote after the second sync')
assert(logsB.some((l) => /rebas/i.test(l)), 'the second device saw the "rebase" step in the sync log')
assert((await mergeCount()) === '', 'history stays linear — no merge commits')
assert((await status(WS_B)) === '', 'device B is left with a clean working tree')
assert(
  (await git('-C', WS_B, 'config', '--get', 'branch.main.merge')) === 'refs/heads/main',
  'syncing does not break the clone\'s upstream tracking (git pull keeps working)',
)

/* ============ 2. both devices edit DIFFERENT REGIONS of ONE file ============ */
fs.writeFileSync(path.join(WS_A, 'shared.txt'), 'line-1: base\nline-2: middle\nline-3: edited by A\n') // A edits the end region
await core.syncProject(WS_A, cfg, { remoteBase: REMOTE_BASE, message: 'A: shared end' })
fs.writeFileSync(path.join(WS_B, 'shared.txt'), 'line-1: edited by B\nline-2: middle\nline-3: base\n') // B (still on the old base) edits the start region
await core.syncProject(WS_B, cfg, { remoteBase: REMOTE_BASE, message: 'B: shared start' })
const merged = await bareShow('shared.txt')
assert(
  merged.includes('edited by B') && merged.includes('edited by A'),
  `same file, different regions → both edits merged (${JSON.stringify(merged)})`,
)

/* ============ 3. both devices edit the SAME region → conflict ============ */
// A catches up first (sync doubles as a pull) so both devices share ONE base
await core.syncProject(WS_A, cfg, { remoteBase: REMOTE_BASE, message: 'A: catch up' })
fs.writeFileSync(path.join(WS_A, 'shared.txt'), 'device A version\n')
await core.syncProject(WS_A, cfg, { remoteBase: REMOTE_BASE, message: 'A: overwrite' })
fs.writeFileSync(path.join(WS_B, 'shared.txt'), 'device B version\n') // same lines, different content, same base
const lastSyncBeforeFail = core.getLinkedProject(WS_B)?.lastSyncAt
let conflictErr = ''
try {
  await core.syncProject(WS_B, cfg, { remoteBase: REMOTE_BASE, message: 'B: overwrite' })
} catch (e) {
  conflictErr = (e as Error).message
}
assert(/nothing was lost/i.test(conflictErr), `conflict throws a "nothing was lost" message (${conflictErr.slice(0, 80)}…)`)
assert(/pull --rebase/i.test(conflictErr), 'the message tells the user how to resolve it')
assert(fs.readFileSync(path.join(WS_B, 'shared.txt'), 'utf8') === 'device B version\n', 'device B kept its own version (rebase aborted cleanly)')
assert((await bareShow('shared.txt')) === 'device A version', 'the remote kept device A\'s version')
assert((await status(WS_B)) === '', 'device B is clean — no half-finished rebase state')
assert(
  !fs.existsSync(path.join(WS_B, '.git', 'rebase-merge')) &&
  !fs.existsSync(path.join(WS_B, '.git', 'rebase-apply')),
  'no rebase-merge/rebase-apply leftovers',
)
assert(
  core.getLinkedProject(WS_B)?.lastSyncAt === lastSyncBeforeFail,
  'the failed sync did not stamp lastSyncAt (it never "happened")',
)

/* --- recovery: follow the error message's own instructions --- */
let pullCode = 0
try { await exec('git', ['-C', WS_B, 'pull', '--rebase']) } catch (e) { pullCode = (e as { code?: number }).code ?? 1 }
assert(pullCode !== 0, 'manual git pull --rebase hits the same conflict (expected at this step)')
// resolve it the standard way: keep device B's side, continue the rebase
await exec('git', ['-C', WS_B, 'checkout', '--theirs', 'shared.txt'])
await exec('git', ['-C', WS_B, 'add', 'shared.txt'])
await exec('git', ['-C', WS_B, '-c', 'user.name=dev-b', '-c', 'user.email=b@x', 'rebase', '--continue'], {
  env: { ...process.env, GIT_EDITOR: 'true' },
})
const logsR: string[] = []
await core.syncProject(WS_B, cfg, { remoteBase: REMOTE_BASE, message: 'B: after manual resolve', onLog: (l) => logsR.push(l) })
assert((await bareShow('shared.txt')) === 'device B version', 'after resolving manually, tagent sync works again (B won the resolved region)')
assert((await status(WS_B)) === '', 'device B clean after the recovery sync')

/* ============ 4. true simultaneity — remote moves BETWEEN fetch and push ============ */
{
  const raceClone = path.join(TMP, 'race-clone')
  await git('clone', BARE, raceClone)
  await git('-C', raceClone, 'config', 'user.name', 'race-device')
  await git('-C', raceClone, 'config', 'user.email', 'race@x')
  // pre-push hook: the FIRST push attempt lets "another device" push to the
  // bare in the gap after tagent's fetch — then fails with fetch-first, the
  // exact state of two devices syncing at the same moment.
  const hook = path.join(WS_B, '.git', 'hooks', 'pre-push')
  fs.writeFileSync(hook, [
    '#!/bin/sh',
    'if [ -f .git/.race-fired ]; then exit 0; fi',
    'touch .git/.race-fired',
    `echo "mid-flight push from device A" >> ${raceClone}/file-race.txt`,
    `git -C ${raceClone} add -A`,
    `git -C ${raceClone} commit -m "race: mid-flight push"`,
    `git -C ${raceClone} push origin main`,
    'exit 0',
    '',
  ].join('\n'))
  fs.chmodSync(hook, 0o755)

  fs.writeFileSync(path.join(WS_B, 'file-c.txt'), 'device B was mid-sync when A pushed\n')
  const logsRace: string[] = []
  await core.syncProject(WS_B, cfg, { remoteBase: REMOTE_BASE, message: 'B: race', onLog: (l) => logsRace.push(l) })
  const treeRace = await bareTree()
  assert(treeRace.includes('file-race.txt') && treeRace.includes('file-c.txt'), 'simultaneous push: BOTH the mid-flight push and B\'s sync landed on the remote')
  assert((await mergeCount()) === '', 'race resolution stays linear')
  assert((await status(WS_B)) === '', 'device B clean after the race sync')
}

/* ============ 5. sync as pull — device with NO local changes, remote moved ============ */
fs.writeFileSync(path.join(WS_A, 'file-d.txt'), 'pushed by A after B cloned around\n')
await core.syncProject(WS_A, cfg, { remoteBase: REMOTE_BASE, message: 'A: file-d' })
await core.syncProject(WS_B, cfg, { remoteBase: REMOTE_BASE, message: 'B: pull-only' })
assert(
  fs.existsSync(path.join(WS_B, 'file-d.txt')),
  'a no-change sync doubles as a pull — A\'s new file appeared on B',
)
assert((await status(WS_B)) === '', 'device B clean after the pull-sync')

/* ============ 6. token hygiene — nothing under .git ============ */
assert(!fs.existsSync(path.join(WS_B, '.git', 'FETCH_HEAD')), 'FETCH_HEAD is scrubbed after every sync')
assert(!scanDir(path.join(WS_B, '.git'), 'fake-token'), 'the sync token never appears anywhere under .git')
assert(!scanDir(path.join(WS_B, '.git'), 'restore-token'), 'the clone token never appears anywhere under .git')

/* ================================ done ================================ */

fs.rmSync(TMP, { recursive: true, force: true })
console.log(fails ? `\nFAILS: ${fails}` : '\nMULTI-DEVICE SYNC TESTS ALL OK')
process.exit(fails ? 1 : 0)
