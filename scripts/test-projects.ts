/**
 * Offline tests for the GitHub project-sync engine:
 * packages/core/src/projects.ts (registry CRUD, authStatus/logout, syncProject,
 * restoreProject) + the remoteBase plumbing in github.ts pushWorkspace.
 *
 * No network, no real keychain: HOME is redirected to a temp dir BEFORE the
 * core modules load (credentials + the projects registry live under ~/.tagent),
 * and git runs with system/global config disabled, so the commit-identity
 * fallback path is genuinely exercised. The "GitHub" remote is a local bare
 * repo reached through a file:// remoteBase — that is what remoteBase exists for.
 *
 * Run: bun scripts/test-projects.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { TagentConfig } from '../packages/core/src/types'

/* ---- hermetic environment (MUST be set before core is imported) ---- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-projects-'))
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

/* ---- world ---- */
const WS = path.join(TMP, 'ws')
const WS2 = path.join(TMP, 'ws2')
const BARE = path.join(TMP, 'bare', 'repo.git')
fs.mkdirSync(WS, { recursive: true })
fs.mkdirSync(WS2, { recursive: true })
fs.mkdirSync(path.dirname(BARE), { recursive: true })
await git('init', '--bare', BARE)
await git('-C', BARE, 'symbolic-ref', 'HEAD', 'refs/heads/main') // clone checks out main
const REMOTE_BASE = `file://${path.dirname(BARE)}/`
const CLEAN_REMOTE = `${REMOTE_BASE}repo.git`
const REGISTRY = path.join(HOME, '.tagent', 'projects.json')

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

/* ============================ 1. registry CRUD ============================ */

assert(core.listProjects().length === 0, 'fresh registry is empty')
assert(core.getLinkedProject(WS) === null, 'nothing linked initially')
assert(core.isLinkRefused(WS) === false, 'nothing refused initially')

const reg1 = core.linkProject(WS, 'testuser/repo')
assert(
  !!reg1.id && reg1.name === 'ws' && reg1.repo === 'testuser/repo' &&
  reg1.root === path.resolve(WS) && typeof reg1.linkedAt === 'number',
  'linkProject returns a full ProjectReg',
)
assert(core.getLinkedProject(WS)?.id === reg1.id, 'getLinkedProject finds it by root')
assert(core.getLinkedProject(WS + '/')?.id === reg1.id, 'getLinkedProject resolves trailing slashes')
assert(core.getLinkedProject(path.join(TMP, 'ws', '..', 'ws'))?.id === reg1.id, 'getLinkedProject resolves .. segments')
assert(core.listProjects().length === 1, 'registry lists the linked project')

const reg2 = core.linkProject(WS, 'testuser/repo-v2')
assert(reg2.id === reg1.id && reg2.repo === 'testuser/repo-v2', 'linkProject upserts by root (same id, new repo)')
assert(core.listProjects().length === 1, 'upsert does not duplicate entries')

core.markSynced(WS)
assert((core.getLinkedProject(WS)?.lastSyncAt ?? 0) > 0, 'markSynced stamps lastSyncAt')
core.markSynced(path.join(TMP, 'never-linked')) // must not throw
assert(true, 'markSynced on an unlinked root is a safe no-op')

assert(core.unlinkProject(WS) === true, 'unlinkProject removes the link')
assert(core.getLinkedProject(WS) === null, 'unlinked → null')
assert(core.unlinkProject(WS) === false, 'unlinking again returns false')

core.refuseLink(WS)
core.refuseLink(WS)
assert(core.isLinkRefused(WS) === true, 'refuseLink flags the root')
assert(core.isLinkRefused(path.join(TMP, 'other')) === false, 'other roots are not refused')
const rawReg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) as { refused: string[] }
assert(rawReg.refused.length === 1, 'refuseLink does not duplicate entries')

core.linkProject(WS, 'testuser/repo')
assert(core.isLinkRefused(WS) === false, 'linking clears the refusal')
core.unlinkProject(WS)

// corrupt-file recovery
fs.writeFileSync(REGISTRY, '{ this is not json')
assert(core.listProjects().length === 0, 'corrupt registry → fresh empty list')
fs.writeFileSync(REGISTRY, JSON.stringify({ projects: [{ id: 42 }], refused: 'nope' }))
assert(core.listProjects().length === 0 && core.isLinkRefused(WS) === false, 'garbage entries are filtered out')
const reg3 = core.linkProject(WS, 'testuser/repo')
assert(core.getLinkedProject(WS)?.id === reg3.id, 'registry recovers after corruption (valid file rewritten)')

assert(core.defaultRepoName(WS) === 'tagent-ws', 'defaultRepoName derives tagent-<basename>')

/* ========================= 2. workspaceHasWork ========================= */

fs.mkdirSync(path.join(WS, '.tagent'), { recursive: true })
assert(core.workspaceHasWork(WS) === false, 'empty workspace (only .tagent) has no work')
fs.mkdirSync(path.join(WS2, '.git'), { recursive: true })
assert(core.workspaceHasWork(WS2) === false, '.git alone is not work')
fs.writeFileSync(path.join(WS2, 'note.txt'), 'x')
assert(core.workspaceHasWork(WS2) === true, 'any file counts as work')
assert(core.workspaceHasWork(path.join(TMP, 'missing-dir')) === false, 'missing dir → no work')

/* ============================ 3. auth status ============================ */

let st = core.authStatus()
assert(st.logged === false && st.login === undefined, 'authStatus: guest by default')

core.saveGithubLogin('fake-token', 'testuser')
st = core.authStatus()
assert(st.logged === true && st.login === 'testuser', 'authStatus: logged in after saveGithubLogin')

core.deleteCredential('github')
core.updateGlobalConfig({ github: { token: 'cfg-token', login: 'cfguser', clientId: 'cid' } })
st = core.authStatus()
assert(st.logged === true && st.login === 'cfguser', 'authStatus: token cached in global config still counts as logged in')

core.logout()
st = core.authStatus()
assert(st.logged === false, 'logout → guest again')
assert(core.getCredential('github') === undefined, 'logout removed the credential')
assert(!core.readGlobalConfig().github?.token, 'logout scrubbed the global-config token')
assert(core.readGlobalConfig().github?.login === undefined, 'logout scrubbed the cached login')
assert(core.readGlobalConfig().github?.clientId === 'cid', 'logout keeps github.clientId (needed for device login)')

core.saveGithubLogin('fake-token', 'testuser') // log back in for the sync tests

/* ============================ 4. syncProject ============================ */

fs.writeFileSync(path.join(WS, 'hello.txt'), 'hello from the first device\n')
const logs: string[] = []
const t0 = Date.now()
const res = await core.syncProject(WS, cfg, { remoteBase: REMOTE_BASE, message: 'first sync', onLog: (l) => logs.push(l) })
assert(res.repo === 'repo' && res.branch === 'main' && res.commit.length > 0, 'syncProject returns repo/branch/commit')
assert(res.created === false, 'non-GitHub remote reports created:false (repo pre-existed)')
assert(res.url === `${REMOTE_BASE}repo`, 'result url uses the remoteBase')
assert(logs.length > 0, 'onLog receives progress lines')

const tree = await git('-C', BARE, 'ls-tree', '-r', '--name-only', 'main')
assert(tree.includes('hello.txt'), 'bare repo received hello.txt')
assert(!tree.includes('.tagent'), '.tagent is gitignored, never pushed')
assert(await git('-C', BARE, 'log', '-1', '--format=%s', 'main') === 'first sync', 'commit message round-trips')

const author = await git('-C', BARE, 'log', '-1', '--format=%an <%ae>', 'main')
assert(author === 'tagent <testuser@users.noreply.github.com>', `commit identity falls back on identity-less machines (${author})`)

assert(await git('-C', WS, 'remote', 'get-url', 'origin') === CLEAN_REMOTE, 'origin is the clean remote (no token)')
assert(!fs.readFileSync(path.join(WS, '.git', 'config'), 'utf8').includes('fake-token'), 'token never appears in .git/config')

const linked = core.getLinkedProject(WS)
assert(linked?.repo === 'repo' && (linked?.lastSyncAt ?? 0) >= t0, 'sync auto-links the project + stamps lastSyncAt')

fs.writeFileSync(path.join(WS, 'file2.txt'), 'second file\n')
await core.syncProject(WS, cfg, { remoteBase: REMOTE_BASE, message: 'second sync' })
assert((await git('-C', BARE, 'log', '--oneline', 'main')).split('\n').length === 2, 'second sync produced a second commit')

await core.syncProject(WS, cfg, { remoteBase: REMOTE_BASE }) // no changes — must be a safe no-op
fs.writeFileSync(path.join(WS, 'file3.txt'), 'third file\n')
await core.syncProject(WS, cfg, { remoteBase: REMOTE_BASE }) // default message
assert(await git('-C', BARE, 'log', '-1', '--format=%s', 'main') === 'Update from Tagent', 'default sync message is "Update from Tagent"')
assert((await git('-C', BARE, 'log', '--oneline', 'main')).split('\n').length === 3, 'third sync produced a third commit')

core.deleteCredential('github')
let err = ''
try { await core.syncProject(WS, cfg, { remoteBase: REMOTE_BASE }) } catch (e) { err = (e as Error).message }
assert(/not logged in/i.test(err), `syncProject without login throws a clear message (${err})`)

/* ========================== 5. restoreProject ========================== */

const DEST = path.join(TMP, 'dest')
const rlogs: string[] = []
const { root } = await core.restoreProject('restore-token', 'repo', DEST, { remoteBase: REMOTE_BASE, onLog: (l) => rlogs.push(l) })
assert(root === path.join(DEST, 'repo'), 'restore returns destDir/<name>')
assert(fs.existsSync(path.join(root, 'hello.txt')) && fs.existsSync(path.join(root, 'file2.txt')), 'files came back on the "other device"')
assert(await git('-C', root, 'remote', 'get-url', 'origin') === CLEAN_REMOTE, 'restored origin is the clean URL')
assert(!fs.readFileSync(path.join(root, '.git', 'config'), 'utf8').includes('restore-token'), 'clone token never persisted in .git/config')
assert(core.getLinkedProject(root)?.repo === 'repo', 'restore auto-links the project')
assert(rlogs.length > 0, 'restoreProject onLog works')

let cloneErr = false
try { await core.restoreProject('t', 'repo', DEST, { remoteBase: REMOTE_BASE }) } catch { cloneErr = true }
assert(cloneErr, 'restore into an occupied dir fails loudly')

/* ================================ done ================================ */

fs.rmSync(TMP, { recursive: true, force: true })
console.log(fails ? `\nFAILS: ${fails}` : '\nPROJECT SYNC TESTS ALL OK')
process.exit(fails ? 1 : 0)
