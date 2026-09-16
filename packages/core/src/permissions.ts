import type { PermissionDecision, PermissionRequest, TagentConfig, ToolContext } from './types'
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
    return this.cfg.permissions?.tools?.[tool]
  }

  async gate(tool: string, input: unknown, ctx: ToolContext): Promise<PermissionDecision> {
    if (this.sessionDenied.has(tool)) return { approved: false }
    if (this.sessionAllowed.has(tool)) return { approved: true }

    const rule = this.rule(tool)
    if (rule === 'deny') return { approved: false }
    if (rule === 'allow') return { approved: true }
    if (!ctx.events.onPermission) return { approved: true } // headless: allow

    const req: PermissionRequest = {
      id: uid(),
      tool,
      input,
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
