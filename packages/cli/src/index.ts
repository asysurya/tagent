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
import { createDaemon } from './daemon'
import { GLOBAL_DIR } from '@tagent/core'

const args = process.argv.slice(2)

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

  const handle = await createDaemon({ port, workspaceRoot: root, guiDir })

  const url = `http://localhost:${port}`
  console.log(`
  ████████╗ █████╗ ██╗   ██╗██████╗ ███████╗██████╗
  ╚══██╔══╝██╔══██╗██║   ██║██╔══██╗██╔════╝██╔══██╗
     ██║   ███████║██║   ██║██████╔╝█████╗  ██████╔╝
     ██║   ██╔══██║██║   ██║██╔══██╗██╔══╝  ██╔══██╗
     ██║   ██║  ██║╚██████╔╝██║  ██║███████╗██║  ██║
     ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝

  ⚡ Tagent daemon is live → ${url}
  📂 workspace: ${root}${
    guiDir
      ? `\n  🖥  GUI: ${guiDir} (websocket at /socket)`
      : '\n  ⚠ GUI bundle not found — run `bun run build:gui` for the browser UI,\n    or use `next dev` in development.'
  }

  Open ${url} in your browser to start coding with the agent.
  Press Ctrl+C to stop.
`)

  if (!noOpen) {
    const { exec } = await import('node:child_process')
    const open =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open'
    exec(`${open} ${url}`.replace('"" ""', '""'), () => undefined)
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
