/**
 * test-browser.ts — REAL Playwright test of the upgraded browser tool
 * (viewports, aria snapshot, audit, screenshots, click/type feedback, errors).
 * Uses the repo devDependency playwright + the cached chromium build.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { browserTool } from '../packages/core/src/tools/browser'
import { defaultConfig } from '../packages/core/src/config'
import type { AgentEvents, ToolContext, TagentConfig } from '../packages/core/src/types'

let passed = 0
let failed = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${extra ? ` — ${String(extra).slice(0, 300)}` : ''}`)
  }
}

const root = fs.mkdtempSync('/tmp/tagent-browser-')
const cfg: TagentConfig = { ...defaultConfig(), tools: { bash: true, browser: true, serve: true } }
const ctx: ToolContext = {
  workspaceRoot: root, sessionId: 's1', depth: 0, config: cfg,
  events: {} as AgentEvents, todos: [],
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Todo Demo</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: Arial, sans-serif; font-size: 16px; margin: 0 }
  .wide { width: 1000px; height: 30px; background: #eee }
  #tiny { width: 16px; height: 16px; padding: 0 }
  .low { color: #b8b8b8; background: #eee }
</style>
</head>
<body>
<h1>Todo demo</h1>
<form onsubmit="return false"><input id="inp" placeholder="Add item" aria-label="New item"><button id="add" type="button">Add</button></form>
<ul id="list"></ul>
<div class="wide">wide block</div>
<button id="tiny" aria-label="tiny">.</button>
<p class="low">barely readable text</p>
<img src="missing.png" id="brokenimg">
<script>
  document.getElementById('add').addEventListener('click', () => {
    const v = document.getElementById('inp').value || 'item'
    const li = document.createElement('li')
    li.textContent = v
    document.getElementById('list').appendChild(li)
  })
</script>
</body>
</html>`

const BAD_PAGE = `<!doctype html>
<html><head><title>Broken</title></head><body>
<button id="boom" onclick="console.error('boom fired')">fire</button>
<script>console.error('startup explosion'); fetch('/nope.json').catch(()=>{})</script>
</body></html>`

fs.writeFileSync(path.join(root, 'index.html'), PAGE)
fs.writeFileSync(path.join(root, 'bad.html'), BAD_PAGE)

// a tiny static server
const server = http.createServer((req, res) => {
  const file = req.url === '/' || req.url === '/index.html' ? 'index.html' : req.url!.slice(1)
  const p = path.join(root, file)
  if (fs.existsSync(p) && fs.statSync(p).isFile()) {
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'application/octet-stream' })
    res.end(fs.readFileSync(p))
  } else {
    res.writeHead(404)
    res.end('nope')
  }
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port
const url = `http://127.0.0.1:${port}`

try {
  console.log('1) open — title + aria snapshot')
  {
    const out = await browserTool.run({ action: 'open', url }, ctx)
    ok('title read', out.includes('Todo Demo'), out.slice(0, 200))
    ok('viewport reported (desktop default)', out.includes('1280×800'), out.slice(0, 200))
    ok('aria snapshot has the heading + button', out.includes('heading') && out.includes('Add'), out.slice(0, 400))
    ok('aria snapshot has the textbox', out.includes('textbox'), out.slice(0, 400))
    ok('no console errors on the good page', !out.includes('startup explosion'), out)
  }

  console.log('\n2) type + click — interaction feedback')
  {
    const t = await browserTool.run({ action: 'type', selector: '#inp', value: 'buy milk' }, ctx)
    ok('type confirmed', t.includes('Typed into #inp'))
    const c = await browserTool.run({ action: 'click', selector: '#add' }, ctx)
    ok('click returns the new page state', c.includes('buy milk'), c.slice(0, 400))
    ok('click confirms the selector', c.includes('Clicked #add'))
    const c2 = await browserTool.run({ action: 'click', selector: '#add' }, ctx)
    ok('second item appears (live DOM)', c2.split('buy milk').length > 2, c2.slice(0, 400))
  }

  console.log('\n3) viewport mobile + audit')
  {
    const v = await browserTool.run({ action: 'viewport', viewport: 'mobile' }, ctx)
    ok('viewport switched', v.includes('390×844') && v.includes('mobile'), v)
    const a = await browserTool.run({ action: 'audit' }, ctx)
    ok('audit reports 390 width', a.includes('390×'), a.slice(0, 120))
    ok('HORIZONTAL OVERFLOW detected', a.includes('HORIZONTAL OVERFLOW'), a)
    ok('overflow names the offender', a.includes('.wide'), a)
    ok('tap target issue flagged', a.includes('small tap targets') && a.includes('#tiny'), a)
    ok('tiny text check ran', a.includes('fonts:'), a.slice(0, 150))
  }

  console.log('\n4) viewport desktop + audit')
  {
    const v = await browserTool.run({ action: 'viewport', viewport: 'desktop' }, ctx)
    ok('viewport switched', v.includes('1280×800'))
    const a = await browserTool.run({ action: 'audit' }, ctx)
    ok('no overflow at desktop', a.includes('no horizontal overflow'), a)
    ok('contrast issue flagged', a.includes('low contrast') && a.includes('barely readable'), a)
    ok('meta viewport present', a.includes('meta viewport present'), a)
    ok('interactive count reported', a.includes('interactive elements:'), a.slice(-200))
  }

  console.log('\n5) screenshot — file + [IMAGE:] marker')
  {
    const s = await browserTool.run({ action: 'screenshot' }, ctx)
    ok('screenshot saved', s.includes('Screenshot saved'), s)
    ok('viewport in filename', s.includes('shot-desktop-'), s)
    const marker = s.match(/\[IMAGE:([^\]]+)\]/)?.[1]
    ok('[IMAGE:] marker with abs path', !!marker && marker.startsWith(root), s)
    ok('png file exists on disk', !!marker && fs.existsSync(marker) && fs.statSync(marker).size > 5_000)
    const m = await browserTool.run({ action: 'screenshot', viewport: 'mobile' }, ctx) // ignored w/o viewport action — switch first
    void m
    await browserTool.run({ action: 'viewport', viewport: 'mobile' }, ctx)
    const s2 = await browserTool.run({ action: 'screenshot' }, ctx)
    const marker2 = s2.match(/\[IMAGE:([^\]]+)\]/)?.[1]
    ok('mobile screenshot separate file', !!marker2 && marker2 !== marker, s2)
  }

  console.log('\n6) errors digest — console + failed network')
  {
    const out = await browserTool.run({ action: 'open', url: `${url}/bad.html` }, ctx)
    ok('console error captured', out.includes('startup explosion'), out.slice(0, 500))
    ok('failed request (404) captured', out.includes('404') || out.includes('nope.json'), out.slice(0, 500))
    const e = await browserTool.run({ action: 'errors' }, ctx)
    ok('errors action lists them', e.includes('startup explosion') || e.includes('[HTTP 404]'), e)
    const net = await browserTool.run({ action: 'network' }, ctx)
    ok('network log has the 404', net.includes('404'), net.slice(0, 300))
  }

  console.log('\n7) snapshot + evaluate + close')
  {
    const snap = await browserTool.run({ action: 'snapshot' }, ctx)
    ok('snapshot action returns the tree', snap.includes('button') || snap.includes('fire'), snap.slice(0, 300))
    const ev = await browserTool.run({ action: 'evaluate', code: 'document.title' }, ctx)
    ok('evaluate returns page data', ev.includes('Broken'), ev)
    const closed = await browserTool.run({ action: 'close' }, ctx)
    ok('browser closed', closed.includes('Browser closed'))
  }
} catch (e) {
  console.error('FATAL', e)
  process.exitCode = 1
} finally {
  server.close()
  console.log(`\n${'='.repeat(50)}\nRESULT: ${passed} passed, ${failed} failed`)
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(failed > 0 ? 1 : 0)
}
