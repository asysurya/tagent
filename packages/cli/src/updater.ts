/**
 * updater.ts — interactive update flow.
 *
 * On startup the TUI checks the release feed (cached once a day). When a newer
 * version exists the user gets an arrow-key y/N prompt — "yes" triggers a
 * self-update that does the right thing for how Tagent was installed:
 *
 *   · single-file binary → downloads the matching release asset and swaps it
 *   · npm -g             → npm install -g tagent@latest
 *   · bun -g             → bun add -g tagent
 *   · source checkout    → git pull + bun install
 *
 * Every path is best-effort: failures print the manual steps, never block.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { CURRENT_VERSION, checkUpdate, type UpdateInfo } from '@tagent/core'
import { confirm } from './select'

const REPO = 'asysurya/tagent'

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

function assetName(version: string): string | undefined {
  const p = process.platform
  const a = process.arch
  const os = p === 'win32' ? 'windows' : p === 'darwin' ? 'macos' : 'linux'
  if (a !== 'x64' && a !== 'arm64') return undefined // no 32-bit builds (bun limit)
  return `tagent-v${version}-${os}-${a}${p === 'win32' ? '.exe' : ''}`
}

function downloadAsset(version: string): { ok: boolean; error?: string; file?: string } {
  const name = assetName(version)
  if (!name) return { ok: false, error: `no prebuilt binary for ${process.platform}-${process.arch}` }
  const url = `https://github.com/${REPO}/releases/download/v${version}/${name}`
  const dest = path.join(os.tmpdir(), name)
  try {
    const res = spawnSync('curl', ['-fSL', '--retry', '2', '-o', dest, url], {
      encoding: 'utf8',
      timeout: 10 * 60_000,
    })
    if (res.status !== 0) {
      return { ok: false, error: `download failed (curl exit ${res.status}) — ${url}` }
    }
    return { ok: true, file: dest }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

function run(cmd: string, args: string[], cwd?: string): { ok: boolean; output: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5 * 60_000, cwd, env: { ...process.env, NO_COLOR: '1' } })
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().slice(0, 400) }
}

/** do the actual update for the detected install kind */
export async function selfUpdate(info: UpdateInfo): Promise<boolean> {
  const kind = detectInstallKind()
  console.log(`  ⬆ updating ${kind} install → v${info.latest}…`)
  if (kind === 'binary') {
    const dl = downloadAsset(info.latest)
    if (!dl.ok || !dl.file) {
      console.log(`  ✗ ${dl.error}`)
      console.log(`    manual: https://github.com/${REPO}/releases/latest`)
      return false
    }
    try {
      fs.chmodSync(dl.file, 0o755)
      const exe = process.execPath
      if (process.platform === 'win32') {
        // a running exe cannot replace itself on windows
        const next = exe.replace(/\.exe$/i, '') + `-v${info.latest}.exe`
        fs.copyFileSync(dl.file, next)
        fs.rmSync(dl.file, { force: true })
        console.log(`  ✔ saved ${path.basename(next)} next to the current binary`)
        console.log(`    close Tagent, delete the old exe, rename the new one to tagent.exe`)
        return true
      }
      // POSIX: rename() atomically swaps even while running
      fs.renameSync(dl.file, exe)
      fs.chmodSync(exe, 0o755)
      console.log(`  ✔ updated in place — restart Tagent to run v${info.latest}`)
      return true
    } catch (e) {
      console.log(`  ✗ ${(e as Error).message}`)
      console.log(`    manual: https://github.com/${REPO}/releases/latest`)
      return false
    }
  }
  if (kind === 'npm') {
    const r = run('npm', ['install', '-g', 'tagent@latest'])
    console.log(r.ok ? `  ✔ updated via npm — restart Tagent` : `  ✗ ${r.output}\n    manual: npm install -g tagent@latest`)
    return r.ok
  }
  if (kind === 'bun') {
    const r = run('bun', ['add', '-g', 'tagent@latest'])
    console.log(r.ok ? `  ✔ updated via bun — restart Tagent` : `  ✗ ${r.output}\n    manual: bun add -g tagent@latest`)
    return r.ok
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
  const r = run('git', ['pull', '--ff-only'], repoDir)
  if (!r.ok) {
    console.log(`  ✗ ${r.output || 'git pull failed'} in ${repoDir}`)
    console.log(`    fix conflicts/divergence manually, or re-clone from https://github.com/${REPO}`)
    return false
  }
  // UserLAnd/proot needs the hoisted linker or socket.io fails to load at runtime
  const proot = /android/i.test(os.release()) || fs.existsSync('/.proot') || !!process.env.USERLAND
  run('bun', proot ? ['install', '--linker=hoisted'] : ['install'], repoDir)

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
