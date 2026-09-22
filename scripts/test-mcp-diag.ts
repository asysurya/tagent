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
 * Run: bun scripts/test-mcp-diag.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { McpManager, resolveMcpLauncher } from '../packages/core/src/mcp'

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

/* ---------------- report ---------------- */
console.log(`\nmcp-diag tests: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
