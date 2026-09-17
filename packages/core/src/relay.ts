import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * Relay mode — share a LIVE session with another person over the network.
 *
 * A relay is an unguessable code bound to one session. The daemon serves a
 * self-contained read-only viewer page at /relay/<code> that connects to the
 * same websocket and renders the session in real time. Unlike a share link
 * (a static HTML snapshot), a relay is live and revocable.
 *
 * One live relay per session keeps the model simple: re-sharing a session
 * returns the existing code; revoking kills it for everyone holding it.
 */

export interface RelayEntry {
  code: string
  sessionId: string
  sessionTitle: string
  createdAt: number
}

/** 60 bits of entropy from an unambiguous alphabet — plenty for a revocable link */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

function newCode(n = 12): string {
  const bytes = crypto.randomBytes(n)
  let out = ''
  for (let i = 0; i < n; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  return out
}

export function relaysPath(root: string): string {
  return path.join(root, '.tagent', 'relays.json')
}

export function loadRelays(root: string): RelayEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(relaysPath(root), 'utf8'))
    return Array.isArray(raw?.relays) ? raw.relays.filter(isRelay) : []
  } catch {
    return []
  }
}

function isRelay(r: unknown): r is RelayEntry {
  const e = r as RelayEntry
  return !!e && typeof e.code === 'string' && typeof e.sessionId === 'string'
}

export function saveRelays(root: string, relays: RelayEntry[]): void {
  const file = relaysPath(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ relays }, null, 2) + '\n', 'utf8')
}

export function relayUrl(code: string): string {
  return `/relay/${code}`
}

/** Create (or return the existing) relay for a session. */
export function createRelay(root: string, sessionId: string, sessionTitle: string): RelayEntry {
  const relays = loadRelays(root)
  const existing = relays.find((r) => r.sessionId === sessionId)
  if (existing) return existing
  const entry: RelayEntry = {
    code: newCode(),
    sessionId,
    sessionTitle,
    createdAt: Date.now(),
  }
  relays.push(entry)
  saveRelays(root, relays)
  return entry
}

/** Find a relay by its code (validates the format too — safe on request paths). */
export function findRelayByCode(root: string, code: string): RelayEntry | undefined {
  if (!/^[a-z0-9]{8,32}$/i.test(code)) return undefined
  return loadRelays(root).find((r) => r.code === code)
}

/** Remove a relay by code. Returns false when the code was unknown. */
export function revokeRelay(root: string, code: string): boolean {
  const relays = loadRelays(root)
  const next = relays.filter((r) => r.code !== code)
  if (next.length === relays.length) return false
  saveRelays(root, next)
  return true
}

/* ------------------------------------------------------------------ */
/* the viewer page — a live, read-only window into one session          */
/* ------------------------------------------------------------------ */

/**
 * Self-contained viewer page. The daemon injects the relay code and its own
 * websocket path; everything else (history + live events) arrives over the
 * socket: 'relay:hello' (snapshot), then the same events the GUI gets,
 * filtered server-side to the relayed session.
 */
export function renderRelayViewerHtml(code: string, socketIoPath: string): string {
  const client = socketIoPath === '/' ? '/socket.io.js' : `${socketIoPath}/socket.io.js`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Tagent relay — live</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.6 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
         background: #09090b; color: #d4d4d8; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 24px 16px 72px; }
  header { border-bottom: 1px solid #27272a; padding-bottom: 16px; margin-bottom: 16px; }
  h1 { font-size: 16px; margin: 0 0 6px; color: #fafafa; }
  .meta { color: #71717a; font-size: 12px; }
  .badge { display: inline-block; border: 1px solid #3f3f46; border-radius: 999px; padding: 1px 8px;
           font-size: 11px; color: #a1a1aa; margin-right: 6px; }
  .badge.live { border-color: #f97316; color: #fb923c; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #34d399;
         margin-right: 4px; vertical-align: 1px; }
  .dot.on { animation: pulse 1.6s ease-in-out infinite; }
  .dot.off { background: #fbbf24; animation: none; }
  .dot.err { background: #f87171; animation: none; }
  @keyframes pulse { 50% { opacity: 0.25; } }
  .banner { border: 1px solid; border-radius: 10px; padding: 10px 14px; margin: 12px 0; font-size: 13px; display: none; }
  .banner.warn { display: block; border-color: #a16207; color: #fde68a; background: #1c1917; }
  .banner.error { display: block; border-color: #7f1d1d; color: #fca5a5; background: #1c1414; }
  .card { border: 1px solid #27272a; border-radius: 10px; padding: 14px 16px; margin: 16px 0; background: #101012; }
  .card h2 { font-size: 13px; margin: 0 0 8px; color: #a1a1aa; font-weight: 600; }
  .msg { border: 1px solid #27272a; border-radius: 10px; padding: 12px 14px; margin: 12px 0; }
  .msg.user { background: #17171c; border-color: #3f3f46; }
  .msg.agent { background: #0e0e11; }
  .msg .who { font-size: 11px; color: #71717a; margin-bottom: 6px; }
  .msg.user .who { color: #c4b5fd; }
  .msg .body { white-space: pre-wrap; word-break: break-word; }
  details.tool { margin-top: 8px; font-size: 12px; }
  details.tool summary { cursor: pointer; color: #a1a1aa; }
  details.tool summary code { color: #93c5fd; }
  .tool-body { padding: 6px 0 0 14px; color: #a1a1aa; }
  .tool-body pre { background: #131316; border: 1px solid #27272a; border-radius: 6px;
                   padding: 8px; overflow-x: auto; font-size: 11px; margin: 4px 0 0; }
  .label { color: #71717a; font-size: 11px; }
  ul.todos { list-style: none; margin: 0; padding: 0; }
  .todo { padding: 2px 0; color: #d4d4d8; }
  .todo.completed { color: #71717a; text-decoration: line-through; }
  .todo small { color: #71717a; }
  .divider { text-align: center; color: #52525b; font-size: 11px; margin: 16px 0; }
  #statusbar { position: fixed; left: 0; right: 0; bottom: 0; background: rgba(9,9,11,.92);
               border-top: 1px solid #27272a; padding: 7px 16px; font-size: 12px; color: #71717a;
               display: flex; gap: 10px; align-items: center; justify-content: center; }
  #statusbar .phase { color: #fb923c; }
  footer { margin-top: 32px; color: #52525b; font-size: 11px; text-align: center; }
  a { color: #93c5fd; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1 id="title">connecting…</h1>
    <div class="meta" id="meta"><span class="badge live"><span class="dot" id="dot"></span><span id="conn">connecting</span></span></div>
  </header>
  <div class="banner" id="banner"></div>
  <section class="card" id="todos" style="display:none"><h2 id="todos-h">Plan</h2><ul class="todos" id="todos-list"></ul></section>
  <main id="log"><p class="meta">waiting for the session…</p></main>
  <footer>live read-only relay · shared with <a href="https://github.com/asysurya/tagent">Tagent</a> · revocable by the owner at any time</footer>
</div>
<div id="statusbar"><span class="dot" id="dot2"></span><span id="state">connecting…</span><span class="phase" id="phase"></span></div>
<script src="${client}"></script>
<script>
(function () {
  var CODE = ${JSON.stringify(code)}
  var PATH = ${JSON.stringify(socketIoPath)}
  var SESSION = null
  var socket = io({ path: PATH, query: { relay: CODE }, transports: ['websocket', 'polling'] })
  var log = document.getElementById('log')
  var banner = document.getElementById('banner')
  var streaming = null
  var stick = true
  // debug trail (capped): which events reached this page, for diagnostics
  var trail = []
  window.__events = trail
  function seen(name) {
    trail.push(name + '@' + Math.round(performance.now()))
    if (trail.length > 60) trail.shift()
  }

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML }
  function el(tag, cls, text) {
    var e = document.createElement(tag)
    if (cls) e.className = cls
    if (text != null) e.textContent = text
    return e
  }
  function nearBottom() { return window.innerHeight + window.scrollY >= document.body.scrollHeight - 140 }
  window.addEventListener('scroll', function () { stick = nearBottom() })
  function scroll() { if (stick) window.scrollTo(0, document.body.scrollHeight) }

  function setConn(state, text) {
    var dot = document.getElementById('dot'), dot2 = document.getElementById('dot2')
    dot.className = 'dot ' + state; dot2.className = 'dot ' + state
    document.getElementById('conn').textContent = text
    document.getElementById('state').textContent = text
  }
  function showBanner(kind, html) { banner.className = 'banner ' + kind; banner.innerHTML = html }
  function hideBanner() { banner.className = 'banner' }
  function setPhase(text) { document.getElementById('phase').textContent = text ? '· ' + text : '' }

  function renderTool(c) {
    var icon = c.status === 'done' ? '✓' : c.status === 'error' ? '✗' : c.status === 'denied' ? '⊘' : '…'
    var dur = c.startedAt && c.endedAt ? ' · ' + ((c.endedAt - c.startedAt) / 1000).toFixed(1) + 's' : ''
    var d = el('details', 'tool')
    var s = el('summary')
    var ic = el('span', null, icon + ' ')
    if (c.status === 'done') ic.style.color = '#34d399'
    else if (c.status === 'error') ic.style.color = '#f87171'
    s.appendChild(ic)
    var nm = el('code', null, c.tool || 'tool')
    s.appendChild(nm)
    s.appendChild(document.createTextNode(dur))
    d.appendChild(s)
    var body = el('div', 'tool-body')
    var lab = el('span', 'label', 'input ')
    body.appendChild(lab)
    var inp = el('code')
    inp.innerHTML = esc(JSON.stringify(c.input || {}).slice(0, 300))
    body.appendChild(inp)
    if (c.output) {
      body.appendChild(el('br'))
      var lab2 = el('span', 'label', 'output')
      body.appendChild(lab2)
      var pre = el('pre')
      pre.innerHTML = esc(String(c.output).slice(0, 1500))
      body.appendChild(pre)
    }
    d.appendChild(body)
    return d
  }

  function renderMessage(m) {
    if (!m || (m.meta && m.meta.toolResults)) return
    if (!(m.content || '').trim() && !(m.toolCalls || []).length) return
    var wrap = el('div', 'msg ' + (m.role === 'user' ? 'user' : 'agent'))
    var who = el('div', 'who', m.role === 'user' ? 'user' : 'tagent · ' + (SESSION ? SESSION.model : ''))
    var body = el('div', 'body')
    body.innerHTML = esc(m.content || '')
    wrap.appendChild(who); wrap.appendChild(body)
    ;(m.toolCalls || []).forEach(function (c) { wrap.appendChild(renderTool(c)) })
    log.appendChild(wrap)
    scroll()
  }

  function renderTodos(todos) {
    var sec = document.getElementById('todos'), ul = document.getElementById('todos-list')
    if (!todos || !todos.length) { sec.style.display = 'none'; return }
    sec.style.display = ''
    ul.innerHTML = ''
    var icons = { completed: '☑', in_progress: '◐', pending: '☐' }
    todos.forEach(function (t) {
      var li = el('li', 'todo ' + t.status, (icons[t.status] || '☐') + ' ' + t.content)
      ul.appendChild(li)
    })
    var done = todos.filter(function (t) { return t.status === 'completed' }).length
    document.getElementById('todos-h').textContent = 'Plan · ' + done + '/' + todos.length + ' done'
  }

  function renderSnapshot(h) {
    SESSION = h.session
    document.title = 'Tagent relay — ' + (SESSION.title || 'session')
    document.getElementById('title').textContent = SESSION.title || 'session'
    document.getElementById('meta').innerHTML =
      '<span class="badge live"><span class="dot on" id="dot"></span><span id="conn">live</span></span>' +
      '<span class="badge">mode: ' + esc(SESSION.mode) + '</span>' +
      '<span class="badge">model: ' + esc(SESSION.model) + '</span>' +
      '<span class="badge">' + (SESSION.messageCount || (SESSION.messages || []).length) + ' messages</span>' +
      '<span class="badge">created ' + esc(new Date(SESSION.createdAt).toLocaleString()) + '</span>'
    log.innerHTML = ''
    streaming = null
    ;(SESSION.messages || []).forEach(renderMessage)
    renderTodos(SESSION.todos)
    setPhase(h.running ? 'run in progress…' : '')
    scroll()
  }

  function onMessage(p) {
    if (!p || !p.message) return
    if (SESSION && p.sessionId && p.sessionId !== SESSION.id) return
    if (p.message.role === 'assistant' && streaming) { streaming.remove(); streaming = null }
    renderMessage(p.message)
  }

  function onChunk(p) {
    if (!p || !SESSION || p.sessionId !== SESSION.id) return
    if (!streaming) {
      streaming = el('div', 'msg agent')
      streaming.appendChild(el('div', 'who', 'tagent · ' + SESSION.model))
      streaming.body = el('div', 'body')
      streaming.appendChild(streaming.body)
      log.appendChild(streaming)
    }
    streaming.body.textContent += p.text || ''
    scroll()
  }

  var liveTools = {}
  function onToolStart(p) {
    if (!p || !p.call || (SESSION && p.sessionId && p.sessionId !== SESSION.id)) return
    var line = el('details', 'tool')
    line.innerHTML = '<summary><span style="color:#a1a1aa">… </span><code>' + esc(p.call.tool) + '</code> running…</summary>'
    log.appendChild(line)
    liveTools[p.call.id || p.call.tool] = line
    scroll()
  }
  function onToolEnd(p) {
    if (!p || !p.call) return
    var key = p.call.id || p.call.tool
    var line = liveTools[key]
    if (line) { line.remove(); delete liveTools[key] }
    if (SESSION && p.sessionId && p.sessionId !== SESSION.id) return
    log.appendChild(renderTool(p.call))
    scroll()
  }

  socket.on('connect', function () { seen('connect'); setConn('on', 'live'); hideBanner() })
  socket.on('disconnect', function () { seen('disconnect'); setConn('off', 'reconnecting…'); showBanner('warn', 'connection lost — reconnecting…') })
  socket.on('connect_error', function (e) {
    seen('connect_error')
    setConn('err', 'unreachable')
    showBanner('error', 'relay link refused: ' + esc(e && e.message ? e.message : 'unknown error'))
  })
  socket.on('relay:hello', function (h) {
    seen('relay:hello')
    if (!h || !h.session) { showBanner('error', 'this session no longer exists — the share has ended.'); socket.close(); return }
    renderSnapshot(h)
  })
  socket.on('message:new', function (p) { seen('message:new:' + (p && p.message ? p.message.role : '?')); onMessage(p) })
  socket.on('agent:chunk', function (p) { seen('chunk'); onChunk(p) })
  socket.on('tool:start', function (p) { seen('tool:start'); onToolStart(p) })
  socket.on('tool:end', function (p) { seen('tool:end'); onToolEnd(p) })
  socket.on('todos:update', function (p) { seen('todos'); if (!SESSION || !p.sessionId || p.sessionId === SESSION.id) renderTodos(p && p.todos) })
  socket.on('agent:status', function (p) { seen('status'); setPhase(p && p.detail ? p.detail : (p && p.phase) || '') })
  socket.on('subagent:update', function (p) {
    if (!p || !p.info) return
    var i = p.info
    var line = el('div', 'divider', '▸ subagent ' + (i.title || i.name || '') + (i.status ? ' — ' + i.status : ''))
    log.appendChild(line)
    scroll()
  })
  socket.on('chat:done', function (p) {
    if (SESSION && p.sessionId && p.sessionId !== SESSION.id) return
    var s = p && p.summary
    var text = '— run finished' + (s ? ' · ' + (s.turns || 0) + ' turns · ' + (s.toolCalls || 0) + ' tool calls' : '') + ' —'
    log.appendChild(el('div', 'divider', text))
    setPhase('')
    scroll()
  })
  socket.on('relay:revoked', function () {
    setConn('err', 'ended')
    showBanner('error', 'the owner ended this share.')
    socket.close()
  })
})()
</script>
</body>
</html>`
}
