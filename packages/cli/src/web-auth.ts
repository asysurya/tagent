/**
 * web-auth.ts — `tagent auth --web`, the browser-based login ("web connect").
 *
 * The CLI starts a tiny HTTP server bound to 127.0.0.1 (loopback ONLY —
 * nothing is ever reachable from the network), opens the browser on a
 * one-time secret URL and waits.
 *
 * Two ways to log in from the page:
 *   1. OAuth device flow ("Connect with GitHub" — one button): the page
 *      redirects to GitHub with the code pre-filled (verification_uri_complete),
 *      the user presses Authorize there, and the CLI polls GitHub until the
 *      token arrives. Needs an OAuth App client id (see getOAuthClientId);
 *      when none is configured the button isn't rendered at all.
 *   2. Paste a PAT — the classic flow, always available ("Paste a token
 *      instead"). The CLI validates it against the GitHub API.
 *
 * Security shape:
 *   - loopback bind, random port — the token never leaves the machine
 *   - one-time random secret in the URL path → drive-by CSRF from a random
 *     web page can't hit an endpoint it can't name
 *   - Origin/Referer checked on POST (same host only, when present)
 *   - the OAuth routes are GETs under the same secret path: authorize only
 *     STARTS a device flow (the token lands in this process, never in a
 *     browser-controlled URL), poll is read-only status
 *   - one-shot: after a successful login the server stops accepting tokens
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
import {
  validatePat,
  startDeviceLogin,
  pollDeviceTokenOnce,
  deviceUrl,
  type DeviceCodeStart,
  type DevicePollResult,
} from '@tagent/core'

/* ------------------------------------------------------------------ */
/* public surface                                                      */
/* ------------------------------------------------------------------ */

export interface WebLoginResult {
  token: string
  login: string
}

/** OAuth device-flow hooks — every piece is injectable for tests. */
export interface OAuthHooks {
  clientId: string
  start?: (clientId: string) => Promise<DeviceCodeStart>
  pollOnce?: (clientId: string, deviceCode: string) => Promise<DevicePollResult>
  validate?: (token: string) => Promise<string>
}

export interface WebLoginOptions {
  /** validate a token → GitHub login. Default: the real GitHub API call. */
  validate?: (token: string) => Promise<string>
  /** enable the one-click OAuth button on the page. */
  oauth?: OAuthHooks
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
/* the local page — self-contained, dark, no external requests           */
/* ------------------------------------------------------------------ */

/** Rendered per request: OAUTH block only when a client id is available. */
const OAUTH_BLOCK = `
  <div id="oauth">
    <a id="cta" class="cta" href="oauth/authorize" target="_blank" rel="noopener">Connect with GitHub&nbsp;&nbsp;↗</a>
    <div id="wait" class="hidden">
      <p class="w1">Waiting for GitHub… press <b>Authorize</b> in the other tab.</p>
      <p class="w2">Nothing opened? Go to <a id="vurl" href="https://github.com/login/device" target="_blank" rel="noreferrer">github.com/login/device</a> and enter:</p>
      <div class="ucode"><code id="uc">····-····</code><button id="copy" type="button">copy</button></div>
    </div>
    <div id="oerr" class="msg err" role="alert"></div>
    <p class="alt"><a href="#" id="swap">Paste a token instead →</a></p>
  </div>`

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
  a.cta {
    display: block; text-align: center; background: #f97316; color: #18181b;
    border: 0; border-radius: 10px; padding: 14px; font-size: 15px; font-weight: 800;
    text-decoration: none; letter-spacing: .01em;
  }
  a.cta:hover { background: #fb923c; text-decoration: none }
  #wait { margin-top: 16px; text-align: center }
  #wait .w1 { color: #d4d4d8; font-size: 13.5px }
  #wait .w2 { color: #71717a; font-size: 12px; margin-top: 8px }
  #wait .w2 a { color: #fb923c; text-decoration: none }
  .ucode { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 8px }
  .ucode code {
    background: #09090b; border: 1px solid #27272a; border-radius: 8px; color: #fafafa;
    padding: 8px 14px; font: 700 17px ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: .08em;
  }
  .ucode button {
    width: auto; margin: 0; background: #27272a; color: #d4d4d8; border: 0; border-radius: 8px;
    padding: 8px 10px; font-size: 12px; font-weight: 600; cursor: pointer;
  }
  .ucode button:hover { background: #3f3f46 }
  p.alt { text-align: center; margin-top: 16px }
  p.alt a { color: #71717a; font-size: 12.5px; text-decoration: none }
  p.alt a:hover { color: #a1a1aa; text-decoration: underline }
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
<body data-done="__LOGIN__">
<div class="card">
  <div class="mark"><div class="dot">t</div><span>tagent</span></div>
  <h1>Connect GitHub</h1>
  <p class="sub" id="subline">Sync your projects to private repos and continue them on any device.</p>

  <!--OAUTH-->

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
           autocomplete="off" autocapitalize="off" spellcheck="false">
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
      ok = document.getElementById('ok'), who = document.getElementById('who'),
      cta = document.getElementById('cta'), wait = document.getElementById('wait'),
      uc = document.getElementById('uc'), oerr = document.getElementById('oerr'),
      swap = document.getElementById('swap'), copy = document.getElementById('copy'),
      subline = document.getElementById('subline');
  var OAUTH = !!cta, pollT = null;

  function show(e, m) { e.textContent = m; e.style.display = 'block' }
  function hide(e) { e.style.display = 'none' }

  function success(login) {
    if (pollT) { clearInterval(pollT); pollT = null }
    if (cta) cta.classList.add('hidden');
    if (wait) wait.classList.add('hidden');
    if (oerr) hide(oerr);
    form.classList.add('hidden');
    who.textContent = login ? 'as ' + login : '';
    ok.style.display = 'block';
    document.title = '✔ connected' + (login ? ' — ' + login : '');
  }

  /* already done when the page was served (e.g. a second tab) */
  var doneLogin = document.body.getAttribute('data-done');
  if (doneLogin) success(doneLogin);

  /* ---------------------------------------------------------------- OAuth */
  function pollOnce() {
    fetch('oauth/poll').then(function (r) { return r.json() }).then(function (j) {
      if (j.user_code && uc.textContent !== j.user_code) uc.textContent = j.user_code;
      if (j.status === 'ok') { success(j.login); return }
      if (j.status === 'error') {
        if (pollT) { clearInterval(pollT); pollT = null }
        wait.classList.add('hidden');
        show(oerr, j.error || 'GitHub said no — try again.');
        cta.classList.remove('hidden');
        return
      }
      if (j.status === 'pending' && !pollT) pollT = setInterval(pollOnce, 3000);
    }).catch(function () { if (!pollT) pollT = setInterval(pollOnce, 3000) });
  }

  if (OAUTH) {
    cta.addEventListener('click', function () {
      cta.classList.remove('hidden');           // stays: "reopen GitHub" on misclicks
      wait.classList.remove('hidden');
      hide(oerr);
      if (!pollT) pollT = setInterval(pollOnce, 3000);
      pollOnce();
    });
    swap.addEventListener('click', function (e) {
      e.preventDefault();
      cta.classList.add('hidden'); wait.classList.add('hidden'); hide(oerr);
      form.classList.remove('hidden');
      if (pollT) { clearInterval(pollT); pollT = null }
      subline.textContent = '…or log in with a personal access token.';
      inp.focus();
    });
    copy.addEventListener('click', function () {
      var t = uc.textContent;
      if (navigator.clipboard) { navigator.clipboard.writeText(t).catch(function () {}) }
    });
    pollOnce(); // resume the waiting UI if the page was reloaded mid-flow
  }

  /* ------------------------------------------------------------------ PAT */
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
        success(j.login);
      } else {
        show(err, j.error || 'Login failed — check the token and try again.');
        btn.disabled = false; btn.textContent = 'Connect'; inp.focus(); inp.select();
      }
    }).catch(function () {
      show(err, 'Could not reach tagent — is the terminal still waiting?');
      btn.disabled = false; btn.textContent = 'Connect';
    });
  }
  if (!OAUTH && !doneLogin) inp.focus();
  btn.addEventListener('click', submit);
  inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit() });
</script>
</body>
</html>`

/** The page, with the OAuth block only when a client id exists (and the done-login baked in). */
function renderPage(oauthOn: boolean, doneLogin: string | null): string {
  let out = PAGE.replace('<!--OAUTH-->', oauthOn ? OAUTH_BLOCK : '').replace('__LOGIN__', doneLogin ?? '')
  if (oauthOn) out = out.replace('<div id="form">', '<div id="form" class="hidden">')
  return out
}

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
 *   start loopback server → open browser → wait for a valid token
 *   (OAuth button when a client id is given, PAT paste always).
 *
 * Resolves with { token, login } once the GitHub API accepted the token
 * (so callers can skip re-validating it). Rejects on timeout or when the
 * server can't start. Ctrl+C simply kills the process — nothing persisted.
 */
export function runWebLogin(opts: WebLoginOptions = {}): Promise<WebLoginResult> {
  const validate = opts.validate ?? validatePat
  const oauth = opts.oauth?.clientId
    ? {
        clientId: opts.oauth.clientId,
        start: opts.oauth.start ?? startDeviceLogin,
        pollOnce: opts.oauth.pollOnce ?? pollDeviceTokenOnce,
        validate: opts.oauth.validate ?? opts.validate ?? validatePat,
      }
    : null
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000

  return new Promise<WebLoginResult>((resolve, reject) => {
    // one-time secret: 22 url-safe chars of entropy in the path
    const secret = crypto.randomBytes(16).toString('base64url')
    let done: WebLoginResult | null = null
    let timer: ReturnType<typeof setTimeout> | undefined

    /**
     * The one success path — one-shot, staged teardown. The listener keeps
     * serving for 2s so the BROWSER gets its final poll (status=ok → the ✔
     * card); without the grace window the page's next poll would hit a
     * refused connection instead of the success state.
     */
    const finish = (token: string, login: string) => {
      done = { token, login }
      if (timer) clearTimeout(timer)
      resolve(done) // the CLI prints success while the page still shows
      setTimeout(() => {
        try {
          server.close() // no new connections; existing sockets live on
        } catch { /* already closing */ }
        setTimeout(() => {
          try {
            server.closeAllConnections?.()
            server.unref()
          } catch { /* already gone */ }
        }, 2000)
      }, 2000)
    }

    /* ---- the OAuth device flow state (null until authorize is hit) ---- */
    let flow: { start: DeviceCodeStart; token?: string; login?: string; error?: string } | null = null

    const runFlow = (start: DeviceCodeStart) => {
      flow = { start }
      const clientId = oauth!.clientId
      void (async () => {
        let waitMs = Math.max((start.interval ?? 5) * 1000, 3000)
        const deadline = Date.now() + (start.expires_in ?? 900) * 1000
        while (!done && !flow?.error && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, waitMs))
          if (done) return
          let r: DevicePollResult
          try {
            r = await oauth!.pollOnce(clientId, start.device_code)
          } catch (e) {
            flow!.error = `could not reach GitHub: ${(e as Error).message}`
            return
          }
          if (r.status === 'ok') {
            flow!.token = r.token
            try {
              const login = await oauth!.validate(r.token)
              flow!.login = login
              finish(r.token, login)
            } catch (e) {
              flow!.error = `GitHub's token didn't validate: ${(e as Error).message}`
            }
            return
          }
          if (r.status === 'slow_down') {
            waitMs = Math.min(waitMs + 5000, 30000) // GitHub asked to back off
            continue
          }
          if (r.status === 'error') {
            flow!.error = r.error
            return
          }
        }
        if (!done && flow && !flow.error) flow.error = 'device flow timed out'
      })()
    }

    const server = http.createServer((req, res) => {
      const send = (status: number, body: string, type = 'application/json') => {
        res.writeHead(status, {
          'content-type': type,
          'cache-control': 'no-store',
          pragma: 'no-cache',
        })
        res.end(body)
      }
      const redirect = (location: string) => {
        res.writeHead(302, { location, 'cache-control': 'no-store' })
        res.end()
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
        return send(200, renderPage(!!oauth, done ? done.login : null), 'text/html; charset=utf-8')
      }
      if (req.method === 'GET' && sub === 'favicon.ico') {
        res.writeHead(204, { 'cache-control': 'no-store' })
        return res.end()
      }

      /* ---- OAuth: one click → GitHub with the code pre-filled ---- */
      const pagePath = `/${secret}/`
      if (req.method === 'GET' && sub === 'oauth/authorize') {
        if (!oauth) return send(404, '{"ok":false,"error":"oauth not configured"}')
        if (done) return redirect(pagePath) // page shows the ✔ card (data-done)
        if (flow && !flow.error && !flow.token) {
          // already in flight (double-click, second tab) — same code page
          return redirect(deviceUrl(flow.start))
        }
        try {
          const start = oauth.start(oauth.clientId)
          // async handler — the navigation awaits the GitHub round-trip
          void start
            .then((s) => {
              runFlow(s)
              redirect(deviceUrl(s))
            })
            .catch((e) => {
              const msg = encodeURIComponent(
                `could not reach GitHub: ${(e as Error).message}`,
              )
              redirect(`${pagePath}?e=${msg}`)
            })
        } catch (e) {
          const msg = encodeURIComponent(`could not reach GitHub: ${(e as Error).message}`)
          return redirect(`${pagePath}?e=${msg}`)
        }
        return
      }
      if (req.method === 'GET' && sub === 'oauth/poll') {
        const body: Record<string, unknown> = {}
        if (done) {
          body.status = 'ok'
          body.login = done.login
        } else if (flow?.error) {
          body.status = 'error'
          body.error = flow.error
        } else if (flow?.login) {
          body.status = 'ok'
          body.login = flow.login // resolved a tick ago; loop is finishing
        } else if (flow) {
          body.status = 'pending'
          body.user_code = flow.start.user_code
        } else {
          body.status = 'idle'
        }
        return send(200, JSON.stringify(body))
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
            send(200, JSON.stringify({ ok: true, login }))
            finish(token, login)
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
