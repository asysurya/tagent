/**
 * test-web-oauth.ts — one-click OAuth on the web-connect page.
 *
 * The GitHub side is fully mocked through the OAuth hooks (start / pollOnce /
 * validate) and a fetch mock, so the test drives the real HTTP server:
 *   page → oauth/authorize (302 to GitHub, code pre-filled) → oauth/poll
 *   until ok → runWebLogin resolves with the token + login.
 * Plus regressions: PAT paste still works, CSRF still blocked, no-oauth
 * server renders the classic page and 404s the oauth routes.
 *
 * Run: bun scripts/test-web-oauth.ts
 */
const { getOAuthClientId, pollDeviceTokenOnce, BUILTIN_OAUTH_CLIENT_ID } = await import(
  '../packages/core/src/github'
)
const { runWebLogin } = await import('../packages/cli/src/web-auth')

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++
    console.log(`  ok  ${name}`)
  } else {
    fail++
    console.log(`  ✗   ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

async function main() {
  /* ---------------------------------------------------------- units --- */
  console.log('\nunit: getOAuthClientId + pollDeviceTokenOnce')

  const realFetch = globalThis.fetch
  const savedEnv = process.env.TAGENT_GH_CLIENT_ID
  delete process.env.TAGENT_GH_CLIENT_ID
  check('no client id anywhere → empty', getOAuthClientId(undefined, undefined) === '')
  check('env wins when present', getOAuthClientId('env-id', 'cfg-id') === 'env-id')
  check('config used without env', getOAuthClientId(undefined, 'cfg-id') === 'cfg-id')
  check('builtin is the shipped default (empty until the OAuth app exists)', BUILTIN_OAUTH_CLIENT_ID === '')

  // pollDeviceTokenOnce — against a mocked github.com
  const polls: Array<Record<string, string>> = [
    { error: 'authorization_pending' },
    { error: 'slow_down' },
    { error: 'authorization_pending' },
    { access_token: 'gho_unit' },
  ]
  let i = 0
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).includes('github.com/login/oauth/access_token')) {
      return new Response(JSON.stringify(polls[Math.min(i++, polls.length - 1)]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch
  const p1 = await pollDeviceTokenOnce('cid', 'dc')
  const p2 = await pollDeviceTokenOnce('cid', 'dc')
  const p3 = await pollDeviceTokenOnce('cid', 'dc')
  const p4 = await pollDeviceTokenOnce('cid', 'dc')
  check('pollOnce pending', p1.status === 'pending')
  check('pollOnce slow_down (was a fatal bug)', p2.status === 'slow_down')
  check('pollOnce pending again', p3.status === 'pending')
  check('pollOnce ok', p4.status === 'ok' && p4.token === 'gho_unit')
  globalThis.fetch = realFetch
  if (savedEnv !== undefined) process.env.TAGENT_GH_CLIENT_ID = savedEnv

  /* ------------------------------------------------- oauth happy path --- */
  console.log('\nweb: one-click OAuth — page → authorize 302 → poll → ok')
  const START = {
    device_code: 'DC-test-1',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    verification_uri_complete: 'https://github.com/login/device/DC-test-1?user_code=ABCD-1234',
    expires_in: 900,
    interval: 3,
  }
  let pollCalls = 0
  let pageUrl = ''
  const r2 = runWebLogin({
    oauth: {
      clientId: 'test-client-id',
      start: async () => START,
      pollOnce: async () => {
        pollCalls++
        if (pollCalls <= 2) return { status: 'pending' as const }
        return { status: 'ok' as const, token: 'gho_oauth_t0ken' }
      },
      validate: async () => 'tester',
    },
    timeoutMs: 30000,
    onReady: (u) => {
      pageUrl = u
    },
  })
  // wait for listen
  for (let t = 0; !pageUrl && t < 50; t++) await new Promise((res) => setTimeout(res, 100))
  check('server ready with one-time URL', pageUrl.startsWith('http://127.0.0.1:') && pageUrl.endsWith('/'))

  // 1. the page renders the OAuth button, hides the PAT form
  const page = await (await fetch(pageUrl)).text()
  check('page has the Connect with GitHub button', page.includes('id="cta"') && page.includes('Connect with GitHub'))
  check('page hides the PAT form in oauth mode', page.includes('<div id="form" class="hidden">'))
  check('page has the paste-token escape hatch', page.includes('Paste a token instead'))

  // 2. poll before authorizing → idle
  const idle = (await (await fetch(`${pageUrl}oauth/poll`)).json()) as Record<string, unknown>
  check('poll is idle before the click', idle.status === 'idle')

  // 3. authorize → 302 to github with the code pre-filled
  const authRes = await fetch(`${pageUrl}oauth/authorize`, { redirect: 'manual' })
  check('authorize redirects (302)', authRes.status === 302 || authRes.status === 301)
  check(
    'redirect target pre-fills the code (verification_uri_complete)',
    (authRes.headers.get('location') ?? '') === START.verification_uri_complete,
  )

  // 4. double-click / second tab → same redirect, no duplicate flow
  const authRes2 = await fetch(`${pageUrl}oauth/authorize`, { redirect: 'manual' })
  check('second authorize while in flight → same 302', authRes2.headers.get('location') === START.verification_uri_complete)

  // 5. poll → pending with the user_code, then ok
  const pend = (await (await fetch(`${pageUrl}oauth/poll`)).json()) as Record<string, unknown>
  check('poll pending carries the user_code', pend.status === 'pending' && pend.user_code === 'ABCD-1234')

  let okPoll: Record<string, unknown> | null = null
  for (let t = 0; t < 60; t++) {
    await new Promise((res) => setTimeout(res, 500))
    const j = (await (await fetch(`${pageUrl}oauth/poll`)).json()) as Record<string, unknown>
    if (j.status === 'ok') {
      okPoll = j
      break
    }
  }
  check('poll flips to ok with the login', okPoll?.status === 'ok' && okPoll?.login === 'tester')

  const result = await r2
  check('runWebLogin resolves with the OAuth token', result.token === 'gho_oauth_t0ken' && result.login === 'tester')

  // 6. after success: one-shot everywhere. The server tears down in stages
  // (listener closes immediately, sockets sweep 2s later) — pooled keep-alive
  // connections still answer within that window; a connection refused after
  // it is ALSO correct one-shot behavior, so both outcomes pass.
  const alive = async (fn: () => Promise<Response | null>): Promise<Response | null> => {
    try {
      return await fn()
    } catch {
      return null // server already gone — one-shot confirmed at the TCP level
    }
  }
  const after = await alive(async () => await fetch(`${pageUrl}oauth/poll`))
  check(
    'poll after done stays ok (or the server is already gone)',
    after === null || (((await after.clone().json()) as Record<string, unknown>).status === 'ok'),
  )
  const again = await alive(async () => await fetch(`${pageUrl}oauth/authorize`, { redirect: 'manual' }))
  check('authorize after done → back to the page (or gone)', again === null || again.status === 302)
  const pageAfter = await alive(async () => await fetch(pageUrl, { redirect: 'manual' }))
  check(
    'page after done shows the ✔ card (or gone)',
    pageAfter === null || (await pageAfter.clone().text()).includes('data-done="tester"'),
  )

  /* ------------------------------------------------- PAT regression --- */
  console.log('\nweb: PAT paste still works (no oauth configured)')
  let patUrl = ''
  const r3 = runWebLogin({
    timeoutMs: 30000,
    validate: async (t: string) => {
      if (t === 'ghp_good') return 'patuser'
      throw new Error('invalid token (HTTP 401)')
    },
    onReady: (u) => {
      patUrl = u
    },
  })
  for (let t = 0; !patUrl && t < 50; t++) await new Promise((res) => setTimeout(res, 100))
  const patPage = await (await fetch(patUrl)).text()
  check('PAT page has no oauth button', !patPage.includes('id="cta"'))
  check('PAT page shows the form directly', patPage.includes('<div id="form">') && !patPage.includes('<div id="form" class="hidden">'))

  const noOauth = await fetch(`${patUrl}oauth/authorize`, { redirect: 'manual' })
  check('oauth/authorize 404s without a client id', noOauth.status === 404)
  const noPoll = await fetch(`${patUrl}oauth/poll`)
  check('oauth/poll without a client id → idle, not a crash', ((await noPoll.json()) as Record<string, unknown>).status === 'idle')

  const origin = new URL(patUrl).origin
  const bad = await fetch(`${patUrl}submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: JSON.stringify({ token: 'ghp_good' }),
  })
  check('CSRF: foreign origin POST rejected', bad.status === 403)

  const good = await fetch(`${patUrl}submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ token: 'ghp_good' }),
  })
  const goodJson = (await good.json()) as { ok: boolean; login?: string }
  check('PAT submit accepted', goodJson.ok === true && goodJson.login === 'patuser')
  const r3res = await r3
  check('PAT flow resolves', r3res.token === 'ghp_good' && r3res.login === 'patuser')

  const dup = await fetch(`${patUrl}submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ token: 'ghp_good' }),
  })
  check('one-shot: second submit 409s', dup.status === 409)

  console.log(`\n${fail === 0 ? '✔' : '✗'} ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
