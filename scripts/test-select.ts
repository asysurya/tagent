/** test: interactive selector — run inside a pty, send arrow keys, verify choice */
import { select, confirm } from '../packages/cli/src/select'

async function main() {
  const choice = await select({
    title: 'pick a fruit',
    items: [
      { label: 'apple', value: 'apple' },
      { label: 'banana', value: 'banana' },
      { label: 'cherry', value: 'cherry' },
      { label: 'durian', value: 'durian' },
    ],
  })
  process.stdout.write(`\nCHOICE=${choice}\n`)
  const yes = await confirm('continue?', { default: false })
  process.stdout.write(`\nCONFIRM=${yes}\n`)
}

main()
