import type { PermissionDecision, PermissionRequest, Risk, TagentConfig, ToolContext } from './types'
import { uid } from './util'

/**
 * Permission gate for tool execution.
 * Order: explicit tool rule → default mode → ask.
 * "remember" upgrades: once (no-op), session (in-memory), always (persisted config).
 */
export class PermissionManager {
  private sessionAllowed = new Set<string>()
  private sessionDenied = new Set<string>()

  constructor(
    private cfg: TagentConfig,
    private onConfigChange?: (cfg: TagentConfig) => void,
  ) {}

  private rule(tool: string): 'ask' | 'allow' | 'deny' | undefined {
    const tools = this.cfg.permissions?.tools
    if (!tools) return undefined
    // exact tool name → server prefix (mcp_<server>) → 'mcp' catch-all
    if (tools[tool] !== undefined) return tools[tool]
    if (tool.startsWith('mcp_')) {
      const parts = tool.split('_')
      if (parts.length >= 3 && tools[parts.slice(0, 2).join('_')] !== undefined) {
        return tools[parts.slice(0, 2).join('_')]
      }
      if (tools.mcp !== undefined) return tools.mcp
    }
    // plugin tools: plugin_<name>_<tool> → plugin_<name> → 'plugin' catch-all
    if (tool.startsWith('plugin_')) {
      const parts = tool.split('_')
      if (parts.length >= 3 && tools[parts.slice(0, 2).join('_')] !== undefined) {
        return tools[parts.slice(0, 2).join('_')]
      }
      if (tools.plugin !== undefined) return tools.plugin
    }
    return undefined
  }

  async gate(tool: string, input: unknown, ctx: ToolContext, risk: Risk = 'medium'): Promise<PermissionDecision> {
    if (this.sessionDenied.has(tool)) return { approved: false }
    if (this.sessionAllowed.has(tool)) return { approved: true }

    const rule = this.rule(tool)
    if (rule === 'deny') return { approved: false }
    if (rule === 'allow') return { approved: true }
    // no explicit tool rule → fall back to the default mode
    if (this.cfg.permissions?.defaultMode === 'allow') return { approved: true }
    if (!ctx.events.onPermission) return { approved: true } // headless: allow

    const req: PermissionRequest = {
      id: uid(),
      tool,
      input,
      risk,
      reason: `Agent wants to run \`${tool}\``,
    }
    const decision = await ctx.events.onPermission(req)
    if (decision.approved) {
      if (decision.remember === 'session') this.sessionAllowed.add(tool)
      if (decision.remember === 'always') {
        this.cfg.permissions.tools[tool] = 'allow'
        this.onConfigChange?.(this.cfg)
      }
    } else if (decision.remember === 'always') {
      this.cfg.permissions.tools[tool] = 'deny'
      this.onConfigChange?.(this.cfg)
    }
    return decision
  }
}
