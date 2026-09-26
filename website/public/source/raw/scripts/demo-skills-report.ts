#!/usr/bin/env bun
/** demo output for the v0.30 report — real runs, quoted verbatim */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.TAGENT_SKILLS_DIR = path.resolve(import.meta.dir, '../builtin-skills')
const { searchSkillsTool, loadSkillTool, skillState } = await import('../packages/core/src/skills')
const { maybeAutoRouteSkills } = await import('../packages/core/src/skill-router')
const { loadConfig } = await import('../packages/core/src/config')
const CFG = loadConfig('/nonexistent')

function root(name: string): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), `demo-${name}-`))
  fs.mkdirSync(path.join(r, '.tagent', 'skills'), { recursive: true })
  fs.writeFileSync(path.join(r, 'WORKLOG.md'), '# Worklog\n')
  return r
}
const ctx = (r: string) => ({ workspaceRoot: r, sessionId: 'demo', depth: 0, config: CFG, events: {}, todos: [] }) as never

console.log('===== search_skills (no filter) =====')
console.log(await searchSkillsTool.run({}, ctx(root('a'))))

console.log('\n===== search_skills({ query: "web" }) =====')
console.log(await searchSkillsTool.run({ query: 'web' }, ctx(root('b'))))

console.log('\n===== two-stage: search → load =====')
{
  const r = root('c')
  const found = JSON.parse(await searchSkillsTool.run({ query: 'broken' }, ctx(r)))
  console.log(`stage 1 → search_skills({query:"broken"}): ${found.skills[0].name} — ${found.skills[0].description}`)
  console.log(`stage 2 → load_skill("${found.skills[0].name}"):`)
  console.log((await loadSkillTool.run({ name: found.skills[0].name }, ctx(r))).slice(0, 300) + ' …')
}

console.log('\n===== auto-router — web / bot / CLI scenarios =====')
{
  // web: Next.js workspace
  const web = root('web')
  fs.writeFileSync(path.join(web, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { next: '^14' } }))
  console.log('--- [web] package.json has "next" ^14 · task: "bikin blog Next.js"')
  console.log(maybeAutoRouteSkills({ sessionId: 'w', workspaceRoot: web, userText: 'bikin blog Next.js', priorUserMessages: [], config: CFG }))
  console.log('WORKLOG.md →', fs.readFileSync(path.join(web, 'WORKLOG.md'), 'utf8').trim().split('\n').pop())
}
{
  // bot: discord.js workspace (workspace skill carries the bot tags)
  const bot = root('bot')
  fs.writeFileSync(path.join(bot, 'package.json'), JSON.stringify({ dependencies: { 'discord.js': '^14' } }))
  fs.mkdirSync(path.join(bot, '.tagent', 'skills', 'bot-commands'), { recursive: true })
  fs.writeFileSync(path.join(bot, '.tagent', 'skills', 'bot-commands', 'SKILL.md'), '---\nname: bot-commands\ndescription: Slash-command patterns, replies and state for chat bots.\ntags: bot, discord, telegram\n---\n\n# Bot Commands\n\nPattern catalog.')
  console.log('\n--- [bot] package.json has "discord.js" · task: "tambah command /ping"')
  console.log(maybeAutoRouteSkills({ sessionId: 'b', workspaceRoot: bot, userText: 'tambah command /ping', priorUserMessages: [], config: CFG }))
}
{
  // CLI: plain TypeScript workspace
  const cli = root('cli')
  fs.writeFileSync(path.join(cli, 'tsconfig.json'), '{ "compilerOptions": { "strict": true } }')
  fs.mkdirSync(path.join(cli, '.tagent', 'skills', 'cli-scaffold'), { recursive: true })
  fs.writeFileSync(path.join(cli, '.tagent', 'skills', 'cli-scaffold', 'SKILL.md'), '---\nname: cli-scaffold\ndescription: Flags, help text, exit codes and stdin/stdout handling for CLIs.\ntags: cli, terminal\n---\n\n# CLI Scaffold\n\nSteps.')
  console.log('\n--- [cli] tsconfig.json only · task: "bikin CLI parser"')
  console.log(maybeAutoRouteSkills({ sessionId: 'c', workspaceRoot: cli, userText: 'bikin CLI parser', priorUserMessages: [], config: CFG }))
}

console.log('\n===== token comparison (web scenario, first request) =====')
{
  const web = root('tok')
  fs.writeFileSync(path.join(web, 'package.json'), JSON.stringify({ dependencies: { next: '^14' } }))
  maybeAutoRouteSkills({ sessionId: 't', workspaceRoot: web, userText: 'bikin blog Next.js', priorUserMessages: [], config: CFG })
  const auto = skillState('t').auto
  const withRouter = auto.reduce((n, s) => n + s.body.length, 0)
  // without the router the agent would have to probe: load each skill to see what fits
  const { listSkills, loadSkill } = await import('../packages/core/src/skills')
  const all = listSkills(web)
  const probeAll = all.reduce((n, s) => n + loadSkill(web, s.name).length, 0)
  const probeMisses = probeAll - withRouter // skills it loaded but didn't need
  console.log(`auto-router (1 relevant skill):  ~${(withRouter / 4).toFixed(0)} tokens (web-app-builder body, 8k-capped)`)
  console.log(`blind probe (all ${all.length} skills):      ~${(probeAll / 4).toFixed(0)} tokens — ${(probeMisses / 4).toFixed(0)} of them wasted on skills it didn't need`)
  console.log(`search_skills first instead:    metadata for all = ~${((await searchSkillsTool.run({}, ctx(web))).length / 4).toFixed(0)} tokens, zero loads until a match is picked`)
}
