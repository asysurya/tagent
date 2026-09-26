#!/usr/bin/env bun
/** quick smoke of the v0.30 skill stack — run from repo root: bun scripts/smoke-skills.ts */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.TAGENT_SKILLS_DIR = path.resolve(import.meta.dir, '../builtin-skills')

const { listSkills, searchSkillsTool, loadSkillTool } = await import('../packages/core/src/skills')
const { routeSkills, maybeAutoRouteSkills, rerunSkillRouter, capAutoBody } = await import('../packages/core/src/skill-router')
const { renderAutoLoadedSkillsBlock } = await import('../packages/core/src/system-prompt')
const { buildToolset, ALL_TOOLS, TEST_MODE_TOOLS } = await import('../packages/core/src/tools')
const { buildSystemPrompt } = await import('../packages/core/src/system-prompt')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-skills-'))
console.log('builtin skills:', listSkills(root).map((s) => `${s.name}[${(s.tags ?? []).join('/')}]`))

// fake ctx
const ctx = { workspaceRoot: root, sessionId: 's1', depth: 0, config: {} as never, events: {}, todos: [] } as never

// A) search all
const all = JSON.parse(await searchSkillsTool.run({}, ctx))
console.log('search all:', all.total, all.shown, all.skills.map((s: { name: string }) => s.name))

// B) query filter
const q = JSON.parse(await searchSkillsTool.run({ query: 'web' }, ctx))
console.log('query "web":', q.skills.map((s: { name: string }) => s.name))

// C) tags filter
const t = JSON.parse(await searchSkillsTool.run({ tags: ['debug'] }, ctx))
console.log('tags [debug]:', t.skills.map((s: { name: string }) => s.name))

// D) limit
const l = JSON.parse(await searchSkillsTool.run({ limit: 1 }, ctx))
console.log('limit 1:', l.shown, 'truncated:', l.truncated)

// E) two-stage
const body = await loadSkillTool.run({ name: 'web-app-builder' }, ctx)
console.log('two-stage: load web-app-builder ->', body.slice(0, 60).replace(/\n/g, ' '))

// J) web scenario
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { next: '^14' } }))
const routed = routeSkills({ userMessage: 'bikin blog Next.js', workspaceRoot: root })
console.log('web scenario:', routed.map((r) => `${r.name} ${r.matchScore} ${r.matchReason}`))

// maybeAutoRouteSkills end-to-end (fresh session — no manual loads yet)
fs.writeFileSync(path.join(root, 'WORKLOG.md'), '# Worklog\n')
const note = maybeAutoRouteSkills({
  sessionId: 'auto1', workspaceRoot: root, userText: 'bikin blog Next.js',
  priorUserMessages: [], config: { skills: { autoRoute: true, autoRouteMax: 3, autoRouteThreshold: 0.5 } } as never,
})
console.log('--- notice ---'); console.log(note)
console.log('worklog:', fs.readFileSync(path.join(root, 'WORKLOG.md'), 'utf8').split('\n').slice(-2).join(' | '))

// S) topic shift — a cli-tagged workspace skill + a completely different ask
fs.mkdirSync(path.join(root, '.tagent', 'skills', 'cli-parser'), { recursive: true })
fs.writeFileSync(path.join(root, '.tagent', 'skills', 'cli-parser', 'SKILL.md'),
  '---\nname: cli-parser\ndescription: Scaffold a command-line parser with flags, help text and exit codes.\nusage: Follow when asked to build a CLI tool or command-line parser.\ntags: cli, terminal\n---\n\n# CLI Parser\n\nSteps here.')
const note2 = maybeAutoRouteSkills({
  sessionId: 'auto1', workspaceRoot: root, userText: 'sekarang bikin CLI tool parse log dari file',
  priorUserMessages: ['bikin blog Next.js'],
  config: { skills: { autoRoute: true, autoRouteMax: 3, autoRouteThreshold: 0.5 } } as never,
})
console.log('topic-shift reroute:', note2 ? note2.split('\n')[0] : '(none)')

// prompt rendering
const prompt = buildSystemPrompt({ workspaceRoot: root, mode: 'build', tools: [] })
console.log('prompt has two-stage:', prompt.includes('two-stage progressive disclosure'))
console.log('prompt has auto-loaded:', prompt.includes('Auto-loaded skills'))
console.log('block:', renderAutoLoadedSkillsBlock([]).slice(0, 20))

// toolset registration
console.log('search_skills in ALL_TOOLS:', ALL_TOOLS.some((t) => t.name === 'search_skills'))
console.log('search_skills in TEST_MODE_TOOLS:', TEST_MODE_TOOLS.has('search_skills'))
console.log('plan mode has it:', buildToolset({ mode: 'plan' }).some((t) => t.name === 'search_skills'))
console.log('test mode has it:', buildToolset({ mode: 'test' }).some((t) => t.name === 'search_skills'))
console.log('cap:', capAutoBody('a\n\nb'.repeat(3000)).length)
