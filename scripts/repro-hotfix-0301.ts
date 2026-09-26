#!/usr/bin/env bun
/**
 * repro-hotfix-0301.ts — raw BEFORE/AFTER evidence for the v0.30.1 hotfix.
 *
 * Reproduces the three v0.30.0 audit findings against the CURRENT code:
 *   BUG-1  topic-shift re-route no-op (rule-signal workspaces)
 *   BUG-3  keyword substring false positives ('ci' ⊂ decide, 'test' ⊂ latest)
 *   BUG-2  no total token cap on auto-loaded skill bodies
 *
 * Run: bun scripts/repro-hotfix-0301.ts
 * Same script before AND after the fix — the printed evidence flips.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/* fixtures — mirrors scripts/test-skills-router.ts, plus a devops skill */
const BUILTIN = fs.mkdtempSync(path.join(os.tmpdir(), 'repro0301-builtin-'))
function mkSkill(dir: string, name: string, description: string, tags: string, body: string): void {
  fs.mkdirSync(path.join(dir, name), { recursive: true })
  fs.writeFileSync(
    path.join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\nusage: Use ${name} when the task is about ${tags.split(',')[0]}.\ntags: ${tags}\n---\n\n${body}\n`,
  )
}
const bigBody = (name: string): string => `# ${name}\n\n${name} playbook. ` + 'lorem ipsum dolor sit amet '.repeat(320)
mkSkill(BUILTIN, 'fake-web', 'Build a web application end to end.', 'web, frontend', bigBody('fake-web'))
mkSkill(BUILTIN, 'fake-bot', 'Wire up a chat bot with commands.', 'bot, discord, telegram', bigBody('fake-bot'))
mkSkill(BUILTIN, 'fake-cli', 'Scaffold a command-line parser.', 'cli, terminal', bigBody('fake-cli'))
mkSkill(BUILTIN, 'fake-api', 'Design a REST API server with tests.', 'backend, api, test', bigBody('fake-api'))
mkSkill(BUILTIN, 'fake-review', 'Review code for correctness.', 'review, quality', bigBody('fake-review'))
mkSkill(BUILTIN, 'fake-bug', 'Hunt down and fix a bug.', 'debug, bug', bigBody('fake-bug'))
mkSkill(BUILTIN, 'fake-devops', 'Deploy with docker and CI pipelines.', 'devops, docker', bigBody('fake-devops'))
process.env.TAGENT_SKILLS_DIR = BUILTIN

const { routeSkills, maybeAutoRouteSkills } = await import('../packages/core/src/skill-router')
const { sessionAutoSkills } = await import('../packages/core/src/skills')
const { loadConfig } = await import('../packages/core/src/config')

const CFG = loadConfig('/nonexistent-root')
const names = (rs: { name: string }[]): string => rs.map((r) => r.name).join(', ') || '(none)'
const estTokens = (s: string): number => Math.ceil(s.length / 4)
function freshRoot(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `repro0301-${name}-`))
  fs.mkdirSync(path.join(root, '.tagent', 'skills'), { recursive: true })
  fs.writeFileSync(path.join(root, 'WORKLOG.md'), '# Worklog\n')
  return root
}

console.log('════ BUG-1: topic-shift re-route no-op (rule-signal workspace) ════')
{
  // three rule signals (next + discord.js + express) → three 0.9 rule-hit
  // skills fill the top-3, exactly the audit's FINDING X setup
  const root = freshRoot('bug1')
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ dependencies: { next: '^14', 'discord.js': '^14', express: '^4' } }),
  )

  const t1 = routeSkills({ userMessage: 'bikin web blog', workspaceRoot: root })
  console.log(`[1a] task1 "bikin web blog" → routed: ${names(t1)}`)

  const t2 = routeSkills({
    userMessage: 'bikin CLI parser untuk parse log',
    workspaceRoot: root,
    existingLoaded: ['fake-web', 'fake-bot', 'fake-api'],
  })
  console.log('[1b] task2 "bikin CLI parser" + existingLoaded=[fake-web,fake-bot,fake-api]')
  console.log(`     → routed: ${names(t2)}`)
  console.log('     expect: fake-cli present (BUG-1: existingLoaded ignored → fake-cli missing)')

  const sid = 'repro-bug1'
  const n1 = maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root, userText: 'bikin web blog', priorUserMessages: [], config: CFG })
  console.log(`[1c] e2e initial route → ${n1 === null ? 'null' : JSON.stringify(n1.split('\n')[0])}`)
  const n2 = maybeAutoRouteSkills({
    sessionId: sid,
    workspaceRoot: root,
    userText: 'sekarang bikin CLI parser untuk parse log',
    priorUserMessages: ['bikin web blog'],
    config: CFG,
  })
  console.log(`[1d] e2e topic shift "…CLI parser…" → ${n2 === null ? 'null (NO-OP — BUG-1)' : JSON.stringify(n2.split('\n')[0])}`)
  console.log(`     loaded after shift: ${names(sessionAutoSkills(sid))}`)
  console.log('     expect: fake-cli in the list (BUG-1: list unchanged, re-route returned null)')
}

console.log('\n════ BUG-3: keyword substring false positives ════')
{
  const root = freshRoot('bug3') // no package.json → keyword-only workspace
  const a = routeSkills({ userMessage: 'help me decide the color scheme', workspaceRoot: root })
  console.log(`[3a] "help me decide the color scheme" → ${names(a)}`)
  console.log('     expect: (none) — \'ci\' ⊂ "decide" must NOT fire the devops group')
  const b = routeSkills({ userMessage: 'apa kabar latest version', workspaceRoot: root })
  console.log(`[3b] "apa kabar latest version" → ${names(b)}`)
  console.log('     expect: (none) — \'test\' ⊂ "latest" must NOT fire the test group')
  const c = routeSkills({ userMessage: 'bikin CI pipeline untuk deploy', workspaceRoot: root })
  console.log(`[3c] "bikin CI pipeline untuk deploy" → ${names(c)}`)
  console.log('     expect: fake-devops (genuine word-boundary match must still work)')
  const d = routeSkills({ userMessage: 'latest test result dari run kemarin', workspaceRoot: root })
  console.log(`[3d] "latest test result …" → ${names(d)}`)
  console.log('     expect: fake-api (genuine word-boundary match must still work)')
}

console.log('\n════ BUG-2: total token cap on auto-loaded skills ════')
{
  // 9 web-tagged skills × ~8k-char bodies; autoRouteMax 8 → 8 would load
  const root = freshRoot('bug2')
  const dir = path.join(root, '.tagent', 'skills')
  for (let i = 1; i <= 8; i++) mkSkill(dir, `web-0${i}`, `Web playbook number ${i}.`, 'web, frontend', bigBody(`web-0${i}`))
  const cfg = { ...CFG, skills: { ...(CFG.skills ?? {}), autoRouteMax: 8 } }
  const sid = 'repro-bug2'
  const n = maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root, userText: 'tulis blog pribadi', priorUserMessages: [], config: cfg })
  const loaded = sessionAutoSkills(sid)
  const total = loaded.reduce((t, s) => t + estTokens(s.body), 0)
  console.log(`[2a] 9 web skills available (autoRouteMax 8, cap default 15000)`)
  console.log(`     → loaded ${loaded.length} skills, est. total ${total} tokens (chars/4)`)
  console.log(`     notice: ${n === null ? 'null' : JSON.stringify(n.split('\n')[0])}`)
  console.log('     expect AFTER fix: ≤ 7 skills, total ≤ 15000, plus "[auto-router] Truncated: …" log line(s)')
  console.log('     (BEFORE fix: 8 skills ≈ 16120 tokens — no cap, no log)')
}
