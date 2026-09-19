/** v0.9.0 feature smoke tests — subagents, fallback, plan extraction, diagnostics config */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  listSubagents, findSubagent, renderSubagentsBlock, SUBAGENT_TEMPLATE,
  sanitizeFallback, fallbackTail, describeChain,
  extractPlan, diagnosticsCommand, defaultConfig,
} from '../packages/core/src/index'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean) => { cond ? pass++ : fail++; console.log(`${cond ? '✔' : '✗'} ${name}`) }

// ---- 1. custom subagents ----
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-feat-'))
fs.mkdirSync(path.join(root, '.tagent', 'agents'), { recursive: true })
fs.writeFileSync(path.join(root, '.tagent', 'agents', 'code-reviewer.md'), `---
name: code-reviewer
description: Reviews diffs for bugs before commit
model: zai/glm-4.7
tools: read_file, grep, list_files
mode: plan
maxTurns: 6
---
You are a strict code reviewer. Report only real bugs.`)
fs.writeFileSync(path.join(root, '.tagent', 'agents', 'reserved-general.md'), `---\ndescription: should be skipped (name=general reserved)\n---\nbody`)
const agents = listSubagents(root)
ok('subagents parsed (2, sorted)', agents.length === 2 && agents[0].name === 'code-reviewer')
ok('front-matter fields', agents[0].mode === 'plan' && agents[0].maxTurns === 6 && !!agents[0].model && (agents[0].tools?.length === 3))
ok('reserved name skipped', !agents.some(a => a.name === 'general') && findSubagent(root, 'general') === undefined)
ok('findSubagent', findSubagent(root, 'Code-Reviewer')?.name === 'code-reviewer')
ok('renderSubagentsBlock mentions name', renderSubagentsBlock(root).includes('code-reviewer'))
ok('template present', SUBAGENT_TEMPLATE.includes('name: my-specialist'))

// ---- 2. fallback chain ----
const cfg = defaultConfig()
cfg.customProviders = [{ id: 'or1', label: 'OR 1', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k1', models: ['m1', 'm2'] }]
cfg.fallback = sanitizeFallback([
  { provider: 'or1', model: 'm1', apiKey: 'keyA' },
  { provider: 'or1', model: 'm1', apiKey: 'keyB', enabled: true },
  { provider: 'or1', model: '', },            // invalid → dropped
  { provider: 'or1', model: 'm2', enabled: false }, // disabled → dropped
  'garbage' as never,                          // non-object → dropped
  { provider: 'or1', model: 'm2', label: 'third key' },
])
ok('sanitizeFallback keeps 4 (disabled preserved)', cfg.fallback.length === 4 && cfg.fallback[2].enabled === false)
ok('per-entry keys survive', cfg.fallback[0].apiKey === 'keyA' && cfg.fallback[1].apiKey === 'keyB' && !cfg.fallback[2].apiKey)
const tail = fallbackTail(cfg)
ok('tail resolves 3 entries', tail.length === 3)
ok('key override reflected', (tail[0].adapter as unknown as { apiKey?: string }).apiKey === 'keyA' && (tail[1].adapter as unknown as { apiKey?: string }).apiKey === 'keyB')
ok('label fallback to provider/model', tail[2].label === 'third key')
const chain = describeChain(cfg)
ok('describeChain = 1 primary + 3', chain.length === 4 && chain[0].primary && !chain[1].primary)

// ---- 3. extractPlan ----
ok('plan heading detected', extractPlan('intro\n## Plan\n1. do x\n2. do y\n3. do z')?.startsWith('## Plan'))
ok('numbered list detected (>=3)', extractPlan('So:\n1. a\n2. b\n3. c\n4. d')?.includes('1. a'))
ok('question NOT a plan', extractPlan('What database do you prefer?\n1. postgres\n2. mysql\n3. sqlite') === undefined)
ok('short text not a plan', extractPlan('ok sounds good') === undefined)

// ---- 4. diagnostics config ----
ok('diag off by default', diagnosticsCommand(cfg) === undefined)
cfg.diagnostics = { command: 'tsc --noEmit' }
ok('diag command read', diagnosticsCommand(cfg) === 'tsc --noEmit')
cfg.diagnostics = { command: '   ' }
ok('blank diag = off', diagnosticsCommand(cfg) === undefined)

console.log(`\n${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
