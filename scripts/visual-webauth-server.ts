/**
 * visual-webauth-server.ts — runWebLogin with mocked GitHub hooks for
 * browser-driven visual checks (agent-browser). The OAuth flow auto-approves
 * ~4s after authorize; the PAT hook accepts the token "ghp_good".
 *
 * Run: bun scripts/visual-webauth-server.ts [--pat]
 * Prints the one-time URL; stays alive 5 minutes.
 */
const mode = process.argv[2] === '--pat' ? 'pat' : 'oauth'
const { runWebLogin } = await import('../packages/cli/src/web-auth')

const START = {
  device_code: 'DC-visual',
  user_code: 'WDJB-DXJK',
  verification_uri: 'https://github.com/login/device',
  verification_uri_complete: 'https://github.com/login/device/DC-visual?user_code=WDJB-DXJK',
  expires_in: 900,
  interval: 3,
}
let pollCalls = 0

const r = runWebLogin({
  ...(mode === 'oauth'
    ? {
        oauth: {
          clientId: 'visual-test-id',
          start: async () => START,
          pollOnce: async () => {
            pollCalls++
            return pollCalls <= 1 ? { status: 'pending' as const } : { status: 'ok' as const, token: 'gho_visual' }
          },
          validate: async () => 'octocat',
        },
      }
    : {}),
  validate: async (t: string) => {
    if (t === 'ghp_good') return 'octocat'
    throw new Error('invalid token (HTTP 401)')
  },
  timeoutMs: 5 * 60 * 1000,
  onReady: (url) => {
    console.log(`READY ${url}`)
  },
})
r.then(
  (v) => console.log('LOGGED IN', v.login),
  (e) => console.log('FAILED', e.message),
)
