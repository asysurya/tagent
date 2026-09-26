/** v0.28.0 updater tests — multi-endpoint checkUpdate, resumable
 *  checksum-verified downloads, EACCES rescue, swapBinary.
 *  Fully hermetic: a local HTTP server (Bun.serve) plays the release feed,
 *  HOME + TMPDIR are redirected before any module loads, and the
 *  TAGENT_UPDATE_URLS / TAGENT_RELEASE_BASE / TAGENT_RELEASE_API hooks
 *  keep every byte on 127.0.0.1. No network, no real ~/.tagent writes. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean) => { cond ? pass++ : fail++; console.log(`${cond ? '✔' : '✗'} ${name}`) }

// ---- isolation FIRST — env before any module that caches it ---------------
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-upd-home-'))
const FAKE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-upd-tmp-'))
process.env.HOME = FAKE_HOME
process.env.TMPDIR = FAKE_TMP

// ---- the fake release server ----------------------------------------------
const BIN = crypto.randomBytes(9 * 1024 * 1024) // ≥ MIN_ASSET_BYTES (8 MB)
const SUM = crypto.createHash('sha256').update(BIN).digest('hex')
const SMALL = Buffer.from('this is not a binary')
const SMALL_SUM = crypto.createHash('sha256').update(SMALL).digest('hex')

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname
    if (p === '/latest.json') return Response.json({ version: '0.28.0', notes: 'updater test release', url: 'https://example.com/v0.28.0' })
    if (p === '/api.json') return Response.json({ tag_name: `v${NEXT_VERSION}`, name: `${NEXT_VERSION} test`, body: '## release notes\nline', html_url: `https://example.com/v${NEXT_VERSION}` })
    if (p === '/bad.json') return Response.json({ nonsense: true })
    const m = /^\/(dl|wrong|small|missing|nosums)\/v0\.28\.0\/(.+)$/.exec(p)
    if (m) {
      const [, base, name] = m
      if (name === 'SHA256SUMS.txt') {
        if (base === 'missing' || base === 'nosums') return new Response('no sums', { status: 404 })
        if (base === 'small') return new Response(`${SMALL_SUM}  ${nameOfAsset()}\n`)
        if (base === 'wrong') return new Response(`${'0'.repeat(64)}  ${nameOfAsset()}\n`)
        return new Response(`${SUM}  ${nameOfAsset()}\n`)
      }
      if (base === 'missing') return new Response('no asset', { status: 404 })
      if (base === 'small') return new Response(SMALL)
      return new Response(BIN) // dl + wrong serve the same 9 MB body
    }
    return new Response('not found', { status: 404 })
  },
})
const BASE = `http://127.0.0.1:${server.port}`

// ---- hooks BEFORE importing the modules under test ------------------------
process.env.TAGENT_UPDATE_URLS =
  `http://127.0.0.1:1/never.json, ${BASE}/nonexistent.json, ${BASE}/bad.json, ${BASE}/latest.json`
process.env.TAGENT_RELEASE_BASE = `${BASE}/dl`

// dynamic imports — GLOBAL_DIR is computed at core load, HOME must be faked first
const core = await import('../packages/core/src/index')
const upd = await import('../packages/cli/src/updater')
const { checkUpdate, isNewer, CURRENT_VERSION } = core as typeof import('../packages/core/src/index')
const { assetName, assetUrl, downloadAsset, verifyDownloaded, swapBinary, installBinaryTo, detectInstallKind, findTagentCheckout } =
  upd as typeof import('../packages/cli/src/updater')

/** a version always NEWER than the running one — keeps the "outdated"
 *  assertions valid across version bumps */
const NEXT_VERSION = (() => {
  const [maj, min] = CURRENT_VERSION.split('.').map(Number)
  return `${maj}.${min + 1}.0`
})()

function nameOfAsset(): string {
  const p = process.platform
  const osName = p === 'win32' ? 'windows' : p === 'darwin' ? 'macos' : 'linux'
  return `tagent-v0.28.0-${osName}-${process.arch}${p === 'win32' ? '.exe' : ''}`
}

// ---- 1. isNewer ------------------------------------------------------------
ok('isNewer: 0.28.0 > 0.27.0', isNewer('0.28.0', '0.27.0') === true)
ok('isNewer: equal is not newer', isNewer('0.27.0', '0.27.0') === false)
ok('isNewer: 0.10.0 > 0.9.2 (numeric, not lexicographic)', isNewer('0.10.0', '0.9.2') === true)
ok('isNewer: 0.27.0 not > 0.28.0', isNewer('0.27.0', '0.28.0') === false)

// ---- 2. checkUpdate — endpoint chain --------------------------------------
{
  const info = await checkUpdate(true)
  ok('chain survives refused + 404 + bad shape → latest 0.28.0', info?.latest === '0.28.0')
  ok('chain result: outdated (current ' + CURRENT_VERSION + ')', info?.outdated === isNewer('0.28.0', CURRENT_VERSION))
  ok('notes carried through', info?.notes === 'updater test release')
  ok('cache written to (fake) ~/.tagent', fs.existsSync(path.join(FAKE_HOME, '.tagent', 'update-check.json')))
  const again = await checkUpdate() // non-forced → cache
  ok('second call served from cache', again?.latest === '0.28.0')
}
{
  // API fallback: chain dead, TAGENT_RELEASE_API carries it — tag_name → version
  process.env.TAGENT_UPDATE_URLS = 'http://127.0.0.1:1/dead.json'
  process.env.TAGENT_RELEASE_API = `${BASE}/api.json`
  const info = await checkUpdate(true)
  ok(`GitHub-API shape: v${NEXT_VERSION} tag_name normalized`, info?.latest === NEXT_VERSION)
  ok('API fallback marks outdated', info?.outdated === true)
  delete process.env.TAGENT_RELEASE_API
  process.env.TAGENT_UPDATE_URLS = `http://127.0.0.1:1/dead.json, ${BASE}/nonexistent.json, ${BASE}/bad.json, ${BASE}/latest.json`
}
{
  // TAGENT_UPDATE_URL (single, legacy) still honored ahead of the defaults
  delete process.env.TAGENT_UPDATE_URLS
  process.env.TAGENT_UPDATE_URL = `${BASE}/latest.json`
  const info = await checkUpdate(true)
  ok('TAGENT_UPDATE_URL (legacy single) still honored', info?.latest === '0.28.0')
  delete process.env.TAGENT_UPDATE_URL
}

// ---- 3. downloadAsset — checksum-verified, resumable, failure-classed ------
{
  const name = assetName('0.28.0')
  ok('assetName matches the release naming', !!name && name === nameOfAsset())
  ok('assetUrl honors TAGENT_RELEASE_BASE', assetUrl('0.28.0', name!).startsWith(`${BASE}/dl/v0.28.0/`))
  delete process.env.TAGENT_RELEASE_BASE
  ok('assetUrl default → github', assetUrl('0.28.0', 'x').startsWith('https://github.com/asysurya/tagent/releases/download/v0.28.0/'))
  process.env.TAGENT_RELEASE_BASE = `${BASE}/dl`

  const dl = await downloadAsset('0.28.0')
  ok('downloadAsset: ok', dl.ok === true && !!dl.file)
  ok('downloaded the full 9 MB', dl.file ? fs.statSync(dl.file).size === BIN.length : false)
  ok('verifyDownloaded → ok', dl.file ? await verifyDownloaded(dl.file, '0.28.0', name!) === 'ok' : false)
  const localHash = dl.file
    ? crypto.createHash('sha256').update(fs.readFileSync(dl.file)).digest('hex')
    : ''
  ok('sha256 matches the served SHA256SUMS', localHash === SUM)

  // re-call: the verified file from the previous run is reused, not re-fetched
  const dl2 = await downloadAsset('0.28.0')
  ok('re-call reuses the verified download', dl2.ok === true && dl2.file === dl.file)

  // a corrupted leftover (same size, wrong bytes) is discarded + re-fetched
  fs.writeFileSync(dl.file!, crypto.randomBytes(9 * 1024 * 1024))
  const dl3 = await downloadAsset('0.28.0')
  ok('corrupted leftover → discarded, fresh download', dl3.ok === true &&
    crypto.createHash('sha256').update(fs.readFileSync(dl3.file!)).digest('hex') === SUM)
}
{
  process.env.TAGENT_RELEASE_BASE = `${BASE}/wrong`
  const r = await downloadAsset('0.28.0')
  ok('wrong SHA256SUMS → checksum failure (no bad swap)', r.ok === false && /checksum/.test(r.error ?? ''))
}
{
  process.env.TAGENT_RELEASE_BASE = `${BASE}/small`
  const r = await downloadAsset('0.28.0')
  ok('tiny file rejected by the size floor', r.ok === false && /too small|truncated/.test(r.error ?? ''))
}
{
  process.env.TAGENT_RELEASE_BASE = `${BASE}/missing`
  const r = await downloadAsset('0.28.0')
  ok('404 asset → "not found (yet)" (upload window)', r.ok === false && /not found/.test(r.error ?? ''))
}
{
  process.env.TAGENT_RELEASE_BASE = `${BASE}/nosums`
  const r = await downloadAsset('0.28.0')
  ok('checksum feed down → accepted with warning', r.ok === true)
  process.env.TAGENT_RELEASE_BASE = `${BASE}/dl` // restore for the swap tests
}

// ---- 4. swapBinary + EACCES rescue ----------------------------------------
{
  const a = path.join(FAKE_TMP, 'new-a')
  const b = path.join(FAKE_TMP, 'exe-b')
  fs.writeFileSync(a, 'new binary A')
  fs.writeFileSync(b, 'old binary B')
  ok('swapBinary: plain rename works', await swapBinary(a, b, '0.28.0') === true && fs.readFileSync(b, 'utf8') === 'new binary A')
}
{
  // read-only dir → EACCES → rescue installs to (fake) ~/.local/bin/tagent
  const roDir = fs.mkdtempSync(path.join(FAKE_TMP, 'ro-'))
  const roExe = path.join(roDir, 'tagent')
  fs.writeFileSync(roExe, 'old root-owned')
  fs.chmodSync(roDir, 0o555)
  const dummy = path.join(FAKE_TMP, 'dummy-dl')
  fs.writeFileSync(dummy, 'would-be binary')
  const rescued = await swapBinary(dummy, roExe, '0.28.0')
  const rescuedFile = path.join(FAKE_HOME, '.local', 'bin', 'tagent')
  ok('EACCES → rescued to ~/.local/bin (no sudo needed)', rescued === true && fs.existsSync(rescuedFile))
  ok('rescued binary is the verified 9 MB asset', fs.statSync(rescuedFile).size === BIN.length)
  fs.chmodSync(roDir, 0o755)
}
{
  const dest = path.join(FAKE_TMP, 'bin', 'tagent')
  ok('installBinaryTo: explicit dest + chmod 755', await installBinaryTo({ current: CURRENT_VERSION, latest: '0.28.0', outdated: true }, dest) === true
    && (fs.statSync(dest).mode & 0o755) === 0o755)
}

// ---- 5. sanity on the install-kind plumbing ------------------------------
ok('detectInstallKind returns a known kind', ['binary', 'npm', 'bun', 'source'].includes(detectInstallKind()))
{
  const co = findTagentCheckout()
  ok('findTagentCheckout finds this repo', !!co
    && fs.existsSync(path.join(co, 'packages', 'cli', 'package.json'))
    && fs.existsSync(path.join(co, '.git')))
}

server.stop(true)
fs.rmSync(FAKE_HOME, { recursive: true, force: true })
fs.rmSync(FAKE_TMP, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
