/* e2e (offline): two devices, one bare git remote — engine pushes, pulls,
 * and carries the encrypted vault across. No network, remoteBase=file:// */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-e2e-'))
process.env.HOME = TMP
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 }).trim()

// bare remote
const REMOTE_DIR = path.join(TMP, 'remote.git')
fs.mkdirSync(REMOTE_DIR, { recursive: true })
git(REMOTE_DIR, 'init', '--bare', '-b', 'main')
const REMOTE_BASE = `file://${TMP}/`
const REPO = 'remote'

// imports AFTER HOME is isolated
const { setCredential } = await import('../packages/core/src/credentials')
const { setVaultPassphrase } = await import('../packages/core/src/vault')
const { linkProject, getLinkedProject } = await import('../packages/core/src/projects')
const { loadConfig, saveConfig } = await import('../packages/core/src/config')
const { SyncEngine, readSyncSettings } = await import('../packages/core/src/sync')

// a fake token + a passphrase shared by both devices
setCredential('github', 'fake-token-for-file-remote')
setVaultPassphrase('tagent-aaaaa-bbbbb-ccccc-ddddd')

let failures = 0
const ok = (name: string, cond: boolean) => {
  if (!cond) failures++
  console.log(`${cond ? '✔' : '✗ FAIL'} ${name}`)
}

/* ---------- device A: dirty workspace → first tick pushes ---------- */
const A = path.join(TMP, 'deviceA')
fs.mkdirSync(A, { recursive: true })
fs.writeFileSync(path.join(A, 'hello.txt'), 'v1')
const cfgA = loadConfig(A)
cfgA.github = { ...cfgA.github, repo: REPO }
cfgA.apiKeys.openrouter = 'sk-or-SHARED'
saveConfig(A, cfgA)
linkProject(A, REPO)

const eventsA: string[] = []
const engineA = new SyncEngine({
  root: A,
  getConfig: () => loadConfig(A),
  remoteBase: REMOTE_BASE,
  onEvent: (e) => eventsA.push(e.type),
})
await engineA.tick('manual')
ok('A pushed its first commit', eventsA.includes('pushed'))
ok('A is linked to the repo', getLinkedProject(A)?.repo === REPO)
ok('A wrote the encrypted vault', fs.existsSync(path.join(A, '.tagent-sync', 'vault.json')))
const vaultRaw = fs.readFileSync(path.join(A, '.tagent-sync', 'vault.json'), 'utf8')
ok('vault does not leak the key', !vaultRaw.includes('sk-or-SHARED'))
ok('settings file synced into the repo', fs.existsSync(path.join(A, '.tagent-sync', 'repo.json')))
ok('auto default on at 15s', readSyncSettings(A).auto === true && readSyncSettings(A).intervalMs === 15_000)
ok('.tagent/ is gitignored (secrets stay local)', fs.readFileSync(path.join(A, '.gitignore'), 'utf8').includes('.tagent/'))

/* ---------- clean tick: nothing to do, no crash ---------- */
eventsA.length = 0
await engineA.tick('manual')
ok('clean tick is quiet', eventsA.length === 0)

/* ---------- device B: clone → pull applies the vault ---------- */
const B = path.join(TMP, 'deviceB')
git(TMP, 'clone', `${REMOTE_DIR}`, B)
linkProject(B, REPO)
const cfgB = loadConfig(B)
cfgB.github = { ...cfgB.github, repo: REPO }
saveConfig(B, cfgB)

const eventsB: string[] = []
const engineB = new SyncEngine({
  root: B,
  getConfig: () => loadConfig(B),
  remoteBase: REMOTE_BASE,
  onEvent: (e) => eventsB.push(e.type),
})
// B is clean and even with the remote — the tick itself is quiet on events…
await engineB.tick('manual')
ok('B clean+even tick is quiet', eventsB.length === 0)
// …but it CONSUMED the vault it cloned (apply-then-export ordering): the key
// landed in B's config, and no phantom re-push happened (quiet tick proves it)
ok('B consumed the vault inside the tick', loadConfig(B).apiKeys.openrouter === 'sk-or-SHARED')
ok('B applied marker written', fs.existsSync(path.join(B, '.tagent', 'vault-state.json')))
const applied = await engineB.applyVaultOnce()
ok('re-apply is a no-op (marker)', applied.length === 0)
ok('B config now carries the key', loadConfig(B).apiKeys.openrouter === 'sk-or-SHARED')

/* ---------- A edits → tick pushes; B tick pulls ---------- */
fs.writeFileSync(path.join(A, 'hello.txt'), 'v2 — edited on device A')
await engineA.tick('manual')
ok('A pushed the edit', eventsA.includes('pushed'))

eventsB.length = 0
await engineB.tick('manual')
ok('B pulled the edit', eventsB.includes('pulled'))
ok('B sees the new content', fs.readFileSync(path.join(B, 'hello.txt'), 'utf8').startsWith('v2'))

/* ---------- B edits config → vault travels back to A ---------- */
const cfgB2 = loadConfig(B)
cfgB2.apiKeys.zai = 'sk-zai-FROM-B'
saveConfig(B, cfgB2)
await engineB.tick('manual') // B pushes (vault changed)
ok('B pushed its vault update', eventsB.includes('pushed'))

eventsA.length = 0
await engineA.tick('manual') // A pulls the new vault
ok('A pulled B\'s work', eventsA.includes('pulled'))
const cfgA3 = loadConfig(A)
ok('A received the shared key via vault', cfgA3.apiKeys.zai === 'sk-zai-FROM-B')

/* ---------- both edit different files → convergence, no data loss ---------- */
fs.writeFileSync(path.join(A, 'note-a.md'), 'from A')
fs.writeFileSync(path.join(B, 'note-b.md'), 'from B')
await engineA.tick('manual') // A pushes first
// B is dirty + remote moved → pushWorkspace rebases then pushes
await engineB.tick('manual')
ok('B converged (rebase + push)', fs.existsSync(path.join(B, 'note-a.md')))
await engineA.tick('manual') // A pulls B's file
ok('A converged too', fs.existsSync(path.join(A, 'note-b.md')))

/* ---------- status + stop ---------- */
const st = engineA.status()
ok('status reports interval', st.intervalMs === 15_000)
engineA.restart()
ok('engine runs for linked project', engineA.status().running === true)
engineA.stop()
ok('stop halts the engine', engineA.status().running === false)

console.log(failures === 0 ? '\nENGINE E2E: ALL GREEN' : `\nENGINE E2E: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
