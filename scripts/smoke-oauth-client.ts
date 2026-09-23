/**
 * Smoke test: the baked-in OAuth client id must be accepted by GitHub's
 * device-flow endpoint (a real HTTP round-trip — proves the app exists,
 * Device Flow is enabled, and the id is copied correctly).
 */
import { BUILTIN_OAUTH_CLIENT_ID, startDeviceLogin } from '../packages/core/src/github.ts'

const id = BUILTIN_OAUTH_CLIENT_ID
console.log(`client id: ${id}`)

if (!id) {
  console.error('FAIL: BUILTIN_OAUTH_CLIENT_ID is empty')
  process.exit(1)
}

try {
  const start = await startDeviceLogin(id)
  console.log('✔ GitHub accepted the client id — device flow started:')
  console.log(`  user_code:            ${start.user_code}`)
  console.log(`  verification_uri:     ${start.verification_uri}`)
  console.log(`  one-click (complete): ${start.verification_uri_complete ?? '(none)'}`)
  console.log(`  expires_in:          ${start.expires_in}s, interval: ${start.interval}s`)
  if (!start.verification_uri_complete) {
    console.error('WARN: no verification_uri_complete — user would have to type the code')
  }
  console.log('PASS')
} catch (e) {
  console.error(`FAIL: ${(e as Error).message}`)
  process.exit(1)
}
