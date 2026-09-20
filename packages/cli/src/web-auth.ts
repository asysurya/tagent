/**
 * web-auth.ts — `tagent auth --web`, the browser-based login ("web connect").
 *
 * The CLI starts a tiny HTTP server bound to 127.0.0.1 (loopback ONLY —
 * nothing is ever reachable from the network), opens the browser on a
 * one-time secret URL and waits. The page walks the user through creating
 * a GitHub token and pasting it there instead of in the terminal; the CLI
 * validates it against the GitHub API, stores it exactly like `tagent auth`
 * does, and the whole server evaporates. No web service, no telemetry,
 * no account — just a better input box.
 *
 * Security shape:
 *   - loopback bind, random port — the token never leaves the machine
 *   - one-time random secret in the URL path → drive-by CSRF from a random
 *     web page can't hit an endpoint it can't name
 *   - Origin/Referer checked on POST (same host only, when present)
 *   - one-shot: after a successful login the endpoint stops accepting tokens
 *   - page served `no-store`, token field autocomplete=off
 *   - 10-minute timeout, then the server is gone
 *
 * On UserLAnd/proot there is no `open` command — but proot shares the
 * network namespace with Android, so the URL is printed for the user to
 * open in the phone's own browser (127.0.0.1 works there).
 */

import http from 'node:http'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { validatePat } from '@tagent/core'

/* ------------------------------------------------------------------ */
/* public surface                                                      */
/* ------------------------------------------------------------------ */

export interface WebLoginResult {
  token: string
  login: string
}

export interface WebLoginOptions {
  /** validate a token → GitHub login. Default: the real GitHub API call. */
  validate?: (token: string) => Promise<string>
  /** give up after this long. Default: 10 minutes. */
  timeoutMs?: number
  /**
   * Called once the server is listening — the one-time URL to hand to the
   * browser. The caller opens it (or prints it for manual opening, e.g. on
   * UserLAnd); keeping it out of here keeps this module UI-free.
   */
  onReady?: (url: string) => void
}

/* ------------------------------------------------------------------ */
/* the local page — self-contained, dark, no external requests         */
/* ------------------------------------------------------------------ */

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>tagent — connect GitHub</title>
<style>
  :root { color-scheme: dark }
  * { box-sizing: border-box; margin: 0 }
  body {
    min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: #09090b; color: #fafafa;
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .card {
    width: 100%; max-width: 430px; background: #18181b; border: 1px solid #27272a;
    border-radius: 14px; padding: 28px;
  }
  .mark { display: flex; align-items: center; gap: 10px; margin-bottom: 6px }
  .mark .dot { width: 22px; height: 22px; border-radius: 6px; background: #f97316;
    display: grid; place-items: center; color: #18181b; font-weight: 800; font-size: 13px }
  .mark span { font-weight: 700; letter-spacing: .02em }
  h1 { font-size: 19px; margin: 14px 0 4px }
  p.sub { color: #a1a1aa; font-size: 13.5px; margin-bottom: 22px }
  .step { display: flex; gap: 12px; margin-bottom: 18px }
  .step .n { flex: none; width: 22px; height: 22px; border-radius: 999px;
    border: 1px solid #3f3f46; color: #a1a1aa; font-size: 12px;
    display: grid; place-items: center; margin-top: 1px }
  .step p { color: #d4d4d8; font-size: 13.5px }
  .step a { color: #fb923c; text-decoration: none; font-weight: 600 }
  .step a:hover { color: #fdba74; text-decoration: underline }
  input {
    width: 100%; background: #09090b; border: 1px solid #27272a; border-radius: 8px;
    color: #fafafa; padding: 11px 12px; font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace;
    outline: none;
  }
  input:focus { border-color: #f97316 }
  button {
    width: 100%; margin-top: 12px; background: #f97316; color: #18181b; border: 0;
    border-radius: 8px; padding: 11px; font-size: 14px; font-weight: 700; cursor: pointer;
  }
  button:hover { background: #fb923c }
  button:disabled { opacity: .55; cursor: default }
  .msg { margin-top: 14px; border-radius: 8px; padding: 10px 12px; font-size: 12.5px; display: none }
  .err  { background: #450a0a; border: 1px solid #7f1d1d; color: #fca5a5; word-break: break-word }
  .ok   { background: #052e16; border: 1px solid #14532d; color: #86efac; text-align: center }
  .ok b { display: block; font-size: 20px; margin: 2px 0 }
  .done { color: #71717a; font-size: 12px; text-align: center; margin-top: 10px }
  footer { color: #52525b; font-size: 11.5px; line-height: 1.7; margin-top: 20px;
    border-top: 1px solid #27272a; padding-top: 14px }
  code { color: #a1a1aa }
  .hidden { display: none !important }
</style>
</head>
<body>
<div class="card">
  <div class="mark"><div class="dot">t</div><span>tagent</span></div>
  <h1>Connect GitHub</h1>
  <p class="sub">Sync your projects to private repos and continue them on any device.</p>

  <div id="form">
    <div class="step">
      <div class="n">1</div>
      <p><a href="https://github.com/settings/tokens/new?scopes=repo&amp;description=tagent"
            target="_blank" rel="noreferrer">Create a token</a> — the <code>repo</code>
          scope is pre-selected for you.</p>
    </div>
    <div class="step">
      <div class="n">2</div>
      <p>Paste it below. It's stored on this machine only
         (<code>~/.tagent/credentials.json</code>) and never leaves it.</p>
    </div>
    <input id="token" type="password" placeholder="ghp_… or github_pat_…"
           autocomplete="off" autocapitalize="off" spellcheck="false" autofocus>
    <button id="go" type="button">Connect</button>
    <div id="err" class="msg err" role="alert"></div>
  </div>

  <div id="ok" class="msg ok">
    <b>✔ Connected</b><span id="who"></span>
    <div class="done">You can close this tab and go back to the terminal.</div>
  </div>

  <footer>
    This page is served by your own <code>tagent</code> process on
    <code>127.0.0.1</code> — it exists only for this login and shuts down
    afterwards. Prefer the terminal? <code>Ctrl+C</code> here, then
    <code>tagent auth</code>.
  </footer>
</div>
<script>
  var inp = document.getElementById('token'), btn = document.getElementById('go'),
      err = document.getElementById('err'), form = document.getElementById('form'),
      ok = document.getElementById('ok'), who = document.getElementById('who');
  function show(e, m) { e.textContent = m; e.style.display = 'block' }
  function submit() {
    var t = inp.value.trim();
    if (!t || btn.disabled) return;
    btn.disabled = true; err.style.display = 'none'; btn.textContent = 'Connecting…';
    fetch('submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: t })
    }).then(function (r) { return r.json() }).then(function (j) {
      if (j.ok) {
        who.textContent = 'as ' + j.login;
        form.classList.add('hidden'); show(ok, '');
        document.title = '✔ connected — ' + j.login;
      } else {
        show(err, j.error || 'Login failed — check the token and try again.');
        btn.disabled = false; btn.textContent = 'Connect'; inp.focus(); inp.select();
      }
    }).catch(function () {
      show(err, 'Could not reach tagent — is the terminal still waiting?');
      btn.disabled = false; btn.textContent = 'Connect';
    });
  }
  btn.addEventListener('click', submit);
  inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit() });
  inp.focus();
</script>
</body>
</html>`

/* ------------------------------------------------------------------ */
/* browser opening — best effort, never fatal                          */
/* ------------------------------------------------------------------ */

function sh(cmd: string, openArgs: string[]): boolean {
  try {
    const r = spawnSync(cmd, openArgs, { stdio: 'ignore', timeout: 5000 })
    return r.status === 0
  } catch {
    return false
  }
}

/**
 * Open a URL in the user's browser. Returns false when nothing worked
 * (headless box, UserLAnd, ssh without -X…) — callers then print the URL.
 */
export function openBrowser(url: string): boolean {
  try {
    if (process.platform === 'darwin') return sh('open', [url])
    if (process.platform === 'win32') return sh('cmd', ['/c', 'start', '', url])
    // linux & friends: the usual suspects, in order of decency
    if (sh('xdg-open', [url])) return true
    if (sh('termux-open-url', [url])) return true // Termux (Android)
    if (sh('gio', ['open', url])) return true
    if (sh('wslview', [url])) return true // WSL
    return false
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* the login server                                                    */
/* ------------------------------------------------------------------ */

/**
 * Run the whole web-connect flow:
 *   start loopback server → open browser → wait for a valid token.
 *
 * Resolves with { token, login } once the GitHub API accepted the token
 * (so callers can skip re-validating it). Rejects on timeout or when the
 * server can't start. Ctrl+C simply kills the process — nothing persisted.
 */
export function runWebLogin(opts: WebLoginOptions = {}): Promise<WebLoginResult> {
  const validate = opts.validate ?? validatePat
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000

  return new Promise<WebLoginResult>((resolve, reject) => {
    // one-time secret: 22 url-safe chars of entropy in the path
    const secret = crypto.randomBytes(16).toString('base64url')
    let done: WebLoginResult | null = null
    let timer: ReturnType<typeof setTimeout> | undefined

    const server = http.createServer((req, res) => {
      const send = (status: number, body: string, type = 'application/json') => {
        res.writeHead(status, {
          'content-type': type,
          'cache-control': 'no-store',
          pragma: 'no-cache',
        })
        res.end(body)
      }

      // ── route: everything lives under /<secret>/… ──
      const url = req.url ?? '/'
      if (!url.startsWith(`/${secret}`)) {
        return send(404, '{"ok":false,"error":"not found"}')
      }
      // '' (or '/') → the page; 'submit'; 'favicon.ico'. The leading slash
      // of "/<secret>/submit" is why we normalize — a fetch('submit') from
      // the page resolves relative to "/<secret>/" and lands here.
      const sub = url
        .slice(secret.length + 1)
        .split('?')[0]
        .replace(/^\//, '')

      if (req.method === 'GET' && (sub === '' || sub === 'index.html')) {
        return send(200, PAGE, 'text/html; charset=utf-8')
      }
      if (req.method === 'GET' && sub === 'favicon.ico') {
        res.writeHead(204, { 'cache-control': 'no-store' })
        return res.end()
      }

      if (req.method === 'POST' && sub === 'submit') {
        // CSRF belt & suspenders: browsers send Origin on same-origin POSTs;
        // anything naming another origin (or referer) is someone else's page.
        const allowed = new Set<string>()
        const host = req.headers.host ?? ''
        allowed.add(`http://${host}`)
        const origin = String(req.headers.origin ?? '')
        const referer = String(req.headers.referer ?? '')
        if (origin && !allowed.has(origin)) return send(403, '{"ok":false,"error":"bad origin"}')
        if (!origin && referer) {
          try {
            if (!allowed.has(new URL(referer).origin)) return send(403, '{"ok":false,"error":"bad referer"}')
          } catch { /* unparseable referer — fall through, the secret is the real gate */ }
        }

        if (done) {
          return send(409, JSON.stringify({ ok: false, error: `already connected as ${done.login}`, login: done.login }))
        }

        let body = ''
        req.on('data', (c: Buffer) => {
          body += c
          if (body.length > 64 * 1024) req.destroy() // absurd — drop it
        })
        req.on('end', async () => {
          let token = ''
          try {
            token = String(((JSON.parse(body || '{}') as { token?: string }).token ?? '')).trim()
          } catch { /* not JSON */ }
          if (!token) return send(400, '{"ok":false,"error":"no token given"}')
          try {
            const login = await validate(token)
            done = { token, login }
            send(200, JSON.stringify({ ok: true, login }))
            // tear down in stages: stop listening at once, but let the
            // browser finish reading its "✔ Connected" — killing keep-alive
            // sockets immediately would RST the response mid-read. The 2s
            // sweep makes sure a parked socket can never hold the CLI open
            // forever either.
            if (timer) clearTimeout(timer)
            resolve(done) // the CLI prints success while the page still shows
            try {
              server.close() // no new connections; existing sockets live on
            } catch { /* already closing */ }
            setTimeout(() => {
              try {
                server.closeAllConnections?.()
                server.unref()
              } catch { /* already gone */ }
            }, 2000)
          } catch (e) {
            send(200, JSON.stringify({ ok: false, error: (e as Error).message || 'invalid token' }))
          }
        })
        return
      }

      return send(404, '{"ok":false,"error":"not found"}')
    })

    server.on('error', (e) => {
      if (timer) clearTimeout(timer)
      reject(new Error(`could not start the login server: ${e.message}`))
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('could not determine the local port'))
        server.close()
        return
      }
      const url = `http://127.0.0.1:${addr.port}/${secret}/`
      timer = setTimeout(() => {
        try {
          server.close()
          server.closeAllConnections?.()
          server.unref()
        } catch { /* ignore */ }
        reject(
          new Error(
            'timed out waiting for the browser — run `tagent auth` to paste a token in the terminal instead',
          ),
        )
      }, timeoutMs)
      // resolve() from the request handler is the only success path — the
      // caller decides what to do with the URL (open it, print it, …)
      opts.onReady?.(url)
    })
  })
}
