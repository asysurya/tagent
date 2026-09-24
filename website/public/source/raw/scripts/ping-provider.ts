/** quick: is the default zai provider reachable? one tiny prompt */
import { AgentLoop, getAdapter, loadConfig, PermissionManager, SessionStore, AgentEvents } from '../packages/core/src/index'
import fs from 'node:fs'

const root = '/tmp/tagent-ping'
if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true })
fs.mkdirSync(root, { recursive: true })

const cfg = loadConfig(root)
const sessions = new SessionStore(root, root)
const session = sessions.create('ping', cfg.defaultModel, 'build')
const loop = new AgentLoop({
  session,
  provider: getAdapter(cfg.defaultProvider, cfg),
  model: cfg.defaultModel,
  events: { onStatus: (p, d) => console.log('status:', p, d ?? ''), onNotify: (l, m) => console.log('notify:', l, m) } as unknown as AgentEvents,
  permissions: new PermissionManager(cfg),
  config: cfg,
  mode: 'build',
})
console.log('provider:', cfg.defaultProvider, 'model:', cfg.defaultModel)
const summary = await Promise.race([
  loop.run('Reply with exactly: pong'),
  new Promise<never>((_, r) => setTimeout(() => r(new Error('TIMEOUT 60s')), 60_000)),
])
console.log('summary:', JSON.stringify(summary))
console.log('last assistant:', session.messages.filter((m) => m.role === 'assistant').pop()?.content?.slice(0, 100))
process.exit(0)
