#!/usr/bin/env bun
/**
 * audit-v030-edge.ts — INDEPENDENT AUDIT of v0.30.0 edge cases (Part 2).
 * Skeptic mode: probe for leaks, not to confirm the happy path.
 *
 * Run: bun scripts/audit-v030-edge.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let pass = 0, fail = 0, info = 0
function ok(cond: boolean, label: string, extra = ''): void {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`) }
}
function note(label: string, val: string): void {
  info++; console.log(`  ·    ${label}: ${val}`)
}
function finding(label: string, detail: string): void {
  console.log(`  🔎   ${label}: ${detail}`)
}

/* ---- fixture: builtin skills dir (shared) ---- */
const BUILTIN = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-skills-'))
function mkSkill(dir: string, name: string, description: string, tags: string, bodySize = 400): void {
  fs.mkdirSync(path.join(dir, name), { recursive: true })
  const body = `# ${name}\n\n${name} playbook. ` + 'x'.repeat(bodySize)
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\nusage: Use ${name} when relevant.\ntags: ${tags}\n---\n\n${body}\n`)
}
mkSkill(BUILTIN, 'fake-web-a', 'Build a web application end to end.', 'web, frontend')
mkSkill(BUILTIN, 'fake-web-b', 'Web app builder number two.', 'web, frontend')
mkSkill(BUILTIN, 'fake-web-c', 'Web app builder number three.', 'web, frontend')
mkSkill(BUILTIN, 'fake-bot-a', 'Wire up a chat bot with commands.', 'bot, discord')
mkSkill(BUILTIN, 'fake-bot-b', 'Second chat bot skill.', 'bot, discord')
mkSkill(BUILTIN, 'fake-bot-c', 'Third chat bot skill.', 'bot, discord')
mkSkill(BUILTIN, 'fake-bug', 'Hunt down and fix a bug.', 'debug, bug')
mkSkill(BUILTIN, 'fake-qa', 'Test and verify things.', 'test, qa')
mkSkill(BUILTIN, 'fake-devops', 'Deploy and run pipelines.', 'devops, docker')
mkSkill(BUILTIN, 'fake-doc', 'Write PDF documents.', 'document, pdf')
process.env.TAGENT_SKILLS_DIR = BUILTIN

const { listSkills, loadSkill, searchSkillsTool, skillState, sessionAutoSkills, recordManualSkillLoad,
  unloadSessionSkill, clearSkillState } = await import('../packages/core/src/skills')
const { routeSkills, maybeAutoRouteSkills, rerunSkillRouter, capAutoBody } = await import('../packages/core/src/skill-router')
const { renderAutoLoadedSkillsBlock } = await import('../packages/core/src/system-prompt')
const { PermissionManager, defaultConfig } = await import('../packages/core/src/index')

const CFG = defaultConfig()
function freshRoot(name: string, pkgDeps?: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `audit-${name}-`))
  fs.mkdirSync(path.join(root, '.tagent', 'skills'), { recursive: true })
  if (pkgDeps) fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: pkgDeps }))
  return root
}
function ctx(root: string, sid = 'audit-sess') {
  return { workspaceRoot: root, sessionId: sid, depth: 0, config: CFG, events: {}, todos: [] } as never
}

/* ================================================================ */
console.log('\n== 2.1 TOKEN BLOW — is there a TOTAL cap across skills? ==')
{
  // 3 web + 3 bot skills, each with a body well past the 8k cap
  for (const n of ['big-web-a', 'big-web-b', 'big-web-c']) mkSkill(BUILTIN, n, 'Big web skill ' + n, 'web, frontend', 9_000)
  for (const n of ['big-bot-a', 'big-bot-b', 'big-bot-c']) mkSkill(BUILTIN, n, 'Big bot skill ' + n, 'bot, discord', 9_000)
  const root = freshRoot('token', { next: '^14' })
  fs.writeFileSync(path.join(root, 'WORKLOG.md'), '# Worklog\n')
  const sid = 'tok-1'
  const n1 = maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root, userText: 'bikin blog Next.js', priorUserMessages: [], config: CFG })
  note('initial route notice', n1 ? n1.split('\n')[0] : '(null)')
  const firstCount = sessionAutoSkills(sid).length
  const firstChars = sessionAutoSkills(sid).reduce((a, s) => a + s.body.length, 0)
  note('skills after initial route', `${firstCount} (${firstChars} body chars)`)
  // topic shift → re-route (budget 1) loads 3 MORE skills
  const n2 = maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root, userText: 'sekarang bikin discord bot untuk server', priorUserMessages: ['bikin blog Next.js'], config: CFG })
  const all = sessionAutoSkills(sid)
  const totalChars = all.reduce((a, s) => a + s.body.length, 0)
  const rendered = renderAutoLoadedSkillsBlock(all)
  note('re-route notice', n2 ? n2.split('\n')[0] : '(null)')
  note('TOTAL skills in context', `${all.length}`)
  note('TOTAL body chars', `${totalChars}`)
  note('rendered block chars', `${rendered.length}`)
  note('approx tokens (chars/4)', `${Math.round(totalChars / 4)} for bodies, ${Math.round(rendered.length / 4)} rendered`)
  ok(all.length === 6, 'session accumulated 6 auto skills (3 initial + 3 re-route)')
  ok(totalChars > 40_000, `NO TOTAL CAP — 6 bodies × ~8k = ${totalChars} chars ≈ ${Math.round(totalChars / 4)} tokens ride the system prompt EVERY turn`)
  finding('2.1', `per-skill cap exists (8k) but NO aggregate cap; worst case grows with re-route + manual loads`)
  // cleanup big fixtures so later sections see the 10-skill set
  for (const n of ['big-web-a', 'big-web-b', 'big-web-c', 'big-bot-a', 'big-bot-b', 'big-bot-c'])
    fs.rmSync(path.join(BUILTIN, n), { recursive: true, force: true })
  await new Promise((r) => setTimeout(r, 15))
  listSkills(root)
  clearSkillState(sid)
}

/* ================================================================ */
console.log('\n== 2.2 TOPIC-SHIFT FALSE POSITIVES ==')
{
  // Test A: short same-task follow-up "fix itu" after "bikin web blog"
  const root = freshRoot('shiftA')
  fs.writeFileSync(path.join(root, 'WORKLOG.md'), '# Worklog\n')
  const sid = 'shift-a'
  maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root, userText: 'bikin web blog', priorUserMessages: [], config: CFG })
  note('after initial', sessionAutoSkills(sid).map((s) => s.name).join(', '))
  const nA = maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root, userText: 'fix itu', priorUserMessages: ['bikin web blog'], config: CFG })
  note('follow-up "fix itu" notice', nA ? nA.split('\n')[0] : '(null)')
  const afterA = sessionAutoSkills(sid).map((s) => s.name)
  ok(nA !== null, 'A: "fix itu" WAS treated as a topic shift (re-route fired)')
  ok(afterA.includes('fake-bug'), `A: FALSE POSITIVE — "fix itu" auto-loaded the bug skill: [${afterA.join(', ')}]`)
  finding('2.2A', 'short anaphoric follow-ups (fix itu / lanjutin / test ya) look like topic shifts; keyword "fix" pulls in the bug skill and burns the 1 re-route budget')

  // Test B: real topic shift
  const rootB = freshRoot('shiftB')
  fs.writeFileSync(path.join(rootB, 'WORKLOG.md'), '# Worklog\n')
  const sidB = 'shift-b'
  maybeAutoRouteSkills({ sessionId: sidB, workspaceRoot: rootB, userText: 'bikin web blog', priorUserMessages: [], config: CFG })
  const nB = maybeAutoRouteSkills({ sessionId: sidB, workspaceRoot: rootB, userText: 'sekarang bikin CLI parser untuk log', priorUserMessages: ['bikin web blog'], config: CFG })
  // no cli skill in fixture... but keyword cli → tags ['cli'] — none tagged cli → nothing loads, budget NOT burned
  note('B: shift to CLI notice', nB ? nB.split('\n')[0] : '(null — no cli-tagged skill in fixture)')
  ok(nB === null, 'B: real shift detected but no cli skill installed → no load (budget preserved)')

  // Test C: "bikin website" → "bikin webapp" (same domain, different words)
  const rootC = freshRoot('shiftC')
  fs.writeFileSync(path.join(rootC, 'WORKLOG.md'), '# Worklog\n')
  const sidC = 'shift-c'
  maybeAutoRouteSkills({ sessionId: sidC, workspaceRoot: rootC, userText: 'bikin website untuk toko', priorUserMessages: [], config: CFG })
  const nC = maybeAutoRouteSkills({ sessionId: sidC, workspaceRoot: rootC, userText: 'lanjut bikin webapp-nya', priorUserMessages: ['bikin website untuk toko'], config: CFG })
  note('C: "bikin webapp" notice', nC ? nC.split('\n')[0] : '(null)')
  // shift detected but web skills already loaded → filtered → no burn
  ok(nC === null, 'C: shift detected but all matched skills already in context → no duplicate load, no budget burn')
  finding('2.2C', 'token-overlap misses word variants (website vs webapp) — detected as shift; harmless here only because the same skills match')
  clearSkillState(sid); clearSkillState(sidB); clearSkillState(sidC)
}

/* ================================================================ */
console.log('\n== 2.3 CACHE INVALIDATION ==')
{
  const root = freshRoot('cache')
  const ws = path.join(root, '.tagent', 'skills')
  const before = listSkills(root).length
  note('initial skill count', `${before}`)
  // (a) NEW skill in a NEW subdir → invalidate?
  await new Promise((r) => setTimeout(r, 15))
  mkSkill(ws, 'new-skill', 'Appeared after first scan.', 'web')
  const afterAdd = listSkills(root).some((s) => s.name === 'new-skill')
  ok(afterAdd, 'adding a new skill dir invalidates the cache (seen without restart)')

  // (b) deterministic same-mtime repro: edit SKILL.md, then set its mtime BACK
  // to the value the cache already recorded → cache misses the edit
  const md = path.join(ws, 'new-skill', 'SKILL.md')
  const statBefore = fs.statSync(md)
  const cachedCount = listSkills(root).length
  note('count before backdated edit', `${cachedCount}`)
  fs.writeFileSync(md, fs.readFileSync(md, 'utf8').replace('Appeared after first scan.', 'EDITED description here'))
  fs.utimesSync(md, statBefore.atime, statBefore.mtime) // force mtime equal to cached
  const seen = listSkills(root).find((s) => s.name === 'new-skill')?.description
  ok(seen === 'Appeared after first scan.', `backdated edit INVISIBLE to cache (stale until next real change) — saw "${seen}"`)
  finding('2.3', 'mtime-only invalidation: any edit that does not advance mtime (same-ms write, utimes restore, clock skew) serves stale metadata; /reload-skills does NOT bust the cache either')

  // (c) DELETE a skill → gone?
  await new Promise((r) => setTimeout(r, 15))
  fs.rmSync(path.join(ws, 'new-skill'), { recursive: true, force: true })
  const gone = !listSkills(root).some((s) => s.name === 'new-skill')
  ok(gone, 'deleting a skill dir invalidates the cache (gone from list)')
}

/* ================================================================ */
console.log('\n== 2.4 CONFIG KNOBS ==')
{
  // autoRoute:false — no routing at all
  const root = freshRoot('cfg1', { next: '^14' })
  fs.writeFileSync(path.join(root, 'WORKLOG.md'), '# Worklog\n')
  const cfgOff = { ...CFG, skills: { autoRoute: false, autoRouteMax: 3, autoRouteThreshold: 0.5 } }
  const sid = 'cfg-1'
  const n1 = maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root, userText: 'bikin blog', priorUserMessages: [], config: cfgOff })
  ok(n1 === null && sessionAutoSkills(sid).length === 0, 'autoRoute:false → nothing loads, no notice')

  // BUT /reload-skills (rerunSkillRouter) ignores autoRoute:false:
  const r1 = rerunSkillRouter({ sessionId: sid, workspaceRoot: root, userText: 'bikin blog', config: cfgOff })
  note('/reload-skills under autoRoute:false', r1 ? r1.split('\n')[0] : '(null)')
  ok(r1 !== null, 'rerunSkillRouter BYPASSES config autoRoute:false — manual override (intended? asymmetric)')

  // pre-loaded skills survive a mid-session config flip to autoRoute:false
  const sid2 = 'cfg-2'
  maybeAutoRouteSkills({ sessionId: sid2, workspaceRoot: root, userText: 'bikin blog', priorUserMessages: [], config: CFG })
  const held = sessionAutoSkills(sid2).length
  maybeAutoRouteSkills({ sessionId: sid2, workspaceRoot: root, userText: 'bikin blog lagi', priorUserMessages: ['bikin blog'], config: cfgOff })
  ok(held >= 1 && sessionAutoSkills(sid2).length === held, `already-loaded skills STAY in context after autoRoute flips off (${held} kept)`)

  // autoRouteMax: 1
  const cfgMax1 = { ...CFG, skills: { autoRoute: true, autoRouteMax: 1, autoRouteThreshold: 0.5 } }
  const sid3 = 'cfg-3'
  maybeAutoRouteSkills({ sessionId: sid3, workspaceRoot: root, userText: 'bikin blog', priorUserMessages: [], config: cfgMax1 })
  note('autoRouteMax=1 loaded', sessionAutoSkills(sid3).map((s) => s.name).join(', ') || '(none)')
  ok(sessionAutoSkills(sid3).length === 1, 'autoRouteMax:1 → exactly 1 skill loads (not 3)')
  clearSkillState(sid); clearSkillState(sid2); clearSkillState(sid3)
}

/* ================================================================ */
console.log('\n== 2.5 SUBAGENT BEHAVIOR (real AgentLoop, depth=1) ==')
{
  const { AgentLoop } = await import('../packages/core/src/index')
  const root = freshRoot('sub', { next: '^14' })
  fs.writeFileSync(path.join(root, 'WORKLOG.md'), '# Worklog\n')
  // parent loads a skill first
  const parentSid = 'sub-parent'
  maybeAutoRouteSkills({ sessionId: parentSid, workspaceRoot: root, userText: 'bikin blog', priorUserMessages: [], config: CFG })
  const parentLoaded = sessionAutoSkills(parentSid).map((s) => s.name)
  note('parent auto-loaded', parentLoaded.join(', '))

  // spawn a subagent loop the way loop.ts does: FRESH uid session, depth=1
  const notices: string[] = []
  const wire: { messages: { role: string; content: string }[] }[] = []
  const fake = {
    id: 'zai', label: 'fake', supportsNativeTools: false, models: [],
    complete: async () => '',
    completeStream: async (_req: never) => {
      wire.push({ messages: _req.messages as { role: string; content: string }[] })
      return { text: 'ok' }
    },
  } as never
  const sub = {
    id: 'sub-fresh-uid', workspaceId: root, title: 'sub', model: 'glm-4.7', mode: 'build',
    createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, messages: [], todos: [],
    parentId: parentSid, subagent: true,
  }
  const subLoop = new AgentLoop({
    session: sub, provider: fake, model: 'glm-4.7',
    events: { onNotify: (_l: string, m: string) => notices.push(m) },
    permissions: new PermissionManager(CFG), config: CFG, mode: 'build', depth: 1,
  })
  await subLoop.run('bikin blog juga')
  const subSys = wire[0]?.messages?.[0]?.content ?? ''
  ok(!notices.some((n) => n.includes('Auto-loaded')), 'subagent: no 🎯 auto-load notice (router skipped, depth=1)')
  ok(!subSys.includes('#### Skill: fake-web-a'), 'subagent: does NOT inherit parent auto-loaded bodies')
  ok(sessionAutoSkills('sub-fresh-uid').length === 0, 'subagent: no skills of its own (fresh session id)')
  ok(subSys.includes('search_skills') || subSys.includes('## Skills'), 'subagent: still sees skill METADATA + search_skills (can load on demand)')
  note('subagent ## Skills section', 'metadata only — bodies absent')
  finding('2.5', 'subagent = lean (no bodies, no routing) but CAN search/load manually; parent skills do not leak down')
}

/* ================================================================ */
console.log('\n== 2.6 PERMISSION GATE ==')
{
  // (a) deny search_skills via config
  const cfgDeny = JSON.parse(JSON.stringify(CFG))
  cfgDeny.permissions.tools.search_skills = 'deny'
  const pm = new PermissionManager(cfgDeny)
  const d = await pm.gate('search_skills', {}, ctx(freshRoot('perm')), 'low')
  note('gate(search_skills) under deny rule', `approved=${d.approved}`)
  ok(d.approved === false, 'config deny → gate returns approved:false')
  // what the MODEL sees on denial (loop.ts:500 hardcodes this string):
  note('denial text fed to the model', '"Permission denied by the user. Do not retry this exact action; ask the user how to proceed or continue with what you can."')
  finding('2.6a', 'denial message says "denied by the user" even when a CONFIG rule denied it — misleading; does not name the rule (permissions.tools.search_skills)')

  // (b) auto-router vs permissions: router calls loadSkill() directly,
  // load_skill permission is NOT consulted
  const cfgDenyLoad = JSON.parse(JSON.stringify(CFG))
  cfgDenyLoad.permissions.tools.load_skill = 'deny'
  const root = freshRoot('perm2', { next: '^14' })
  fs.writeFileSync(path.join(root, 'WORKLOG.md'), '# Worklog\n')
  const sid = 'perm-2'
  const n = maybeAutoRouteSkills({ sessionId: sid, workspaceRoot: root, userText: 'bikin blog', priorUserMessages: [], config: cfgDenyLoad })
  note('router under load_skill:deny', n ? n.split('\n')[0] : '(null)')
  ok(n !== null && sessionAutoSkills(sid).length >= 1, 'router BYPASSES load_skill permission — bodies injected despite deny')
  finding('2.6b', 'auto-router reads SKILL.md via fs directly: permissions.tools.load_skill=deny does not stop it. Audit trail = WORKLOG [auto-router] line + TUI notice only.')
  clearSkillState(sid)
}

/* ================================================================ */
console.log('\n== 2.8 MATCH SCORE CORRECTNESS ==')
{
  const root = freshRoot('score', { next: '^14' })
  // rule 0.9 + keyword corroboration → NOT additive
  const r = routeSkills({ userMessage: 'bikin blog', workspaceRoot: root })
  const web = r.find((s) => s.name === 'fake-web-a')!
  note('next + "bikin blog"', `score=${web.matchScore} reason="${web.matchReason}" source=${web.matchSource}`)
  ok(web.matchScore === 0.9, 'rule+keyword → 0.9 (max, NOT 0.9+0.5 or weighted)')
  ok(web.matchReason === 'rule:next-detected,blog', 'keyword corroboration appended to reason')

  // threshold boundary: exactly 0.5 vs 0.5
  const plain = freshRoot('score2')
  const one = routeSkills({ userMessage: 'tulis blog pribadi', workspaceRoot: plain })
  const blog = one.find((s) => s.name === 'fake-web-a')
  note('keyword-only "blog"', `score=${blog?.matchScore}`)
  ok(blog?.matchScore === 0.5, 'single keyword group → exactly 0.5')
  ok(blog?.matchScore! >= 0.5, 'threshold 0.5 with score 0.5 → LOADS (>= comparison, no off-by-one)')
  const strict = routeSkills({ userMessage: 'tulis blog pribadi', workspaceRoot: plain }, { threshold: 0.5000001 })
  ok(!strict.some((s) => s.name === 'fake-web-a'), 'threshold a hair above 0.5 → filtered (boundary is inclusive)')

  // scoring formula: 0.5 + 0.1*(groups-1), cap 0.7
  const two = routeSkills({ userMessage: 'bikin api endpoint lalu test', workspaceRoot: plain }).find((s) => s.name === 'fake-qa')
  note('"api endpoint ... test" for fake-qa', `score=${two?.matchScore} reason="${two?.matchReason}"`)
  ok(two?.matchScore === 0.6, 'two keyword groups → 0.6')
  finding('2.8', 'formula verified: rule=0.9 fixed; keyword=0.5+0.1×(extra groups) capped 0.7; combined=max(rule,keyword); filter is >= threshold')
}

/* ================================================================ */
console.log('\n== 2.10 FALSE NEGATIVES + KEYWORD SUBSTRING LEAKS ==')
{
  // empty workspace, keyword-only
  const empty = freshRoot('empty')
  const r = routeSkills({ userMessage: 'bikin web blog', workspaceRoot: empty })
  note('empty workspace + "bikin web blog"', r.map((s) => `${s.name}(${s.matchScore})`).join(', '))
  ok(r.length >= 1, 'empty workspace + keyword task → still loads (keyword-based) ✓')

  // Indonesian phrasing with English tech word
  const id1 = routeSkills({ userMessage: 'bikin aplikasi web untuk toko', workspaceRoot: empty })
  note('"bikin aplikasi web"', id1.map((s) => `${s.name}(${s.matchScore})`).join(', '))
  ok(id1.length >= 1, 'Indonesian + "web" → detected')

  // pure Indonesian, no English tech word
  const id2 = routeSkills({ userMessage: 'buat halaman internet untuk warung', workspaceRoot: empty })
  note('"buat halaman internet untuk warung"', id2.map((s) => s.name).join(', ') || '(nothing)')
  ok(id2.length === 0, 'pure Indonesian without English tech words → NOTHING loads (keyword lists are English-only)')

  // substring FALSE POSITIVES: 'ci' inside "service", 'test' inside "latest"
  const svc = routeSkills({ userMessage: 'tolong restart service-nya', workspaceRoot: empty })
  note('"restart service-nya"', svc.map((s) => `${s.name}(${s.matchScore},${s.matchReason})`).join(', '))
  ok(svc.some((s) => s.name === 'fake-devops'), `FALSE POSITIVE: 'ci' substring inside "serviCE" pulls the devops skill`)
  const latest = routeSkills({ userMessage: 'apa kabar latest version', workspaceRoot: empty })
  note('"apa kabar latest version"', latest.map((s) => `${s.name}(${s.matchScore},${s.matchReason})`).join(', '))
  ok(latest.some((s) => s.name === 'fake-qa'), `FALSE POSITIVE: 'test' substring inside "laTEST" pulls the QA skill`)
  finding('2.10', `KEYWORD_GROUPS use unanchored scanText.includes(w): 'ci' and 'test' match inside unrelated words → spurious 0.5 loads in ANY workspace`)
}

/* ================================================================ */
console.log('\n== 2.9 WORKLOG NOISE ==')
{
  const root = freshRoot('noise')
  fs.writeFileSync(path.join(root, 'WORKLOG.md'), '# Worklog\n')
  for (let i = 1; i <= 10; i++) {
    maybeAutoRouteSkills({ sessionId: `noise-${i}`, workspaceRoot: root, userText: `bikin blog pribadi nomor ${i}`, priorUserMessages: [], config: CFG })
    clearSkillState(`noise-${i}`)
  }
  await new Promise((r) => setTimeout(r, 50)) // worklog writes are fire-and-forget (void)
  const wl = fs.readFileSync(path.join(root, 'WORKLOG.md'), 'utf8')
  const entries = wl.split('\n').filter((l) => l.includes('[auto-router]'))
  note('[auto-router] entries after 10 sessions', `${entries.length}`)
  note('WORKLOG.md size', `${wl.length} chars`)
  ok(entries.length >= 10, `10 sessions → ${entries.length} [auto-router] lines — append-only, no rotation/limit`)
  console.log('  sample:', entries[0]?.slice(0, 110))
  finding('2.9', 'unbounded append; no per-agent filter tooling beyond what worklog.ts already offers')
}

/* ================================================================ */
console.log('\n== EXTRA: search_skills input validation ==')
{
  const root = freshRoot('valid')
  const r0 = JSON.parse(await searchSkillsTool.run({ limit: 0 }, ctx(root)))
  note('limit:0', `shown=${r0.shown} (silently defaults to 20, NOT 0)`)
  const rNeg = JSON.parse(await searchSkillsTool.run({ limit: -5 }, ctx(root)))
  note('limit:-5', `shown=${rNeg.shown}`)
  const rStr = JSON.parse(await searchSkillsTool.run({ tags: 'bot' }, ctx(root)))  // string, not array
  note("tags:'bot' (string)", `total=${rStr.total} of ${JSON.parse(await searchSkillsTool.run({}, ctx(root))).total} — filter silently IGNORED`)
  ok(rStr.total === JSON.parse(await searchSkillsTool.run({}, ctx(root))).total, 'tags-as-string is silently dropped (no error, full list returned)')
  finding('extra', 'search_skills: limit<=0 → default 20; non-array tags silently ignored — no validation error surface')
}

console.log(`\n${fail === 0 ? 'ALL PROBES EXECUTED' : 'FAILURES'} — ${pass} passed, ${fail} failed, ${info} notes`)
process.exit(0)
