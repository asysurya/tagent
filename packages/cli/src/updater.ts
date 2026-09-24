/**
 * updater.ts — interactive update flow.
 *
 * On startup the TUI checks the release feed (cached once a day). When a newer
 * version exists the user gets an arrow-key y/N prompt — "yes" triggers a
 * self-update that does the right thing for how Tagent was installed:
 *
 *   · single-file binary → downloads the matching release asset (resumable,
 *     checksum-verified against SHA256SUMS.txt) and swaps it in place
 *   · npm -g             → npm install -g tagent@latest — on failure falls
 *                           back to the standalone binary (tagent isn't on npm)
 *   · bun -g             → bun add -g tagent — same binary fallback
 *   · source checkout    → git pull + bun install
 *
 * Every path is best-effort: failures print the manual steps, never block.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { CURRENT_VERSION, GLOBAL_DIR, checkUpdate, type UpdateInfo } from '@tagent/core'
import { confirm } from './select'

const REPO = 'asysurya/tagent'

/** same home resolution as @tagent/core's GLOBAL_DIR (env first — os.homedir()
 *  in bun reads the STARTUP env, missing a runtime override) */
const homeDir = () => process.env.HOME || process.env.USERPROFILE || os.homedir()

/** async sleep — keeps the event loop breathing (the TUI stays responsive) */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** async curl — the JS thread stays FREE while a 100 MB download streams
 *  (spawnSync would freeze the whole TUI/daemon for the entire transfer). */
function curlAsync(args: string[], timeoutMs: number): Promise<{ code: number | null; error?: Error }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('curl', args, { stdio: 'inherit' })
    } catch (e) {
      resolve({ code: null, error: e as Error })
      return
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, error: e as Error }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code }) })
  })
}

export type InstallKind = 'binary' | 'npm' | 'bun' | 'source'

/** how was this tagent installed? */
export function detectInstallKind(): InstallKind {
  const exe = process.execPath
  const base = path.basename(exe).replace(/\.exe$/i, '').toLowerCase()
  // compiled binaries name themselves `tagent…`
  if (base === 'tagent' || base.startsWith('tagent-')) return 'binary'
  try {
    // npm global layout: .../lib/node_modules/tagent or npm-cache _npx
    const real = fs.realpathSync(exe)
    if (/_npx|node_modules\/\.bin/.test(real)) return 'npm'
  } catch { /* ignore */ }
  if (process.versions?.bun || base === 'bun') {
    // bun global installs run the real entry through the bun runtime
    const argv1 = process.argv[1] ?? ''
    if (argv1.includes('bun/install/global') || argv1.includes('.bun')) return 'bun'
    return 'source'
  }
  if (process.argv[1]?.includes('node_modules')) return 'npm'
  return 'source'
}

export function assetName(version: string): string | undefined {
  const p = process.platform
  const a = process.arch
  const os = p === 'win32' ? 'windows' : p === 'darwin' ? 'macos' : 'linux'
  if (a !== 'x64' && a !== 'arm64') return undefined // no 32-bit builds (bun limit)
  return `tagent-v${version}-${os}-${a}${p === 'win32' ? '.exe' : ''}`
}

/** the release download base — TAGENT_RELEASE_BASE overrides (test hook,
 *  or a GitHub mirror) */
export function assetUrl(version: string, name: string): string {
  const base = process.env.TAGENT_RELEASE_BASE || `https://github.com/${REPO}/releases/download`
  return `${base}/v${version}/${name}`
}

/** release binaries are ~70–110 MB — anything smaller is a truncated
 *  download or an error page. */
const MIN_ASSET_BYTES = 8 * 1024 * 1024

/** sha256 of a file, streamed; undefined when unreadable */
function sha256File(file: string): string | undefined {
  try {
    const h = crypto.createHash('sha256')
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(1024 * 1024)
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, null)
        if (!n) break
        h.update(buf.subarray(0, n))
      }
    } finally { fs.closeSync(fd) }
    return h.digest('hex')
  } catch { return undefined }
}

/** expected hash from the release's SHA256SUMS.txt ("hash  filename" lines) */
async function expectedSha256(version: string, name: string): Promise<string | undefined> {
  const sumsFile = path.join(os.tmpdir(), `tagent-SHA256SUMS-${version}.txt`)
  try {
    const res = await curlAsync(['-fsSL', '--connect-timeout', '20', '-o', sumsFile, assetUrl(version, 'SHA256SUMS.txt')], 60_000)
    if (res.code !== 0) return undefined
    for (const line of fs.readFileSync(sumsFile, 'utf8').split('\n')) {
      const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim())
      if (m && m[2].trim() === name) return m[1]
    }
  } catch { /* fall through */ }
  return undefined
}

type VerifyResult = 'ok' | 'nosums' | 'size' | 'hash'

/** size floor + checksum — 'nosums' means the feed was unreachable (accept,
 *  with a warning): the checksum guards corruption, not attackers. */
export async function verifyDownloaded(file: string, version: string, name: string): Promise<VerifyResult> {
  try {
    if (fs.statSync(file).size < MIN_ASSET_BYTES) return 'size'
  } catch { return 'size' }
  const want = await expectedSha256(version, name)
  if (!want) return 'nosums'
  return sha256File(file) === want ? 'ok' : 'hash'
}

export async function downloadAsset(version: string): Promise<{ ok: boolean; error?: string; file?: string }> {
  const name = assetName(version)
  if (!name) return { ok: false, error: `no prebuilt binary for ${process.platform}-${process.arch}` }
  const url = assetUrl(version, name)
  const dest = path.join(os.tmpdir(), name)
  let lastError = `download failed — ${url}`
  // a previous run may have died between download and swap — reuse it
  if (fs.existsSync(dest)) {
    const v = await verifyDownloaded(dest, version, name)
    if (v === 'ok' || v === 'nosums') return { ok: true, file: dest }
    fs.rmSync(dest, { force: true }) // size/hash bad — start over
  }
  // up to 3 attempts; every retry RESUMES the partial file (-C -), so a
  // flaky connection costs the remaining bytes, not the whole 100 MB again
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) console.log(`  ↻ attempt ${attempt}/3 — resuming from where it stopped…`)
    const res = await curlAsync([
      '-fSL',
      ...(attempt > 1 ? ['-C', '-'] : []),
      '--connect-timeout', '20',
      '--speed-limit', '10240', // slower than 10 KB/s…
      '--speed-time', '90',     // …for 90s ⇒ stalled — never hang silently
      '-o', dest, url,
    ], 12 * 60_000)
    if (res.code === 0) {
      const v = await verifyDownloaded(dest, version, name)
      if (v === 'ok' || v === 'nosums') {
        if (v === 'nosums') console.log('  ⚠ checksum feed unreachable — continuing without verification')
        return { ok: true, file: dest }
      }
      if (v === 'size') {
        fs.rmSync(dest, { force: true })
        return { ok: false, error: `downloaded file is too small (truncated?) — run tagent update again\n    ${url}` }
      }
      fs.rmSync(dest, { force: true }) // corrupted transfer — take the retry fresh
      lastError = 'checksum mismatch — the download was corrupted'
      continue
    }
    if (res.error) {
      return { ok: false, error: `curl is not available (${res.error.message}) — install curl, or download:\n    ${url}` }
    }
    // curl failed — is the asset even there? (404: still uploading / typo)
    const head = await curlAsync(['-fsIL', '--connect-timeout', '20', url], 60_000)
    if (head.code !== 0) {
      return { ok: false, error: `release asset not found (yet) — ${url}\n    the upload may still be propagating; try again in a few minutes` }
    }
    lastError = `download interrupted (curl exit ${res.code}) — attempt ${attempt}/3`
  }
  return { ok: false, error: lastError }
}

function run(cmd: string, args: string[], cwd?: string, timeoutMs = 5 * 60_000): { ok: boolean; output: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, cwd, env: { ...process.env, NO_COLOR: '1' } })
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().slice(0, 400) }
}

/** critical user-data files in ~/.tagent — snapshotted before EVERY update
 *  (auth, MCP, model catalog, workspace registry, memory instructions). */
const USER_DATA_FILES = [
  'config.json', 'credentials.json', 'models.json', 'workspaces.json',
  'zai-models.json', 'AGENTS.md', 'relays.json', 'plugins.json',
]

/** Snapshot the user's ~/.tagent data before an update. Never throws. */
function backupUserData(): string | undefined {
  try {
    if (!fs.existsSync(GLOBAL_DIR)) return undefined
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
    const dest = path.join(GLOBAL_DIR, 'backups', `update-${stamp}`)
    let copied = 0
    for (const f of USER_DATA_FILES) {
      const src = path.join(GLOBAL_DIR, f)
      if (fs.existsSync(src) && fs.statSync(src).isFile()) {
        fs.mkdirSync(dest, { recursive: true })
        fs.copyFileSync(src, path.join(dest, f))
        copied++
      }
    }
    // prune — keep the 5 newest backup dirs
    try {
      const backupsDir = path.join(GLOBAL_DIR, 'backups')
      const dirs = fs.readdirSync(backupsDir).filter((d) => d.startsWith('update-')).sort()
      for (const d of dirs.slice(0, Math.max(0, dirs.length - 5))) {
        fs.rmSync(path.join(backupsDir, d), { recursive: true, force: true })
      }
    } catch { /* pruning is best-effort */ }
    return copied > 0 ? dest : undefined
  } catch {
    return undefined
  }
}

/** After an update: restore any critical file that vanished (belt+suspenders). */
function verifyUserData(backupDir?: string): string[] {
  const restored: string[] = []
  if (!backupDir) return restored
  try {
    for (const f of USER_DATA_FILES) {
      const now = path.join(GLOBAL_DIR, f)
      const bak = path.join(backupDir, f)
      if (fs.existsSync(bak) && !fs.existsSync(now)) {
        fs.copyFileSync(bak, now)
        restored.push(f)
      }
    }
  } catch { /* never block the update on the safety net */ }
  return restored
}

/**
 * Clear a stuck in-progress merge/rebase or an unmerged index — the state
 * that makes BOTH `git stash` and `git pull` refuse to run ("bun.lock: needs
 * merge" / "you have unmerged files"). The working tree is preserved:
 * abort restores the pre-operation state, and a mixed reset only rewrites
 * the index. Whatever is left gets stashed by the caller right after.
 */
function recoverGitState(repoDir: string): void {
  const hasUnmerged = () => {
    const r = run('git', ['ls-files', '--unmerged'], repoDir)
    return r.ok && r.output.trim().length > 0
  }
  if (!fs.existsSync(path.join(repoDir, '.git', 'MERGE_HEAD')) &&
      !fs.existsSync(path.join(repoDir, '.git', 'rebase-merge')) &&
      !fs.existsSync(path.join(repoDir, '.git', 'rebase-apply')) &&
      !fs.existsSync(path.join(repoDir, '.git', 'CHERRY_PICK_HEAD')) &&
      !fs.existsSync(path.join(repoDir, '.git', 'REVERT_HEAD')) &&
      !hasUnmerged()) return
  console.log(`  ⚠ unfinished merge/conflict state found — recovering (your files are kept)…`)
  for (const args of [['merge', '--abort'], ['rebase', '--abort'], ['cherry-pick', '--abort'], ['revert', '--abort']]) {
    const r = run('git', args, repoDir)
    if (r.ok) break
  }
  if (hasUnmerged()) {
    // conflict markers remain staged — clear the index only (files untouched)
    run('git', ['reset', 'HEAD', '--', '.'], repoDir)
  }
  if (hasUnmerged()) {
    console.log(`  ⚠ index still unmerged — run: git -C "${repoDir}" reset HEAD -- .`)
  }
}

/** do the actual update for the detected install kind */
export async function selfUpdate(info: UpdateInfo): Promise<boolean> {
  const kind = detectInstallKind()
  console.log(`  ⬆ updating ${kind} install → v${info.latest}…`)
  // user data first — auth, MCP, model catalog, memory. Whatever happens
  // below, ~/.tagent is recoverable from the snapshot.
  const backupDir = backupUserData()
  if (backupDir) console.log(`  ✔ user data backed up — ${path.join(path.basename(path.dirname(backupDir)), path.basename(backupDir))} (auth · mcp · config)`)
  try {
    return await selfUpdateInner(info, kind)
  } finally {
    const restored = verifyUserData(backupDir)
    for (const f of restored) console.log(`  ✔ restored ${f} from the pre-update backup`)
  }
}

async function selfUpdateInner(info: UpdateInfo, kind: InstallKind): Promise<boolean> {
  if (kind === 'binary') return await updateViaBinary(info)
  if (kind === 'npm' || kind === 'bun') {
    const r = run(kind, kind === 'npm' ? ['install', '-g', 'tagent@latest'] : ['add', '-g', 'tagent@latest'])
    if (r.ok) {
      console.log(`  ✔ updated via ${kind} — restart Tagent`)
      return true
    }
    // tagent is NOT published on npm — a global npm/bun install can only have
    // come from a git URL, and `tagent@latest` will 404 forever. Fall back to
    // the standalone binary instead of dead-ending.
    console.log(`  ✗ ${kind} couldn't update: ${r.output || 'install failed'}`)
    console.log(`  ⚠ tagent isn't published on npm — switching to the standalone binary…`)
    const dest = path.join(homeDir(), '.local', 'bin', 'tagent')
    if (await installBinaryTo(info, dest)) {
      console.log(`    make sure ${path.dirname(dest)} is on your PATH (it usually is)`)
      console.log(`    and remove the ${kind} copy so it can't shadow the binary:`)
      console.log(`      ${kind === 'npm' ? 'npm rm -g tagent' : 'bun remove -g tagent'}`)
      return true
    }
    return false
  }
  // source checkout — update the checkout that provides THIS running code.
  // The user may run `tagent update` from anywhere (their own project, another
  // clone): pulling whatever repo happens to be the CWD is how v0.13.0 and
  // earlier "updated" the wrong tree and still printed success.
  const repoDir = findTagentCheckout()
  if (!repoDir) {
    console.log(`  ✗ can't locate your tagent source checkout (running from ${process.argv[1] ?? '?'}, cwd ${process.cwd()})`)
    console.log(`    manual: cd <your tagent clone> && git pull && bun install`)
    console.log(`    or download a binary: https://github.com/${REPO}/releases/latest`)
    return false
  }
  // a dirty tree (bun.lock churn from a different bun version, local edits)
  // is the #1 reason `git pull` refuses to run — but an UNRESOLVED MERGE is
  // the #0: it blocks even the stash. Clear it first, then stash.
  recoverGitState(repoDir)
  // a detached HEAD (the user checked out a tag or a commit) makes pull
  // refuse outright — get back on the default branch first
  {
    const head = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoDir)
    if (head.ok && head.output.trim() === 'HEAD') {
      const def = run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoDir)
      const target = def.ok ? def.output.trim().replace(/^origin\//, '') : 'main'
      const co = run('git', ['checkout', target], repoDir)
      console.log(co.ok ? `  ⚠ was on a detached commit — back on ${target}` : `  ✗ couldn't checkout ${target}: ${co.output}`)
    }
  }
  let stashed = false
  const dirty = run('git', ['status', '--porcelain'], repoDir)
  if (dirty.ok && dirty.output) {
    const stash = run(
      'git',
      ['-c', 'user.name=tagent-update', '-c', 'user.email=update@tagent.local',
        'stash', 'push', '-u', '-m', `tagent update v${info.latest} — backup of local changes`],
      repoDir,
    )
    if (stash.ok) {
      stashed = true
      console.log(`  ⚠ checkout had local changes — stashed (kept safe): ${dirty.output.split('\n').length} file(s)`)
    } else {
      console.log(`  ✗ the checkout is dirty and stashing failed — ${stash.output || 'git stash error'}`)
      console.log(`    manual: git -C "${repoDir}" stash && tagent update`)
      return false
    }
  }
  let r = run('git', ['pull', '--ff-only'], repoDir)
  if (!r.ok) {
    // ff-only refused — usually local commits that diverged from main.
    // Fetch + hard reset to the upstream tip: the update can never block on
    // divergence again. Local commits stay recoverable via reflog.
    const fetch = run('git', ['fetch', 'origin'], repoDir)
    if (fetch.ok) {
      const branch = (run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoDir).output || 'main').trim()
      const up = run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], repoDir)
      const target = up.ok && up.output ? up.output.trim() : `origin/${branch}`
      const reset = run('git', ['reset', '--hard', target], repoDir)
      if (reset.ok) {
        console.log(`  ⚠ branch had diverged — reset to ${target} (recover local commits: git -C "${repoDir}" reflog)`)
        r = { ok: true, output: '' }
      }
    }
  }
  if (!r.ok) {
    console.log(`  ✗ ${r.output || 'git pull failed'} in ${repoDir}`)
    if (stashed) console.log(`    your local changes are safe in the stash: git -C "${repoDir}" stash list`)
    console.log(`    fix conflicts/divergence manually, or re-clone from https://github.com/${REPO}`)
    console.log(`    note: ~/.tagent (auth, mcp, config) is untouched by re-cloning — it lives in your home dir`)
    return false
  }
  if (stashed) {
    console.log(`  ⚠ your previous local changes sit in the stash — review: git -C "${repoDir}" stash show -p · restore: git -C "${repoDir}" stash pop`)
  }
  // UserLAnd/proot needs the hoisted linker or socket.io fails to load at runtime
  const proot = /android/i.test(os.release()) || fs.existsSync('/.proot') || !!process.env.USERLAND
  const inst = run('bun', proot ? ['install', '--linker=hoisted'] : ['install'], repoDir, 10 * 60_000)
  if (!inst.ok) {
    // the CODE is updated; without dependencies it may not RUN. Never print
    // "updated" over a broken install — say exactly what to do.
    console.log(`  ✗ the code updated, but dependencies failed to install:`)
    console.log(`    ${inst.output.replace(/\n/g, ' ').slice(0, 300)}`)
    console.log(`    fix: cd "${repoDir}" && bun install  — then restart Tagent`)
    return false
  }

  // verify the update actually landed — read the version file we just pulled.
  // A stale PATH entry / a second clone / a diverged branch must never print
  // "updated" when the running code is still old.
  const nowVer = readRepoVersion(repoDir)
  if (nowVer && nowVer !== info.latest) {
    console.log(`  ✔ pulled ${repoDir} — checkout is at v${nowVer} (release: v${info.latest})`)
    console.log(`    your branch may lag main; if this repeats: git -C "${repoDir}" checkout main`)
  } else if (nowVer) {
    console.log(`  ✔ source updated → v${nowVer} (${repoDir}) — restart Tagent`)
  } else {
    console.log(`  ✔ pulled ${repoDir} — restart Tagent (couldn't read the new version)`)
  }
  // the `tagent` on PATH may point elsewhere than the repo we just updated
  const which = run('which', ['tagent'])
  if (which.ok && which.output && !which.output.includes(repoDir) && !isSubpathOrLinked(which.output, repoDir)) {
    console.log(`  ⚠ PATH resolves tagent to ${which.output}`)
    console.log(`    that is NOT the checkout we just updated — check for a second install (tagent uninstall removes old ones)`)
  }
  return true
}

/** binary install: download the matching release asset and swap it in place */
async function updateViaBinary(info: UpdateInfo): Promise<boolean> {
  const dl = await downloadAsset(info.latest)
  if (!dl.ok || !dl.file) {
    console.log(`  ✗ ${dl.error}`)
    console.log(`    manual: https://github.com/${REPO}/releases/latest`)
    return false
  }
  const exe = process.execPath
  try {
    fs.chmodSync(dl.file, 0o755)
    if (process.platform === 'win32') {
      // a running exe cannot replace itself on windows
      const next = exe.replace(/\.exe$/i, '') + `-v${info.latest}.exe`
      fs.copyFileSync(dl.file, next)
      fs.rmSync(dl.file, { force: true })
      console.log(`  ✔ saved ${path.basename(next)} next to the current binary`)
      console.log(`    close Tagent, delete the old exe, rename the new one to tagent.exe`)
      return true
    }
    if (!(await swapBinary(dl.file, exe, info.latest))) return false
    fs.chmodSync(exe, 0o755)
    // prove the swap: ask the new binary its version
    const check = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 60_000 })
    const ver = (check.stdout ?? '').trim()
    console.log(ver
      ? `  ✔ updated in place — restart Tagent to run v${ver}`
      : `  ✔ updated in place — restart Tagent to run v${info.latest}`)
    return true
  } catch (e) {
    console.log(`  ✗ ${(e as Error).message}`)
    console.log(`    manual: https://github.com/${REPO}/releases/latest`)
    return false
  }
}

/** atomically replace `exe` with the downloaded `newFile` (POSIX). Exported
 *  for tests. Handles the two classic failures:
 *   · ETXTBSY — the binary is executing right now; brief retry
 *   · EACCES  — root-owned install dir (e.g. /usr/local/bin); rescue via
 *               ~/.local/bin (usually EARLIER on PATH — no sudo needed) */
export async function swapBinary(newFile: string, exe: string, version: string): Promise<boolean> {
  let lastErr: Error | undefined
  for (let i = 0; i < 4; i++) {
    try {
      fs.renameSync(newFile, exe)
      return true
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ETXTBSY') { await sleep(250); continue } // running binary — brief retry
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        console.log(`  ✗ no permission to replace ${exe} (root-owned location?)`)
        // no-sudo rescue: ~/.local/bin usually comes BEFORE /usr/local/bin on
        // PATH, so the new binary takes over on the next launch
        const home = path.join(homeDir(), '.local', 'bin', 'tagent')
        if (await installBinaryTo({ current: CURRENT_VERSION, latest: version, outdated: true }, home)) {
          console.log(`    it takes effect if ${path.dirname(home)} comes before ${path.dirname(exe)} in your PATH`)
          console.log(`    when convenient, remove the old one: sudo rm "${exe}"`)
          return true
        }
        // home not writable either — park the download, hand over the command
        console.log(`  ✔ the new binary is saved at ${newFile}`)
        console.log(`    finish the update with one command:`)
        console.log(`      sudo mv "${newFile}" "${exe}"`)
        return false
      }
      lastErr = e
      break
    }
  }
  console.log(`  ✗ ${lastErr?.message ?? 'could not replace the binary'}`)
  console.log(`    the download is kept at ${newFile} — move it by hand:`)
  console.log(`      mv "${newFile}" "${exe}"`)
  return false
}

/** download the release binary to an explicit path (npm/bun fallback, and
 *  the EACCES rescue). Callers print their own follow-up guidance. */
export async function installBinaryTo(info: UpdateInfo, dest: string): Promise<boolean> {
  const dl = await downloadAsset(info.latest)
  if (!dl.ok || !dl.file) {
    console.log(`  ✗ ${dl.error}`)
    console.log(`    manual: https://github.com/${REPO}/releases/latest`)
    return false
  }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    try {
      fs.renameSync(dl.file, dest) // fast path — same device
    } catch {
      fs.copyFileSync(dl.file, dest) // EXDEV across devices
      fs.rmSync(dl.file, { force: true })
    }
    fs.chmodSync(dest, 0o755)
  } catch (e) {
    console.log(`  ✗ ${(e as Error).message}`)
    console.log(`    the download is kept at ${dl.file}`)
    console.log(`    manual: https://github.com/${REPO}/releases/latest`)
    return false
  }
  console.log(`  ✔ standalone binary installed: ${dest} (v${info.latest})`)
  return true
}

/** walk up from the running entry file to find a tagent source checkout.
 *  argv[1] is resolved through symlinks so `bun link` / wrapper scripts land
 *  on the real clone. */
export function findTagentCheckout(): string | undefined {
  const seen = new Set<string>()
  let dir: string | undefined
  try {
    dir = path.dirname(fs.realpathSync(process.argv[1] ?? '.'))
  } catch {
    return undefined
  }
  for (let i = 0; dir && i < 12; i++) {
    if (seen.has(dir)) break
    seen.add(dir)
    const isGit = fs.existsSync(path.join(dir, '.git'))
    const looksTagent =
      fs.existsSync(path.join(dir, 'packages', 'cli', 'package.json')) &&
      fs.existsSync(path.join(dir, 'packages', 'core', 'package.json'))
    if (isGit && looksTagent) {
      const remote = run('git', ['config', '--get', 'remote.origin.url'], dir)
      if (remote.ok && /asysurya\/tagent(\.git)?$/i.test(remote.output)) return dir
      return undefined // a tagent-like repo, but not ours — don't touch it
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

function readRepoVersion(repoDir: string): string | undefined {
  try {
    const src = fs.readFileSync(path.join(repoDir, 'packages', 'core', 'src', 'version.ts'), 'utf8')
    const m = /CURRENT_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(src)
    return m?.[1]
  } catch {
    return undefined
  }
}

/** is `exe` a symlink into / the same tree as `repoDir`? (bun link, wrappers) */
function isSubpathOrLinked(exe: string, repoDir: string): boolean {
  try {
    const real = fs.realpathSync(exe)
    return real.startsWith(repoDir + path.sep) || real === repoDir || repoDir.startsWith(path.dirname(real) + path.sep)
  } catch {
    return false
  }
}

/**
 * The startup flow: silent check (daily cache) → arrow-key y/N → self-update.
 * Only runs interactively; `tagent run` / pipes never block on it.
 */
export async function startupUpdatePrompt(): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) return
  const info = await checkUpdate()
  if (!info?.outdated) return
  console.log('')
  console.log(`  ┌ update available`)
  console.log(`  │ v${info.current} → v${info.latest}${info.notes ? ` — ${info.notes}` : ''}`)
  console.log(`  │ ${info.url ?? `https://github.com/${REPO}/releases`}`)
  const yes = await confirm('  └ update now?', { default: false, cancelable: true })
  if (yes === undefined) {
    console.log(`  · skipped — /update checks again any time`)
    return
  }
  if (!yes) {
    console.log(`  · staying on v${info.current} — /update any time`)
    return
  }
  await selfUpdate(info)
}
