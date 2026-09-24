import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, homeDir } from './util'
import type { TagentConfig, ToolDefinition } from './types'

/**
 * Plugin system — lightweight, semver'd hooks + custom tools + commands.
 * A plugin is a .mjs/.js module exporting any mix of:
 *
 *   export const name = 'my-plugin'
 *   export const version = '1.0.0'
 *   export const description = 'what it does'
 *
 *   // lifecycle hooks (fire-and-forget observability)
 *   export const hooks = {
 *     onSessionStart({session, config}) {},
 *     onUserMessage({session, message}) {},
 *     onToolCall({tool, input, record}) {},     // before execution
 *     onToolResult({tool, input, record}) {},   // after execution
 *     onAgentDone({summary, session}) {},
 *   }
 *
 *   // custom tools — become agent-callable as plugin_<plugin>_<tool>
 *   export const tools = [{
 *     name: 'weather',
 *     description: 'get the weather for a city',
 *     risk: 'low',                    // low | medium | high
 *     params: { city: 'string — city name' },
 *     inputSchema: { type:'object', properties:{ city:{type:'string'} }, required:['city'] },
 *     async run(input) { return `sunny in ${input.city}` },
 *   }]
 *
 *   // custom slash commands — /hello world
 *   export const commands = [{
 *     name: 'hello',
 *     description: 'greet someone',
 *     async run({ args, workspaceRoot, config }) { return `hi ${args}` },
 *   }]
 *
 * Plugin files live in:
 *   - <workspace>/.tagent/plugins/*.mjs   (project-level)
 *   - ~/.tagent/plugins/*.mjs             (global)
 */

export interface PluginHooks {
  onSessionStart?: (ctx: Record<string, unknown>) => void | Promise<void>
  onUserMessage?: (ctx: Record<string, unknown>) => void | Promise<void>
  onToolCall?: (ctx: Record<string, unknown>) => void | Promise<void>
  onToolResult?: (ctx: Record<string, unknown>) => void | Promise<void>
  onAgentDone?: (ctx: Record<string, unknown>) => void | Promise<void>
}

/** a custom agent tool contributed by a plugin */
export interface PluginTool extends Omit<ToolDefinition, 'name'> {
  /** final tool name: plugin_<plugin>_<tool> (auto-prefixed) */
  name?: string
}

/** a custom slash command contributed by a plugin */
export interface PluginCommand {
  name: string
  description?: string
  run(ctx: { args: string; workspaceRoot: string; config: TagentConfig }): Promise<string | void> | string | void
}

export interface TagentPlugin {
  name: string
  version: string
  description?: string
  file: string
  scope: 'workspace' | 'global'
  hooks: PluginHooks
  tools: ToolDefinition[]
  commands: PluginCommand[]
}

export const PLUGIN_API_VERSION = '2.0.0'

export function pluginDirs(root: string): string[] {
  return [
    path.join(root, '.tagent', 'plugins'),
    path.join(homeDir(), '.tagent', 'plugins'),
  ]
}

export function listPluginFiles(root: string): string[] {
  const files: string[] = []
  for (const dir of pluginDirs(root)) {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile() && /\.m?js$/.test(e.name)) files.push(path.join(dir, e.name))
      }
    } catch { /* dir missing */ }
  }
  return files
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

export async function loadPlugins(root: string, cfg?: TagentConfig): Promise<TagentPlugin[]> {
  const plugins: TagentPlugin[] = []
  for (const file of listPluginFiles(root)) {
    try {
      const mod: any = await import(`${file}?t=${Date.now()}`) // fresh reload while running
      const scope: 'workspace' | 'global' = file.startsWith(path.join(root, '.tagent', 'plugins'))
        ? 'workspace'
        : 'global'
      const name = String(mod.name ?? path.basename(file).replace(/\.(m?js)$/, ''))
      const pfx = slug(name)
      const tools: ToolDefinition[] = (Array.isArray(mod.tools) ? mod.tools : [])
        .filter((t: unknown) => t && typeof t === 'object' && typeof (t as { run?: unknown }).run === 'function')
        .map((t: any) => ({
          name: `plugin_${pfx}_${slug(String(t.name ?? 'tool'))}`.slice(0, 60),
          description: String(t.description ?? t.name ?? 'plugin tool').slice(0, 400),
          risk: t.risk === 'low' || t.risk === 'high' ? t.risk : 'medium',
          params: t.params && typeof t.params === 'object' ? t.params : {},
          inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
          run: t.run.bind(t),
        }))
      const commands: PluginCommand[] = (Array.isArray(mod.commands) ? mod.commands : [])
        .filter((c: unknown) => c && typeof c === 'object' && typeof (c as { run?: unknown }).run === 'function' && typeof (c as { name?: unknown }).name === 'string')
        .map((c: any) => ({
          name: slug(String(c.name)),
          description: c.description ? String(c.description) : undefined,
          run: c.run.bind(c),
        }))
      plugins.push({
        name,
        version: String(mod.version ?? '0.0.0'),
        description: mod.description ? String(mod.description) : undefined,
        file,
        scope,
        hooks: mod.hooks ?? {},
        tools,
        commands,
      })
    } catch (e) {
      // a broken plugin must never take the daemon down
      console.error(`[tagent] plugin failed to load: ${file} — ${(e as Error).message}`)
    }
  }
  return plugins
}

/** all agent-callable tool definitions contributed by loaded plugins */
export function pluginToolDefinitions(plugins: TagentPlugin[]): ToolDefinition[] {
  return plugins.flatMap((p) => p.tools)
}

export async function emitPluginEvent(
  plugins: TagentPlugin[],
  hook: keyof PluginHooks,
  ctx: Record<string, unknown>,
): Promise<void> {
  for (const p of plugins) {
    try {
      await p.hooks[hook]?.(ctx)
    } catch (e) {
      console.error(`[tagent] plugin "${p.name}" ${hook} error: ${(e as Error).message}`)
    }
  }
}

/** metadata for pickers / the GUI (no module loading) */
export function pluginMeta(root: string): { name: string; file: string; scope: 'workspace' | 'global' }[] {
  return listPluginFiles(root).map((file) => {
    const scope: 'workspace' | 'global' = file.startsWith(path.join(root, '.tagent', 'plugins'))
      ? 'workspace'
      : 'global'
    let name = path.basename(file).replace(/\.(m?js)$/, '')
    try {
      const head = fs.readFileSync(file, 'utf8').slice(0, 4_000)
      const m = head.match(/export\s+const\s+name\s*=\s*['"`]([^'"`]+)['"`]/)
      if (m) name = m[1]
    } catch { /* unreadable */ }
    return { name, file, scope }
  })
}

/** Create the scaffold for a new plugin in the workspace. */
export function scaffoldPlugin(root: string, name: string): string {
  const dir = path.join(root, '.tagent', 'plugins')
  ensureDir(dir)
  const safe = name.replace(/[^a-zA-Z0-9-]/g, '-')
  const file = path.join(dir, `${safe}.mjs`)
  fs.writeFileSync(
    file,
    `export const name = '${safe}'
export const version = '1.0.0'
export const description = 'describe what this plugin does'

// lifecycle hooks (optional)
export const hooks = {
  onSessionStart({ session }) {
    console.log('[${safe}] session start:', session.id)
  },
  onToolCall({ tool, input }) {
    console.log('[${safe}] tool call:', tool)
  },
}

// custom agent tools (optional) — callable as plugin_${safe}_<name>
export const tools = [
  {
    name: 'helloworld',
    description: 'say hello from the ${safe} plugin',
    risk: 'low',
    params: { who: 'string — who to greet' },
    inputSchema: {
      type: 'object',
      properties: { who: { type: 'string', description: 'who to greet' } },
      required: ['who'],
    },
    async run(input) {
      return 'hello ' + String(input.who ?? 'world')
    },
  },
]

// custom slash commands (optional) — /hello-world <args>
export const commands = [
  {
    name: 'hello-world',
    description: 'print a greeting',
    async run({ args }) {
      return '[${safe}] hello ' + (args || 'world')
    },
  },
]
`,
  )
  return file
}
