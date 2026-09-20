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
  // source checkout — only pull when cwd really is the tagent repo
  // (a misdetection must never `git pull` the USER's project)
  const remote = run('git', ['config', '--get', 'remote.origin.url'])
  if (!remote.ok || !/asysurya\/tagent(\.git)?$/i.test(remote.output)) {
    console.log(`  ✗ not a tagent source checkout (cwd: ${process.cwd()})`)
    console.log(`    manual: git pull in your tagent checkout — https://github.com/${REPO}`)
    return false
  }
  const top = run('git', ['rev-parse', '--show-toplevel'])
  const repoDir = top.ok ? top.output || undefined : undefined
  const r = run('git', ['pull', '--ff-only'], repoDir)
  if (!r.ok) {
    console.log(`  ✗ ${r.output || 'git pull failed'} — update manually with git pull`)
    return false
  }
  run('bun', ['install'], repoDir)
  console.log(`  ✔ source updated — restart Tagent`)
  return true
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
