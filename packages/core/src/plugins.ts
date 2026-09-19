import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, homeDir } from './util'

/**
 * Plugin system — lightweight, semver'd hooks.
 * A plugin is a .mjs/.js module exporting:
 *   export const name = 'my-plugin'
 *   export const version = '1.0.0'
 *   export const hooks = {
 *     onSessionStart({session, config}) {},
 *     onUserMessage({session, message}) {},
 *     onToolCall({tool, input, record}) {},     // before execution
 *     onToolResult({tool, input, record}) {},   // after execution
 *     onAgentDone({summary, session}) {},
 *   }
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

export interface TagentPlugin {
  name: string
  version: string
  hooks: PluginHooks
}

export const PLUGIN_API_VERSION = '1.0.0'

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

export async function loadPlugins(root: string): Promise<TagentPlugin[]> {
  const plugins: TagentPlugin[] = []
  for (const file of listPluginFiles(root)) {
    try {
      const mod: any = await import(file)
      const p: TagentPlugin = {
        name: mod.name ?? path.basename(file).replace(/\.(m?js)$/, ''),
        version: mod.version ?? '0.0.0',
        hooks: mod.hooks ?? {},
      }
      plugins.push(p)
    } catch (e) {
      // a broken plugin must never take the daemon down
      console.error(`[tagent] plugin failed to load: ${file} — ${(e as Error).message}`)
    }
  }
  return plugins
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

export const hooks = {
  onSessionStart({ session }) {
    console.log('[${safe}] session start:', session.id)
  },
  onToolCall({ tool, input }) {
    console.log('[${safe}] tool call:', tool)
  },
}
`,
  )
  return file
}
