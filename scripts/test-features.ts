/**
 * Feature tests — worklog tool + todos protocol + caveman mode.
 *
 * Run: bun scripts/test-features.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { worklogTool, worklogPath } from '../packages/core/src/tools/worklog'
import { buildToolset } from '../packages/core/src/tools'
import { buildSystemPrompt } from '../packages/core/src/system-prompt'
import { defaultConfig } from '../packages/core/src/config'
import type { ToolContext, TagentConfig } from '../packages/core/src/types'

let fails = 0
function assert(cond: boolean, label: string) {
  console.log(cond ? '✓' : '✗', label)
  if (!cond) fails++
}

const TMP = '/tmp/tagent-features-ws'
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

function makeCtx(root: string): ToolContext {
  return {
    workspaceRoot: root,
    sessionId: 'test',
    depth: 0,
    config: defaultConfig(),
    events: {},
    todos: [],
  } as ToolContext
}

/* ---------------- worklog tool ---------------- */

const ctx = makeCtx(TMP)
let out = await worklogTool.run({ entry: 'read app.js, found the counter bug', title: 'investigate' }, ctx)
assert(out.startsWith('Logged to WORKLOG.md'), 'worklog returns confirmation')

const file = worklogPath(TMP)
assert(fs.existsSync(file), 'WORKLOG.md created at workspace root')
let text = fs.readFileSync(file, 'utf8')
assert(text.includes('# Worklog'), 'journal has the header')
assert(text.includes(`## ${new Date().toISOString().slice(0, 10)}`), 'entries grouped under today\'s date')
assert(text.includes('found the counter bug'), 'entry content written')
assert(/\*\d{2}:\d{2} — investigate\*\*/.test(text), 'timestamp + title rendered')

await worklogTool.run({ entry: 'patched off-by-one in updateCount()' }, ctx)
text = fs.readFileSync(file, 'utf8')
assert(text.split('## ').length - 1 === 1, 'same-day entries append under ONE date heading')
assert(text.includes('patched off-by-one'), 'second entry appended')
assert(text.indexOf('found the counter bug') < text.indexOf('patched off-by-one'), 'chronological order')

const bad = await worklogTool.run({ entry: '' }, ctx)
assert(bad.startsWith('Error'), 'empty entry rejected')

/* ---------------- toolset wiring ---------------- */

const cfgOn = defaultConfig()
assert(cfgOn.worklog?.enabled === true, 'config default: worklog on')
assert(cfgOn.caveman === false, 'config default: caveman off')

let tools = buildToolset({ config: cfgOn }).map((t) => t.name)
assert(tools.includes('worklog'), 'worklog tool registered by default')

const cfgOff: TagentConfig = { ...defaultConfig(), worklog: { enabled: false } }
tools = buildToolset({ config: cfgOff }).map((t) => t.name)
assert(!tools.includes('worklog'), 'worklog tool removed when disabled')

tools = buildToolset({ readOnly: true, config: cfgOn }).map((t) => t.name)
assert(!tools.includes('worklog'), 'worklog not available in plan mode (read-only)')
assert(tools.includes('todowrite'), 'todowrite still available in plan mode')

assert(cfgOn.permissions.tools.worklog === 'allow', 'worklog permission defaults to allow (no nag)')

/* ---------------- system prompt ---------------- */

const dummyTools = buildToolset({ config: cfgOn })

let prompt = buildSystemPrompt({
  workspaceRoot: TMP, mode: 'build', tools: dummyTools, worklog: true,
})
assert(prompt.includes('WORKLOG.md'), 'prompt: journal protocol present when worklog on')
assert(prompt.includes('todowrite'), 'prompt: todo protocol present')

prompt = buildSystemPrompt({ workspaceRoot: TMP, mode: 'build', tools: dummyTools, worklog: false })
assert(!prompt.includes('## Progress tracking — todos + worklog'), 'prompt: journal protocol absent when off')

prompt = buildSystemPrompt({ workspaceRoot: TMP, mode: 'plan', tools: dummyTools, worklog: true })
assert(!prompt.includes('call worklog'), 'prompt: no worklog calls instructed in plan mode')

prompt = buildSystemPrompt({ workspaceRoot: TMP, mode: 'build', tools: dummyTools, caveman: true })
assert(prompt.includes('CAVEMAN MODE'), 'prompt: caveman block present')
assert(prompt.includes('- worklog('), 'caveman: one-line tool docs format')
assert(!prompt.includes('### worklog (risk'), 'caveman: verbose tool docs replaced')
assert(prompt.length < buildSystemPrompt({ workspaceRoot: TMP, mode: 'build', tools: dummyTools }).length,
  'caveman: system prompt is strictly smaller')

prompt = buildSystemPrompt({ workspaceRoot: TMP, mode: 'build', tools: dummyTools, caveman: false })
assert(!prompt.includes('CAVEMAN'), 'caveman absent by default')
assert(prompt.includes('### worklog (risk'), 'normal mode: verbose tool docs')

console.log(fails ? `\n${fails} FAILED` : '\nAll feature tests passed ✓')
process.exit(fails ? 1 : 0)
