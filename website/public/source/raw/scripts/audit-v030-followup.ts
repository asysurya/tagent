#!/usr/bin/env bun
/**
 * audit-v030-followup.ts — verify the re-route-under-rule-signals finding
 * + corrected probes ('ci' substring, keyword-only accumulation).
 * Run: bun scripts/audit-v030-followup.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BUILTIN = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2-skills-'))
function mkSkill(dir: string, name: string, description: string, tags: string, bodySize = 400): void {
  fs.mkdirSync(path.join(dir, name), { recursive: true })
  const body = `# ${name}\n\n${name} playbook. ` + 'x'.repeat(bodySize)
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\nusage: Use ${name} when relevant.\ntags: ${tags}\n---\n\n${body}\n`)
}
mkSkill(BUILTIN, 'fake-web', 'Build a web application end to end.', 'web, frontend')
mkSkill(BUILTIN, 'fake-bot', 'Wire up a chat bot with commands.', 'bot, discord')
mkSkill(BUILTIN, 'fake-cli', 'Scaffold a command-line parser.', 'cli, terminal')
mkSkill(BUILTIN, 'fake-api', 'Design a REST API server with tests.', 'backend, api')
mkSkill(BUILTIN, 'fake-devops', 'Deploy and run pipelines.', 'devops, docker')
mkSkill(BUILTIN, 'fake-qa', 'Test and verify things.', 'test, qa')
for (const n of ['big-web-1', 'big-web-2', 'big-web-3']) mkSkill(BUILTIN, n, 'Big web skill ' + n, 'web, frontend', 9_000)
for (const n of ['big-bot-1', 'big-bot-2', 'big-bot-3']) mkSkill(BUILTIN, n, 'Big bot skill ' + n, 'bot, discord', 9_000)
process.env.TAGENT_SKILLS_DIR = BUILTIN

const { listSkills, skillState, sessionAutoSkills, clearSkillState } = await import('../packages/core/src/skills')
const { routeSkills, maybeAutoRouteSkills, isTopicShiftProbe } = {
  ...await import('../packages/core/src/skill-router'),
  isTopicShiftProbe: undefined as never,
} as never

const { defaultConfig } = await import('../packages/core/src/index')
const CFG = defaultConfig()
function freshRoot(name: string, pkgDeps?: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `audit2-${name}-`))
  fs.mkdirSync(path.join(root, '.tagent', 'skills'), { recursive: true })
  if (pkgDeps) fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: pkgDeps }))
  return root
}

console.log('\n== FINDING X: re-route in a workspace WITH rule signals ==')
{
  const root = freshRoot('rule', { next: '^14' })
  fs.writeFileSync(path.join(root, 'WORKLOG.md'), '# Worklog\n')
  const sid = 'rule-1'
  const n1 = maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root, userText: 'bikin blog Next.js', priorUserMessages: [], config: CFG })
  console.log('  initial  :', n1?.split('\n')[0])
  console.log('  loaded   :', sessionAutoSkills(sid).map((s) => `${s.name}(${s.matchScore})`).join(', '))

  const n2 = maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root, userText: 'sekarang bikin CLI parser untuk log', priorUserMessages: ['bikin blog Next.js'], config: CFG })
  console.log('  re-route :', n2 ? n2.split('\n')[0] : '(NULL — nothing loaded)')
  console.log('  loaded   :', sessionAutoSkills(sid).map((s) => s.name).join(', '))
  console.log('  reroutes :', skillState(sid).reroutes, '(budget NOT burned since nothing loaded)')

  // WHY: raw routeSkills for the shift message — rule-hit web skills (0.9)
  // outrank the CLI keyword hit (0.5), the top-3 slice is all-web, and the
  // already-loaded filter removes every one of them:
  const raw = routeSkills({ userMessage: 'sekarang bikin CLI parser untuk log', workspaceRoot: root })
  console.log('  raw rank :', raw.map((r) => `${r.name}(${r.matchScore},${r.matchReason})`).join(' | '))
  console.log('  → top-3 = all rule-hit web skills = already in context → filter → [] → no CLI skill ever loads')
  console.log('  RESULT  : topic-shift re-route is a NO-OP in any workspace with a rule signal (the common case: package.json present)')
}

console.log('\n== 2.1 (corrected): keyword-only workspace accumulation ==')
{
  const root = freshRoot('kw') // NO package.json — no rule signals
  fs.writeFileSync(path.join(root, 'WORKLOG.md'), '# Worklog\n')
  const sid = 'kw-1'
  maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root, userText: 'bikin blog pribadi', priorUserMessages: [], config: CFG })
  const c1 = sessionAutoSkills(sid)
  console.log('  initial  :', c1.map((s) => s.name).join(', '), `(${c1.reduce((a, s) => a + s.body.length, 0)} chars)`)
  const n2 = maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root, userText: 'sekarang bikin discord bot untuk server', priorUserMessages: ['bikin blog pribadi'], config: CFG })
  console.log('  re-route :', n2 ? n2.split('\n')[0] : '(null)')
  const all = sessionAutoSkills(sid)
  const totalChars = all.reduce((a, s) => a + s.body.length, 0)
  console.log('  TOTAL    :', `${all.length} skills, ${totalChars} body chars ≈ ${Math.round(totalChars / 4)} tokens, EVERY turn`)
  console.log('  → per-skill 8k cap respected, but NO aggregate cap: 3+3 = 6 × ~8k')
  clearSkillState(sid)
}

console.log('\n== 2.10 (corrected): substring false positives ==')
{
  const root = freshRoot('sub2')
  const a = routeSkills({ userMessage: 'help me decide the color scheme', workspaceRoot: root })
  console.log('  "help me decide the color scheme" →', a.map((s) => `${s.name}(${s.matchScore},${s.matchReason})`).join(', ') || '(none)')
  const b = routeSkills({ userMessage: 'review the social features please', workspaceRoot: root })
  console.log('  "review the social features please" →', b.map((s) => `${s.name}(${s.matchScore},${s.matchReason})`).join(', ') || '(none)')
  const c = routeSkills({ userMessage: 'apa kabar latest version sekarang', workspaceRoot: root })
  console.log('  "apa kabar latest version sekarang" →', c.map((s) => `${s.name}(${s.matchScore},${s.matchReason})`).join(', ') || '(none)')
  console.log('  → unanchored includes(): \'ci\' ⊂ decide/social, \'test\' ⊂ latest — spurious 0.5 hits ≥ threshold')
}

console.log('\n== boundary: keyword scores vs threshold (table) ==')
{
  const root = freshRoot('tab')
  const msgs = ['tulis blog', 'bikin api endpoint lalu test hasilnya', 'blog api test review bug deploy']
  for (const m of msgs) {
    const r = routeSkills({ userMessage: m, workspaceRoot: root })
    console.log(`  "${m}"`)
    for (const s of r) console.log(`    ${s.name.padEnd(12)} score=${s.matchScore} ${s.matchReason}`)
  }
  console.log('  threshold=0.5 inclusive: score 0.5 loads; formula 0.5+0.1×(groups−1) cap 0.7 — as documented')
}
process.exit(0)
