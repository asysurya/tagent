/**
 * Test suite — `tagent uninstall` logic (plan building + removal).
 *
 * Run: bun scripts/test-uninstall.ts
 * Covers (against a FAKE home + FAKE repo — the real uninstall() is NEVER run):
 *   1. fmtBytes / pathSize        — size helpers (du without following symlinks)
 *   2. isTagentRepo / isInside    — repo + path-containment markers
 *   3. collectUninstallTargets    — the plan: global dir, command links
 *                                    (symlink / dead link / launcher copy /
 *                                    foreign file left alone), bun global
 *                                    registration, repo + git dirty count,
 *                                    release binary, workspace offer rules
 *   4. planToString               — enumerated output + find hint
 *   5. removeItem                 — deletions on fakes: symlink target kept,
 *                                    bun package.json edited surgically,
 *                                    chdir-out-of-repo before rm, failures
 *                                    reported instead of thrown (EACCES)
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'

import {
  fmtBytes,
  pathSize,
  isTagentRepo,
  isInside,
  gitDirtyCount,
  collectUninstallTargets,
  planToString,
  removeItem,
  type CollectOptions,
} from '../packages/cli/src/uninstall'

let passed = 0
let failed = 0
function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed++
    console.log(`  ✔ ${name}`)
  } else {
    failed++
    console.log(`  ✘ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

const isRoot = (() => {
  try {
    return process.getuid?.() === 0
  } catch {
    return false
  }
})()

const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0

/* ---------------------------------------------------------------- setup */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-uninstall-'))
const home = path.join(tmp, 'home')
const repo = path.join(tmp, 'repo')
const ws = path.join(tmp, 'ws')
const ws2 = path.join(tmp, 'ws2')
const usrbin = path.join(tmp, 'usrbin')       // stands in for /usr/local/bin
const bin2 = path.join(tmp, 'bin2')           // plain-file launcher copy lives here
const bin3 = path.join(tmp, 'bin3')           // a foreign file named `tagent`
const bindir = path.join(tmp, 'bin')          // holds the fake release binary
const bunGlobal = path.join(home, '.bun', 'install', 'global')
const globalDir = path.join(home, '.tagent')

const LAUNCHER = '#!/usr/bin/env bash\n# Tagent launcher — put this on your PATH and `tagent` just works.\nexec bun x "$@"\n'

for (const d of [home, path.join(home, '.local', 'bin'), usrbin, bin2, bin3, bindir, ws, ws2, bunGlobal]) {
  fs.mkdirSync(d, { recursive: true })
}

// (a) fake global data
fs.mkdirSync(path.join(globalDir, 'agents'), { recursive: true })
fs.mkdirSync(path.join(globalDir, 'gui-cache', 'deadbeef'), { recursive: true })
fs.writeFileSync(path.join(globalDir, 'config.json'), '{"version":1}\n')
fs.writeFileSync(path.join(globalDir, 'credentials.json'), '{}\n')
fs.writeFileSync(path.join(globalDir, 'models.json'), '{}\n')
fs.writeFileSync(path.join(globalDir, 'agents', 'reviewer.md'), '# reviewer\n')
fs.writeFileSync(path.join(globalDir, 'gui-cache', 'deadbeef', 'index.html'), '<html></html>')
fs.writeFileSync(path.join(globalDir, 'big.bin'), 'x'.repeat(5_000)) // measurable size

// (d) fake source repo
fs.mkdirSync(path.join(repo, 'packages', 'cli'), { recursive: true })
fs.mkdirSync(path.join(repo, 'bin'), { recursive: true })
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'tagent', version: '0.0.0' }))
fs.writeFileSync(path.join(repo, 'packages', 'cli', 'package.json'), JSON.stringify({ name: 'tagent' }))
fs.writeFileSync(path.join(repo, 'bin', 'tagent'), LAUNCHER)

// (b) fake command locations
fs.symlinkSync(path.join(repo, 'bin', 'tagent'), path.join(home, '.local', 'bin', 'tagent')) // good link → repo
fs.symlinkSync('/nonexistent-tagent-target', path.join(usrbin, 'tagent'))                    // dead link
fs.writeFileSync(path.join(bin2, 'tagent'), LAUNCHER)                                       // plain launcher copy
fs.writeFileSync(path.join(bin3, 'tagent'), '#!/bin/sh\necho not tagent\n')                  // foreign file

// (c) fake bun global registration
fs.writeFileSync(
  path.join(bunGlobal, 'package.json'),
  JSON.stringify({ dependencies: { 'tagent': `link:${path.join(repo, 'packages', 'cli')}`, 'other-pkg': '^1.0.0' } }, null, 2),
)
fs.mkdirSync(path.join(bunGlobal, 'node_modules'), { recursive: true })
fs.symlinkSync(path.join(repo, 'packages', 'cli'), path.join(bunGlobal, 'node_modules', 'tagent'))

// (e) fake release binary (outside the repo, named /^tagent/)
const fakeBinary = path.join(bindir, 'tagent-v0.9.9-linux-x64')
fs.writeFileSync(fakeBinary, '\x7fELF…binary…')

// (f) fake workspaces
fs.mkdirSync(path.join(ws, '.tagent', 'sessions'), { recursive: true })
fs.writeFileSync(path.join(ws, '.tagent', 'file-state.json'), '{}\n')
fs.writeFileSync(path.join(ws, '.tagent', 'sessions', 's1.json'), '{}\n')
fs.mkdirSync(path.join(ws2, '.tagent'), { recursive: true })
// a .tagent INSIDE the repo — must be covered by the repo, not offered twice
fs.mkdirSync(path.join(repo, '.tagent'), { recursive: true })

function collect(over: Partial<CollectOptions> = {}) {
  return collectUninstallTargets({
    home,
    globalDir,
    binDirs: [path.join(home, '.local', 'bin'), usrbin, bin2, bin3],
    bunGlobalDir: bunGlobal,
    repoRoot: repo,
    cwd: ws,
    execPath: fakeBinary,
    ...over,
  })
}

async function main(): Promise<void> {
  console.log('\n1) fmtBytes / pathSize')
  ok('fmtBytes 512 → 512B', fmtBytes(512) === '512B')
  ok('fmtBytes 2048 → 2KB', fmtBytes(2048) === '2KB')
  ok('fmtBytes 3MB → 3.0MB', fmtBytes(3 * 1024 * 1024) === '3.0MB')
  {
    const f = path.join(tmp, 'size-file.bin')
    fs.writeFileSync(f, 'y'.repeat(1_000))
    ok('pathSize file = 1000', pathSize(f) === 1000, `got ${pathSize(f)}`)
    const d = path.join(tmp, 'size-dir')
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'a'), 'y'.repeat(1_000))
    fs.writeFileSync(path.join(d, 'b'), 'y'.repeat(2_000))
    fs.symlinkSync(f, path.join(d, 'link-to-big')) // never followed
    ok('pathSize dir = 3000 (symlink counted 0)', pathSize(d) === 3_000, `got ${pathSize(d)}`)
    ok('pathSize missing → 0 (no throw)', pathSize(path.join(tmp, 'nope')) === 0)
  }

  console.log('\n2) isTagentRepo / isInside')
  ok('isTagentRepo(fake repo) = true', isTagentRepo(repo))
  ok('isTagentRepo(empty dir) = false', isTagentRepo(tmp) === false)
  {
    const notrepo = path.join(tmp, 'notrepo')
    fs.mkdirSync(notrepo, { recursive: true })
    fs.writeFileSync(path.join(notrepo, 'package.json'), '{"name":"other"}')
    ok('isTagentRepo(wrong name) = false', isTagentRepo(notrepo) === false)
    const half = path.join(tmp, 'halfrepo')
    fs.mkdirSync(half, { recursive: true })
    fs.writeFileSync(path.join(half, 'package.json'), '{"name":"tagent"}')
    ok('isTagentRepo(no packages/cli) = false', isTagentRepo(half) === false)
  }
  ok('isInside(/a/b, /a) = true', isInside('/a/b', '/a'))
  ok('isInside(/ab, /a) = false', isInside('/ab', '/a') === false)
  ok('isInside(/a, /a) = true', isInside('/a', '/a'))

  console.log('\n3) collectUninstallTargets — the plan')
  const plan = collect()
  const kinds = (k: string) => plan.items.filter((i) => i.kind === k)
  const linkPaths = kinds('command-link').map((i) => i.path)

  ok('global data found', kinds('global-dir').length === 1 && kinds('global-dir')[0].path === globalDir)
  ok('global size ≥ 5KB (recursive du)', (kinds('global-dir')[0].size ?? 0) >= 5_000, `got ${kinds('global-dir')[0].size}`)

  ok('3 command links found (symlink, dead link, launcher copy)', kinds('command-link').length === 3,
    `got ${linkPaths.join(', ')}`)
  ok('symlink → repo detected', linkPaths.includes(path.join(home, '.local', 'bin', 'tagent')))
  ok('dead symlink detected', linkPaths.includes(path.join(usrbin, 'tagent')))
  ok('plain launcher copy detected (header match)', linkPaths.includes(path.join(bin2, 'tagent')))
  ok('foreign file named `tagent` NOT collected', !linkPaths.includes(path.join(bin3, 'tagent')))
  ok('foreign file explained in notes', plan.notes.some((n) => n.includes(bin3)))

  ok('bun link found', kinds('bun-link').length === 1 && kinds('bun-link')[0].path === path.join(bunGlobal, 'node_modules', 'tagent'))
  ok('bun package.json entry found', kinds('bun-package-json').length === 1 && kinds('bun-package-json')[0].path === path.join(bunGlobal, 'package.json'))

  ok('source repo found', plan.repo?.path === repo)
  ok('release binary found (outside repo)', plan.binary?.path === fakeBinary)
  ok('workspace .tagent found (cwd)', plan.workspace?.path === path.join(ws, '.tagent'))

  ok('binary NOT offered when execPath is bun', collect({ execPath: process.execPath, argv1: path.join(repo, 'packages', 'cli', 'src', 'index.ts') }).binary === undefined)
  ok('binary NOT offered when inside the repo', collect({ execPath: path.join(repo, 'bin', 'tagent-helper') }).binary === undefined)
  ok('workspace NOT offered when inside the repo', collect({ cwd: repo, execPath: fakeBinary }).workspace === undefined)
  ok('TAGENT_WORKSPACE override wins over cwd', collect({ envWorkspace: ws2, execPath: fakeBinary }).workspace?.path === path.join(ws2, '.tagent'))

  {
    const emptyHome = path.join(tmp, 'empty-home')
    fs.mkdirSync(emptyHome, { recursive: true })
    const nothing = collectUninstallTargets({
      home: emptyHome,
      globalDir: path.join(emptyHome, '.tagent'),
      binDirs: [path.join(emptyHome, '.local', 'bin')],
      bunGlobalDir: path.join(emptyHome, '.bun', 'install', 'global'),
      repoRoot: emptyHome, // not a repo — suppress the real default
      cwd: emptyHome,
      execPath: process.execPath,
    })
    ok('nothing found in a clean fake home', nothing.items.length === 0 && !nothing.repo && !nothing.binary && !nothing.workspace,
      `items=${nothing.items.length} repo=${!!nothing.repo}`)
  }

  console.log('\n4) planToString')
  const text = planToString(plan)
  ok('enumerates found items', text.includes('found:') && text.includes('1.') && text.includes('global data'))
  ok('prints dim paths', text.includes(globalDir) && text.includes(path.join(home, '.local', 'bin', 'tagent')))
  ok('repo/binary listed as asked-separately', text.includes('asked separately:') && text.includes('source repo'))
  ok('workspace find hint printed', text.includes('find ~/projects -maxdepth 2 -name .tagent -type d'))
  ok('sizes rendered', text.includes('KB') || text.includes('B'))

  console.log('\n5) gitDirtyCount')
  if (hasGit) {
    ok('non-git dir → undefined', gitDirtyCount(tmp) === undefined)
    spawnSync('git', ['init', '-q'], { cwd: repo })
    spawnSync('git', ['add', '-A'], { cwd: repo })
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo })
    ok('clean repo → 0', gitDirtyCount(repo) === 0, `got ${gitDirtyCount(repo)}`)
    fs.writeFileSync(path.join(repo, 'PRD.md'), 'uncommitted user work\n')
    ok('uncommitted file → 1', gitDirtyCount(repo) === 1, `got ${gitDirtyCount(repo)}`)
  } else {
    ok('git unavailable → undefined (skipped)', gitDirtyCount(repo) === undefined)
  }

  console.log('\n6) removeItem — deletions on fakes')
  // global dir
  const g = removeItem({ kind: 'global-dir', label: 'global data', path: globalDir })
  ok('global dir removed', g.ok && !fs.existsSync(globalDir))
  // symlink: link gone, target alive
  const l = removeItem({ kind: 'command-link', label: 'command', path: path.join(home, '.local', 'bin', 'tagent') })
  ok('command link removed, repo bin kept', l.ok && !fs.existsSync(path.join(home, '.local', 'bin', 'tagent')) && fs.existsSync(path.join(repo, 'bin', 'tagent')))
  // bun package.json: surgical edit
  const pj = removeItem({ kind: 'bun-package-json', label: 'bun global registration', path: path.join(bunGlobal, 'package.json') })
  const after = JSON.parse(fs.readFileSync(path.join(bunGlobal, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
  ok('bun package.json: tagent entry dropped, others kept', pj.ok && !('tagent' in after.dependencies) && after.dependencies['other-pkg'] === '^1.0.0')
  // bun link
  const bl = removeItem({ kind: 'bun-link', label: 'bun global link', path: path.join(bunGlobal, 'node_modules', 'tagent') })
  ok('bun link removed, target kept', bl.ok && !fs.existsSync(path.join(bunGlobal, 'node_modules', 'tagent')) && fs.existsSync(path.join(repo, 'packages', 'cli', 'package.json')))
  // workspace
  const w = removeItem({ kind: 'workspace-dir', label: 'workspace data', path: path.join(ws, '.tagent') })
  ok('workspace .tagent removed', w.ok && !fs.existsSync(path.join(ws, '.tagent')))
  // binary
  const b = removeItem({ kind: 'binary', label: 'release binary', path: fakeBinary })
  ok('release binary removed', b.ok && !fs.existsSync(fakeBinary))
  // repo: chdir out first, then delete — and survive deleting our own cwd
  process.chdir(repo)
  const r = removeItem({ kind: 'repo', label: 'source repo', path: repo })
  ok('repo removed, cwd moved out', r.ok && !fs.existsSync(repo) && process.cwd() !== repo, `cwd=${process.cwd()}`)
  // missing path with force → ok, no throw
  const m = removeItem({ kind: 'global-dir', label: 'gone', path: path.join(tmp, 'never-existed') })
  ok('missing path → ok (ENOENT swallowed)', m.ok)
  // EACCES → reported, not thrown
  if (!isRoot) {
    const ro = path.join(tmp, 'ro')
    fs.mkdirSync(path.join(ro, 'x'), { recursive: true })
    fs.chmodSync(ro, 0o555)
    const e = removeItem({ kind: 'global-dir', label: 'locked', path: path.join(ro, 'x') })
    ok('EACCES → ok:false with error, no crash', e.ok === false && !!e.error, `ok=${e.ok} err=${e.error}`)
    fs.chmodSync(ro, 0o755)
  } else {
    ok('EACCES sub-test skipped (running as root)', true)
  }

  console.log(`\n  ${failed === 0 ? 'ALL PASS' : 'FAILURES'} — ${passed} passed, ${failed} failed\n`)
  // cleanup (best-effort)
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch { /* tmpdir cleans itself */ }
  process.exit(failed === 0 ? 0 : 1)
}

main()
