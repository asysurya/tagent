#!/usr/bin/env bun
/**
 * test-mcp-diag.ts — MCP failure diagnostics (v0.22.2).
 *
 * Doctor used to report a dead server as "error — server exited (code 1)"
 * with the actual reason (npm network error, old node, missing launcher)
 * thrown away: stderr was never read. Now:
 *
 * 1) stderr is captured — the exit error carries the last lines of it
 * 2) a missing launcher says so by name (ENOENT → "cannot start 'x' — not
 *    found on PATH"), with install advice for the npx case
 * 3) a configured `npx` with no Node on the machine transparently falls
 *    back to `bunx` when bun is installed (same npm packages)
 * 4) calls made after a death include the reason, not a bare "not running"
 * 5) a server that dies AFTER handshake reports why it died
 * 6) stderr chatter does not corrupt a healthy server
 *
 * v0.22.3 — the reason itself had to become readable:
 *
 * 7) a node-style crash no longer surfaces the banner ("}" + "Node.js
 *    v24.20.0") — the `Error: …` headline and its `code:` are named
 * 8) ENOSPC ("No space left on device (os error 28)") is named plainly,
 *    dropping the package manager's multi-line hint essay
 * 9) known causes map to ONE actionable hint (disk full → free space;
 *    MODULE_NOT_FOUND via npx → clear the npx cache)
 * 10) a banner-only tail yields NO summary instead of garbage
 * 11) diskFreeBytes probes the filesystem the servers install onto
 *
 * Run: bun scripts/test-mcp-diag.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { McpManager, resolveMcpLauncher, summarizeStderr, mcpFailureHint, diskFreeBytes } from '../packages/core/src/mcp'

let pass = 0
let fail = 0
function ok(cond: boolean, label: string, extra = ''): void {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`) }
}

/** helper: what does the manager end up saying about the one server?
 *  (status is read BEFORE close — close() empties the connection map) */
async function oneServer(cmd: string, args: string[]): Promise<{ state: string; error?: string; note?: string; tools: number }> {
  const mgr = new McpManager({ servers: { s: { command: cmd, args } } })
  try {
    await mgr.ensureStarted()
  } catch { /* per-server isolation — never throws for one bad server */ }
  const st = mgr.status()[0]
  mgr.close()
  return st
}

console.log('1) stderr is surfaced — the exit error names the disease:')
{
  const st = await oneServer('bash', ['-c', 'echo "npm ERR! code ENOTFOUND" >&2; echo "npm ERR! network" >&2; exit 7'])
  ok(st.state === 'error', 'state is error', JSON.stringify(st))
  ok(/server exited \(code 7\)/.test(st.error ?? ''), 'exit code reported', st.error)
  ok(/ENOTFOUND/.test(st.error ?? '') && /network/.test(st.error ?? ''), 'stderr tail carried into the error', st.error)
}
{
  const st = await oneServer('bash', ['-c', 'exit 3'])
  ok(st.state === 'error' && /server exited \(code 3\)/.test(st.error ?? ''), 'clean exit still reports its code', st.error)
  ok(!/\|/.test(st.error ?? ''), 'no stderr → no garbage tail', st.error)
}

console.log('\n2) missing launcher — ENOENT says the command by name:')
{
  const st = await oneServer('definitely-not-a-real-cmd-xyz', [])
  ok(st.state === 'error', 'state is error', JSON.stringify(st))
  ok(/cannot start 'definitely-not-a-real-cmd-xyz'/.test(st.error ?? ''), 'command named', st.error)
  ok(/not found on PATH/.test(st.error ?? ''), 'not-found phrasing', st.error)
}

console.log('\n3) npx with no Node installed → bunx fallback:')
{
  // a scratch dir with ONLY a bunx executable → npx invisible
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-launch-'))
  fs.writeFileSync(path.join(dir, 'bunx'), '#!/bin/sh\nsleep 60\n')
  fs.chmodSync(path.join(dir, 'bunx'), 0o755)
  const env = { PATH: dir } as NodeJS.ProcessEnv
  const r = resolveMcpLauncher('npx', env)
  ok(r.command === 'bunx', 'npx → bunx when only bunx exists', JSON.stringify(r))
  ok(r.via !== undefined, 'fallback carries a note', r.via)
  const r2 = resolveMcpLauncher('uvx', env)
  ok(r2.command === 'uvx' && r2.via === undefined, 'non-npx commands untouched', JSON.stringify(r2))
  const r3 = resolveMcpLauncher('npx', { PATH: '' })
  ok(r3.command === 'npx' && r3.via === undefined, 'no npx AND no bunx → keep npx, let the spawn error explain', JSON.stringify(r3))
  fs.rmSync(dir, { recursive: true, force: true })
}
{
  // real environment: whichever launchers exist here, resolution must not crash
  const r = resolveMcpLauncher('npx')
  ok(r.command === 'npx' || r.command === 'bunx', 'live PATH resolves to a real launcher', JSON.stringify(r))
}

console.log('\n4) a dead server leaves its reason in status:')
{
  const st = await oneServer('bash', ['-c', 'echo "boom: bad token" >&2; exit 1'])
  ok(/boom: bad token/.test(st.error ?? ''), 'reason visible in status', st.error)
}

console.log('\n5) a server that dies AFTER handshake — error surfaces too:')
{
  // answers initialize, then dies with a reason on stderr
  const mgr = new McpManager({
    servers: { s: { command: 'bash', args: ['-c', "read line; echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"serverInfo\":{\"name\":\"t\"}}}'; echo 'fatal: disk full' >&2; exit 5"] } },
  })
  await mgr.ensureStarted()
  const st = mgr.status()[0]
  mgr.close()
  ok(st.state === 'error', 'handshake-then-die ends error', JSON.stringify(st))
  ok(/code 5/.test(st.error ?? '') && /disk full/.test(st.error ?? ''), 'reason carried (code + stderr)', st.error)
}

console.log('\n6) stderr noise does not corrupt a healthy server:')
{
  // answers initialize + tools/list + tools/call while spamming stderr
  const mgr = new McpManager({
    servers: {
      s: {
        command: 'bash',
        args: [
          '-c',
          "while IFS= read -r line; do id=$(echo \"$line\" | sed -n 's/.*\"id\":\\([0-9]*\\).*/\\1/p'); echo \"log noise $id\" >&2; case \"$line\" in *initialize*) printf '{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{\"serverInfo\":{\"name\":\"noisy\"}}}\\n' \"$id\";; *tools/list*) printf '{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{\"tools\":[{\"name\":\"echo\",\"description\":\"echoes\"}]}}\\n' \"$id\";; *tools/call*) printf '{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"pong\"}]}}\\n' \"$id\";; esac; done",
        ],
      },
    },
  })
  await mgr.ensureStarted()
  const st = mgr.status()[0]
  ok(st.state === 'ready', 'handshake completes despite stderr chatter', JSON.stringify(st))
  ok(st.tools === 1, 'tools listed', JSON.stringify(st))
  const defs = mgr.toolDefinitions()
  ok(defs.length === 1 && defs[0].name === 'mcp_s_echo', 'tool exposed as mcp_s_echo', defs.map((d) => d.name).join(','))
  const out = await defs[0].run({})
  ok(out === 'pong', 'call round-trips through the noise', String(out))
  mgr.close()
}

console.log('\n7) an absolute-path server connects (launcher resolution untouched):')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-mcp-ok-'))
  const file = path.join(dir, 'srv.sh')
  fs.writeFileSync(
    file,
    [
      '#!/bin/sh',
      'while IFS= read -r line; do',
      "  case \"$line\" in",
      "    *initialize*) echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"serverInfo\":{\"name\":\"x\"}}}';;",
      "    *tools/list*) echo '{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[]}}';;",
      '  esac',
      'done',
      '',
    ].join('\n'),
  )
  fs.chmodSync(file, 0o755)
  const st = await oneServer(file, [])
  ok(st.state === 'ready', 'absolute-path server connects', JSON.stringify(st))
  fs.rmSync(dir, { recursive: true, force: true })
}

/** helper: a server whose only job is to dump a file to stderr, then die */
async function stderrServer(file: string): Promise<{ state: string; error?: string; hint?: string }> {
  const st = await oneServer('bash', ['-c', `cat "${file}" >&2; exit 1`])
  return st
}

console.log('\n8) node-style crash — banner junk dropped, headline + code named:')
{
  // the EXACT shape v0.22.2 summarized as "} | Node.js v24.20.0"
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-node-crash-'))
  const file = path.join(dir, 'crash.txt')
  fs.writeFileSync(
    file,
    [
      'node:internal/modules/cjs/loader:1143',
      '  throw err;',
      '  ^',
      '',
      "Error: Cannot find module 'zod'",
      'Require stack:',
      '- /home/u/.npm/_npx/abc/node_modules/@modelcontextprotocol/server-memory/dist/index.js',
      '    at Module._resolveFilename (node:internal/modules/cjs/loader:1143:15)',
      '    at Module._load (node:internal/modules/cjs/loader:977:17)',
      "  code: 'MODULE_NOT_FOUND',",
      '  requireStack: [',
      "    '/home/u/.npm/_npx/abc/node_modules/@modelcontextprotocol/server-memory/dist/index.js'",
      '  ]',
      '}',
      'Node.js v24.20.0',
      '',
    ].join('\n'),
  )
  const st = await stderrServer(file)
  ok(st.state === 'error', 'state is error', JSON.stringify(st))
  ok(/Cannot find module 'zod'/.test(st.error ?? ''), 'the module is named', st.error)
  ok(/MODULE_NOT_FOUND/.test(st.error ?? ''), 'the code is named', st.error)
  ok(!/Node\.js v24/.test(st.error ?? ''), 'version banner dropped', st.error)
  ok(!/\}\s*\|/.test(st.error ?? ''), 'closing-brace junk dropped', st.error)
  ok(!/at Module\./.test(st.error ?? ''), 'stack frames dropped', st.error)
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('\n9) ENOSPC (uv-style) — named plainly, essay dropped:')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-uv-crash-'))
  const file = path.join(dir, 'crash.txt')
  fs.writeFileSync(
    file,
    [
      'error: failed to prepare `duckduckgo-mcp-server` (v0.7)',
      'No space left on device (os error 28)',
      'hint: `jsonschema-specifications` (v2025.9.1) was included because `duckduckgo-mcp-server` (v0.7) depends on `jsonschema` directly',
      '',
    ].join('\n'),
  )
  const st = await stderrServer(file)
  ok(/No space left on device \(os error 28\) — disk full/.test(st.error ?? ''), 'ENOSPC named + flagged as disk full', st.error)
  ok(!/jsonschema/.test(st.error ?? ''), 'package-manager hint essay dropped', st.error)
  ok(/free disk space/.test(st.hint ?? ''), 'actionable hint attached', st.hint)
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('\n10) mcpFailureHint — known causes map to the one fixing move:')
{
  const h1 = mcpFailureHint("server exited (code 1): No space left on device (os error 28) — disk full", 'uvx')
  ok(/free disk space/.test(h1 ?? ''), 'ENOSPC → free-space hint', h1)
  const h2 = mcpFailureHint("server exited (code 1): Error: Cannot find module 'zod' | code: 'MODULE_NOT_FOUND'", 'npx')
  ok(/_npx/.test(h2 ?? ''), 'MODULE_NOT_FOUND via npx → cache hint', h2)
  const h3 = mcpFailureHint("server exited (code 1): Error: Cannot find module 'zod' | code: 'MODULE_NOT_FOUND'", '/usr/local/bin/bunx')
  ok(/_npx/.test(h3 ?? ''), '…also for a bunx launcher (same npm cache)', h3)
  const h4 = mcpFailureHint("server exited (code 1): Error: Cannot find module 'zod' | code: 'MODULE_NOT_FOUND'", 'uvx')
  ok(h4 === undefined, 'uvx module errors get no npx-cache advice', JSON.stringify(h4))
  const h5 = mcpFailureHint('npm ERR! code ENOTFOUND', 'npx')
  ok(/network/.test(h5 ?? ''), 'ENOTFOUND → network hint', h5)
  const h6 = mcpFailureHint("server exited (code 1): listen EADDRINUSE", 'node')
  ok(/port/.test(h6 ?? ''), 'EADDRINUSE → port hint', h6)
  const h7 = mcpFailureHint('server exited (code 1): boom', 'bash')
  ok(h7 === undefined, 'unknown causes get no invented hint', JSON.stringify(h7))
}

console.log('\n11) banner-only tail → no summary instead of garbage:')
{
  const s = summarizeStderr('}\nNode.js v24.20.0\n')
  ok(s === '', 'banner-only tail summarized to nothing', JSON.stringify(s))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-banner-'))
  const file = path.join(dir, 'crash.txt')
  fs.writeFileSync(file, '}\nNode.js v24.20.0\n')
  const st = await stderrServer(file)
  ok(st.error === 'server exited (code 1)', 'error carries no banner junk', st.error)
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('\n12) diskFreeBytes probes this machine:')
{
  const free = diskFreeBytes('/')
  ok(typeof free === 'number' && (free as number) > 0, 'free bytes on / is a positive number', String(free))
  const home = diskFreeBytes(os.homedir())
  ok(home === undefined || (typeof home === 'number' && home > 0), 'home probe sane (or unknown)', String(home))
}

/* ---------------- report ---------------- */
console.log(`\nmcp-diag tests: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
