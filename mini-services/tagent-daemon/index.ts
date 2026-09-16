/**
 * Tagent daemon — sandbox mini-service.
 * Runs the agent engine on :3001; the Next.js GUI (port 3000) reaches it
 * through the gateway via `?XTransformPort=3001`.
 */
import path from 'node:path'

process.env.TAGENT_SKILLS_DIR = path.resolve(import.meta.dir, '../../builtin-skills')

const { createDaemon } = await import('../../packages/cli/src/daemon')

const workspaceRoot = path.resolve(import.meta.dir, '../../demo-workspace')

await createDaemon({
  port: 3001,
  workspaceRoot,
  socketPath: '/',
  configOverride: {
    // sandbox safety: fs tools are jailed to demo-workspace; bash is off
    defaultProvider: 'zai',
    defaultModel: 'glm-4.7',
    tools: { bash: false, browser: false },
    maxTurns: 24,
  },
})

console.log('[tagent-daemon] listening on :3001 (workspace: %s)', workspaceRoot)
