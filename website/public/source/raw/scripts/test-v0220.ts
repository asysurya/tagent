#!/usr/bin/env bun
/**
 * test-v0220.ts — the three agent directives + the input key swap.
 *
 * 1) ask_user directive: EVERY mode's prompt tells the agent to ask through
 *    the ask_user tool instead of plain-text questions (subagents excluded —
 *    they have no ask_user tool)
 * 2) MCP auto-detect: when mcp_* tools are in the toolset, the prompt teaches
 *    using them on own initiative (with the connected server names); without
 *    MCP tools the section is absent
 * 3) Quality bar (build mode): professional-grade by default — "build a blog"
 *    means Blogger/Ghost level, never one bare HTML file unless the user
 *    asked for simple
 *
 * Run: bun scripts/test-v0220.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildSystemPrompt } from '../packages/core/src/system-prompt'
import type { ToolDefinition } from '../packages/core/src/types'

let pass = 0
let fail = 0
function ok(cond: boolean, label: string, extra = ''): void {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`) }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-v0220-'))

/** minimal fake tool for prompt building */
function tool(name: string, description: string): ToolDefinition {
  return {
    name,
    description,
    risk: 'medium',
    params: {},
    run: async () => '',
  }
}

const BASE = [tool('read_file', 'reads'), tool('write_file', 'writes')]
const WITH_MCP = [
  ...BASE,
  tool('mcp_context7_resolve', '[mcp:context7] resolve library docs'),
  tool('mcp_fetch_page', '[mcp:fetch] fetch a web page'),
]

console.log('1) ask_user directive — every mode, never plain-text questions:')
for (const mode of ['build', 'plan', 'test'] as const) {
  const p = buildSystemPrompt({ workspaceRoot: root, mode, tools: BASE })
  ok(p.includes('## Asking the user — the ask_user tool, every time'), `${mode}: section present`)
  ok(p.includes('NEVER ask a question as plain text'), `${mode}: never plain-text rule`)
  ok(/When you need the user's input MID-RUN, call the ask_user tool/.test(p), `${mode}: action-protocol rule 3 points to ask_user`)
}
{
  const p = buildSystemPrompt({ workspaceRoot: root, mode: 'build', tools: BASE, subagent: true })
  ok(!p.includes('## Asking the user'), 'subagent: no ask section (no ask_user tool there)')
}

console.log('\n2) MCP auto-detect section:')
{
  const p = buildSystemPrompt({ workspaceRoot: root, mode: 'build', tools: WITH_MCP })
  ok(p.includes('## MCP tools — use them on your own initiative'), 'section present with mcp tools')
  ok(p.includes('connected now: context7, fetch'), 'connected server names listed', p.match(/connected now[^\n]*/)?.[0])
  ok(p.includes('AUTO-DETECT'), 'teaches auto-detecting from the [mcp:<server>] prefix')
}
{
  const p = buildSystemPrompt({ workspaceRoot: root, mode: 'build', tools: BASE })
  ok(!p.includes('## MCP tools'), 'absent without mcp tools')
  const t = buildSystemPrompt({ workspaceRoot: root, mode: 'test', tools: WITH_MCP })
  ok(t.includes('## MCP tools'), 'present in test mode too (mcp stays available there)')
}

console.log('\n3) quality bar — build mode:')
{
  const p = buildSystemPrompt({ workspaceRoot: root, mode: 'build', tools: BASE })
  ok(p.includes('Quality bar — build it like it ships'), 'quality bar section present')
  ok(p.includes('professional-grade, production-quality'), 'professional-grade default')
  ok(p.includes("level of Blogger/Ghost"), 'named reference: Blogger/Ghost')
  ok(p.includes('NOT one bare HTML file'), 'explicitly bans the bare HTML deliverable')
  ok(p.includes('EXPLICITLY asked for simple'), 'simple only on explicit request')
  ok(p.includes('no lorem ipsum'), 'no placeholders rule')
}
{
  const p = buildSystemPrompt({ workspaceRoot: root, mode: 'plan', tools: BASE })
  ok(!p.includes('Quality bar — build it like it ships'), 'plan mode: no build-mode quality section')
  const t = buildSystemPrompt({ workspaceRoot: root, mode: 'test', tools: BASE })
  ok(!t.includes('Quality bar — build it like it ships'), 'test mode: none either (QA does not create)')
}

console.log('\n4) caveman prompts keep the directives (terse docs, same rules):')
{
  const p = buildSystemPrompt({ workspaceRoot: root, mode: 'build', tools: BASE, caveman: true })
  ok(p.includes('NEVER ask a question as plain text'), 'caveman: ask rule survives')
  ok(p.includes('Quality bar — build it like it ships'), 'caveman: quality bar survives')
}

/* ---------------- report ---------------- */
console.log(`\nv0.22.0 tests: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
