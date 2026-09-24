#!/usr/bin/env bun
/**
 * test-sync-presence.ts — device presence ("device lain sedang online") +
 * per-project sync history (riwayat sync per proyek).
 *
 * 1) deviceIdOf: stable, persisted, hex-clean
 * 2) writePresence: due → writes + true; not due → false
 * 3) readPresence/onlineOthers: fresh entries online, stale pruned, self excluded
 * 4) SyncEngine.status(): carries `others` from the presence file
 * 5) recordSyncHistory/readSyncHistory: append, cap 100, newest-first
 *
 * Run: bun scripts/test-sync-presence.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-presence-'))
// keep the global config isolated — readSyncSettings/presenceTtl reads it on fallback
process.env.HOME = TMP

let failed = 0
const ok = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${cond ? '' : ` — ${extra}`}`)
  if (!cond) failed++
}

const {
  deviceIdOf, deviceName, readPresence, writePresence, onlineOthers,
  recordSyncHistory, readSyncHistory, SyncEngine, PRESENCE_EVERY_MS,
} = await import('../packages/core/src/sync')

/* ---------------- device id ---------------- */

{
  const root = fs.mkdtempSync(path.join(TMP, 'dev-'))
  const id1 = deviceIdOf(root)
  const id2 = deviceIdOf(root)
  ok('deviceId: stable across calls', id1 === id2 && /^[a-f0-9]{10}$/.test(id1), `${id1} / ${id2}`)
  const onDisk = fs.readFileSync(path.join(root, '.tagent', 'device-id'), 'utf8').trim()
  ok('deviceId: persisted under .tagent/ (gitignored)', onDisk === id1)
  // different root → different id (a clone = a device)
  const other = fs.mkdtempSync(path.join(TMP, 'dev2-'))
  ok('deviceId: per-project clone', deviceIdOf(other) !== id1)
  ok('deviceName: hostname label', typeof deviceName() === 'string' && deviceName().length > 0)
}

/* ---------------- heartbeat ---------------- */

{
  const root = fs.mkdtempSync(path.join(TMP, 'hb-'))
  const first = writePresence(root)
  ok('heartbeat: first write reports change', first === true)
  const file = path.join(root, '.tagent-sync', 'presence.json')
  ok('heartbeat: file created in .tagent-sync/', fs.existsSync(file))
  const again = writePresence(root)
  ok('heartbeat: not due → no change', again === false)
  const me = readPresence(root)
  ok('heartbeat: own entry fresh', me.length === 1 && me[0].id === deviceIdOf(root))
  ok('heartbeat: carries the device name', me[0].name === deviceName())
}

/* ---------------- others online / stale pruning ---------------- */

{
  const root = fs.mkdtempSync(path.join(TMP, 'others-'))
  const selfId = deviceIdOf(root)
  // craft a presence file as if another device (laptop-b) had written it
  const file = path.join(root, '.tagent-sync', 'presence.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const now = Date.now()
  fs.writeFileSync(
    file,
    JSON.stringify({
      devices: {
        [selfId]: { name: deviceName(), at: now },
        laptopb: { name: 'laptop-b', at: now - 10_000 }, // fresh — 10s ago
        phone7: { name: 'pixel-7', at: now - 400_000 }, // stale — ~7min ago
      },
    }),
  )
  const others = onlineOthers(root)
  ok(
    'others: fresh device online, stale pruned, self excluded',
    others.length === 1 && others[0].name === 'laptop-b',
    JSON.stringify(others),
  )
  // the next heartbeat write prunes the stale entry from disk — make the
  // SELF entry due first (older than one heartbeat interval), since a
  // fresh self heartbeat returns early without touching the file
  const crafted = JSON.parse(fs.readFileSync(file, 'utf8')) as { devices: Record<string, { name: string; at: number }> }
  crafted.devices[selfId].at = Date.now() - (PRESENCE_EVERY_MS + 5_000)
  fs.writeFileSync(file, JSON.stringify(crafted))
  writePresence(root)
  const after = JSON.parse(fs.readFileSync(file, 'utf8')) as { devices: Record<string, unknown> }
  ok('others: stale entry pruned on write', !('phone7' in after.devices) && 'laptopb' in after.devices)
  // a completely fresh file with an unknown name falls back to a short id label
  fs.writeFileSync(file, JSON.stringify({ devices: { xyz12345: { name: '', at: now } } }))
  ok('others: unnamed device falls back to id', readPresence(root)[0].name === 'xyz12345'.slice(0, 6))
}

/* ---------------- engine status carries `others` ---------------- */

{
  const root = fs.mkdtempSync(path.join(TMP, 'eng-'))
  const selfId = deviceIdOf(root)
  const file = path.join(root, '.tagent-sync', 'presence.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ devices: { [selfId]: { name: 'me', at: Date.now() }, tab9: { name: 'tablet', at: Date.now() - 5_000 } } }))
  const eng = new SyncEngine({ root })
  const st = eng.status()
  ok('status: others present', st.others.length === 1 && st.others[0].name === 'tablet', JSON.stringify(st.others))
  ok('status: engine not running before restart', st.running === false)
}

/* ---------------- sync history ---------------- */

{
  const root = fs.mkdtempSync(path.join(TMP, 'hist-'))
  ok('history: empty by default', readSyncHistory(root).length === 0)
  recordSyncHistory(root, { action: 'pushed', detail: 'auto ⧉laptop', repo: 'owner/proj', commit: 'abc1234' })
  recordSyncHistory(root, { action: 'pulled', detail: '3 files' })
  recordSyncHistory(root, { action: 'error', detail: 'boom' })
  const h = readSyncHistory(root)
  ok('history: newest first', h.length === 3 && h[0].action === 'error' && h[2].action === 'pushed')
  ok('history: fields kept', h[2].repo === 'owner/proj' && h[2].commit === 'abc1234' && typeof h[2].at === 'number')
  // cap at 100
  for (let i = 0; i < 110; i++) recordSyncHistory(root, { action: 'settings', detail: `s${i}` })
  const capped = readSyncHistory(root, 500)
  ok('history: capped at 100', capped.length === 100)
  ok('history: kept the newest', capped[0].detail === 's109' && capped[99].detail === 's10')
  ok('history: limit works', readSyncHistory(root, 2).length === 2)
  ok('history: long detail truncated safely', (() => {
    recordSyncHistory(root, { action: 'error', detail: 'x'.repeat(500) })
    const last = readSyncHistory(root, 1)[0]
    return last.detail.length <= 160
  })())
  // per-project: another root has its own timeline
  const other = fs.mkdtempSync(path.join(TMP, 'hist2-'))
  ok('history: per project (empty elsewhere)', readSyncHistory(other).length === 0)
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILING`)
process.exit(failed === 0 ? 0 : 1)
