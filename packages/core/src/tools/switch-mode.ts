import type { AgentMode, ToolContext, ToolDefinition } from '../types'

/**
 * switch_mode — the agent changes its own operating mode MID-RUN, but only
 * with the user's explicit approval (risk: medium → the permission gate
 * shows the target mode + reason before anything happens).
 *
 * This is the escape hatch that keeps the PLAN → BUILD → TEST loop in one
 * conversation: plan approved → switch to build; build done → switch to
 * test to verify; test fails → switch back to build to fix.
 *
 * Primary agent only (depth 0) — subagents have their mode fixed at spawn.
 */
export const switchModeTool: ToolDefinition = {
  name: 'switch_mode',
  risk: 'medium',
  description:
    'Switch YOUR operating mode mid-run: build (write code, run commands), plan (read-only: interview the user, produce a plan), test (read-only QA: run the project, verify, report). The user must APPROVE the switch — always send a concrete reason (what you finished, what you need next). On approval the system prompt and toolset change immediately for the following turns. Use it when the WORK calls for it (plan approved → build; implementation done → test to verify; test found bugs → build to fix), not to dodge a mode\u2019s rules.',
  params: {
    mode: 'target mode: "build" | "plan" | "test"',
    reason: 'why you are switching — one concrete sentence (shown to the user for approval)',
  },
  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['build', 'plan', 'test'] },
      reason: { type: 'string' },
    },
    required: ['mode', 'reason'],
  },
  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const mode = String(input.mode ?? '') as AgentMode
    const reason = String(input.reason ?? '').trim()
    if (mode !== 'build' && mode !== 'plan' && mode !== 'test') {
      return `Error: unknown mode "${input.mode}" — use build, plan, or test.`
    }
    if (!reason) {
      return 'Error: a reason is required — the user approves switches based on it. Send {"mode": "...", "reason": "what you finished / what you need next"}.'
    }
    if (!ctx.switchMode) {
      return 'Error: mode switching is not available here (subagents run with a fixed mode).'
    }
    const res = ctx.switchMode(mode, reason)
    if ('error' in res) return `Error: ${res.error}`
    const personas: Record<AgentMode, string> = {
      build: 'BUILD — your job is WORKING CODE: write files, run commands, get it done. Read PRD.md first if it exists.',
      plan: 'PLAN — your job is REQUIREMENTS: read-only investigation, interview the user with ask_user, deliver a "## Plan".',
      test: 'TEST — your job is VERIFICATION: run the project read-only (serve + browser + vision) and deliver the QA report.',
    }
    return (
      `MODE SWITCHED — you are now in ${mode.toUpperCase()} mode.\n` +
      `Persona: ${personas[mode]}\n` +
      `The system prompt and toolset for the following turns reflect the new mode. Continue the task under the new rules.`
    )
  },
}
