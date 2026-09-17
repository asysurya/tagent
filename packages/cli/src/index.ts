#!/usr/bin/env node
/**
 * Tagent — terminal-native coding agent with a web GUI.
 *
 * Usage:
 *   tagent [path] [--port N] [--no-open] [--gui <dir>]
 *
 * The daemon serves the GUI and the agent API over websockets.
 */

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createDaemon } from './daemon'
import { GLOBAL_DIR, CURRENT_VERSION, checkUpdate } from '@tagent/core'

const args = process.argv.slice(2)

// fast paths
if (args.includes('--version') || args.includes('-v')) {
  // eslint-disable-next-line no-console
  console.log(CURRENT_VERSION)
  process.exit(0)
}
if (args.includes('--check-update')) {
  const info = await import('@tagent/core').then((m) => m.checkUpdate(true))
  if (!info) {
    console.log('could not reach the update endpoint (offline?)')
    process.exit(1)
  }
  console.log(
    info.outdated
      ? `outdated: v${info.current} → v${info.latest} available\n${info.notes ?? ''}\n${info.url ?? ''}`
      : `up to date: v${info.current}`,
  )
  process.exit(info.outdated ? 2 : 0)
}

/** Android/UserLAnd detection — no xdg-open there, print phone-browser hints instead. */
function isAndroidish() {
  try {
    return /android/i.test(os.release()) || fs.existsSync('/.proot') || !!process.env.USERLAND
  } catch {
    return false
  }
}

function flag<T = string>(name: string): T | undefined {
  const i = args.indexOf(`--${name}`)
  if (i === -1) return undefined
  const v = args[i + 1]
  return (v && !v.startsWith('--') ? v : true) as T
}

async function main() {
  const dirArg = args.find((a) => !a.startsWith('--')) ?? '.'
  const root = path.resolve(dirArg)
  const port = Number(flag('port') ?? 4020)
  const noOpen = flag('no-open') === true
  const host = typeof flag<string>('host') === 'string' ? flag<string>('host') : '127.0.0.1'

  // GUI bundle: explicit --gui <dir> wins, else look for gui-dist/ in the repo
  let guiDir: string | undefined = flag<string>('gui')
  if (typeof guiDir === 'string') {
    guiDir = path.resolve(guiDir)
  } else {
    const candidates = [
      path.resolve(import.meta.dir, '../../../gui-dist'), // repo root when running from source
      path.resolve(process.cwd(), 'gui-dist'),
    ]
    guiDir = candidates.find((d) => fs.existsSync(path.join(d, 'index.html')))
  }

  const { mkdirSync } = await import('node:fs')
  mkdirSync(GLOBAL_DIR, { recursive: true })

  const handle = await createDaemon({ port, host, workspaceRoot: root, guiDir })

  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`
  const mobile = isAndroidish()

  // Non-blocking update check — a stale version warns but never blocks.
  void checkUpdate().then((info) => {
    if (info?.outdated) {
      console.log(`  ⚠ Update available: Tagent v${info.latest} (you're on v${info.current})`)
      console.log(`    Get it: ${info.url ?? 'https://github.com/asysurya/tagent/releases'}`)
      console.log(`    This session continues on v${info.current} — everything still works.`)
    }
  })
  console.log(`
  ████████╗ █████╗ ██╗   ██╗██████╗ ███████╗██████╗
  ╚══██╔══╝██╔══██╗██║   ██║██╔══██╗██╔════╝██╔══██╗
     ██║   ███████║██║   ██║██████╔╝█████╗  ██████╔╝
     ██║   ██╔══██║██║   ██║██╔══██╗██╔══╝  ██╔══██╗
     ██║   ██║  ██║╚██████╔╝██║  ██║███████╗██║  ██║
     ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝

  ⚡ Tagent daemon v${CURRENT_VERSION} is live → ${url}
  📂 workspace: ${root}${
    guiDir
      ? `\n  🖥  GUI: ${guiDir} (websocket at /socket)`
      : '\n  ⚠ GUI bundle not found — run `bun run build:gui` for the browser UI,\n    or use `next dev` in development.'
  }

  Open ${url} in your browser to start coding with the agent.${
    mobile
      ? '\n  📱 You are on Android (UserLAnd) — open that URL in your PHONE browser.'
      : ''
  }
  Press Ctrl+C to stop.
`)

  if (!noOpen && !mobile) {
    const { exec } = await import('node:child_process')
    const open =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open'
    // xdg-open is best-effort — on bare WSL/headless boxes it simply no-ops
    exec(`command -v ${open.split(' ')[0]} >/dev/null 2>&1 && ${open} ${url}`, () => undefined)
  }

  const shutdown = async () => {
    console.log('\n[tagent] shutting down…')
    await handle.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((e) => {
  console.error('[tagent] fatal:', e)
  process.exit(1)
})
