/**
 * Regenerates website/public/latest.json from website/src/data/releases.ts
 * so the CLI update check and the website can never drift apart.
 *
 * Run: bun scripts/sync-latest.ts
 */
import { RELEASES, LATEST } from '../website/src/data/releases'
import fs from 'node:fs'

const [newest] = RELEASES
if (!newest) throw new Error('no releases found')

if (newest.version !== LATEST) {
  throw new Error(`LATEST (${LATEST}) != newest release (${newest.version}) — fix releases.ts`)
}

const payload = {
  version: newest.version,
  date: newest.date,
  notes: newest.summary,
  url: `https://github.com/asysurya/tagent/releases/tag/v${newest.version}`,
}

fs.writeFileSync('website/public/latest.json', JSON.stringify(payload, null, 2) + '\n')
console.log('website/public/latest.json →', JSON.stringify(payload))
