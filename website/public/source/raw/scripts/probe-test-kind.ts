/**
 * probe-test-kind.ts — prove/refute the loop.ts bug: when a BUILD-mode parent
 * spawns task {agent:"test"}, does the sub actually run in TEST mode?
 * Captures the sub's system prompt (persona + tool docs embedded in it).
 */
import {
  AgentLoop, PermissionManager, defaultConfig,
  type ProviderAdapter, type CompletionRequest,
} from '../packages/core/src/index'
import type { AgentEvents, SessionData, TagentConfig } from '../packages/core/src/types'
import fs from 'node:fs'

const root = fs.mkdtempSync('/tmp/tagent-probe-')
const cfg: TagentConfig = {
  ...defaultConfig(),
  permissions: { defaultMode: 'allow', tools: {} },
  tools: { bash: true, browser: true, serve: true },
}

let subSystem = ''
let p = 0
const provider: ProviderAdapter = {
  id: 'fake', label: 'fake', supportsNativeTools: false, models: [],
  complete: async () => ({ text: '' }),
  completeStream: async (req: CompletionRequest) => {
    const sys = String((req.messages[0] as any)?.content ?? '')
    if (sys.includes('Tagent subagent')) {
      subSystem = sys
      return { text: 'sub done — report' }
    }
    p++
    return {
      text:
        p === 1
          ? '```tagent:action\n{"tool":"task","input":{"description":"verify pages","prompt":"Test the pages and report.","agent":"test"}}\n```'
          : 'done',
    }
  },
}

const session: SessionData = {
  id: 'p1', workspaceId: root, title: 't', model: 'fake', mode: 'build',
  createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, messages: [], todos: [],
}
const events: AgentEvents = {}
const loop = new AgentLoop({
  session, provider, model: 'fake', events,
  permissions: new PermissionManager(cfg), config: cfg, mode: 'build',
})
const summary = await loop.run('verify it')
console.log('RUN SUMMARY:', JSON.stringify(summary))

console.log('=== SUB SYSTEM PROMPT DIAGNOSTICS ===')
console.log('persona TEST       :', subSystem.includes('Mode: TEST'))
console.log('persona BUILD      :', subSystem.includes('Mode: BUILD'))
console.log('has test_report    :', /### test_report/.test(subSystem))
console.log('has write_file     :', /### write_file/.test(subSystem))
console.log('has edit_file      :', /### edit_file/.test(subSystem))
console.log('has browser        :', /### browser/.test(subSystem))
console.log('has vision         :', /### vision/.test(subSystem))
console.log('has serve          :', /### serve/.test(subSystem))
console.log('has task           :', /### task/.test(subSystem))
console.log('has ask_user       :', /### ask_user/.test(subSystem))
console.log('parent turns       :', p)
