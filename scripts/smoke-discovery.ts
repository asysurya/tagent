/** Smoke: fake OpenAI-compatible server + tagent discovery + adapter wiring. */
const server = Bun.serve({
  port: 9911,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/v1/models') {
      return Response.json({
        data: [
          { id: 'test-model-a' },
          { id: 'test-model-b' },
          { id: 'text-embedding-should-be-filtered' },
        ],
      })
    }
    if (url.pathname === '/v1/chat/completions') {
      const body = `data: ${JSON.stringify({ choices: [{ delta: { content: 'hello from test' } }] })}\n\ndata: [DONE]\n\n`
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('not found', { status: 404 })
  },
})

const cfgFile = '/tmp/tagent-smoke/.tagent/config.json'
const cfg = await Bun.file(cfgFile).json()
cfg.customProviders = [{
  id: 'test-srv',
  label: 'Test Server',
  baseUrl: 'http://127.0.0.1:9911/v1',
  models: ['seed-model'],
}]
await Bun.write(cfgFile, JSON.stringify(cfg, null, 2))

const proc = Bun.spawn(['bun', '/home/z/my-project/packages/cli/src/index.ts', 'models', '--refresh'], {
  cwd: '/tmp/tagent-smoke', stdout: 'pipe', stderr: 'pipe',
})
await proc.exited
console.log(await new Response(proc.stdout).text())

// now check the listed models include discovery results
const proc2 = Bun.spawn(['bun', '/home/z/my-project/packages/cli/src/index.ts', 'models'], {
  cwd: '/tmp/tagent-smoke', stdout: 'pipe', stderr: 'pipe',
})
await proc2.exited
const out = await new Response(proc2.stdout).text()
const testLines = out.split('\n').filter((l) => l.includes('test-srv') || l.includes('test-model') || l.includes('seed-model'))
console.log('--- discovered models visible? ---')
console.log(testLines.join('\n'))

// cache file check
const cache = await Bun.file('/home/z/.tagent/models.json').json()
console.log('--- cache ---')
console.log(JSON.stringify(cache.providers['test-srv']))

server.stop(true)
