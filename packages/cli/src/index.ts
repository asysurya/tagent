#!/usr/bin/env bun
/**
 * Tagent — terminal-native coding agent.
 *
 * The TUI is the primary interface (`tagent start`). The web GUI is an
 * always-available companion (`--web-gui`, `tagent web`) — same engine, same
 * sessions, same permissions, on desktop and on a phone.
 *
 * Commands:
 *   tagent [start] [path]   interactive TUI (add --web-gui for the browser UI)
 *   tagent web [path]       daemon + web GUI only — for phone / remote use
 *   tagent run [path] "msg" one-shot agent run, prints the result
 *   tagent auth             GitHub login wizard (device flow or PAT)
 *   tagent config …         get / set / list settings
 *   tagent models [path]    providers + models catalog (--refresh to discover)
 *   tagent sessions [path]  list sessions of a workspace
 *   tagent share [id] [p]   export a session as standalone HTML
 *   tagent relay [id] [p]   share a session LIVE over the network (read-only)
 *   tagent doctor           environment sanity check
 *   tagent version          print the version
 */

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import readline from 'node:readline'
import { spawnSync } from 'node:child_process'

import {
  CURRENT_VERSION,
  GLOBAL_DIR,
  checkUpdate,
  loadConfig,
  saveConfig,
  defaultConfig,
  updateGlobalConfig,
  readGlobalConfig,
  workspaceDir,
  listProviderInfos,
  getAdapter,
  parseModelRef,
  refreshModelCache,
  binaryDir,
  resolveShell,
  type SessionData,
  type ToolCallRecord,
} from '@tagent/core'

import { GUI_BUNDLE_FILES } from './generated/gui-bundle'

import { AgentHost } from './host'
import { createDaemon } from './daemon'
import { Tui, runPiped } from './tui'
import { lanIPv4s } from './net'
import { loadRelays, revokeRelay } from '@tagent/core'
import { selfUpdate, detectInstallKind } from './updater'

const args = process.argv.slice(2)

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function flag<T = string>(name: string): T | undefined {
  const i = args.indexOf(`--${name}`)
  if (i === -1) return undefined
  const v = args[i + 1]
  return (v && !v.startsWith('--') ? v : true) as T
}
const has = (...names: string[]) => args.some((a) => names.includes(a))
const plain = args.filter((a) => !a.startsWith('--'))

/** Android/UserLAnd detection — no xdg-open there, print phone hints instead. */
function isAndroidish(): boolean {
  try {
    return /android/i.test(os.release()) || fs.existsSync('/.proot') || !!process.env.USERLAND
  } catch {
    return false
  }
}

function findGuiDir(): string | undefined {
  const explicit = flag<string>('gui')
  if (typeof explicit === 'string') return path.resolve(explicit)
  const candidates = [
    path.resolve(import.meta.dir, '../../../gui-dist'), // repo root when running from source
    path.join(binaryDir(), 'gui-dist'),                 // next to a compiled binary
    path.resolve(process.cwd(), 'gui-dist'),
  ]
  return candidates.find((d) => fs.existsSync(path.join(d, 'index.html')))
}

/**
 * Single-file binaries embed the web GUI (gui-dist/) as base64 — extract it
 * to ~/.tagent/gui-cache/<digest>/ on first use so the daemon can serve it.
 */
async function embeddedGuiDir(): Promise<string | undefined> {
  const rels = Object.keys(GUI_BUNDLE_FILES)
  if (!rels.length) return undefined
  const digest = Bun.hash(JSON.stringify(GUI_BUNDLE_FILES)).toString(16)
  const dir = path.join(GLOBAL_DIR, 'gui-cache', digest)
  const marker = path.join(dir, '.complete')
  if (fs.existsSync(marker)) return dir
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    for (const rel of rels) {
      if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) continue // safety
      const dest = path.join(dir, rel)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, Buffer.from(GUI_BUNDLE_FILES[rel], 'base64'))
    }
    fs.writeFileSync(marker, String(Date.now()))
    return dir
  } catch {
    return undefined // extraction failed — TUI still fully works
  }
}

/** Where the daemon should serve the web GUI from (disk candidates, then embedded). */
async function resolveGuiDir(): Promise<string | undefined> {
  return findGuiDir() ?? (await embeddedGuiDir())
}

/** Open a URL in the default browser — Windows-safe (no `command -v`). */
async function openUrlInBrowser(url: string): Promise<void> {
  const { exec } = await import('node:child_process')
  if (process.platform === 'win32') {
    exec(`start "" "${url}"`, () => undefined) // `start` is a cmd builtin
    return
  }
  const open = process.platform === 'darwin' ? 'open' : 'xdg-open'
  exec(`command -v ${open} >/dev/null 2>&1 && ${open} ${url}`, () => undefined)
}

function resolveWorkspace(p?: string): string {
  return path.resolve(p && fs.existsSync(p) ? p : '.')
}

function die(msg: string): never {
  console.error(`[tagent] ${msg}`)
  process.exit(1)
}

/* ------------------------------------------------------------------ */
/* fast paths                                                          */
/* ------------------------------------------------------------------ */

if (args.length === 0 || args[0] === 'start') {
  // handled by main() below — `tagent` and `tagent start` are the same thing
} else if (has('--version', '-v') || args[0] === 'version') {
  console.log(CURRENT_VERSION)
  process.exit(0)
} else if (has('--check-update')) {
  const info = await checkUpdate(true)
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
} else if (has('--help', '-h') || args[0] === 'help') {
  printHelp()
  process.exit(0)
}

function printHelp() {
  console.log(`
  ${'tagent'} — terminal-native coding agent (v${CURRENT_VERSION})

  ${'USAGE'}
    tagent [start] [path] [--web-gui] [--port N] [--host H] [--no-open]
            the interactive TUI — the primary interface.
            --web-gui       also serve the browser GUI on this workspace
            --no-web-gui    skip the GUI even if config enables it
    tagent web [path] [--port N] [--no-open]
            daemon + web GUI only (no TUI) — phone / remote use
    tagent run [path] "prompt" [--json]
            one-shot: run the agent on a prompt, print the result, exit
    tagent auth
            GitHub login wizard (device flow or personal access token)
    tagent config list [path] · get <key> [path] · set <key> <value> [path] [-g]
            settings from the shell (keys: webGui caveman worklog maxTurns
            provider model bash browser autoCheckpoint) — -g writes globally
            model accepts provider/model refs: config set model groq/llama-3.3-70b-versatile
    tagent models [path] [--refresh]
            list every provider + model. Keys come from config or env vars
            (OPENAI_API_KEY, ANTHROPIC_API_KEY, GROQ_API_KEY, …).
            --refresh runs live discovery (GET /models) and caches the result.
    tagent sessions [path]
            list sessions of a workspace
    tagent share [sessionId] [path]
            export a session as a standalone HTML file
    tagent relay [sessionId] [path] [--port N] [--host H]
            share a session LIVE — read-only viewer page over the network.
            subcommands: relay list [path] · relay stop <code> [path]
            --host 0.0.0.0 exposes it on your LAN (prints LAN urls)
    tagent doctor
            environment sanity check
    tagent update
            check for a newer release and self-update (y/N prompt)
            — binary installs download the matching release asset,
              npm/bun installs run the global upgrade, source runs git pull
    tagent version · --check-update

  ${'TUI'}
    everything is a slash command inside the TUI — /help there lists them all.
    text (no slash) talks to the agent. Ctrl+C interrupts a run, twice exits.
`)
}

/* ------------------------------------------------------------------ */
/* main dispatcher — runs after every declaration is initialized        */
/* ------------------------------------------------------------------ */

const command = args[0] && !args[0].startsWith('--') ? args[0] : 'start'

async function init(): Promise<void> {
  switch (command) {
    case 'start': await mainStart(); break
    case 'web': await mainWeb(); break
    case 'run': await mainRun(); break
    case 'auth': await mainAuth(); break
    case 'config': await mainConfig(); break
    case 'models': await mainModels(); break
    case 'sessions': await mainSessions(); break
    case 'share': await mainShare(); break
    case 'relay': await mainRelay(); break
    case 'doctor': await mainDoctor(); break
    case 'update': await mainUpdate(); break
    default: {
      // `tagent <path>` — a bare directory arg means "start here"
      const p = resolveWorkspace(command)
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        await mainStart(command)
      } else {
        console.error(`[tagent] unknown command "${command}" — try: tagent help`)
        process.exit(1)
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* tagent start — the TUI                                              */
/* ------------------------------------------------------------------ */

async function mainStart(dirArg?: string) {
  const root = resolveWorkspace(dirArg ?? (command === 'start' ? plain[1] : plain[0]))
  fs.mkdirSync(GLOBAL_DIR, { recursive: true })

  const cfg = loadConfig(root)
  let webGui = cfg.webGui === true
  if (has('--web-gui')) webGui = true
  if (has('--no-web-gui')) webGui = false

  const host = new AgentHost({ workspaceRoot: root })

  // optional companion: the web gui on the same shared host
  let webUrl: string | undefined
  let stopDaemon: (() => Promise<void>) | undefined
  if (webGui) {
    const port = Number(flag('port') ?? 4020)
    const hostName = typeof flag<string>('host') === 'string' ? flag<string>('host') : '127.0.0.1'
    const handle = await createDaemon({
      port, host: hostName, workspaceRoot: root, guiDir: await resolveGuiDir(), agentHost: host, quiet: true,
    })
    webUrl = `http://${hostName === '0.0.0.0' ? 'localhost' : hostName}:${port}`
    stopDaemon = handle.close
    console.log(dim(`  web gui live → ${webUrl}`))
    if (!has('--no-open') && !isAndroidish()) {
      await openUrlInBrowser(webUrl)
    }
  }

  // non-blocking update check — pipe mode only (interactive TUI asks with y/N)
  if (!process.stdout.isTTY) {
    void checkUpdate().then((info) => {
      if (info?.outdated) {
        console.log(`  ⚠ update available: v${info.latest} (you're on v${info.current}) — ${info.url ?? ''}`)
      }
    })
  }

  const tui = new Tui(host, { workspaceRoot: root, webUrl })
  try {
    if (process.stdin.isTTY) {
      await tui.start()
    } else {
      // piped input: `echo "fix X" | tagent start`
      await runPiped(host)
    }
  } finally {
    host.interrupt()
    host.close() // kill MCP servers
    await stopDaemon?.().catch(() => undefined)
  }
}

/* ------------------------------------------------------------------ */
/* tagent web — daemon + GUI only                                      */
/* ------------------------------------------------------------------ */

async function mainWeb() {
  const root = resolveWorkspace(plain[1])
  const port = Number(flag('port') ?? 4020)
  const noOpen = has('--no-open')
  const hostName = typeof flag<string>('host') === 'string' ? flag<string>('host') : '127.0.0.1'
  const guiDir = await resolveGuiDir()

  fs.mkdirSync(GLOBAL_DIR, { recursive: true })
  const handle = await createDaemon({ port, host: hostName, workspaceRoot: root, guiDir })
  const url = `http://${hostName === '0.0.0.0' ? 'localhost' : hostName}:${port}`
  const mobile = isAndroidish()

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
      : '\n  ⚠ GUI bundle not found — the TUI works fine; from a source checkout run `bun run build:gui`.'
  }

  Open ${url} in your browser — or use the TUI instead: tagent start${
    mobile
      ? '\n  📱 You are on Android (UserLAnd) — open that URL in your PHONE browser.'
      : ''
  }
  Press Ctrl+C to stop.
`)

  if (!noOpen && !mobile) {
    await openUrlInBrowser(url)
  }

  const shutdown = async () => {
    console.log('\n[tagent] shutting down…')
    await handle.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

/* ------------------------------------------------------------------ */
/* tagent run — one-shot                                                */
/* ------------------------------------------------------------------ */

async function mainRun() {
  const rest = plain.slice(1)
  let root = '.'
  let prompt = ''
  if (rest.length > 0 && fs.existsSync(resolveWorkspace(rest[0])) && fs.statSync(resolveWorkspace(rest[0])).isDirectory()) {
    root = rest[0]
    prompt = rest.slice(1).join(' ')
  } else {
    prompt = rest.join(' ')
  }
  if (!prompt.trim()) die('usage: tagent run [path] "prompt" [--json]')
  root = resolveWorkspace(root)
  const json = has('--json')

  const host = new AgentHost({ workspaceRoot: root })

  let session: SessionData | undefined
  if (!json) {
    host.bus.on('tool:end', (d: { call: ToolCallRecord }) => {
      const icon = d.call.status === 'done' ? '✓' : d.call.status === 'error' ? '✗' : '⊘'
      console.error(`  ${icon} ${d.call.tool}`)
    })
  }
  // one-shot mode cannot answer prompts — deny them explicitly
  host.bus.on('permission:request', (req: { id: string; tool: string; risk: string }) => {
    console.error(`[permission] ${req.tool} (risk: ${req.risk}) — denied in one-shot mode (pre-allow with /allow or config)`)
    host.permissionRespond(req.id, false)
  })

  try {
    const summary = await host.chatSend(prompt)
    session = host.session
    if (json) {
      const last = [...(session?.messages ?? [])].reverse().find((m) => m.role === 'assistant' && m.content.trim())
      console.log(JSON.stringify({ summary, answer: last?.content ?? null }, null, 2))
    } else {
      const last = [...(session?.messages ?? [])].reverse().find((m) => m.role === 'assistant' && m.content.trim())
      if (last) console.log(last.content)
      console.error(`— ${summary.turns} turns · ${summary.toolCalls} tool calls · ${summary.finished}`)
    }
    host.close() // kill MCP servers before exit
    process.exit(summary.finished === 'error' ? 1 : 0)
  } catch (e) {
    host.close()
    die((e as Error).message)
  }
}

/* ------------------------------------------------------------------ */
/* tagent auth — GitHub wizard                                          */
/* ------------------------------------------------------------------ */

async function mainAuth() {
  const root = resolveWorkspace(plain[1])
  const host = new AgentHost({ workspaceRoot: root })
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q: string) => new Promise<string>((r) => rl.question(q, (a) => r(a ?? '')))

  const github = host.cfg.github ?? {}
  if (has('--logout')) {
    await host.githubLogout()
    console.log('logged out.')
    rl.close()
    return
  }
  if (github.token) {
    console.log(`✔ connected as ${github.login ?? '(unknown)'} — repo: ${github.repo ?? '(auto)'}`)
    console.log('use --logout to disconnect.')
    rl.close()
    return
  }

  console.log(bold('\n  GitHub login\n'))
  console.log('  1) device flow — cleanest (needs TAGENT_GH_CLIENT_ID or github.clientId)')
  console.log('  2) personal access token — works everywhere')
  const a = (await ask('  choose [1/2] ')).trim()
  try {
    if (a === '1') {
      const start = await host.githubDeviceStart()
      console.log(`\n  open  ${start.verification_uri}`)
      console.log(`  code  ${start.user_code}\n`)
      console.log('  waiting for authorization…')
      const r = await host.githubDevicePoll()
      console.log(`✔ logged in as ${r.login}`)
    } else if (a === '2') {
      const token = (await ask('  token: ')).trim()
      if (!token) { console.log('cancelled.'); rl.close(); return }
      const r = await host.githubPat(token)
      console.log(`✔ logged in as ${r.login}`)
    } else {
      console.log('cancelled.')
    }
    console.log('\n  next: `tagent push` or /push in the TUI to sync this workspace.')
  } catch (e) {
    die((e as Error).message)
  }
  rl.close()
}

/* ------------------------------------------------------------------ */
/* tagent config                                                        */
/* ------------------------------------------------------------------ */

type CfgType = 'bool' | 'number' | 'string'
const CONFIG_KEYS: Record<string, { path: string[]; type: CfgType; global?: boolean; desc: string }> = {
  webGui: { path: ['webGui'], type: 'bool', global: true, desc: 'start the web GUI together with `tagent start`' },
  caveman: { path: ['caveman'], type: 'bool', desc: 'terse replies + compact prompts (token saver)' },
  worklog: { path: ['worklog', 'enabled'], type: 'bool', desc: 'agent journals to WORKLOG.md + live todos' },
  maxTurns: { path: ['maxTurns'], type: 'number', desc: 'turn budget per run (1-80)' },
  provider: { path: ['defaultProvider'], type: 'string', desc: 'default provider id' },
  model: { path: ['defaultModel'], type: 'string', desc: 'default model id' },
  bash: { path: ['tools', 'bash'], type: 'bool', desc: 'bash tool available to the agent' },
  browser: { path: ['tools', 'browser'], type: 'bool', desc: 'browser tool available to the agent' },
  autoCheckpoint: { path: ['autoCheckpoint'], type: 'bool', desc: 'snapshot before risky writes' },
}

function readPath(obj: Record<string, unknown>, pathArr: string[]): unknown {
  let cur: unknown = obj
  for (const k of pathArr) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

function mainConfigBad(msg: string): never {
  console.error(`[tagent] ${msg}\nusage: tagent config list [path] | get <key> [path] | set <key> <value> [path] [-g]`)
  process.exit(1)
}

async function mainConfig() {
  const sub = plain[1]
  const rest = plain.slice(2).filter((a) => a !== '-g' && a !== '--global')
  const globalScope = has('-g', '--global')

  if (sub === 'list') {
    const root = resolveWorkspace(rest[0])
    const cfg = loadConfig(root) as unknown as Record<string, unknown>
    console.log(`\n  effective config — workspace: ${root}\n`)
    for (const [key, def] of Object.entries(CONFIG_KEYS)) {
      const v = readPath(cfg, def.path)
      console.log(`    ${key.padEnd(15)} ${String(v).padEnd(10)} ${dim(def.desc)}`)
    }
    console.log(`\n  set: tagent config set <key> <value>${dim(' [-g = global (~/.tagent/config.json)]')}`)
    return
  }

  if (sub === 'get') {
    const key = rest[0]
    const def = key ? CONFIG_KEYS[key] : undefined
    if (!def) mainConfigBad(`unknown key "${key}"`)
    const root = resolveWorkspace(rest[1])
    const v = readPath(loadConfig(root) as unknown as Record<string, unknown>, def.path)
    console.log(String(v))
    return
  }

  if (sub === 'set') {
    const [key, value] = [rest[0], rest[1]]
    const def = key ? CONFIG_KEYS[key] : undefined
    if (!def) mainConfigBad(`unknown key "${key ?? ''}" — keys: ${Object.keys(CONFIG_KEYS).join(', ')}`)
    if (value === undefined) mainConfigBad(`missing value for ${key}`)
    let parsed: boolean | number | string
    if (def.type === 'bool') {
      const v = value.toLowerCase()
      if (!['on', 'off', 'true', 'false', '1', '0'].includes(v)) mainConfigBad(`${key} expects on/off`)
      parsed = ['on', 'true', '1'].includes(v)
    } else if (def.type === 'number') {
      parsed = Number(value)
      if (!Number.isFinite(parsed)) mainConfigBad(`${key} expects a number`)
      if (key === 'maxTurns') parsed = Math.min(Math.max(Math.round(parsed as number), 1), 80)
    } else {
      parsed = value
    }

    // scope-aware config for the provider-aware keys below
    const setRoot = resolveWorkspace(rest[2] ?? '.')
    const scopeCfg = def.global || globalScope ? readGlobalConfig() : loadConfig(setRoot)

    // `config set model <provider>/<model>` — opencode-style ref, sets both keys
    if (key === 'model' && typeof value === 'string' && value.includes('/')) {
      const ref = parseModelRef(value, scopeCfg)
      if (!ref) mainConfigBad(`"${value}" — the part before / must be a known provider id (tagent models)`)
      const patch = { defaultProvider: ref.provider, defaultModel: ref.model }
      if (def.global || globalScope) {
        updateGlobalConfig(patch as never)
        console.log(`✔ provider = ${ref.provider} · model = ${ref.model} (global)`)
      } else {
        saveConfig(setRoot, deepPatch(loadConfig(setRoot) as unknown as Record<string, unknown>, patch) as never)
        console.log(`✔ provider = ${ref.provider} · model = ${ref.model} (${workspaceDir(setRoot)}/config.json)`)
      }
      return
    }

    // `config set provider <id>` — validate against the catalog + customs
    if (key === 'provider') {
      const known = listProviderInfos(scopeCfg).some((p) => p.id === value)
      if (!known) mainConfigBad(`unknown provider "${value}" — run \`tagent models\` to see every provider id`)
    }

    // build a nested patch object from the path
    const patch: Record<string, unknown> = {}
    let node = patch
    for (let i = 0; i < def.path.length; i++) {
      if (i === def.path.length - 1) node[def.path[i]] = parsed
      else node = node[def.path[i]] = {}
    }

    if (def.global || globalScope) {
      updateGlobalConfig(patch as never)
      console.log(`✔ ${key} = ${parsed} (global)`)
    } else {
      const root = resolveWorkspace(rest[2] ?? '.')
      const cfg = loadConfig(root)
      // merge patch into the loaded config, then persist
      const merged = deepPatch(cfg as unknown as Record<string, unknown>, patch)
      saveConfig(root, merged as never)
      console.log(`✔ ${key} = ${parsed} (${workspaceDir(root)}/config.json)`)
    }
    return
  }

  mainConfigBad('missing subcommand')
}

function deepPatch(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target }
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] !== null) {
      out[k] = deepPatch(out[k] as Record<string, unknown>, v as Record<string, unknown>)
    } else {
      out[k] = v
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* tagent models — the provider catalog                                 */
/* ------------------------------------------------------------------ */

async function mainModels() {
  const root = resolveWorkspace(plain[1])
  const cfg = loadConfig(root)

  if (has('--refresh', '-r')) {
    console.log(dim('  discovering models (GET /models on every provider with a key)…'))
    const r = await refreshModelCache(cfg)
    console.log(green(`✔ ${r.updated.length} provider(s) refreshed`))
    if (r.updated.length) console.log(`  ${dim(r.updated.join(', '))}`)
    if (r.failed.length) console.log(`  ${dim(`unreachable: ${r.failed.join(', ')}`)}`)
    return
  }

  const infos = listProviderInfos(cfg)
  const ready = infos.filter((p) => !p.needsKey || p.hasKey)
  const locked = infos.filter((p) => p.needsKey && !p.hasKey)

  console.log(`\n  ${bold('tagent models')} · ${infos.length} providers · current: ${cfg.defaultProvider}/${cfg.defaultModel}\n`)
  console.log(`  ${bold('ready')}${dim(' — key set or no key needed')}`)
  for (const p of ready) {
    const mark = p.id === cfg.defaultProvider ? green('▸') : ' '
    const status = !p.needsKey ? dim('free') : p.hasKey ? green('key✓') : red('no key')
    const env = p.envVar ? dim(` · env ${p.envVar}`) : ''
    console.log(`  ${mark} ${bold(p.id.padEnd(18))} ${status.padEnd(6)} ${p.label}${env}`)
    const models = p.models.slice(0, 6).map((mm) => mm.id)
    if (models.length) console.log(`      ${dim(models.join(' · '))}${p.models.length > 6 ? dim(` · +${p.models.length - 6} more`) : ''}`)
  }
  if (locked.length) {
    console.log(`\n  ${bold('catalog')}${dim(' — add a key to use')}`)
    for (const p of locked) {
      console.log(`    ${p.id.padEnd(18)} ${dim(p.label)}${p.envVar ? dim(` · env ${p.envVar}`) : ''}`)
      if (p.models.length) console.log(`        ${dim(p.models.slice(0, 4).map((mm) => mm.id).join(' · '))}${p.models.length > 4 ? dim(` · +${p.models.length - 4}`) : ''}`)
    }
  }
  console.log(`\n  ${dim('set: tagent config set model <provider>/<model>   discover: tagent models --refresh')}`)
  console.log(`${dim('  custom endpoints: settings → providers → add custom (any OpenAI/Anthropic/Google-compatible URL)')}\n`)
}

/* ------------------------------------------------------------------ */
/* tagent sessions / share                                              */
/* ------------------------------------------------------------------ */

async function mainSessions() {
  const root = resolveWorkspace(plain[1])
  const host = new AgentHost({ workspaceRoot: root })
  const list = host.listSessions()
  if (list.length === 0) {
    console.log('no sessions yet.')
    return
  }
  console.log(`\n  sessions in ${root} (newest first)\n`)
  for (const s of list) {
    console.log(`  ${bold(s.title)}  ${dim(`· ${s.mode} · ${s.messageCount} msgs · ${new Date(s.updatedAt).toISOString().slice(0, 16).replace('T', ' ')} · ${s.id.slice(0, 12)}`)}`)
  }
  console.log(`\n  resume in the TUI: tagent start ${root} → /open <id>`)
}

async function mainShare() {
  const [id, dir] = [plain[1], plain[2]]
  const root = resolveWorkspace(dir ?? '.')
  const host = new AgentHost({ workspaceRoot: root })
  const r = host.share(id)
  if (!r.ok) die(r.error ?? 'export failed')
  console.log(`✔ share exported`)
  console.log(`  file: ${r.file}`)
  console.log(`  url:  /share/${path.basename(r.file!)}  ${dim('(served by the daemon / tagent web)')}`)
}

/* ------------------------------------------------------------------ */
/* tagent relay — live read-only sharing                                */
/* ------------------------------------------------------------------ */

async function mainRelay() {
  const sub = plain[1]

  /* relay list [path] */
  if (sub === 'list') {
    const root = resolveWorkspace(plain[2] ?? '.')
    const relays = loadRelays(root)
    if (relays.length === 0) {
      console.log('no live relays.')
      return
    }
    console.log(`\n  live relays in ${root}\n`)
    for (const r of relays) {
      console.log(`  ${bold(r.code)}  ${dim(`· ${r.sessionTitle} · since ${new Date(r.createdAt).toISOString().slice(0, 16).replace('T', ' ')}`)}`)
    }
    console.log(`\n  stop: tagent relay stop <code>`)
    return
  }

  /* relay stop <code> [path] */
  if (sub === 'stop') {
    const code = plain[2]
    if (!code) die('usage: tagent relay stop <code> [path]')
    const root = resolveWorkspace(plain[3] ?? '.')
    const ok = revokeRelay(root, code)
    console.log(ok ? `✔ relay ${code} ended — viewers are disconnected.` : `no live relay ${code} in this workspace.`)
    return
  }

  /* relay [sessionId] [path] — start sharing live */
  // positional args with --flag values stripped (e.g. `--port 4183`)
  const raw = args.slice(1) // args[0] is the "relay" command itself
  const positional: string[] = []
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].startsWith('--')) {
      const v = raw[i + 1]
      if (v && !v.startsWith('--')) i++ // skip the flag's value too
      continue
    }
    positional.push(raw[i])
  }
  let root = '.'
  let sessionArg: string | undefined
  if (positional.length > 0 && fs.existsSync(resolveWorkspace(positional[0])) && fs.statSync(resolveWorkspace(positional[0])).isDirectory()) {
    root = positional[0]
    sessionArg = positional[1]
  } else {
    sessionArg = positional[0]
  }
  root = resolveWorkspace(root)

  const host = new AgentHost({ workspaceRoot: root })
  const sessions = host.listSessions()
  if (sessions.length === 0) die('no sessions in this workspace yet — run the TUI first (tagent start)')

  const target = sessionArg
    ? sessions.find((s) => s.id.startsWith(sessionArg))
    : host.session && sessions.some((s) => s.id === host.session?.id)
      ? host.session
      : sessions[0]
  if (!target) die(`no session starts with "${sessionArg}" — see: tagent sessions ${root}`)

  const relay = host.relayCreate(target.id)
  if (!relay.ok || !relay.code) die(relay.error ?? 'relay failed')

  const port = Number(flag('port') ?? 4020)
  const hostName = typeof flag<string>('host') === 'string' ? flag<string>('host') : '127.0.0.1'
  const handle = await createDaemon({
    port, host: hostName, workspaceRoot: root, agentHost: host, quiet: true,
  })

  const local = `http://127.0.0.1:${port}`
  console.log(`
  ${bold('⚡ Tagent relay')} — sharing ${bold(target.title)} live

  ${green('viewer url')}   ${local}${relay.url}
  ${dim('read-only · updates in real time · the TUI/GUI keep full control')}`)
  if (hostName === '0.0.0.0') {
    for (const ip of lanIPv4s()) {
      console.log(`  ${green('on your lan')}    ${`http://${ip}:${port}`}${relay.url}`)
    }
    console.log(dim('  note: --host 0.0.0.0 also exposes the web GUI + RPC on this network — trusted networks only.'))
  } else {
    console.log(dim(`  share beyond this machine: re-run with ${bold('--host 0.0.0.0')} (or use an SSH tunnel)`))
  }
  console.log(dim(`  end it: Ctrl+C · tagent relay stop ${relay.code}

  Ctrl+C to stop.`))

  const shutdown = async () => {
    console.log('\n[tagent] relay stopped.')
    await handle.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

/* ------------------------------------------------------------------ */
/* tagent doctor                                                        */
/* ------------------------------------------------------------------ */

async function mainDoctor() {
  const root = resolveWorkspace(plain[1])
  const results: [boolean, string][] = []
  const check = (ok: boolean, label: string) => results.push([ok, label])

  // runtime
  check(true, `runtime: bun ${Bun.version} on ${process.platform}/${process.arch}`)

  // global dir
  try {
    fs.mkdirSync(GLOBAL_DIR, { recursive: true })
    fs.accessSync(GLOBAL_DIR, fs.constants.W_OK)
    check(true, `global dir writable: ${GLOBAL_DIR}`)
  } catch {
    check(false, `global dir not writable: ${GLOBAL_DIR}`)
  }

  // config
  let cfg
  try {
    cfg = loadConfig(root)
    check(true, `config loads (provider: ${cfg.defaultProvider} · model: ${cfg.defaultModel})`)
  } catch (e) {
    check(false, `config broken: ${(e as Error).message}`)
    cfg = defaultConfig()
  }

  // provider keys — detail only the active one, summarize the catalog
  const infos = listProviderInfos(cfg)
  const def = infos.find((p) => p.id === cfg.defaultProvider)
  if (def) {
    if (!def.needsKey) check(true, `provider ${def.id}: no key needed`)
    else if (def.hasKey) check(true, `provider ${def.id}: key set${def.envVar ? ` (config or ${def.envVar})` : ''}`)
    else check(false, `provider ${def.id}: MISSING key — /apikey ${def.id} in the TUI, settings in the GUI${def.envVar ? `, or export ${def.envVar}` : ''}`)
  }
  const readyN = infos.filter((p) => !p.needsKey || p.hasKey).length
  check(true, `provider catalog: ${readyN}/${infos.length} ready — tagent models to browse`)

  // adapter instantiation
  try {
    getAdapter(cfg.defaultProvider, cfg)
    check(true, `adapter ok: ${cfg.defaultProvider}`)
  } catch (e) {
    check(false, `adapter failed: ${(e as Error).message}`)
  }

  // workspace
  check(fs.existsSync(root), `workspace exists: ${root}`)
  const sessDir = path.join(workspaceDir(root), 'sessions')
  const nSessions = fs.existsSync(sessDir) ? fs.readdirSync(sessDir).filter((f) => f.endsWith('.json')).length : 0
  check(true, `sessions on disk: ${nSessions}`)

  // shell for the bash tool (Windows: Git for Windows' bash.exe)
  {
    const shell = resolveShell()
    const probe = spawnSync(shell, ['-c', 'echo ok'], { timeout: 5000 })
    check(
      probe.status === 0,
      probe.status === 0
        ? `bash shell: ${process.platform === 'win32' ? shell : 'ok'}`
        : `bash shell not found${process.platform === 'win32' ? ' — install Git for Windows (https://git-scm.com/download/win), then restart the terminal' : ''}`,
    )
  }

  // gui bundle
  const gui = await resolveGuiDir()
  check(!!gui, `gui bundle: ${gui ?? 'not found (bun run build:gui) — TUI works regardless'}`)

  // github
  check(!!cfg.github?.token, `github: ${cfg.github?.login ? `connected as ${cfg.github.login}` : 'not connected (tagent auth)'}`)

  // mcp servers
  const mcpServers = Object.entries(cfg.mcp?.servers ?? {})
  if (mcpServers.length > 0) {
    const { McpManager } = await import('@tagent/core')
    const mgr = new McpManager(cfg.mcp)
    try {
      await mgr.ensureStarted()
      for (const st of mgr.status()) {
        check(
          st.state === 'ready',
          `mcp ${st.name}: ${st.state}${st.state === 'ready' ? ` · ${st.tools} tools` : st.error ? ` — ${st.error.slice(0, 60)}` : ''}`,
        )
      }
    } finally {
      mgr.close()
    }
  } else {
    results.push([true, 'mcp: none configured — tagent start, then /mcp to add servers'])
  }

  // update
  const upd = await checkUpdate(true).catch(() => undefined)
  if (upd) check(!upd.outdated, `version: v${upd.current}${upd.outdated ? ` → v${upd.latest} available` : ' (up to date)'}`)
  else results.push([true, 'version: update check skipped (offline)'])

  console.log(`\n  ${bold('tagent doctor')} · v${CURRENT_VERSION} · ${root}\n`)
  let bad = 0
  for (const [ok, label] of results) {
    console.log(`  ${ok ? green('✔') : red('✗')} ${label}`)
    if (!ok) bad++
  }
  console.log(bad === 0 ? `\n  ${green('all good')}\n` : `\n  ${red(`${bad} issue(s) found`)}\n`)
  process.exit(bad === 0 ? 0 : 1)
}

/* ------------------------------------------------------------------ */
/* tagent update — self-update                                          */
/* ------------------------------------------------------------------ */

async function mainUpdate() {
  console.log(`\n  ${bold('tagent update')} · install: ${detectInstallKind()} · v${CURRENT_VERSION}\n`)
  const info = await checkUpdate(true)
  if (!info) {
    console.log('  could not reach the update endpoint (offline?) — try again later')
    process.exit(1)
  }
  if (!info.outdated) {
    console.log(green(`  ✔ up to date — v${info.current}`))
    process.exit(0)
  }
  console.log(`  update available: v${info.current} → ${bold('v' + info.latest)}`)
  if (info.notes) console.log(dim(`  ${info.notes}`))
  if (info.url) console.log(dim(`  ${info.url}`))
  const yes = await new Promise<boolean>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question('\n  update now? [y/N] ', (a: string) => {
      rl.close()
      resolve(a.trim().toLowerCase().startsWith('y'))
    })
  })
  if (!yes) {
    console.log(dim('  later — the TUI also offers this on startup when a release is out'))
    process.exit(0)
  }
  const ok = await selfUpdate(info)
  process.exit(ok ? 0 : 1)
}

/* ------------------------------------------------------------------ */
/* tiny ansi (kept dependency-free)                                     */
/* ------------------------------------------------------------------ */

function bold(s: string): string { return process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s }
function dim(s: string): string { return process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s }
function green(s: string): string { return process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s }
function red(s: string): string { return process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s }

init().catch((e: unknown) => {
  console.error('[tagent] fatal:', e)
  process.exit(1)
})
