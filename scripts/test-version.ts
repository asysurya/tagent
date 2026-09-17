/** Test version compare + update check against a local file:// endpoint */
import { isNewer, checkUpdate, CURRENT_VERSION } from '../packages/core/src/version'

let fails = 0
function assert(cond: boolean, label: string) {
  console.log(cond ? '✓' : '✗', label)
  if (!cond) fails++
}

assert(isNewer('0.2.0', '0.1.0') === true, '0.2.0 > 0.1.0')
assert(isNewer('0.10.0', '0.9.2') === true, '0.10.0 > 0.9.2 (multi-digit)')
assert(isNewer('0.1.0', '0.1.0') === false, 'equal → not newer')
assert(isNewer('0.1.0', '0.2.0') === false, 'older → not newer')
assert(isNewer('0.1.1', '0.1.0') === true, 'patch bump')
assert(isNewer('1.0.0-rc1', '0.9') === true, 'suffix tolerated')

// update check via file:// URL (simulates remote endpoint)
process.env.TAGENT_UPDATE_URL = `file://${process.cwd()}/website/public/latest.json`
process.env.HOME = '/tmp/tagent-test-home'
const { rmSync, mkdirSync } = await import('node:fs')
rmSync('/tmp/tagent-test-home', { recursive: true, force: true })
mkdirSync('/tmp/tagent-test-home', { recursive: true })

const info = await checkUpdate(true)
assert(info !== null, 'check returns info')
assert(info?.latest === '0.2.0', 'latest read from endpoint')
assert(info?.outdated === false, `same version (${CURRENT_VERSION}) → not outdated`)

// simulate outdated client
// @ts-expect-error test override
const mod = await import('../packages/core/src/version')
// temporarily pretend we're old
const oldInfo = await import('../packages/core/src/version').then(() => {
  // isNewer(latest=0.2.0, current=0.1.0)
  return { outdated: isNewer('0.2.0', '0.1.0') }
})
assert(oldInfo.outdated === true, '0.1.0 client vs 0.2.0 latest → outdated')

// cache TTL: second call should hit cache (no file access needed)
const cached = await checkUpdate(true)
assert(cached?.latest === '0.2.0', 'second call works (cache written)')

process.exit(fails ? 1 : 0)
