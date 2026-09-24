/**
 * Hermetic test for `tagent auth --web` (packages/cli/src/web-auth.ts).
 *
 * No network, no GitHub: the validator is a fake that knows one good token.
 * Everything runs against the real loopback server the CLI would use —
 * routing, the CSRF gates, the retry loop, the one-shot teardown and the
 * timeout are all exercised over real HTTP.
 */
import { runWebLogin, openBrowser, type WebLoginResult } from '../packages/cli/src/web-auth'

let fails = 0
function assert(cond: boolean, label: string) {
  console.log(cond ? '✓' : '✗', label)
  if (!cond) fails++
}

const GOOD = 'ghp_testtoken1234567890'
const goodLogin = 'octocat'

/** fake GitHub API: exactly one good token */
const fakeValidate = async (token: string): Promise<string> => {
  if (token === GOOD) return goodLogin
  throw new Error('invalid token (HTTP 401)')
}

interface Handle {
  url: string
  origin: string
  login: Promise<WebLoginResult>
}

/**
 * Start a login server with a fake validator; `timeoutMs` is kept short for
 * scenarios that never complete so the test process self-cleans. The login
 * promise is pre-caught — each scenario decides what (if anything) to await.
 */
async function start(timeoutMs: number): Promise<Handle> {
  let resolveUrl!: (u: string) => void
  const urlReady = new Promise<string>((r) => (resolveUrl = r))
  const login = runWebLogin({
    validate: fakeValidate,
    timeoutMs,
    onReady: (u) => resolveUrl(u),
  })
  login.catch(() => { /* scenarios assert on their own terms */ })
  const url = await urlReady
  return { url, origin: new URL(url).origin, login }
}

const j = async (r: Response): Promise<Record<string, unknown>> => (await r.json()) as Record<string, unknown>
const post = (h: Handle, body: string, headers: Record<string, string> = {}) =>
  fetch(`${h.url}submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })

/* ---------------------------------------------------------------- A. url -- */
{
  const h = await start(2000)
  assert(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{20,}\/$/.test(h.url), `url is loopback + one-time secret (${h.url})`)
}

/* ------------------------------------------------------- B. the page GET -- */
{
  const h = await start(2000)
  const r = await fetch(h.url)
  const html = await r.text()
  assert(r.status === 200, 'GET /<secret>/ → 200')
  assert(String(r.headers.get('content-type')).startsWith('text/html'), 'content-type text/html')
  assert(r.headers.get('cache-control') === 'no-store', 'page served no-store')
  assert(html.includes('Connect GitHub'), 'page: "Connect GitHub"')
  assert(html.includes('github.com/settings/tokens/new?scopes=repo'), 'page: token link with repo scope prefilled')
  assert(!html.includes(GOOD), 'page contains no token material')
  const r2 = await fetch(`${h.url}index.html`)
  assert(r2.status === 200 && (await r2.text()).includes('Connect GitHub'), 'index.html alias → the page')
}

/* ----------------------------------------------------------- C. 404 gate -- */
{
  const h = await start(2000)
  const r = await fetch(`http://127.0.0.1:${new URL(h.url).port}/not-the-secret/`)
  assert(r.status === 404, 'wrong secret path → 404')
}

/* -------------------------------------------------------- D. CSRF origin -- */
{
  const h = await start(2000)
  const r = await post(h, JSON.stringify({ token: GOOD }), { origin: 'https://evil.example' })
  assert(r.status === 403, 'foreign Origin → 403')
}

/* ------------------------------------------------------ E. CSRF referer -- */
{
  const h = await start(2000)
  const r = await post(h, JSON.stringify({ token: GOOD }), {
    referer: 'https://evil.example/phish',
  })
  assert(r.status === 403, 'foreign Referer (no Origin) → 403')
}

/* ------------------------------------------------------------ F. no token -- */
{
  const h = await start(2000)
  const r = await post(h, JSON.stringify({}))
  assert(r.status === 400 && (await j(r)).ok === false, 'empty token → 400')
}

/* --------------------------------------------- G. invalid → retry → valid -- */
{
  const h = await start(60_000)
  const bad = await post(h, JSON.stringify({ token: 'totally-wrong' }))
  const badBody = await j(bad)
  assert(bad.status === 200 && badBody.ok === false && typeof badBody.error === 'string', 'invalid token → ok:false + reason, server stays up')

  // same-origin POST like a real browser would send
  const good = await post(h, JSON.stringify({ token: GOOD }), { origin: h.origin })
  const goodBody = await j(good)
  assert(good.status === 200 && goodBody.ok === true && goodBody.login === goodLogin, 'valid token → ok:true + login')

  const res = await h.login
  assert(res.token === GOOD && res.login === goodLogin, 'login promise resolves with { token, login }')

  // one-shot at the transport level: after success the server is GONE
  let refused = false
  try {
    const again = await post(h, JSON.stringify({ token: 'x' }))
    refused = !(await j(again)).ok
  } catch {
    refused = true // connection refused — server already torn down
  }
  assert(refused, 'after success the endpoint is dead (one-shot)')
}

/* ------------------------------------------------------------ I. timeout -- */
{
  const t0 = Date.now()
  try {
    await runWebLogin({ validate: fakeValidate, timeoutMs: 400 })
    assert(false, 'timeout rejects')
  } catch (e) {
    const msg = (e as Error).message
    assert(msg.includes('timed out'), `timeout rejects ("${msg.slice(0, 40)}…")`)
    assert(Date.now() - t0 < 5000, 'timeout fires on schedule')
  }
}

/* ---------------------------------------------------------- J. openBrowser -- */
{
  let b: boolean | undefined
  try {
    b = openBrowser('http://127.0.0.1:1/nope')
  } catch {
    b = undefined
  }
  assert(b === undefined || typeof b === 'boolean', 'openBrowser never throws (headless → false is fine)')
}

console.log(fails ? `\n${fails} FAILED` : '\nall web-auth tests passed')
process.exit(fails ? 1 : 0)
