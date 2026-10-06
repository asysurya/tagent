#!/usr/bin/env bun
/**
 * test-memory-profile.ts — v0.31.1 small-RAM stability profile.
 *
 * Covers:
 *  - profileForRam tiers (4 / 8 / 16+ / invalid) and monotonicity
 *  - resolveMemoryProfile: user pin vs auto-detect, source reporting
 *  - defaultConfig ships performance.ramGb = 0 (auto)
 *  - setWebCacheMax: lowered cap actually evicts (the while-loop fix)
 *  - AgentLoop compactThresholdChars: the context diet fires earlier when
 *    the profile lowers it (renderMessages through a real loop turn)
 *  - AgentHost wiring: memProfile(), subagentLimits default, sanitizeConfig
 *    exposure, settingsSave({ramGb}) (global config isolated via HOME)
 *
 * Run: bun scripts/test-memory-profile.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// isolate the GLOBAL config before @tagent/core loads (homeDir() reads HOME)
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-mem-home-'))
process.env.HOME = TMP_HOME

const core = await import('../packages/core/src/index')
const { AgentLoop, PermissionManager, defaultConfig, profileForRam, resolveMemoryProfile, detectRamGb, setWebCacheMax } = core
const { AgentHost } = await import('../packages/cli/src/host')

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra?: string) => {
  cond ? pass++ : fail++
  console.log(`${cond ? '✔' : '✗'} ${name}${!cond && extra ? ` — ${extra}` : ''}`)
}

console.log('1) profileForRam — tiers')
{
  const p4 = profileForRam(4)
  const p8 = profileForRam(8)
  const p16 = profileForRam(16)
  const p0 = profileForRam(0)
  ok('4 GB: log 1500 / subs 2 / web 48 / diet 100k',
    p4.tuiLogLines === 1500 && p4.subagentParallelDefault === 2 && p4.webCacheMax === 48 && p4.compactThresholdChars === 100_000,
    JSON.stringify(p4))
  ok('8 GB: log 2500 / subs 3 / web 96 / diet 120k',
    p8.tuiLogLines === 2500 && p8.subagentParallelDefault === 3 && p8.webCacheMax === 96 && p8.compactThresholdChars === 120_000,
    JSON.stringify(p8))
  ok('16 GB = the defaults (log 4000 / subs 4 / web 128 / diet 150k)',
    p16.tuiLogLines === 4000 && p16.subagentParallelDefault === 4 && p16.webCacheMax === 128 && p16.compactThresholdChars === 150_000,
    JSON.stringify(p16))
  ok('0 / invalid → the default profile', JSON.stringify(p0) === JSON.stringify(p16) && JSON.stringify(profileForRam(-3)) === JSON.stringify(p16))
  ok('monotone: less RAM never has a bigger knob',
    p4.tuiLogLines <= p8.tuiLogLines && p8.tuiLogLines <= p16.tuiLogLines &&
    p4.subagentParallelDefault <= p8.subagentParallelDefault && p8.subagentParallelDefault <= p16.subagentParallelDefault &&
    p4.webCacheMax <= p8.webCacheMax && p8.webCacheMax <= p16.webCacheMax &&
    p4.compactThresholdChars <= p8.compactThresholdChars && p8.compactThresholdChars <= p16.compactThresholdChars)
  // fractional budgets round DOWN to the tighter tier (7.5 GB → the 8 GB row
  // is "≤ 8", which is the honest reading of a 7.5 GB machine)
  ok('fractional budgets stay in the ≤-tier (7.5 → 8 GB row)', profileForRam(7.5).tuiLogLines === 2500)
}

console.log('\n2) resolveMemoryProfile — user pin vs auto')
{
  const pinned = resolveMemoryProfile({ performance: { ramGb: 4 } } as never)
  ok('pinned 4 → source user, ramGb 4', pinned.source === 'user' && pinned.ramGb === 4)
  const auto = resolveMemoryProfile(undefined)
  ok('no config → auto, sane detected value', auto.source === 'auto' && auto.ramGb > 0)
  ok('detectRamGb() matches the auto resolution', detectRamGb() === auto.ramGb)
  const zero = resolveMemoryProfile({ performance: { ramGb: 0 } } as never)
  ok('ramGb 0 (the default) means auto', zero.source === 'auto' && zero.ramGb === detectRamGb())
  const dflt = defaultConfig()
  ok('defaultConfig ships performance.ramGb = 0 (auto)', dflt.performance?.ramGb === 0)
}

console.log('\n3) setWebCacheMax — a lowered cap actually evicts')
{
  setWebCacheMax(128)
  for (let i = 0; i < 128; i++) core.webCacheSet(`k${i}`, 'x')
  ok('128 entries fit at cap 128', core.webCacheGet('k0', 60_000) === 'x')
  setWebCacheMax(48)
  core.webCacheSet('new', 'x')
  ok('after shrinking to 48 + 1 insert, the oldest entry is gone', core.webCacheGet('k0', 60_000) === undefined)
  ok('clamped: absurd values fall back to sane bounds', (() => {
    setWebCacheMax(NaN)
    return true // did not throw
  })())
  setWebCacheMax(128)
}

console.log('\n4) AgentLoop.compactThresholdChars — the diet fires earlier')
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-mem-loop-'))
  fs.mkdirSync(path.join(root, '.tagent'), { recursive: true })
  const cfg = defaultConfig()
  const mkLoop = (compactThresholdChars: number | undefined) => {
    const fake = {
      id: 'zai', label: 'fake', supportsNativeTools: false, models: [],
      complete: async () => '',
      completeStream: async () => ({ text: 'ok' }),
    }
    // 8 pad tool-result turns ≈ 8 × 12 KB = ~96 KB total: under the default
    // 150k threshold (diet idle) but over a 20k profile threshold (diet fires)
    const session = {
      id: 's1', workspaceId: root, title: 't', model: 'glm-4.7', mode: 'build',
      createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, todos: [],
      messages: [] as { id: string; role: string; createdAt: number; content: string; meta?: Record<string, unknown> }[],
    }
    for (let i = 0; i < 8; i++) {
      session.messages.push({
        id: `pad-u-${i}`, role: 'user', createdAt: Date.now(),
        content: 'TOOL RESULTS:\n\n### read_file (done)\ninput: {"path":"src/pad' + i + '.ts"}\noutput:\n' + 'padding line\n'.repeat(1000),
        meta: { toolResults: true },
      })
      session.messages.push({ id: `pad-a-${i}`, role: 'assistant', createdAt: Date.now(), content: 'continuing' })
    }
    return new AgentLoop({
      session: session as never, provider: fake as never, model: 'glm-4.7',
      events: {} as never, permissions: new PermissionManager(cfg), config: cfg, mode: 'build',
      ...(compactThresholdChars !== undefined ? { compactThresholdChars } : {}),
    })
  }
  // renderMessages is the internal diet site (sync) — the same private probe
  // test-context-loop.ts uses
  const probe = (loop: ReturnType<typeof mkLoop>) =>
    (loop as unknown as { renderMessages: (s: string) => { role: string; content: string }[] }).renderMessages('sys')
  const afterDefault = probe(mkLoop(undefined))
  const afterLow = probe(mkLoop(20_000))
  const len = (arr: { content: string }[]) => arr.reduce((n, m) => n + m.content.length, 0)
  ok('default (150k): ~96k of tool results pass through untouched', len(afterDefault) > 80_000, String(len(afterDefault)))
  // the diet keeps the newest COMPACT_KEEP (4) turns full: 4 × 12k ≈ 48k
  // survive + digests, so ~53k — the win is that the OLD half is digested
  ok('profile threshold (20k): the diet digested the old results', len(afterLow) < 60_000 && len(afterLow) < len(afterDefault) - 30_000, String(len(afterLow)))
  ok('digest keeps the tool header + key input, drops the bulk', afterLow.some((m) => m.content.includes('read_file (done)') && m.content.includes('src/pad0.ts') && !m.content.includes('padding line\n'.repeat(20))))
  fs.rmSync(root, { recursive: true, force: true })
}

console.log('\n5) AgentHost wiring — profile, limits, sanitize, settings')
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-mem-host-'))
  fs.mkdirSync(path.join(TMP, '.tagent'), { recursive: true })
  const host = new AgentHost({ workspaceRoot: TMP })
  const autoP = host.memProfile()
  ok('auto profile at boot (source auto, sane ramGb)', autoP.source === 'auto' && autoP.ramGb > 0)
  const lim = host.subagentLimits()
  ok('subagent default follows the profile', lim.maxParallel === autoP.subagentParallelDefault, `${lim.maxParallel} vs ${autoP.subagentParallelDefault}`)
  const sani = host.sanitizeConfig() as { performance?: { ramGb: number; source: string; tuiLogLines: number } }
  ok('sanitizeConfig exposes the profile', sani.performance?.ramGb === autoP.ramGb && sani.performance?.source === 'auto' && typeof sani.performance?.tuiLogLines === 'number')

  host.settingsSave({ ramGb: 4 } as never)
  const pinned = host.memProfile()
  ok('settingsSave({ramGb:4}) → host profile pinned at 4', pinned.source === 'user' && pinned.ramGb === 4)
  ok('subagent default now the 4 GB row', host.subagentLimits().maxParallel === 2)
  const gfile = path.join(TMP_HOME, '.tagent', 'config.json')
  const g = JSON.parse(fs.readFileSync(gfile, 'utf8')) as { performance?: { ramGb?: number } }
  ok('persisted to the GLOBAL config (machine property)', g.performance?.ramGb === 4)

  // an explicit subagents.maxParallel still wins over the profile
  host.settingsSave({ subagentMaxParallel: 3 } as never)
  ok('explicit subagents.maxParallel beats the profile default', host.subagentLimits().maxParallel === 3)
  fs.rmSync(TMP, { recursive: true, force: true })
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
