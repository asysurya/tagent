/* smoke: vault crypto roundtrip + sync settings + payload apply (offline) */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-smoke-'))
process.env.HOME = TMP
// isolate the global dir BEFORE any import touches it
const { GLOBAL_DIR } = await import('../packages/core/src/config')
console.log('global dir →', GLOBAL_DIR)

const {
  encryptVaultJSON, decryptVaultJSON, generatePassphrase, setVaultPassphrase, getVaultPassphrase,
} = await import('../packages/core/src/vault')

// 1. passphrase gen + store
const pp = generatePassphrase()
console.log('generated passphrase shape ok:', /^tagent(-[a-z2-9]{5}){4}$/.test(pp))
setVaultPassphrase(pp)
console.log('passphrase stored:', getVaultPassphrase() === pp)

// 2. encrypt/decrypt roundtrip
const payload = { v: 1, savedAt: Date.now(), apiKeys: { openrouter: 'sk-or-123' }, mcpServers: { memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] } } }
const sealed = encryptVaultJSON(payload, pp)
const raw = JSON.stringify(sealed)
console.log('ciphertext not readable:', !raw.includes('sk-or-123'))
const opened = decryptVaultJSON(JSON.parse(raw), pp) as typeof payload
console.log('roundtrip ok:', opened.apiKeys?.openrouter === 'sk-or-123' && opened.mcpServers?.memory?.command === 'npx')

// 3. wrong passphrase → clean error
let err = ''
try { decryptVaultJSON(JSON.parse(raw), 'wrong') } catch (e) { err = (e as Error).message }
console.log('wrong passphrase message:', /wrong passphrase/.test(err))

// 4. tamper → clean error
const tampered = JSON.parse(raw); tampered.ct = tampered.ct.slice(0, -4) + 'AAAA'
let err2 = ''
try { decryptVaultJSON(tampered, pp) } catch (e) { err2 = (e as Error).message }
console.log('tamper message ok:', /wrong passphrase|corrupted|decrypt/.test(err2))

// 5. sync settings roundtrip (with clamping)
const root = path.join(TMP, 'proj')
fs.mkdirSync(path.join(root, '.tagent-sync'), { recursive: true })
const { writeSyncSettings, readSyncSettings } = await import('../packages/core/src/sync')
writeSyncSettings(root, { auto: true, intervalMs: 1_000, vault: { apiKeys: true, customProviders: false, mcp: true, memory: true } })
const rs = readSyncSettings(root)
console.log('interval clamped to min 5s:', rs.intervalMs === 5_000)
console.log('vault flags kept:', rs.vault.customProviders === false && rs.vault.apiKeys === true)
writeSyncSettings(root, { auto: false, intervalMs: 99_999_999, vault: { apiKeys: true, customProviders: true, mcp: true, memory: true } })
const rs2 = readSyncSettings(root)
console.log('interval clamped to max 1h:', rs2.intervalMs === 3_600_000, '· auto off:', rs2.auto === false)

// 6. vault payload export + apply into a second "device" workspace
const { exportVaultPayload, applyVaultPayload } = await import('../packages/core/src/sync')
const { saveConfig, loadConfig } = await import('../packages/core/src/config')
const src = path.join(TMP, 'deviceA')
fs.mkdirSync(path.join(src, '.tagent'), { recursive: true })
const cfgA = loadConfig(src)
cfgA.apiKeys.openrouter = 'sk-or-AAA'
cfgA.apiKeys.zai = 'sk-zai-BBB'
cfgA.customProviders.push({ id: 'myllama', label: 'My Llama', baseUrl: 'http://localhost:11434/v1', models: ['llama3.2'] })
cfgA.mcp = { servers: { memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] } } }
saveConfig(src, cfgA)
const exported = exportVaultPayload(src, cfgA, { apiKeys: true, customProviders: true, mcp: true, memory: true })
console.log('export has keys:', exported.apiKeys?.openrouter === 'sk-or-AAA' && Object.keys(exported.apiKeys ?? {}).length === 2)
console.log('export has provider + mcp:', exported.customProviders?.[0]?.id === 'myllama' && !!exported.mcpServers?.memory)

const dst = path.join(TMP, 'deviceB')
fs.mkdirSync(path.join(dst, '.tagent'), { recursive: true })
saveConfig(dst, loadConfig(dst)) // baseline local config
const { changed } = applyVaultPayload(dst, exported)
console.log('apply reports changes:', changed.some((c) => c.startsWith('apikey:')) && changed.some((c) => c === 'provider:myllama'))
const cfgB = loadConfig(dst)
console.log('device B got the keys:', cfgB.apiKeys.openrouter === 'sk-or-AAA' && cfgB.mcp?.servers?.memory?.command === 'npx')
const again = applyVaultPayload(dst, exported)
console.log('apply is idempotent:', again.changed.length === 0)

console.log('ALL SMOKE CHECKS DONE')
