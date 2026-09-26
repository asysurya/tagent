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
 *
 * v0.30.1 regression (sections 14–19): BUG-1 topic-shift re-route,
 * BUG-3 keyword word-boundary, BUG-2 total token cap
 * (skills.autoRouteMaxTokens), short-follow-up duplicate guard, manual
 * load_skill cap exemption, search_skills word-boundary.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// type-only imports (erased at runtime — no effect on the TAGENT_SKILLS_DIR
// setup or the dynamic imports below); real types for the section-13 fixtures
import type { SessionData } from '../packages/core/src/types'
import type { CompletionRequest, ProviderAdapter } from '../packages/core/src/providers'

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
// v0.30.1 regression fixture (BUG-3): a devops-tagged skill so substring
// false positives ('ci' ⊂ "decide", 'pip' ⊂ "pipelines") are observable
mkSkill(BUILTIN, 'fake-devops', 'Deploy with docker and CI pipelines.', 'devops, docker')
process.env.TAGENT_SKILLS_DIR = BUILTIN

const { listSkills, loadSkill, searchSkillsTool, loadSkillTool, skillState, sessionAutoSkills, recordManualSkillLoad, unloadSessionSkill, disableSessionSkillRouting, clearSkillState } =
  await import('../packages/core/src/skills')
const { routeSkills, maybeAutoRouteSkills, rerunSkillRouter, capAutoBody } = await import('../packages/core/src/skill-router')
const { isReadOnlyTool } = await import('../packages/core/src/loop')
const { buildToolset, ALL_TOOLS, TEST_MODE_TOOLS } = await import('../packages/core/src/tools')
const { buildSystemPrompt, renderAutoLoadedSkillsBlock } = await import('../packages/core/src/system-prompt')
const { loadConfig } = await import('../packages/core/src/config')

const CFG = loadConfig('/nonexistent-root') // defaults: autoRoute true, max 3, threshold 0.5
function ctx(root: string, sessionId = 'test-sess', config = CFG) {
  return { workspaceRoot: root, sessionId, depth: 0, config, events: {}, todos: [] } as never
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
  ok(Array.isArray(out.skills) && out.skills.length === 7, `skills array (${out.skills?.length})`)
  ok(out.total === 7 && out.shown === 7 && out.truncated === false, 'total/shown/truncated correct')
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
  ok(q.total < 7, 'query filters (subset of all)')
  const t = JSON.parse(await searchSkillsTool.run({ tags: ['bot'] }, ctx(root)))
  ok(t.skills.every((s: { tags?: string[] }) => (s.tags ?? []).includes('bot')), 'tags [bot] only bot skills')
  const t2 = JSON.parse(await searchSkillsTool.run({ tags: ['bot', 'discord'] }, ctx(root)))
  ok(t2.skills.every((s: { tags?: string[] }) => ['bot', 'discord'].every((x) => (s.tags ?? []).includes(x))), 'tags are AND-ed')
  const l = JSON.parse(await searchSkillsTool.run({ limit: 1 }, ctx(root)))
  ok(l.shown === 1 && l.total === 7 && l.truncated === true, 'limit 1 → shown 1, truncated true')
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
  const fake: ProviderAdapter = {
    id: 'zai', label: 'fake', supportsNativeTools: false, models: [],
    complete: async () => '',
    completeStream: async (_req: CompletionRequest) => {
      turn++
      wireCalls.push({ messages: _req.messages })
      if (turn === 1) {
        // stage 1 of the two-stage flow: search before loading
        return { text: 'looking up skills first.\n```tagent:action\n{"tool": "search_skills", "input": {"query": "web"}}\n```' }
      }
      return { text: 'done — used the auto-loaded playbook.' }
    },
  }
  const session: SessionData = {
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

console.log('14) BUG-1 regression — topic-shift re-route after v0.30.1:')
{
  // direct: existingLoaded must filter BEFORE the top-max slice
  const root = freshRoot('bug1')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { next: '^14' } }))
  const t1 = routeSkills({ userMessage: 'bikin web blog', workspaceRoot: root })
  ok(t1.some((r) => r.name === 'fake-web'), 'A: task1 "bikin web blog" → fake-web routed')
  const t2 = routeSkills({ userMessage: 'bikin CLI parser', workspaceRoot: root, existingLoaded: ['fake-web'] })
  ok(t2.length > 0, `A: task2 re-route is not a no-op (${t2.map((r) => r.name).join(', ') || '[]'})`)
  ok(t2.some((r) => r.name === 'fake-cli'), 'A: task2 "bikin CLI parser" + existingLoaded [fake-web] → fake-cli')
  ok(!t2.some((r) => r.name === 'fake-web'), 'A: already-loaded fake-web NOT re-routed')

  // stronger e2e — the audit's FINDING X setup: three 0.9 rule hits (next +
  // discord.js + express) fill the top-max slice, then the topic shifts
  const root2 = freshRoot('bug1x')
  fs.writeFileSync(path.join(root2, 'package.json'), JSON.stringify({ dependencies: { next: '^14', 'discord.js': '^14', express: '^4' } }))
  fs.writeFileSync(path.join(root2, 'WORKLOG.md'), '# Worklog\n')
  const sid = 'bug1-e2e'
  const n1 = maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root2, userText: 'bikin web blog', priorUserMessages: [], config: CFG })
  const s1 = sessionAutoSkills(sid)
  ok(s1.length === 3 && s1.every((s) => s.matchScore === 0.9 && !!s.matchReason?.startsWith('rule:')), `A: e2e initial route loads the three 0.9 rule skills (${s1.map((s) => s.name).join(', ')})`)
  ok(n1 !== null && n1.includes('fake-web') && n1.includes('fake-bot') && n1.includes('fake-api'), 'A: e2e initial notice names all three rule skills')
  const n2 = maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root2, userText: 'sekarang bikin CLI parser untuk parse log', priorUserMessages: ['bikin web blog'], config: CFG })
  ok(n2 !== null && n2.includes('fake-cli'), `A: e2e topic shift re-routes — notice includes fake-cli (${n2 === null ? 'null (BUG-1 regression!)' : n2.split('\n')[0]})`)
  const s2 = sessionAutoSkills(sid)
  ok(s2.length === 4 && s2.some((s) => s.name === 'fake-cli'), `A: e2e sessionAutoSkills gains fake-cli (${s2.map((s) => s.name).join(', ')})`)
  ok(s2.filter((s) => s.name === 'fake-web').length === 1, 'A: e2e fake-web still in context exactly once (no duplicate)')
}

console.log('15) BUG-3 regression — keyword word-boundary after v0.30.1:')
{
  const root = freshRoot('bug3') // no package.json → keyword-only workspace
  const a = routeSkills({ userMessage: 'help me decide the color scheme', workspaceRoot: root })
  ok(a.length === 0, `B: "decide the color scheme" → no skill at all — 'ci' ⊂ "decide" must not fire (${a.map((r) => r.name).join(', ') || '(none)'})`)
  ok(!a.some((r) => r.name === 'fake-devops'), 'B: no fake-devops from "decide"')
  const b = routeSkills({ userMessage: 'apa kabar latest version', workspaceRoot: root })
  ok(b.length === 0 && !b.some((r) => r.name === 'fake-api'), `B: "latest version" → no fake-api — 'test' ⊂ "latest" must not fire (${b.map((r) => r.name).join(', ') || '(none)'})`)
  const c = routeSkills({ userMessage: 'bikin CI pipeline', workspaceRoot: root })
  ok(c.some((r) => r.name === 'fake-devops'), `B: "bikin CI pipeline" → fake-devops DOES match (genuine whole-word 'ci') (${c.map((r) => r.name).join(', ')})`)
  const d = routeSkills({ userMessage: 'latest test result', workspaceRoot: root })
  ok(d.some((r) => r.name === 'fake-api'), `B: "latest test result" → fake-api DOES match (genuine whole-word 'test') (${d.map((r) => r.name).join(', ')})`)
}

console.log('16) BUG-2 regression — total token cap after v0.30.1:')
{
  // fixture: 6 skills with ~8k-char bodies (≈2018 tokens each after the 8k cap)
  const root = freshRoot('bug2')
  fs.writeFileSync(path.join(root, 'WORKLOG.md'), '# Worklog\n')
  const capDir = path.join(root, '.tagent', 'skills')
  const capBody = (name: string): string => `# ${name}\n\n${name} playbook. ` + 'lorem ipsum dolor sit amet '.repeat(320)
  mkSkill(capDir, 'cap-w1', 'Web playbook one, plus api.', 'web, frontend, backend, api', capBody('cap-w1'))
  mkSkill(capDir, 'cap-w2', 'Web playbook two.', 'web, frontend', capBody('cap-w2'))
  mkSkill(capDir, 'cap-w3', 'Web playbook three.', 'web, frontend', capBody('cap-w3'))
  mkSkill(capDir, 'cap-c1', 'CLI playbook one.', 'cli, terminal', capBody('cap-c1'))
  mkSkill(capDir, 'cap-c2', 'CLI playbook two.', 'cli, terminal', capBody('cap-c2'))
  mkSkill(capDir, 'cap-c3', 'CLI playbook three.', 'cli, terminal', capBody('cap-c3'))
  const estTokens = (s: string): number => Math.ceil(s.length / 4)
  const truncLines = (logs: string[]): string[] => logs.filter((l) => l.includes('[auto-router] Truncated:'))
  // fires web + api + review groups → cap-w1 0.6 (two tag groups), cap-w2/w3 0.5
  const MSG = 'tulis blog api endpoint untuk review'
  // topic-shift text that fires only the cli group → routes cap-c1..c3 at 0.5
  const SHIFT = 'sekarang bikin command-line tool untuk parse log'

  // (1) default cap (skills.autoRouteMaxTokens = 15000) → all 3 candidates load
  {
    const sid = 'cap-default'
    const logs: string[] = []
    const orig = console.log
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')) }
    let note: string | null = null
    try {
      note = maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root, userText: MSG, priorUserMessages: [], config: CFG })
    } finally { console.log = orig }
    const loaded = sessionAutoSkills(sid)
    const total = loaded.reduce((n, s) => n + estTokens(s.body), 0)
    ok(loaded.length === 3, `C1: default cap 15000 → all 3 candidates load (${loaded.length})`)
    ok(loaded.map((s) => s.name).join(',') === 'cap-w1,cap-w2,cap-w3', `C1: loaded = the top-3 by score (${loaded.map((s) => s.name).join(', ')})`)
    ok(total <= 15_000, `C1: estimated total (chars/4) ≤ 15000 (${total})`)
    ok(truncLines(logs).length === 0, `C1: no truncation under the default cap (${truncLines(logs).length} lines)`)
    ok(note !== null && note.includes('cap-w1'), 'C1: notice rendered under the default cap')
  }

  // (2) low cap (3000) → keep-at-least-1: exactly 1 survivor + 2 truncation logs
  {
    const sid = 'cap-low'
    const lowCfg = { ...CFG, skills: { autoRoute: true, autoRouteMax: 3, autoRouteThreshold: 0.5, autoRouteMaxTokens: 3_000 } }
    const logs: string[] = []
    const orig = console.log
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')) }
    try {
      maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root, userText: MSG, priorUserMessages: [], config: lowCfg })
    } finally { console.log = orig }
    const loaded = sessionAutoSkills(sid)
    const total = loaded.reduce((n, s) => n + estTokens(s.body), 0)
    const tl = truncLines(logs)
    ok(tl.length === 2, `C2: exactly 2 truncation log lines (${tl.length})`)
    ok(tl.every((l) => /^\[auto-router\] Truncated: [\w-]+ \(score 0\.5\) — total cap hit$/.test(l.trim())), `C2: log format "[auto-router] Truncated: <name> (score <score>) — total cap hit" (${tl.join(' | ')})`)
    ok(tl.some((l) => l.includes('cap-w3')) && tl.some((l) => l.includes('cap-w2')), 'C2: truncated = the two lowest-score candidates (cap-w3, cap-w2)')
    ok(loaded.length === 1 && loaded[0].name === 'cap-w1' && loaded[0].matchScore === 0.6, `C2: survivor is the highest-score skill (${loaded.map((s) => `${s.name} (${s.matchScore})`).join(', ')})`)
    ok(total <= 3_000, `C2: surviving total tokens ≤ 3000 (${total})`)
  }

  // (3) accumulation: bodies already in the session count toward the budget
  {
    const sid = 'cap-accum'
    const cfg10k = { ...CFG, skills: { autoRoute: true, autoRouteMax: 3, autoRouteThreshold: 0.5, autoRouteMaxTokens: 10_000 } }
    maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root, userText: MSG, priorUserMessages: [], config: cfg10k }) // 3 skills ≈ 6054 tokens
    ok(sessionAutoSkills(sid).length === 3, `C3: initial route loads 3 skills (${sessionAutoSkills(sid).length})`)
    const logs: string[] = []
    const orig = console.log
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')) }
    let note2: string | null = null
    try {
      note2 = maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root, userText: SHIFT, priorUserMessages: [MSG], config: cfg10k })
    } finally { console.log = orig }
    const finalSkills = sessionAutoSkills(sid)
    const total = finalSkills.reduce((n, s) => n + estTokens(s.body), 0)
    ok(note2 !== null && note2.includes('cap-c1'), `C3: re-route loads only the new skill that fits (${note2 === null ? 'null' : note2.split('\n')[0]})`)
    ok(truncLines(logs).length === 2, `C3: 2 of the 3 new candidates truncated — accumulation counted (${truncLines(logs).length})`)
    ok(finalSkills.length === 4, `C3: session holds the 3 existing + 1 new skill (${finalSkills.length})`)
    ok(total <= 10_000, `C3: final session total ≤ 10000 cap (${total})`)
  }
}

console.log('17) D — short follow-up after the initial route:')
{
  const root = freshRoot('followup')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { next: '^14' } }))
  fs.writeFileSync(path.join(root, 'WORKLOG.md'), '# Worklog\n')
  const sid = 'followup-sess'
  const n1 = maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root, userText: 'bikin web blog', priorUserMessages: [], config: CFG })
  ok(n1 !== null && n1.includes('fake-web'), 'D: initial "bikin web blog" → fake-web loaded once')
  // "fix itu" — 2 tokens, 0 overlap with the prior message. KNOWN OUT-OF-SCOPE
  // behavior (audit finding 2.2A, low, NOT fixed in v0.30.1): it is detected
  // as a topic shift and loads fake-bug. Asserted as-is below — do NOT "fix".
  const n2 = maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root, userText: 'fix itu', priorUserMessages: ['bikin web blog'], config: CFG })
  const skills = sessionAutoSkills(sid)
  ok(new Set(skills.map((s) => s.name)).size === skills.length, `D: no duplicate skill entries in the session (${skills.map((s) => s.name).join(', ')})`)
  ok(skills.filter((s) => s.name === 'fake-web').length === 1, 'D: fake-web exactly once — the re-route never re-loads an existing skill')
  ok(skills.map((s) => s.name).join(',') === 'fake-web,fake-bug' && n2 !== null && n2.includes('fake-bug'), `D: documented — "fix itu" still fires 2.2A and loads fake-bug [out of scope] (${n2 === null ? 'null' : n2.split('\n')[0]})`)
}

console.log('18) E — manual load_skill is NOT capped by the auto-router budget:')
{
  const root = freshRoot('manualcap')
  const lowCfg = { ...CFG, skills: { autoRoute: true, autoRouteMax: 3, autoRouteThreshold: 0.5, autoRouteMaxTokens: 100 } }
  const logs: string[] = []
  const orig = console.log
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')) }
  let body = ''
  try {
    body = await loadSkillTool.run({ name: 'fake-cli' }, ctx(root, 'manual-cap', lowCfg))
  } finally { console.log = orig }
  ok(body.startsWith('# fake-cli') && body.length > 4_000, `E: full fake-cli body returns despite autoRouteMaxTokens 100 (${body.length} chars)`)
  ok(!body.includes('auto-loaded as an excerpt'), 'E: no excerpt marker — manual loads bypass the auto-router cap')
  ok(!logs.some((l) => l.includes('[auto-router] Truncated:')), 'E: no [auto-router] Truncated log involvement')
}

console.log('19) F — search_skills word-boundary (BUG-3 search side):')
{
  const root = freshRoot('wbsearch')
  const pip = JSON.parse(await searchSkillsTool.run({ query: 'pip' }, ctx(root)))
  ok(pip.total === 0, `F: query "pip" (substring of "pipelines") → 0 results (${pip.total})`)
  const pl = JSON.parse(await searchSkillsTool.run({ query: 'pipelines' }, ctx(root)))
  ok(pl.total >= 1 && pl.skills.some((s: { name: string }) => s.name === 'fake-devops'), `F: query "pipelines" → fake-devops found (${pl.total})`)
  const web = JSON.parse(await searchSkillsTool.run({ query: 'WEB' }, ctx(root)))
  ok(web.total >= 1 && web.skills.some((s: { name: string }) => s.name === 'fake-web'), `F: query "WEB" still matches fake-web (${web.total})`)
}

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILURES'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
