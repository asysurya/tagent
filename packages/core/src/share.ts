import fs from 'node:fs'
import path from 'node:path'
import type { SessionData, ToolCallRecord } from './types'

/**
 * Share links — export a session as a single standalone HTML file.
 *
 * The file is fully self-contained (inline CSS, zero JS dependencies) so it
 * can be served by the daemon at /share/<id>.html, opened from disk, or sent
 * to anyone. Read-only by design: it is a snapshot, not a live session.
 */

export function shareDir(root: string): string {
  return path.join(root, '.tagent', 'shares')
}

export interface ShareResult {
  id: string
  /** absolute path of the exported html file */
  file: string
  /** relative url when the daemon serves this workspace */
  url: string
}

export function exportShare(root: string, session: SessionData): ShareResult {
  const dir = shareDir(root)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${session.id}.html`)
  fs.writeFileSync(file, renderShareHtml(session), 'utf8')
  return { id: session.id, file, url: `/share/${session.id}.html` }
}

/** Safe to call on a request path — only [a-z0-9_-]+.html passes. */
export function readShareFile(root: string, name: string): string | undefined {
  if (!/^[a-zA-Z0-9_-]+\.html$/.test(name)) return undefined
  const file = path.join(shareDir(root), name)
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ */
/* html rendering                                                      */
/* ------------------------------------------------------------------ */

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

function renderToolCall(c: ToolCallRecord): string {
  const icon = c.status === 'done' ? '✓' : c.status === 'error' ? '✗' : c.status === 'denied' ? '⊘' : '…'
  const color = c.status === 'done' ? '#34d399' : c.status === 'error' ? '#f87171' : '#a1a1aa'
  const dur =
    c.startedAt && c.endedAt ? ` · ${((c.endedAt - c.startedAt) / 1000).toFixed(1)}s` : ''
  const input = esc(JSON.stringify(c.input ?? {}).slice(0, 300))
  const output = c.output ? `<pre>${esc(c.output.slice(0, 1500))}</pre>` : ''
  return `
    <details class="tool">
      <summary><span style="color:${color}">${icon}</span> <code>${esc(c.tool)}</code>${dur}</summary>
      <div class="tool-body"><span class="label">input</span> <code>${input}</code>${output ? `<br><span class="label">output</span>${output}` : ''}</div>
    </details>`
}

function renderTodos(session: SessionData): string {
  if (!session.todos?.length) return ''
  const icons: Record<string, string> = { completed: '☑', in_progress: '◐', pending: '☐' }
  const items = session.todos
    .map(
      (t) =>
        `<li class="todo ${t.status}"><span>${icons[t.status] ?? '☐'}</span> ${esc(t.content)}${
          t.priority ? ` <small>(${t.priority})</small>` : ''
        }</li>`,
    )
    .join('')
  const done = session.todos.filter((t) => t.status === 'completed').length
  return `
  <section class="card">
    <h2>Plan · ${done}/${session.todos.length} done</h2>
    <ul class="todos">${items}</ul>
  </section>`
}

export function renderShareHtml(session: SessionData): string {
  const msgs = session.messages.filter(
    (m) => !m.meta?.toolResults && m.content.trim().length > 0,
  )
  const body = msgs
    .map((m) => {
      if (m.role === 'user') {
        return `<div class="msg user"><div class="who">user</div><div class="body">${esc(m.content)}</div></div>`
      }
      const tools = (m.toolCalls ?? []).map(renderToolCall).join('')
      return `<div class="msg agent"><div class="who">tagent · ${esc(session.model)}</div><div class="body">${esc(m.content)}${tools}</div></div>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Tagent share — ${esc(session.title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.6 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
         background: #09090b; color: #d4d4d8; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 24px 16px 64px; }
  header { border-bottom: 1px solid #27272a; padding-bottom: 16px; margin-bottom: 24px; }
  h1 { font-size: 16px; margin: 0 0 6px; color: #fafafa; }
  .meta { color: #71717a; font-size: 12px; }
  .badge { display: inline-block; border: 1px solid #3f3f46; border-radius: 999px; padding: 1px 8px;
            font-size: 11px; color: #a1a1aa; margin-right: 6px; }
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
  footer { margin-top: 32px; color: #52525b; font-size: 11px; text-align: center; }
  a { color: #93c5fd; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${esc(session.title)}</h1>
    <div class="meta">
      <span class="badge">mode: ${esc(session.mode)}</span>
      <span class="badge">model: ${esc(session.model)}</span>
      <span class="badge">${session.messageCount} messages</span>
      <span class="badge">created ${esc(fmtTime(session.createdAt))}</span>
    </div>
  </header>
  ${renderTodos(session)}
  <main>${body || '<p class="meta">(empty session)</p>'}</main>
  <footer>read-only share exported by <a href="https://github.com/asysurya/tagent">Tagent</a> · ${esc(fmtTime(Date.now()))}</footer>
</div>
</body>
</html>`
}
