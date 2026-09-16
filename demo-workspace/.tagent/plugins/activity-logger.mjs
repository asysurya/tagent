export const name = 'activity-logger'
export const version = '1.0.0'

// Example Tagent plugin — appends every tool call to .tagent/plugin-log.jsonl
export const hooks = {
  onToolCall({ tool, input }) {
    const line = JSON.stringify({ at: Date.now(), event: 'call', tool, input })
    append(line)
  },
  onToolResult({ tool, record }) {
    const line = JSON.stringify({ at: Date.now(), event: 'result', tool, status: record?.status })
    append(line)
  },
  onAgentDone({ summary }) {
    const line = JSON.stringify({ at: Date.now(), event: 'done', finished: summary?.finished, turns: summary?.turns })
    append(line)
  },
}

function append(line) {
  try {
    const fs = require('node:fs')
    const path = require('node:path')
    const dir = path.join(process.cwd(), '.tagent')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'plugin-log.jsonl'), line + '\n')
  } catch {
    // never break the agent because of a plugin
  }
}
