/** Debug: why didn't the daemon show the update warning? */
process.env.TAGENT_UPDATE_URL = 'file:///tmp/fake-latest.json'
process.env.HOME = '/tmp/tagent-warn-home2'

const { rmSync, mkdirSync, readFileSync } = await import('node:fs')
rmSync('/tmp/tagent-warn-home2', { recursive: true, force: true })
mkdirSync('/tmp/tagent-warn-home2', { recursive: true })

const { checkUpdate, CURRENT_VERSION } = await import('../packages/core/src/version')
const info = await checkUpdate(false)
console.log('info:', JSON.stringify(info, null, 2))
console.log('current:', CURRENT_VERSION)

// also test plain fetch on file:// the way the daemon does
try {
  const res = await fetch(process.env.TAGENT_UPDATE_URL!, { signal: AbortSignal.timeout(4000) })
  console.log('fetch ok:', res.status, await res.text())
} catch (e) {
  console.log('fetch FAILED:', (e as Error).message)
}
