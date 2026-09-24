/** smoke test: plugin v2 — custom tools + slash commands */
import { loadPlugins, pluginToolDefinitions, scaffoldPlugin } from '../packages/core/src/plugins'
import fs from 'node:fs'

async function main() {
  // scaffold then overwrite with a v2 plugin
  const file = scaffoldPlugin('/tmp/tagent-plugin-test-ws', 'demo')
  fs.writeFileSync(file, `export const name = 'demo'
export const version = '1.2.0'
export const description = 'test plugin'
export const tools = [{
  name: 'ping',
  description: 'pong back',
  risk: 'low',
  params: { msg: 'string — message to echo' },
  async run(input) { return 'pong: ' + (input.msg ?? '') },
}]
export const commands = [{
  name: 'hello',
  description: 'say hi',
  async run({ args }) { return 'hi ' + (args || 'world') },
}]
`)
  const plugins = await loadPlugins('/tmp/tagent-plugin-test-ws')
  console.log('plugins:', plugins.map((p) => `${p.name}@${p.version} (${p.tools.length} tools, ${p.commands.length} cmds)`))
  const defs = pluginToolDefinitions(plugins)
  console.log('tool defs:', defs.map((t) => `${t.name} [${t.risk}]`))
  const out = await defs[0].run({ msg: 'integration test' })
  console.log('tool run:', out)
  const cmdOut = await plugins[0].commands[0].run({ args: 'tagent', workspaceRoot: '/tmp', config: {} as never })
  console.log('command run:', cmdOut)
  if (out !== 'pong: integration test') throw new Error('tool output mismatch')
}

main().catch((e) => {
  console.error('FAIL:', e)
  process.exit(1)
})
