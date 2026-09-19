/** smoke test: MCP client against the official sequential-thinking server */
import { McpManager } from '../packages/core/src/mcp'

async function main() {
  const mgr = new McpManager({
    servers: {
      seq: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory'],
      },
    },
  })
  await mgr.ensureStarted()
  console.log('status:', JSON.stringify(mgr.status(), null, 2))
  const defs = mgr.toolDefinitions()
  console.log('tools:', defs.map((t) => t.name))
  const t = defs.find((d) => d.name === 'mcp_seq_read_graph') ?? defs[0]
  if (t) {
    const out = await t.run({})
    console.log('call output (first 200):', out.slice(0, 200))
  }
  mgr.close()
}

main().catch((e) => {
  console.error('FAIL:', e)
  process.exit(1)
})
