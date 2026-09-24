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
 *   tagent auth [--web]    GitHub login — web connect (browser page), or
 *                           a PAT pasted in the terminal (--device: OAuth)
 *   tagent sync [message]   link + push this project to GitHub
 *   tagent projects         manage linked projects — list · sync · edit ·
 *                           delete · clone (all interactive)
 *   tagent clone [repo]     restore a project from GitHub (picks when bare)
 *   tagent logout           remove the stored GitHub token
 *   tagent whoami           print the current login (or guest)
 *   tagent config …         get / set / list settings
 *   tagent models [path]    providers + models catalog (--refresh to discover)
 *   tagent sessions [path]  list sessions of a workspace
 *   tagent share [id] [p]   export a session as standalone HTML
 *   tagent relay [id] [p]   share a session LIVE over the network (read-only)
 *   tagent doctor           environment sanity check
 *   tagent uninstall         remove everything tagent (confirm per step)
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
  clearCaches,
  listCredentialsMasked,
  validatePat,
  startDeviceLogin,
  pollDeviceToken,
  deviceUrl,
  getOAuthClientId,
  getCredential,
  setCredential,
  authStatus,
  logout,
  saveGithubLogin,
  defaultRepoName,
  listProjects,
  getLinkedProject,
  linkProject,
  unlinkProject,
  syncProject,
  restoreProject,
  deleteRepo,
  readSyncSettings,
  writeSyncSettings,
  recordSyncHistory,
  getVaultPassphrase,
  setVaultPassphrase,
  pushConfigSync,
  pullConfigSync,
  checkConfigRepo,
  readConfigSyncState,
  CONFIG_REPO_NAME,
  keychainProviders,
  workspaceHasWork,
  refuseLink,
  isLinkRefused,
  diskFreeBytes,
  type SessionData,
  type ToolCallRecord,
  type ProjectReg,
} from '@tagent/core'

import { GUI_BUNDLE_FILES } from './generated/gui-bundle'

import { AgentHost } from './host'
import { createDaemon } from './daemon'
import { Tui, runPiped } from './tui'
import { runApp, appCapable } from './tui-app'
import { lanIPv4s } from './net'
import { runWebLogin, openBrowser } from './web-auth'
import { loadRelays, revokeRelay } from '@tagent/core'
import { selfUpdate, detectInstallKind } from './updater'
import { uninstall } from './uninstall'
import { select, confirm } from './select'

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
    console.log('could not reach any update endpoint (offline?) — raw.githubusercontent, jsDelivr and the GitHub API were all tried')
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
            --inline        scrollback-native app (no alt-screen)
            --fresh         boot with an empty screen — the last chat's
                            text is not replayed (memory still loads)
    tagent web [path] [--port N] [--no-open]
            daemon + web GUI only (no TUI) — phone / remote use
    tagent run [path] "prompt" [--json]
            one-shot: run the agent on a prompt, print the result, exit
    tagent test [path] [--url http://localhost:3000]
            QA mode — the agent serves the project, clicks through it
            with a real browser (buttons, inputs, forms), screenshots +
            audits responsive (mobile/tablet/desktop), typography and
            contrast, then writes TEST-REPORT.md. --url skips the serve
            step and tests a running app instead. needs playwright:
            bun add playwright && bunx playwright install chromium
    tagent auth [--web]
            GitHub login — in a terminal you get a picker:
            web connect (a browser page opens, paste the token there)
            or paste a PAT right in the terminal (scope: repo).
            --device switches to the OAuth device flow (needs
            TAGENT_GH_CLIENT_ID). after login, a workspace with files
            gets a one-time "sync to GitHub?" offer.
    tagent sync [message]
            link this project to GitHub and push it — the first run
            creates a private repo (tagent-<dirname>). needs auth.
    tagent projects
            list linked projects — name, repo, last sync
    tagent clone <owner/name | name> [dir]
            restore a project from GitHub into ./<name> (or <dir>/<name>);
            a bare name matches your linked projects first
    tagent logout [--yes]
            remove the stored GitHub token — your GitHub repos
            are never touched
    tagent whoami
            print the current GitHub login (guest when logged out)
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
    tagent cache [path] · tagent cache clear [path] [--all]
            smart-cache status / wipe (file states, discovered models,
            update checks — run --all to reset everything)
    tagent update [--yes]
            check for a newer release and self-update (y/N prompt,
            --yes skips the question)
            — binary installs download the matching release asset,
              npm/bun installs run the global upgrade, source runs git pull
    tagent uninstall [--yes]
            remove EVERYTHING tagent: the command, ~/.tagent data
            (config, credentials, caches) and — each behind its own
            confirmation — the source repo and/or the release binary.
            per-workspace .tagent/ dirs are left alone (one optional offer)
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
    case 'uninstall': await mainUninstall(); break // before start — it may delete the repo the TUI would run in
    case 'start': await mainStart(); break
    case 'test': await mainStart(plain[1], { mode: 'test', url: flag<string>('url') }); break
    case 'web': await mainWeb(); break
    case 'run': await mainRun(); break
    case 'auth': await mainAuth(); break
    case 'sync': await mainSync(); break
    case 'projects': await mainProjects(); break
    case 'clone': await mainClone(); break
    case 'logout': await mainLogout(); break
    case 'whoami': await mainWhoami(); break
    case 'config': await mainConfig(); break
    case 'models': await mainModels(); break
    case 'sessions': await mainSessions(); break
    case 'share': await mainShare(); break
    case 'relay': await mainRelay(); break
    case 'doctor': await mainDoctor(); break
    case 'cache': await mainCache(); break
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

async function mainStart(dirArg?: string, boot?: { mode?: 'test'; url?: string | true }) {
  const root = resolveWorkspace(dirArg ?? (command === 'start' ? plain[1] : command === 'test' ? plain[1] : plain[0]))
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

  try {
    if (!process.stdin.isTTY) {
      // piped input: `echo "fix X" | tagent start`
      if (boot?.mode === 'test') host.ensureSession('test')
      await runPiped(host)
    } else if (appCapable() && !has('--classic')) {
      // the app TUI — opencode-style FULL-SCREEN by default (alternate
      // screen, mouse wheel, built-in scrollback viewer); `--inline` keeps
      // the scrollback-native inline app
      const target = typeof boot?.url === 'string' ? boot.url : undefined
      await runApp(host, {
        workspaceRoot: root,
        webUrl,
        fullscreen: !has('--inline'),
        // --fresh: boot with an empty screen — the previous chat's TEXT is
        // not replayed (its memory still loads, /open brings it back)
        noResume: has('--fresh'),
        ...(boot?.mode === 'test'
          ? {
              initialMode: 'test' as const,
              ...(target
                ? {
                    autoSend:
                      `Verify the app running at ${target} — test every feature you can reach, check ` +
                      'responsiveness (mobile/tablet/desktop) and visuals, then write the report.',
                  }
                : {}),
            }
          : {}),
      })
    } else {
      // classic readline TUI — small terminals or --classic
      const tui = new Tui(host, { workspaceRoot: root, webUrl })
      await tui.start()
    }
  } finally {
    host.interrupt()
    host.close() // kill MCP servers
    await stopDaemon?.().catch(() => undefined)
  }
  // the TUI was quit — exit NOW. handles with long lifetimes (a running
  // project-sync engine, paused raw stdin on some bun builds) must not
  // keep the process alive after the terminal is already restored
  process.exit(0)
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
/* tagent auth — GitHub login (web connect primary; PAT + device flow too)  */
/* ------------------------------------------------------------------ */

/** surgical raw-JSON edit: drop cached github token/login from a config file */
function clearGithubKeysFromConfig(file: string): boolean {
  try {
    if (!fs.existsSync(file)) return false
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { github?: Record<string, unknown> }
    if (!raw.github) return false
    let changed = false
    for (const k of ['token', 'login']) {
      if (raw.github[k] !== undefined) {
        delete raw.github[k]
        changed = true
      }
    }
    if (Object.keys(raw.github).length === 0) delete raw.github
    if (changed) fs.writeFileSync(file, JSON.stringify(raw, null, 2))
    return changed
  } catch {
    return false
  }
}

async function mainAuth() {
  const root = resolveWorkspace(plain[1])

  // legacy alias from pre-0.13: `tagent auth --logout` — same flow as `tagent logout`
  if (has('--logout')) {
    await mainLogout()
    return
  }

  // status — migrating a pre-0.13 token that lived in config.json, if any
  let st = authStatus()
  let migrated = false
  if (!st.logged) {
    const legacy = loadConfig(root).github
    if (legacy?.token) {
      // scrub the config files FIRST (this also clears the global login we are about to re-cache)
      clearGithubKeysFromConfig(path.join(workspaceDir(root), 'config.json'))
      clearGithubKeysFromConfig(path.join(GLOBAL_DIR, 'config.json'))
      if (legacy.login) saveGithubLogin(legacy.token, legacy.login)
      else setCredential('github', legacy.token)
      console.log(dim('  migrated the stored GitHub token into ~/.tagent/credentials.json'))
      st = authStatus()
      migrated = true
    }
  }
  if (st.logged) {
    const login = st.login ?? readGlobalConfig().github?.login ?? '(unknown)'
    console.log(`  ${okChip('logged in')} ${bold(login)}`)
    console.log(dim('  tagent sync uploads a project · tagent logout disconnects'))
    if (migrated) await maybePromptLinkWorkspace(root) // this run completed a login
    return
  }

  // web connect — explicit opt-in: a one-time page on 127.0.0.1
  if (has('--web')) {
    await runWebConnect(root)
    return
  }

  // device flow — explicit opt-in; the web page embeds the same flow as a
  // one-click button when a client id is available
  if (has('--device')) {
    const clientId = getOAuthClientId(process.env.TAGENT_GH_CLIENT_ID, loadConfig(root).github?.clientId)
    if (!clientId) die('device flow needs TAGENT_GH_CLIENT_ID (a GitHub OAuth app client id) — or use a PAT: tagent auth')
    try {
      const start = await startDeviceLogin(clientId)
      console.log(bold('\n  GitHub login — device flow\n'))
      // best link first: GitHub opens with the code pre-filled when possible
      console.log(`  open   ${deviceUrl(start)}`)
      console.log(`  code   ${bold(start.user_code)}\n`)
      console.log('  waiting for authorization…')
      const token = await pollDeviceToken(clientId, start)
      await finishLogin(root, token)
    } catch (e) {
      die(`login failed: ${(e as Error).message}`)
    }
    return
  }

  // interactive terminal → the picker (web connect is the happy path).
  // Piped/scripted sessions skip straight to the paste/pipe prompt below.
  if (process.stdin.isTTY) {
    const oauthReady = !!getOAuthClientId(
      process.env.TAGENT_GH_CLIENT_ID,
      loadConfig(root).github?.clientId,
    )
    const pick = await select<string>({
      title: 'GitHub login — pick a method',
      items: [
        {
          label: 'Web connect',
          value: 'web',
          hint: 'recommended',
          detail: oauthReady
            ? 'a browser page opens — press Authorize on GitHub, done'
            : 'a browser page opens — paste the token there',
        },
        { label: 'Paste token', value: 'paste', hint: 'right here', detail: 'github.com/settings/tokens · scope repo' },
      ],
      footer: 'OAuth device flow: tagent auth --device',
    })
    if (pick === 'web') {
      await runWebConnect(root)
      return
    }
    if (pick === undefined) {
      console.log(dim('  cancelled — nothing changed'))
      return
    }
    // 'paste' → fall through
  }

  // primary path — personal access token
  console.log(bold('\n  GitHub login\n'))
  console.log('  a personal access token is the simplest way to connect:')
  console.log('    1. open   https://github.com/settings/tokens')
  console.log(`             ${dim('Settings → Developer settings → Personal access tokens (classic)')}`)
  console.log(`    2. generate a token — check the ${bold('repo')} scope`)
  console.log(`    3. paste it below${dim(' (stored in ~/.tagent/credentials.json, never in your repos)')}\n`)
  let token = ''
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    token = (await new Promise<string>((r) => rl.question('  token: ', (a) => r(a ?? '')))).trim()
    rl.close()
  } else {
    // piped: echo "$GH_TOKEN" | tagent auth
    token = (await Bun.stdin.text().catch(() => '')).trim()
  }
  if (!token) die('no token given — run `tagent auth` in a terminal, or pipe one: echo "$GH_TOKEN" | tagent auth')
  try {
    await finishLogin(root, token)
  } catch (e) {
    die(`login failed: ${(e as Error).message}`)
  }
}

/** web connect — the browser flow: a one-time page on 127.0.0.1 (one-click
 *  OAuth button when a client id is configured, PAT paste always), the token
 *  never typed in the terminal at all. See web-auth.ts for the security shape. */
async function runWebConnect(root: string): Promise<void> {
  console.log(bold('\n  GitHub login — web connect\n'))
  const oauthClientId = getOAuthClientId(
    process.env.TAGENT_GH_CLIENT_ID,
    loadConfig(root).github?.clientId,
  )
  try {
    const r = await runWebLogin({
      oauth: oauthClientId ? { clientId: oauthClientId } : undefined,
      onReady: (url) => {
        if (openBrowser(url)) {
          console.log(
            `  ✔ browser opened — ${dim(
              oauthClientId ? 'press Connect with GitHub, then Authorize' : 'paste the token on that page',
            )}`,
          )
        } else {
          // no opener here (UserLAnd, headless box, ssh without -X…) — the
          // URL is the whole UI. On UserLAnd the phone's own browser reaches
          // 127.0.0.1 (proot shares the network namespace with Android).
          console.log('  open this in a browser on THIS device:')
          console.log(`    ${bold(url)}`)
          if (isAndroidish()) console.log(dim('    UserLAnd/Termux: the phone browser works — 127.0.0.1 is the same device'))
        }
        console.log(`\n  waiting for the browser… ${dim('Ctrl+C to cancel')}`)
      },
    })
    await finishLogin(root, r.token, r.login) // login already validated by the web flow
  } catch (e) {
    die(`web connect failed: ${(e as Error).message}`)
  }
}

/** validate + store the token, cache the login, print it, offer the first sync */
async function finishLogin(root: string, token: string, preValidated?: string): Promise<void> {
  const login = preValidated ?? (await validatePat(token)) // throws on an invalid token
  saveGithubLogin(token, login) // credential store + login cached in the global config
  console.log(`\n  ${okChip('logged in')} ${bold(login)}`)
  await authConfigBootstrapCli()
  await maybePromptLinkWorkspace(root)
}

/**
 * Post-auth: "kalo auth nanti tagent otomatis bikin repo private untuk
 * default config / global" — ensure login/tagent-config exists and carries
 * this device's config. Pull-first, so a defaults-only device never
 * clobbers a config another device already pushed.
 */
async function authConfigBootstrapCli(): Promise<void> {
  try {
    await pullConfigSync().catch(() => undefined)
    console.log(dim('  setting up your private config repo…'))
    const r = await pushConfigSync()
    console.log(`  ${okChip('config repo')} ${bold(r.repo)}${r.created ? ' (private, new)' : ''}`)
    if (r.passphrase) {
      console.log(`  ${warnChip('vault passphrase')} ${bold(r.passphrase)}`)
      console.log(yellow('    save it — other devices need it to unlock the config'))
    }
    console.log(dim('    providers · api keys · mcp · models — same on every device (/config in the TUI)'))
  } catch (e) {
    console.log(`  ${warnChip('config repo')} ${yellow(`setup skipped — ${(e as Error).message}`)}`)
  }
}

/* ------------------------------------------------------------------ */
/* guest→login flow — the one-time "sync this project?" offer            */
/* ------------------------------------------------------------------ */

/**
 * Run right after a successful login: when the workspace has files, is not
 * linked to a repo yet and was not refused → ask ONCE whether to sync it
 * to GitHub. Non-interactive sessions never block; they just get a hint.
 *
 * Reusable — but note this module is the CLI entry point (importing it
 * boots the CLI), so daemon/GUI hosts should replicate the flow instead.
 */
export async function maybePromptLinkWorkspace(root: string): Promise<void> {
  try {
    if (!workspaceHasWork(root)) return // nothing to upload
    if (getLinkedProject(root)) return // already linked
    if (isLinkRefused(root)) return // user said never
  } catch {
    return // registry unreadable — never break a successful login
  }
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.log(dim('  this project is not on GitHub yet — run `tagent sync` to upload it'))
    return
  }
  const pick = await select<string>({
    title: 'Proyek ini belum di-sync. Sync ke GitHub sekarang?',
    items: [
      { label: 'Sync sekarang', value: 'now', hint: 'repo privat + upload' },
      { label: 'Nanti', value: 'later', hint: 'tanya lagi nanti' },
      { label: 'Jangan untuk proyek ini', value: 'never', hint: 'jangan tanya lagi' },
    ],
    footer: 'sync = link + push ke GitHub',
  })
  if (pick === 'now') {
    await doInitialSync(root)
  } else if (pick === 'never') {
    try {
      refuseLink(root)
    } catch { /* best-effort */ }
    console.log(dim('  ok — this project will not be offered again'))
  }
  // 'later' (or Esc / Ctrl+C) → nothing; asked again on the next login only
}

async function doInitialSync(root: string): Promise<void> {
  try {
    const cfg = loadConfig(root)
    linkProject(root, cfg.github?.repo || defaultRepoName(root))
    console.log('')
    const res = await syncProject(root, cfg, {
      message: 'sync: initial upload from tagent',
      onLog: (l) => console.log(`  ${dim(l)}`),
    }) // a successful sync re-links the registry with the full owner/name
    console.log(`\n  ${okChip('pushed')} ${bold(`→ ${res.url}`)}`)
    console.log(dim(`  commit ${res.commit} · next time: tagent sync [message]`))
  } catch (e) {
    console.log(`  ${errChip('sync failed')} ${red((e as Error).message)}`)
    console.log(dim('    nothing was lost — try again any time: tagent sync'))
  }
}

/* ------------------------------------------------------------------ */
/* tagent sync / projects / clone / logout / whoami                     */
/* ------------------------------------------------------------------ */

async function mainSync() {
  const message = plain.slice(1).join(' ').trim() || 'sync: update from tagent'
  const root = path.resolve('.')
  if (!authStatus().logged) die('not logged in — run `tagent auth` first (GitHub sync needs it)')
  const cfg = loadConfig(root)
  try {
    if (!getLinkedProject(root)) {
      const repoName = cfg.github?.repo || defaultRepoName(root)
      linkProject(root, repoName)
      console.log(dim(`  linked this project as ${repoName}`))
    }
    const res = await syncProject(root, cfg, { message, onLog: (l) => console.log(`  ${dim(l)}`) }) // re-links with the full owner/name
    recordSyncHistory(root, { action: 'pushed', detail: 'manual — tagent sync', repo: res.repo, commit: res.commit })
    console.log(`\n  ${okChip('synced')} ${bold(`→ ${res.url}`)}\n`)
    console.log(dim(`  commit ${res.commit} · branch ${res.branch}`))
  } catch (e) {
    console.error(`[tagent] sync failed: ${(e as Error).message}`)
    process.exit(1)
  }
}

async function mainProjects() {
  const list = listProjects()
  const sub = plain[1]

  // `tagent projects list` (and every non-TTY run) → the plain table
  if (sub === 'list' || !process.stdout.isTTY || !process.stdin.isTTY) {
    printProjectsTable()
    if (!process.stdout.isTTY || !process.stdin.isTTY) return
    return // TTY + explicit list → done
  }

  // direct actions: `tagent projects sync|rm <name>` (scriptable)
  if (sub === 'sync' || sub === 'rm' || sub === 'remove' || sub === 'delete') {
    const name = plain[2]
    if (!name) die(`usage: tagent projects ${sub} <name> — see tagent projects list`)
    const p = findProject(name)
    if (!p) die(`no linked project matches "${name}"`)
    if (sub === 'sync') {
      await syncOneProject(p)
    } else {
      unlinkProject(p.root)
      console.log(`  ${okChip('unlinked')} ${bold(p.name)} ${dim(`(${p.repo}) — files stay on disk`)}`)
    }
    return
  }

  if (list.length === 0) {
    console.log(`\n  ${bold('tagent projects')} · 0 linked\n`)
    console.log(dim('  nothing linked yet — open a project and run `tagent sync`,'))
    console.log(dim('  or log in (`tagent auth`) and take the sync offer\n'))
    return
  }

  // interactive manager — list · sync · edit · delete · clone
  for (;;) {
    const items = listProjects().map((p) => ({
      label: `${fs.existsSync(p.root) ? '' : yellow('⚠ ')}${bold(p.name)}`,
      hint: p.lastSyncAt ? relTime(p.lastSyncAt) : 'never synced',
      detail: `${p.root} · ${p.repo}${fs.existsSync(p.root) ? '' : red(' · missing on this device')}`,
      value: p,
    }))
    items.push({
      label: `+ clone…`,
      hint: 'restore a repo',
      detail: 'bring a synced project to this device',
      value: undefined as unknown as ProjectReg,
    })
    const pick = await select<ProjectReg | undefined>({
      title: `tagent projects · ${items.length - 1} linked`,
      items,
      footer: 'enter = manage · esc = quit',
    })
    if (pick === undefined) {
      console.log(dim('\n  bye — projects stay as they are\n'))
      return
    }
    if (!pick.root) {
      await mainClone()
      continue
    }
    await manageProject(pick)
  }
}

function printProjectsTable(): void {
  const list = listProjects()
  console.log(`\n  ${bold('tagent projects')} · ${list.length} linked\n`)
  if (list.length === 0) {
    console.log(dim('  nothing linked yet — open a project and run `tagent sync`,'))
    console.log(dim('  or log in (`tagent auth`) and take the sync offer'))
    console.log()
    return
  }
  const cwd = path.resolve('.')
  for (const p of list) {
    const mark = path.resolve(p.root) === cwd ? green('▸') : ' '
    const synced = p.lastSyncAt ? relTime(p.lastSyncAt) : 'never synced'
    console.log(`  ${mark} ${bold(p.name)}  ${p.repo}  ${dim(synced)}`)
    console.log(dim(`      ${p.root}`))
  }
  console.log(`\n  ${dim('▸ = this directory · restore anywhere: tagent clone <name>')}\n`)
}

/** name / repo / path prefix match against the registry */
function findProject(name: string): ProjectReg | undefined {
  const n = name.replace(/\.git$/, '').toLowerCase()
  return listProjects().find(
    (p) =>
      p.name.toLowerCase() === n ||
      p.repo.toLowerCase() === n ||
      p.repo.toLowerCase().endsWith('/' + n) ||
      p.root.toLowerCase().endsWith(n) ||
      p.root.toLowerCase() === n,
  )
}

async function syncOneProject(p: ProjectReg): Promise<void> {
  if (!fs.existsSync(p.root)) die(`folder is gone: ${p.root} — clone it back: tagent clone ${p.repo}`)
  if (!authStatus().logged) die('not logged in — run `tagent auth` first')
  const cfg = loadConfig(p.root)
  console.log(`\n  ${bold(p.name)} → ${p.repo}\n`)
  try {
    const r = await syncProject(p.root, cfg, {
      message: 'sync: manual from tagent projects',
      onLog: (l) => console.log(`  ${dim(l)}`),
    })
    recordSyncHistory(p.root, { action: 'pushed', detail: 'manual — tagent projects', repo: r.repo, commit: r.commit })
    console.log(`\n  ${okChip('synced')} ${bold(`→ ${r.url}`)} ${dim(`(${r.commit})`)}\n`)
  } catch (e) {
    recordSyncHistory(p.root, { action: 'error', detail: `manual — ${(e as Error).message}` })
    console.log(`\n  ${errChip('sync failed')} ${red((e as Error).message)}`)
    console.log(dim('    nothing was lost — try again any time\n'))
  }
}

/** one project's cockpit: sync · edit · delete */
async function manageProject(p: ProjectReg): Promise<void> {
  for (;;) {
    const s = fs.existsSync(p.root) ? readSyncSettings(p.root) : null
    const syncState = s
      ? `${s.auto ? green('auto') : 'off'}${s.auto ? ` · every ${Math.round(s.intervalMs / 1000)}s` : ''}`
      : yellow('folder missing')
    const act = await select<string>({
      title: `${bold(p.name)} · ${p.repo}`,
      items: [
        { label: 'sync now', value: 'sync', hint: 'push + pull, right away', detail: p.root },
        { label: 'edit', value: 'edit', hint: 'repo name · auto-sync · vault', detail: `auto-sync: ${syncState}` },
        { label: 'clone to…', value: 'clone', hint: 'this repo, another folder' },
        { label: 'unlink', value: 'unlink', hint: 'forget on this device', detail: 'files stay, syncing stops' },
        { label: 'delete from GitHub…', value: 'delete', hint: red('removes the repo'), detail: 'needs a delete_repo token' },
        { label: 'back', value: 'back' },
      ],
      footer: p.lastSyncAt ? `last sync ${relTime(p.lastSyncAt)}` : 'never synced',
    })
    if (!act || act === 'back') return

    if (act === 'sync') {
      await syncOneProject(p)
      const again = getLinkedProject(p.root)
      if (again) Object.assign(p, again)
      continue
    }
    if (act === 'edit') {
      await editProject(p)
      const again = getLinkedProject(p.root)
      if (again) Object.assign(p, again)
      continue
    }
    if (act === 'clone') {
      await mainClone(p.repo)
      continue
    }
    if (act === 'unlink') {
      const sure = await confirm(`  unlink ${bold(p.name)}? (files stay, syncing stops)`, { default: true })
      if (!sure) continue
      unlinkProject(p.root)
      console.log(`\n  ${okChip('unlinked')} ${dim('— /push or tagent sync links it again any time')}\n`)
      return
    }
    if (act === 'delete') {
      console.log(red(`\n  this deletes ${bold(p.repo)} on GitHub — the local folder stays`))
      console.log(dim('    a delete_repo-scoped PAT is required\n'))
      const sure1 = await confirm(`  delete ${bold(p.repo)}?`, { default: false })
      if (!sure1) { console.log(dim('  cancelled — nothing touched')); continue }
      const sure2 = await confirm(red(`  really delete ${p.repo}? this cannot be undone`), { default: false })
      if (!sure2) { console.log(dim('  cancelled — nothing touched')); continue }
      const token = getCredential('github') || readGlobalConfig().github?.token
      if (!token) { console.log(red('  not logged in — tagent auth first')); continue }
      try {
        await deleteRepo(token, p.repo)
        unlinkProject(p.root)
        console.log(`\n  ${okChip('deleted')} ${bold(p.repo)} ${dim('from GitHub')}\n`)
        return
      } catch (e) {
        console.log(`\n  ${errChip()} ${red((e as Error).message)}`)
        console.log(dim('    the PAT may lack the delete_repo scope — delete it in the browser instead\n'))
      }
    }
  }
}

/** edit: repo name · auto-sync on/off · interval · vault shares · passphrase */
async function editProject(p: ProjectReg): Promise<void> {
  for (;;) {
    const s = readSyncSettings(p.root)
    const pick = await select<string>({
      title: `edit · ${bold(p.name)}`,
      items: [
        { label: 'repo name', value: 'repo', hint: p.repo, detail: 're-links; the next sync pushes to the new name' },
        { label: `${s.auto ? green('⦿') : '○'} auto-sync`, value: 'auto', hint: s.auto ? `on · every ${Math.round(s.intervalMs / 1000)}s` : 'off', detail: 'push + pull in the background while tagent runs' },
        { label: 'interval', value: 'interval', hint: `every ${Math.round(s.intervalMs / 1000)}s`, detail: 'min 5s · max 1h' },
        { label: `${s.vault.apiKeys ? green('☑') : '☐'} api keys`, value: 'v:apiKeys', hint: 'encrypted in the repo', detail: 'provider keys travel with the project' },
        { label: `${s.vault.customProviders ? green('☑') : '☐'} custom providers`, value: 'v:customProviders', hint: 'encrypted' },
        { label: `${s.vault.mcp ? green('☑') : '☐'} mcp servers`, value: 'v:mcp', hint: 'encrypted' },
        { label: `${s.vault.memory ? green('☑') : '☐'} memory`, value: 'v:memory', hint: 'saved facts' },
        { label: 'passphrase', value: 'pass', hint: getVaultPassphrase() ? 'saved here → set a new one' : 'set this device\'s passphrase' },
        { label: 'back', value: 'back' },
      ],
      footer: 'settings live in .tagent-sync/ inside the project — every device agrees',
    })
    if (!pick || pick === 'back') return

    if (pick === 'repo') {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      const next = (await new Promise<string>((r) => rl.question(`  new repo name [${p.repo.split('/').pop()}]: `, (a) => r(a ?? '')))).trim()
      rl.close()
      if (!next || next === p.repo.split('/').pop()) { console.log(dim('  unchanged')); continue }
      const owner = p.repo.includes('/') ? p.repo.split('/')[0] : readGlobalConfig().github?.login || 'you'
      linkProject(p.root, `${owner}/${next}`)
      Object.assign(p, getLinkedProject(p.root))
      console.log(`  ${okChip('re-linked')} ${bold(p.repo)} ${dim('— the next sync creates/pushes there')}`)
      continue
    }
    if (pick === 'auto') {
      writeSyncSettings(p.root, { ...s, auto: !s.auto })
      console.log(s.auto ? dim('  auto-sync off') : green(`  ✔ auto-sync on — every ${Math.round(s.intervalMs / 1000)}s`))
      continue
    }
    if (pick === 'interval') {
      const secs = [5, 10, 15, 30, 60, 300]
      const t = await select<number>({
        title: 'sync interval',
        items: secs.map((v) => ({ label: v < 60 ? `${v}s` : `${v / 60}m`, value: v, hint: v * 1000 === s.intervalMs ? green('current') : '' })),
      })
      if (!t) continue
      writeSyncSettings(p.root, { ...s, intervalMs: t * 1000 })
      console.log(`  ${okChip('interval')} ${bold(`every ${t < 60 ? t + 's' : t / 60 + 'm'}`)}`)
      continue
    }
    if (pick.startsWith('v:')) {
      const key = pick.slice(2) as keyof typeof s.vault
      writeSyncSettings(p.root, { ...s, vault: { ...s.vault, [key]: !s.vault[key] } })
      continue
    }
    if (pick === 'pass') {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      const next = (await new Promise<string>((r) => rl.question('  new passphrase: ', (a) => r(a ?? '')))).trim()
      rl.close()
      if (!next) { console.log(dim('  unchanged — empty passphrase skipped')); continue }
      setVaultPassphrase(next)
      console.log(green('  ✔ passphrase saved on this device — other devices need it to unlock the vault'))
      console.log(dim('    the vault is re-encrypted on the next sync tick'))
      continue
    }
  }
}

async function mainClone(repoOverride?: string) {
  let arg = repoOverride ?? plain[1]
  const st = authStatus()
  if (!st.logged) die('not logged in — run `tagent auth` first')
  const token = getCredential('github')
  if (!token) die('no stored token — run `tagent auth` again')
  // interactive: no repo given → offer linked projects + free-form owner/name
  if (!arg) {
    if (!process.stdin.isTTY) die('usage: tagent clone <owner/name | name> [dir]')
    const linked = listProjects()
    const items: { label: string; hint?: string; detail?: string; value: string }[] = linked.map((p) => ({
      label: p.repo,
      hint: p.name,
      detail: p.root,
      value: p.repo,
    }))
    items.push({ label: 'other…', hint: 'owner/name', value: '', detail: 'type the repo yourself' })
    const pick = await select<string>({
      title: 'clone — pick a repo',
      items,
      footer: 'tagent clone <owner/name> works too',
    })
    if (pick === undefined) return
    if (pick) {
      arg = pick
    } else {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      arg = (await new Promise<string>((r) => rl.question('  repo (owner/name): ', (a) => r(a ?? '')))).trim()
      rl.close()
      if (!arg) return console.log(dim('  cancelled'))
    }
  }

  // 'owner/name' is used as-is; a bare name matches a linked project, else the login owns it
  let repo = arg.includes('/') ? arg.replace(/\.git$/, '') : undefined
  if (!repo) {
    const hit = listProjects().find((p) => p.name === arg || p.repo === arg || p.repo.endsWith(`/${arg}`))
    if (hit) repo = hit.repo
  }
  if (!repo && st.login) repo = `${st.login}/${arg}`
  if (!repo) die(`"${arg}" is not owner/name and matches no linked project — try: tagent clone <owner/name>`)

  // restoreProject clones into <dir>/<name> — [dir] is the parent, default .
  const name = repo.split('/').pop()?.replace(/\.git$/, '') || repo
  const parent = path.resolve(plain[2] ?? '.')
  const dest = path.join(parent, name)
  if (fs.existsSync(dest)) {
    try {
      if (fs.readdirSync(dest).length > 0) die(`directory not empty: ${dest}`)
    } catch {
      die(`cannot use destination: ${dest}`)
    }
  }
  console.log(`\n  ${bold('tagent clone')} · ${repo} → ${path.relative(process.cwd(), dest) || dest}\n`)
  try {
    const r = await restoreProject(token, repo, parent, { onLog: (l) => console.log(`  ${dim(l)}`) })
    console.log(`\n  ${okChip('cloned')} ${bold(`into ${r.root}`)}`)
    console.log('\n  next steps:')
    console.log(`    cd ${path.relative(process.cwd(), r.root) || '.'}`)
    console.log(`    tagent${dim('   # start the TUI there')}\n`)
  } catch (e) {
    console.error(`[tagent] clone failed: ${(e as Error).message}`)
    process.exit(1)
  }
}

async function mainLogout() {
  if (!authStatus().logged) {
    console.log('not logged in.')
    return
  }
  if (!has('--yes')) {
    console.log(dim('  hanya menghapus token lokal, repo GitHub tidak tersentuh'))
    const yes = await confirm('logout GitHub?', { default: false, yes: 'logout', no: 'keep', cancelable: true })
    if (!yes) {
      console.log(dim('  cancelled — still logged in'))
      return
    }
  }
  try {
    logout() // drops the credential + scrubs the cached login from the global config
  } catch (e) {
    die(`logout failed: ${(e as Error).message}`)
  }
  // the workspace config may still hold a legacy pre-0.13 token — scrub it too
  clearGithubKeysFromConfig(path.join(workspaceDir(path.resolve('.')), 'config.json'))
  console.log(green('✔ logged out') + dim(' — hanya menghapus token lokal, repo GitHub tidak tersentuh'))
}

async function mainWhoami() {
  const st = authStatus()
  if (st.logged) {
    const login = st.login ?? readGlobalConfig().github?.login
    console.log(`  ${okChip('logged in')} ${bold(login ?? '(unknown)')}`)
  } else {
    console.log('guest — not logged in (tagent auth connects GitHub sync)')
  }
}

function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 31) return `${d} d ago`
  return new Date(ts).toISOString().slice(0, 10)
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
  serve: { path: ['tools', 'serve'], type: 'bool', desc: 'dev-server tool available to the agent (test mode)' },
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

  // disk space — npx/uvx download MCP servers onto this disk; a full one is
  // the #1 cause of "server exited (code 1)" that no retry can fix
  {
    const free = diskFreeBytes(os.homedir() || GLOBAL_DIR)
    const fmt = (n: number) =>
      n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`
    if (free === undefined) results.push([true, 'disk space: unknown on this platform'])
    else if (free < 256 * 1024 * 1024)
      check(false, `disk space: ${fmt(free)} free — too low for npx/uvx server installs; free space (npm cache clean --force · bun pm cache rm · docker system prune)`)
    else if (free < 1024 * 1024 * 1024) check(true, `disk space: ${fmt(free)} free — low (large MCP installs may fail)`)
    else check(true, `disk space: ${fmt(free)} free`)
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

  // github — the token lives in ~/.tagent/credentials.json (config.json keeps
  // only the login since the auth rework); checking config alone made doctor
  // report "✗ connected as <user>" on perfectly healthy installs.
  const ghToken = getCredential('github') || cfg.github?.token
  check(!!ghToken, `github: ${cfg.github?.login ? `connected as ${cfg.github.login}` : 'not connected (tagent auth)'}`)

  // v0.24 — the global config repo + the multi-key keychain
  if (ghToken) {
    const st = readConfigSyncState()
    if (st.repo) {
      const h = await checkConfigRepo()
      if (h.status === 'missing') {
        check(false, `config repo: ${st.repo} deleted on GitHub — /config push in the TUI recreates it`)
      } else {
        check(h.status === 'ok', `config repo: ${st.repo}${st.lastPushAt ? ` · pushed ${new Date(st.lastPushAt).toLocaleString()}` : ''}`)
      }
    } else {
      results.push([true, `config repo: not set up yet — created on the next ${bold('tagent start')} or /config push`])
    }
  }
  {
    const provs = keychainProviders(readGlobalConfig())
    const n = provs.reduce((a, p) => a + p.keys, 0)
    results.push([true, `keychain: ${n ? `${n} named key${n === 1 ? '' : 's'} across ${provs.length} provider${provs.length === 1 ? '' : 's'} — /config keys to manage` : 'no named keys (single-key mode) — /config add key'}`])
  }

  // mcp servers
  const mcpServers = Object.entries(cfg.mcp?.servers ?? {})
  if (mcpServers.length > 0) {
    const { McpManager } = await import('@tagent/core')
    const mgr = new McpManager(cfg.mcp)
    try {
      await mgr.ensureStarted()
      for (const st of mgr.status()) {
        const timedOut = st.state !== 'ready' && /timed out/i.test(st.error ?? '')
        const dead = st.state !== 'ready' && /server exited|cannot start|not running/i.test(st.error ?? '')
        check(
          st.state === 'ready',
          `mcp ${st.name}: ${st.state}${st.state === 'ready' ? ` · ${st.tools} tools` : st.error ? ` — ${st.error.slice(0, 160)}` : ''}` +
            (st.note ? ` (${st.note})` : '') +
            (st.hint
              ? ` — ${st.hint}`
              : timedOut
                ? ' (first run downloads the server via npx — try doctor again once warm; raise it with TAGENT_MCP_INIT_TIMEOUT_MS)'
                : dead
                  ? ' — /mcp reload retries after fixing'
                  : ''),
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

  // smart cache
  {
    const fsFile = path.join(workspaceDir(root), 'file-state.json')
    let tracked = 0
    try {
      tracked = Object.keys((JSON.parse(fs.readFileSync(fsFile, 'utf8')) as { files?: object }).files ?? {}).length
    } catch { /* none yet */ }
    check(
      true,
      `smart cache: fileState ${cfg.cache?.fileState !== false ? 'on' : 'off'} · web ${cfg.cache?.web !== false ? 'on' : 'off'} (${cfg.cache?.webTtlMin ?? 10} min) · ${tracked} tracked file(s) — tagent cache to inspect`,
    )
  }

  console.log(`\n  ${infoChip('doctor')} ${bold(`tagent v${CURRENT_VERSION}`)} · ${root}\n`)
  let bad = 0
  for (const [ok, label] of results) {
    console.log(`  ${ok ? okChip() : errChip()} ${label}`)
    if (!ok) bad++
  }
  console.log(bad === 0 ? `\n  ${okChip('all good')}\n` : `\n  ${errChip(`${bad} issue(s) found`)}\n`)
  process.exit(bad === 0 ? 0 : 1)
}

/* ------------------------------------------------------------------ */
/* tagent cache — smart-cache status & wipe                             */
/* ------------------------------------------------------------------ */

function fileAge(file: string): string {
  try {
    const ms = Date.now() - fs.statSync(file).mtimeMs
    const min = Math.round(ms / 60_000)
    if (min < 1) return 'just now'
    if (min < 60) return `${min} min ago`
    const h = Math.round(min / 60)
    if (h < 24) return `${h} h ago`
    return `${Math.round(h / 24)} d ago`
  } catch {
    return '—'
  }
}

function fileKb(file: string): string {
  try {
    return `${(fs.statSync(file).size / 1024).toFixed(1)} KB`
  } catch {
    return '—'
  }
}

async function mainCache() {
  const sub = plain[1]
  const isClear = sub === 'clear'
  const root = resolveWorkspace(isClear ? (plain[2] && !plain[2].startsWith('-') ? plain[2] : undefined) : (sub && !sub.startsWith('-') ? sub : undefined))
  const all = has('--all')

  const fsFile = path.join(workspaceDir(root), 'file-state.json')
  const modelsFile = path.join(GLOBAL_DIR, 'models.json')
  const updFile = path.join(GLOBAL_DIR, 'update-check.json')
  const credFile = path.join(GLOBAL_DIR, 'credentials.json')
  const guiCache = path.join(GLOBAL_DIR, 'gui-cache')

  if (isClear) {
    const cleared = clearCaches(root)
    const removed: string[] = [`${cleared.workspaces} workspace file-state(s)`]
    if (all) {
      for (const f of [modelsFile, updFile]) {
        try { fs.rmSync(f, { force: true }); removed.push(path.basename(f)) } catch { /* ignore */ }
      }
      try { fs.rmSync(guiCache, { recursive: true, force: true }); removed.push('gui-cache/') } catch { /* ignore */ }
    }
    console.log(`\n  ${bold('tagent cache clear')} · ${root}`)
    console.log(`  ${green('✔')} wiped: ${removed.join(', ')}`)
    console.log(dim(`  credentials are kept — delete them per-provider in settings\n`))
    process.exit(0)
  }

  console.log(`\n  ${bold('tagent cache')} · v${CURRENT_VERSION} · ${root}\n`)

  // file-state (per workspace, survives restarts)
  let tracked = 0
  let reads = 0
  try {
    const raw = JSON.parse(fs.readFileSync(fsFile, 'utf8')) as { files?: Record<string, { reads?: number }> }
    tracked = Object.keys(raw.files ?? {}).length
    reads = Object.values(raw.files ?? {}).reduce((n, s) => n + (s.reads ?? 0), 0)
  } catch { /* none yet */ }
  console.log(`  file-state    ${tracked ? green('on') : dim('empty')} · ${tracked} file(s) tracked · ${reads} read(s) · ${fileKb(fsFile)} · ${fileAge(fsFile)}`)
  console.log(dim(`                unchanged-file re-reads return a stub instead of resending content`))

  // discovered models
  let mProviders = 0
  let mModels = 0
  try {
    const raw = JSON.parse(fs.readFileSync(modelsFile, 'utf8')) as { providers?: Record<string, string[]> }
    mProviders = Object.keys(raw.providers ?? {}).length
    mModels = Object.values(raw.providers ?? {}).reduce((n, v) => n + v.length, 0)
  } catch { /* none */ }
  console.log(`  model catalog ${mProviders ? green(`${mProviders} provider(s)`) : dim('empty')} · ${mModels} discovered model(s) · ${fileAge(modelsFile)}`)

  // update check
  console.log(`  update check  ${fs.existsSync(updFile) ? fileAge(updFile) : dim('never')} · ${fileKb(updFile)}`)

  // credentials (names + masked values only)
  const creds = listCredentialsMasked()
  const credNames = Object.keys(creds)
  console.log(`  credentials   ${credNames.length ? green(`${credNames.length} secret(s)`) : dim('none')} · 0600 · ${credFile}`)
  for (const n of credNames) console.log(dim(`                ${n} = ${creds[n]}`))

  // web cache is in-memory (per daemon run) — show config
  const cfg = loadConfig(root)
  console.log(`  web cache     ${cfg.cache?.web !== false ? green(`on · TTL ${cfg.cache?.webTtlMin ?? 10} min`) : red('off')} (in-memory, per session)\n`)
  console.log(dim(`  tagent cache clear wipes file-state · --all also resets models + update checks\n`))
}

/* ------------------------------------------------------------------ */
/* tagent uninstall — remove everything                                */
/* ------------------------------------------------------------------ */

async function mainUninstall() {
  await uninstall({ yes: has('--yes') })
  process.exit(0)
}

/* ------------------------------------------------------------------ */
/* tagent update — self-update                                          */
/* ------------------------------------------------------------------ */

async function mainUpdate() {
  console.log(`\n  ${bold('tagent update')} · install: ${detectInstallKind()} · v${CURRENT_VERSION}\n`)
  const info = await checkUpdate(true)
  if (!info) {
    console.log('  could not reach any update endpoint (offline?) — raw.githubusercontent, jsDelivr and the GitHub API were all tried')
    process.exit(1)
  }
  if (!info.outdated) {
    console.log(`  ${okChip('up to date')} ${dim(`v${info.current}`)}`)
    process.exit(0)
  }
  console.log(`  update available: v${info.current} → ${bold('v' + info.latest)}`)
  if (info.notes) console.log(dim(`  ${info.notes}`))
  if (info.url) console.log(dim(`  ${info.url}`))
  const yes = has('--yes') ? true : await confirm('update now?', { default: false, cancelable: true })
  if (yes !== true) {
    console.log(dim(`  staying on v${info.current} — manual: https://github.com/asysurya/tagent/releases/latest`))
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
function yellow(s: string): string { return process.stdout.isTTY ? `\x1b[33m${s}\x1b[0m` : s }

/** v0.23.1 — a bg chip for CLI report lines (doctor, sync, auth…):
 *  same look as the TUI's ui.ts chip(), tuned for BOTH terminal kinds —
 *  green/black pairs stay readable on paper-white and dark terminals
 *  alike. Degrades to plain " text " when piped (isTTY false). */
function chip(text: string, bg: string, fg: string): string {
  return process.stdout.isTTY ? `\x1b[${bg};${fg}m ${text} \x1b[0m` : ` ${text} `
}
const okChip = (s = '') => chip(`✔${s ? ` ${s}` : ''}`, '42', '30')
const errChip = (s = '') => chip(`✗${s ? ` ${s}` : ''}`, '41', '97')
const warnChip = (s = '') => chip(`⚠${s ? ` ${s}` : ''}`, '43', '30')
const infoChip = (s: string) => chip(s, '44', '97')

init().catch((e: unknown) => {
  console.error('[tagent] fatal:', e)
  process.exit(1)
})
