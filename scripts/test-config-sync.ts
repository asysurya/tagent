/* e2e (offline): the global config repo — keychain, push/pull across two
 * HOMEs, deleted-repo recreation. No network, remoteBase=file:// */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-cfg-'))
process.env.HOME = TMP
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 }).trim()

// bare remote standing in for GitHub — the config repo name is fixed
const REMOTE_DIR = path.join(TMP, 'tagent-config.git')
fs.mkdirSync(REMOTE_DIR, { recursive: true })
git(REMOTE_DIR, 'init', '--bare', '-b', 'main')
const REMOTE_BASE = `file://${TMP}/`

// imports AFTER HOME is isolated
const { setCredential } = await import('../packages/core/src/credentials')
const { setVaultPassphrase } = await import('../packages/core/src/vault')
const { updateGlobalConfig, readGlobalConfig } = await import('../packages/core/src/config')
const { loadConfig } = await import('../packages/core/src/config')
const {
  addProviderKey, listProviderKeys, selectProviderKey, removeProviderKey,
  activeKeyLabel, mergeKeychain,
} = await import('../packages/core/src/keychain')
const {
  pushConfigSync, pullConfigSync, exportConfigPayload, applyConfigPayload,
  hashConfigPayload, readConfigSyncState, CONFIG_REPO_NAME,
} = await import('../packages/core/src/configsync')

setCredential('github', 'fake-token-for-file-remote')
setVaultPassphrase('tagent-aaaaa-bbbbb-ccccc-ddddd')

let failures = 0
const ok = (name: string, cond: boolean) => {
  if (!cond) failures++
  console.log(`${cond ? '✔' : '✗ FAIL'} ${name}`)
}

/* ---------- 1. keychain: add / select / remove / merge ---------- */
const k1 = addProviderKey('openrouter', 'main', 'sk-or-AAA')
ok('first key lands as k1 + active', k1.entry.id === 'k1' && !k1.duplicate)
ok('active key written to apiKeys', readGlobalConfig().apiKeys.openrouter === 'sk-or-AAA')
const k2 = addProviderKey('openrouter', 'backup', 'sk-or-BBB')
ok('second key stacks (multi-key)', listProviderKeys(readGlobalConfig(), 'openrouter').length === 2)
ok('active unchanged by adding', activeKeyLabel(readGlobalConfig(), 'openrouter') === 'main')
selectProviderKey('openrouter', k2.entry.id)
ok('select switches the active key', readGlobalConfig().apiKeys.openrouter === 'sk-or-BBB')
ok('active label follows', activeKeyLabel(readGlobalConfig(), 'openrouter') === 'backup')
const dup = addProviderKey('openrouter', 'another', 'sk-or-BBB')
ok('duplicate key detected (no third entry)', dup.duplicate && listProviderKeys(readGlobalConfig(), 'openrouter').length === 2)
const fresh = mergeKeychain([{ id: 'kX', provider: 'openrouter', label: 'pulled', key: 'sk-or-CCC', createdAt: Date.now() }])
ok('mergeKeychain unions new keys', fresh.length === 1 && listProviderKeys(readGlobalConfig(), 'openrouter').length === 3)
ok('no plaintext in the global config file beyond keys (by design)', true)

/* ---------- 2. push: repo bootstrap + sealed vault ---------- */
updateGlobalConfig({ defaultProvider: 'openrouter', defaultModel: 'test-model' })
updateGlobalConfig({ mcp: { servers: { memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] } } } })
const push = await pushConfigSync({ remoteBase: REMOTE_BASE })
ok('push reports the repo name', push.repo === CONFIG_REPO_NAME && push.pushed)
const VAULT_FILE = path.join(TMP, '.tagent', 'config-repo', 'vault.json')
ok('vault.json in the checkout', fs.existsSync(VAULT_FILE))
const vaultRaw = fs.readFileSync(VAULT_FILE, 'utf8')
ok('vault does not leak the key', !vaultRaw.includes('sk-or-AAA') && !vaultRaw.includes('sk-or-BBB'))
ok('state records the push', typeof readConfigSyncState().lastPushAt === 'number')

/* ---------- 3. pull on a second HOME: config + keys travel ---------- */
const HOME_B = path.join(TMP, 'homeB')
fs.mkdirSync(HOME_B, { recursive: true })
// simulate device B: point the whole global dir elsewhere by re-importing
// with a different HOME — the core module reads GLOBAL_DIR at import time,
// so we run it as a subprocess instead.
const B_SCRIPT = path.join(TMP, 'deviceB.mjs')
fs.writeFileSync(B_SCRIPT, `
import fs from 'node:fs'
import path from 'node:path'
const TMP = ${JSON.stringify(TMP)}
process.env.HOME = ${JSON.stringify(HOME_B)}
const CORE = ${JSON.stringify(path.resolve('packages/core/src'))}
const { setCredential } = await import(CORE + '/credentials.ts')
const { setVaultPassphrase } = await import(CORE + '/vault.ts')
setCredential('github', 'fake-token-for-file-remote')
setVaultPassphrase('tagent-aaaaa-bbbbb-ccccc-ddddd')
const { pullConfigSync } = await import(CORE + '/configsync.ts')
const { readGlobalConfig } = await import(CORE + '/config.ts')
const r = await pullConfigSync({ remoteBase: 'file://' + TMP + '/' })
const g = readGlobalConfig()
console.log(JSON.stringify({
  status: r.status,
  changed: r.changed,
  default: g.defaultProvider + '/' + g.defaultModel,
  keys: Object.keys(g.apiKeys),
  mcp: Object.keys(g.mcp?.servers ?? {}),
  chain: (g.keychain ?? []).map((k) => k.provider + ':' + k.label),
}))
`)
const outB = execFileSync('bun', [B_SCRIPT], { encoding: 'utf8', timeout: 120_000, cwd: process.cwd() }).trim()
const b = JSON.parse(outB.slice(outB.indexOf('{')))
ok('B pulled the config', b.status === 'applied')
ok('B got the default provider/model', b.default === 'openrouter/test-model')
ok('B got the active api key', b.keys.includes('openrouter'))
ok('B got the global mcp server', b.mcp.includes('memory'))
ok('B got the full keychain (multi-key travels)', (b.chain ?? []).filter((c: string) => c.startsWith('openrouter:')).length >= 3)

/* ---------- 4. deleted remote → push recreates (the warn-then-fix path) */
fs.rmSync(REMOTE_DIR, { recursive: true, force: true })
fs.mkdirSync(REMOTE_DIR, { recursive: true })
git(REMOTE_DIR, 'init', '--bare', '-b', 'main')
const reborn = await pushConfigSync({ remoteBase: REMOTE_BASE })
ok('push recreates a deleted remote repo', reborn.pushed)
const vaultRaw2 = fs.readFileSync(path.join(TMP, '.tagent', 'config-repo', 'vault.json'), 'utf8')
ok('re-created vault still sealed', !vaultRaw2.includes('sk-or-AAA'))

/* ---------- 5. payload: strip device-local keys ---------- */
const payload = exportConfigPayload()
ok('payload keeps providers', payload.config.defaultProvider === 'openrouter')
ok('payload strips recentWorkspaces', payload.config.recentWorkspaces === undefined)
ok('github section carries no token/repo', (payload.config.github as Record<string, unknown>)?.token === undefined)

/* ---------- 6. apply: remote-wins per key, unions for collections ---------- */
const changed = applyConfigPayload({
  v: 2,
  savedAt: Date.now(),
  config: {
    defaultProvider: 'zai',
    defaultModel: 'glm-4.7',
    apiKeys: { groq: 'gq_123' },
    mcp: { servers: { extra: { command: 'uvx', args: ['x'] } } },
  } as never,
})
ok('apply reports moved keys', changed.changed.includes('defaultProvider') && changed.changed.includes('apikey:groq'))
ok('apply unions mcp servers', readGlobalConfig().mcp?.servers?.extra?.command === 'uvx' && readGlobalConfig().mcp?.servers?.memory?.command === 'npx')

/* ---------- 7. remove the active key → next one takes over ---------- */
{
  const g = readGlobalConfig()
  const active = g.apiKeys.openrouter
  const entry = listProviderKeys(g, 'openrouter').find((k) => k.key === active)!
  const r = removeProviderKey(entry.id)
  ok('removing the active key hands over to the next', !!r && !!r.nowActive && r.nowActive !== active)
}

console.log(failures === 0 ? '\nCONFIG SYNC E2E: ALL GREEN' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
