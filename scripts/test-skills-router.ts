#!/usr/bin/env bun
/**
 * test-skills-router.ts — v0.30: search_skills tool + skill auto-router.
 *
 * Part A: SkillMeta metadata (usage/tags), mtime cache, the search_skills
 * tool (query/tags/limit filters, two-stage flow, mode gating, perf).
 * Part B: the router — rule hits (workspace signals), keyword hits, threshold/
 * max, config gating, topic-shift re-route, session registry + slash-command
 * logic (/skills · /reload-skills · /no-auto-skill · /unload-skill),
 * transparency notice + WORKLOG entry, system-prompt rendering.
 *
 * Run: bun scripts/test-skills-router.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let pass = 0
let fail = 0
function ok(cond: boolean, label: string, extra = ''): void {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`) }
}

/* ---- fixture: one builtin skills dir shared by all scenario roots ---- */
const BUILTIN = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-skills-builtin-'))
function mkSkill(dir: string, name: string, description: string, tags: string, body = `# ${name}\n\n${name} playbook body — long enough to matter for the token comparison. ` + 'x'.repeat(400)): void {
  fs.mkdirSync(path.join(dir, name), { recursive: true })
  fs.writeFileSync(
    path.join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\nusage: Use ${name} when the task is about ${tags.split(',')[0]}.\ntags: ${tags}\n---\n\n${body}\n`,
  )
}
mkSkill(BUILTIN, 'fake-web', 'Build a web application end to end.', 'web, frontend')
mkSkill(BUILTIN, 'fake-bot', 'Wire up a chat bot with commands.', 'bot, discord, telegram')
mkSkill(BUILTIN, 'fake-cli', 'Scaffold a command-line parser.', 'cli, terminal', `# fake-cli\n\nA full parser playbook. ` + 'step. '.repeat(900))
mkSkill(BUILTIN, 'fake-api', 'Design a REST API server with tests.', 'backend, api, test')
mkSkill(BUILTIN, 'fake-review', 'Review code for correctness.', 'review, quality')
mkSkill(BUILTIN, 'fake-bug', 'Hunt down and fix a bug.', 'debug, bug')
process.env.TAGENT_SKILLS_DIR = BUILTIN

const { listSkills, loadSkill, searchSkillsTool, loadSkillTool, skillState, sessionAutoSkills, recordManualSkillLoad, unloadSessionSkill, disableSessionSkillRouting, clearSkillState } =
  await import('../packages/core/src/skills')
const { routeSkills, maybeAutoRouteSkills, rerunSkillRouter, capAutoBody } = await import('../packages/core/src/skill-router')
const { isReadOnlyTool } = await import('../packages/core/src/loop')
const { buildToolset, ALL_TOOLS, TEST_MODE_TOOLS } = await import('../packages/core/src/tools')
const { buildSystemPrompt, renderAutoLoadedSkillsBlock } = await import('../packages/core/src/system-prompt')
const { loadConfig } = await import('../packages/core/src/config')

const CFG = loadConfig('/nonexistent-root') // defaults: autoRoute true, max 3, threshold 0.5
function ctx(root: string, sessionId = 'test-sess') {
  return { workspaceRoot: root, sessionId, depth: 0, config: CFG, events: {}, todos: [] } as never
}
function freshRoot(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tagent-sr-${name}-`))
  fs.mkdirSync(path.join(root, '.tagent', 'skills'), { recursive: true })
  return root
}

console.log('1) tool registration & mode gating (A, F):')
ok(ALL_TOOLS.some((t) => t.name === 'search_skills'), 'search_skills is in ALL_TOOLS')
ok(ALL_TOOLS.findIndex((t) => t.name === 'search_skills') < ALL_TOOLS.findIndex((t) => t.name === 'load_skill'), 'listed before load_skill')
ok(TEST_MODE_TOOLS.has('search_skills'), 'search_skills in TEST_MODE_TOOLS')
ok(isReadOnlyTool('search_skills'), 'isReadOnlyTool(search_skills) — plan-mode gate passes')
for (const mode of ['build', 'plan', 'test'] as const) {
  ok(buildToolset({ mode, config: CFG }).some((t) => t.name === 'search_skills'), `${mode} mode toolset includes search_skills`)
}
ok(buildToolset({ readOnly: true }).some((t) => t.name === 'search_skills'), 'explore subagents (readOnly) get search_skills')

console.log('2) search_skills output shape (A):')
{
  const root = freshRoot('search')
  const raw = await searchSkillsTool.run({}, ctx(root))
  const out = JSON.parse(raw)
  ok(Array.isArray(out.skills) && out.skills.length === 6, `skills array (${out.skills?.length})`)
  ok(out.total === 6 && out.shown === 6 && out.truncated === false, 'total/shown/truncated correct')
  ok(typeof out.hint === 'string' && out.hint.includes('load_skill'), 'hint points at load_skill')
  const s = out.skills[0]
  ok(typeof s.name === 'string' && typeof s.description === 'string' && Array.isArray(s.tags), 'entry shape: name/description/tags')
  ok(typeof s.usage === 'string' && s.usage.length > 0, 'usage metadata present (from frontmatter)')
}

console.log('3) query / tags / limit filters (B, C, D):')
{
  const root = freshRoot('filter')
  const q = JSON.parse(await searchSkillsTool.run({ query: 'WEB' }, ctx(root)))
  ok(q.total >= 1 && q.skills.every((s: { name: string; description: string; tags?: string[] }) => /web|frontend/i.test(s.name + s.description) || (s.tags ?? []).some((t: string) => /web/.test(t))), 'query "WEB" (case-insensitive) matches web skills')
  ok(q.total < 6, 'query filters (subset of all)')
  const t = JSON.parse(await searchSkillsTool.run({ tags: ['bot'] }, ctx(root)))
  ok(t.skills.every((s: { tags?: string[] }) => (s.tags ?? []).includes('bot')), 'tags [bot] only bot skills')
  const t2 = JSON.parse(await searchSkillsTool.run({ tags: ['bot', 'discord'] }, ctx(root)))
  ok(t2.skills.every((s: { tags?: string[] }) => ['bot', 'discord'].every((x) => (s.tags ?? []).includes(x))), 'tags are AND-ed')
  const l = JSON.parse(await searchSkillsTool.run({ limit: 1 }, ctx(root)))
  ok(l.shown === 1 && l.total === 6 && l.truncated === true, 'limit 1 → shown 1, truncated true')
}

console.log('4) two-stage flow: search → load (E, H):')
{
  const root = freshRoot('two-stage')
  const found = JSON.parse(await searchSkillsTool.run({ query: 'command-line' }, ctx(root)))
  ok(found.total === 1 && found.skills[0].name === 'fake-cli', 'search finds fake-cli')
  const searchOne = await searchSkillsTool.run({ query: 'command-line' }, ctx(root))
  const body = await loadSkillTool.run({ name: found.skills[0].name }, ctx(root))
  ok(body.includes('# fake-cli') && !body.startsWith('Error:'), 'load_skill(fake-cli) returns the body')
  ok(searchOne.length < body.length / 2, `H: token economy — search metadata (${searchOne.length}B) ≪ one load (${body.length}B)`)
  const manual = JSON.parse(JSON.stringify(skillState('test-sess').manual))
  ok(manual.includes('fake-cli'), 'manual load recorded in the session registry')
  const bad = await loadSkillTool.run({ name: 'nope' }, ctx(root))
  ok(bad.startsWith('Error:'), 'unknown skill → error string, not a crash')
}

console.log('5) mtime cache (G):')
{
  const root = freshRoot('cache')
  listSkills(root) // warm
  let t0 = performance.now()
  listSkills(root)
  const warmMs = performance.now() - t0
  ok(warmMs < 50, `cached listSkills < 50ms (${warmMs.toFixed(2)}ms)`)
  t0 = performance.now()
  await searchSkillsTool.run({}, ctx(root))
  ok(performance.now() - t0 < 50, `cached search_skills < 50ms (${(performance.now() - t0).toFixed(2)}ms)`)
  // invalidate: a new skill appears only after the mtime moves
  // (sleep BEFORE the write — on coarse-mtime filesystems a write in the
  // same millisecond as the warm scan is invisible to mtime comparison)
  await new Promise((r) => setTimeout(r, 10))
  mkSkill(path.join(root, '.tagent', 'skills'), 'late-skill', 'Appeared after the first scan.', 'web')
  ok(listSkills(root).some((s) => s.name === 'late-skill'), 'touching the skills dir invalidates the cache')
}

console.log('6) router — rule scenarios (J, K, L):')
{
  // J: web — package.json with next
  const webRoot = freshRoot('web')
  fs.writeFileSync(path.join(webRoot, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { next: '^14.2.0' } }))
  const routed = routeSkills({ userMessage: 'bikin blog Next.js', workspaceRoot: webRoot })
  ok(routed.length >= 1 && routed.some((r) => r.name === 'fake-web'), 'J: next dep + "bikin blog" → fake-web')
  const web = routed.find((r) => r.name === 'fake-web')!
  ok(web.matchScore === 0.9 && web.matchSource === 'rule' && web.matchReason.includes('rule:next-detected'), `J: score 0.9 rule reason (${web.matchReason})`)

  // K: bot — discord.js dep
  const botRoot = freshRoot('bot')
  fs.writeFileSync(path.join(botRoot, 'package.json'), JSON.stringify({ dependencies: { 'discord.js': '^14' } }))
  const bots = routeSkills({ userMessage: 'tambah command /ping', workspaceRoot: botRoot })
  ok(bots.some((r) => r.name === 'fake-bot'), 'K: discord.js dep + bot task → fake-bot')
  ok(bots.find((r) => r.name === 'fake-bot')!.matchReason.includes('rule:discord.js-detected'), 'K: rule reason names discord.js')

  // L: CLI — plain TypeScript workspace
  const cliRoot = freshRoot('cli')
  fs.writeFileSync(path.join(cliRoot, 'tsconfig.json'), '{}')
  const clis = routeSkills({ userMessage: 'bikin CLI parser', workspaceRoot: cliRoot })
  ok(clis.some((r) => r.name === 'fake-cli'), 'L: tsconfig + "bikin CLI parser" → fake-cli')

  // fallback: no match → []
  const plainRoot = freshRoot('plain')
  ok(routeSkills({ userMessage: 'write a haiku about rust borrow checker', workspaceRoot: plainRoot }).length === 0, 'no signals + no keywords → [] (no speculation)')
}

console.log('7) router — keyword scoring + threshold/max:')
{
  const root = freshRoot('kw')
  const one = routeSkills({ userMessage: 'tulis blog pribadi', workspaceRoot: root })
  ok(one.some((r) => r.name === 'fake-web' && r.matchScore === 0.5), 'single keyword hit → 0.5')
  const two = routeSkills({ userMessage: 'bikin api endpoint lalu test hasilnya', workspaceRoot: root })
  const apiHit = two.find((r) => r.name === 'fake-api')
  ok(!!apiHit && apiHit.matchScore! >= 0.6 && apiHit.matchReason.startsWith('keyword:'), `two keyword groups → 0.6+ (${apiHit?.matchScore} ${apiHit?.matchReason})`)
  const capped = routeSkills({ userMessage: 'blog api test review bug deploy api api', workspaceRoot: root })
  ok(capped.every((r) => r.matchScore <= 0.7), 'keyword score capped at 0.7')
  ok(capped.length <= 3, `max 3 by default (${capped.length})`)
  const strict = routeSkills({ userMessage: 'tulis blog pribadi', workspaceRoot: root }, { threshold: 0.6 })
  ok(!strict.some((r) => r.name === 'fake-web'), 'threshold 0.6 filters the 0.5 hit')
  const sorted = routeSkills({ userMessage: 'blog api', workspaceRoot: root })
  ok(sorted.every((r, i) => i === 0 || sorted[i - 1].matchScore! >= r.matchScore!), 'sorted by score desc')
}

console.log('8) maybeAutoRouteSkills — config gate + notice + worklog (M, Q):')
{
  const root = freshRoot('auto')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { next: '^14' } }))
  fs.writeFileSync(path.join(root, 'WORKLOG.md'), '# Worklog\n')
  const sid = 'auto-m'
  const note = maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root, userText: 'bikin blog Next.js', priorUserMessages: [], config: CFG })
  ok(note !== null && note.includes('🎯 Auto-loaded skills: fake-web'), 'Q: 🎯 notice rendered')
  ok(note!.includes('rule:next-detected'), 'Q: notice carries the match reason')
  const auto = sessionAutoSkills(sid)
  ok(auto.length === 1 && auto[0].name === 'fake-web' && auto[0].body.includes('# fake-web'), 'body loaded into the session registry')
  ok(auto[0].body.length <= 8_200, `auto body capped ~8k (${auto[0].body.length})`)
  const wl = fs.readFileSync(path.join(root, 'WORKLOG.md'), 'utf8')
  ok(wl.includes('[auto-router] Auto-loaded: fake-web (score 0.9,'), 'Q: WORKLOG.md has the [auto-router] entry')

  // M: config disable
  const offRoot = freshRoot('off')
  fs.writeFileSync(path.join(offRoot, 'package.json'), JSON.stringify({ dependencies: { next: '^14' } }))
  const off = maybeAutoRouteSkills({ sessionId: 'auto-off', workspaceRoot: offRoot, userText: 'bikin blog', priorUserMessages: [], config: { ...CFG, skills: { autoRoute: false, autoRouteMax: 3, autoRouteThreshold: 0.5 } } })
  ok(off === null, 'M: skills.autoRoute=false → no auto-load, no notice')
}

console.log('9) topic shift — 1 re-route per session (S):')
{
  const root = freshRoot('shift')
  fs.writeFileSync(path.join(root, 'WORKLOG.md'), '# Worklog\n')
  const sid = 'auto-shift'
  const n1 = maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root, userText: 'bikin blog pribadi yang keren', priorUserMessages: [], config: CFG })
  ok(n1 !== null && n1.includes('fake-web'), 'session start routes (fake-web)')
  // same topic continues → no second route
  const n2 = maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root, userText: 'blog-nya kasih dark mode juga', priorUserMessages: ['bikin blog pribadi yang keren'], config: CFG })
  ok(n2 === null, 'same-topic follow-up → no re-route')
  // topic shift → 1 re-route (fake-cli via keywords)
  const n3 = maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root, userText: 'sekarang bikin CLI tool untuk parse log', priorUserMessages: ['bikin blog pribadi yang keren', 'blog-nya kasih dark mode juga'], config: CFG })
  ok(n3 !== null && n3.includes('fake-cli'), 'topic shift → re-route loads fake-cli')
  // old skills stay
  ok(sessionAutoSkills(sid).some((s) => s.name === 'fake-web'), 'S: old auto-loaded skill stays in context')
  // budget spent → no more re-routes
  const n4 = maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root, userText: 'dan sekarang design api endpoint-nya', priorUserMessages: ['bikin blog', 'cli tool parse log'], config: CFG })
  ok(n4 === null, 're-route budget is 1 per session')
}

console.log('10) slash-command logic (N, O, P):')
{
  const root = freshRoot('slash')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { next: '^14' } }))
  fs.writeFileSync(path.join(root, 'WORKLOG.md'), '# Worklog\n')
  const sid = 'auto-slash'
  maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root, userText: 'bikin blog', priorUserMessages: [], config: CFG })
  recordManualSkillLoad(sid, 'fake-review')

  // P: /unload-skill
  ok(unloadSessionSkill(sid, 'fake-web') === true, 'P: unload fake-web → true')
  ok(!sessionAutoSkills(sid).some((s) => s.name === 'fake-web'), 'P: gone from the loaded list')
  ok(unloadSessionSkill(sid, 'fake-review') === true, 'P: unload a manual load too')
  ok(unloadSessionSkill(sid, 'fake-web') === false, 'P: unloading twice → false')

  // N: /no-auto-skill
  disableSessionSkillRouting(sid)
  const n = maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root, userText: 'totally different api endpoint task now', priorUserMessages: [], config: CFG })
  ok(n === null, 'N: disabled session → no auto-load even on a fresh topic')

  // O: /reload-skills re-runs anyway (manual action)
  const r = rerunSkillRouter({ sessionId: sid, workspaceRoot: root, userText: 'bikin blog', config: CFG })
  ok(r !== null && r.includes('fake-web'), 'O: reload-skills re-runs the router despite /no-auto-skill')
  ok(sessionAutoSkills(sid).some((s) => s.name === 'fake-web'), 'O: skill back in context')
  clearSkillState(sid)
}

console.log('11) system prompt rendering (B6):')
{
  const root = freshRoot('prompt')
  const p = buildSystemPrompt({ workspaceRoot: root, mode: 'build', tools: [] })
  ok(p.includes('### How to use skills — two-stage progressive disclosure'), 'two-stage section present')
  ok(p.includes('FIRST call search_skills'), 'search-first instruction')
  ok(p.includes('### Auto-loaded skills'), 'auto-loaded section present')
  ok(p.includes('(none)'), 'empty auto-loaded renders (none)')
  const sid = 'auto-prompt'
  maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root, userText: 'bikin blog pribadi', priorUserMessages: [], config: CFG })
  const p2 = buildSystemPrompt({ workspaceRoot: root, mode: 'build', tools: [], autoSkills: sessionAutoSkills(sid) })
  ok(p2.includes('- fake-web [auto, score 0.5, keyword:blog]:'), 'auto-loaded list line rendered')
  ok(p2.includes('#### Skill: fake-web'), 'auto-loaded BODY rendered in the prompt')
  ok(renderAutoLoadedSkillsBlock([]) === '(none)', 'renderAutoLoadedSkillsBlock([]) = (none)')
}

console.log('12) capAutoBody + perf (R):')
{
  const long = `para one.\n\n${'word '.repeat(3_000)}`
  const capped = capAutoBody(long)
  ok(capped.length <= 8_200 && capped.includes('auto-loaded as an excerpt'), `cap at paragraph boundary (${capped.length} chars)`)
  ok(capAutoBody('short') === 'short', 'short body untouched')

  // 50 skills, router must stay <100ms
  const perfRoot = freshRoot('perf')
  const skillsDir = path.join(perfRoot, '.tagent', 'skills')
  for (let i = 0; i < 50; i++) mkSkill(skillsDir, `perf-skill-${String(i).padStart(2, '0')}`, `Filler ${i} for performance checks.`, 'filler')
  fs.writeFileSync(path.join(perfRoot, 'package.json'), JSON.stringify({ dependencies: { next: '^14' } }))
  listSkills(perfRoot) // warm the cache — the router only pays for matching
  const t0 = performance.now()
  for (let i = 0; i < 10; i++) routeSkills({ userMessage: 'bikin blog dengan dark mode', workspaceRoot: perfRoot })
  const perCall = (performance.now() - t0) / 10
  ok(perCall < 100, `routeSkills over 50+ skills < 100ms (${perCall.toFixed(2)}ms)`)
}

console.log('13) end-to-end through the real AgentLoop:')
{
  const { AgentLoop, PermissionManager, defaultConfig } = await import('../packages/core/src/index')
  const root = freshRoot('e2e')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { next: '^14' } }))
  fs.writeFileSync(path.join(root, 'WORKLOG.md'), '# Worklog\n')
  const cfg = defaultConfig()
  const notices: string[] = []
  const wireCalls: { messages: { role: string; content: string }[] }[] = []
  let turn = 0
  const fake = {
    id: 'zai', label: 'fake', supportsNativeTools: false, models: [],
    complete: async () => '',
    completeStream: async (_req: never) => {
      turn++
      wireCalls.push({ messages: _req.messages as { role: string; content: string }[] })
      if (turn === 1) {
        // stage 1 of the two-stage flow: search before loading
        return { text: 'looking up skills first.\n```tagent:action\n{"tool": "search_skills", "input": {"query": "web"}}\n```' }
      }
      return { text: 'done — used the auto-loaded playbook.' }
    },
  } as never
  const session = {
    id: 'e2e-1', workspaceId: root, title: 't', model: 'glm-4.7', mode: 'build',
    createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, messages: [], todos: [],
  }
  const loop = new AgentLoop({
    session, provider: fake, model: 'glm-4.7',
    events: { onNotify: (_l: string, m: string) => notices.push(m) },
    permissions: new PermissionManager(cfg), config: cfg, mode: 'build',
  })
  await loop.run('bikin blog Next.js')

  ok(notices.some((n) => n.includes('🎯 Auto-loaded skills: fake-web')), 'loop: 🎯 transparency notify fired')
  const sys = wireCalls[0]?.messages?.[0]?.content ?? ''
  ok(sys.includes('### How to use skills — two-stage progressive disclosure'), 'loop: two-stage section in the system prompt')
  ok(sys.includes('#### Skill: fake-web'), 'loop: auto-loaded body rides the system prompt')
  ok(sys.includes('rule:next-detected'), 'loop: match reason in the prompt')
  const toolResult = session.messages.find((m) => m.role === 'user' && m.meta?.toolResults && String(m.content).includes('search_skills'))
  ok(!!toolResult, 'loop: search_skills action executed through the gate')
  ok(String(toolResult?.content).includes('"skills"') && String(toolResult?.content).includes('fake-web'), 'loop: search returned JSON with fake-web')
  const wl = fs.readFileSync(path.join(root, 'WORKLOG.md'), 'utf8')
  ok(wl.includes('[auto-router] Auto-loaded: fake-web'), 'loop: WORKLOG.md journaled the auto-load')
}

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILURES'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
