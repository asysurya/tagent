/**
 * ask_user tests — the agent's interview form.
 * Covers: toolset registration per mode, input parsing/validation, headless +
 * subagent fallbacks, answer formatting, the full loop pipeline (scripted model
 * calls ask_user → the form travels to events.onAskUser → answers flow back),
 * and AgentHost wiring (bus event + askRespond).
 *
 * Run: bun scripts/test-ask.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  buildToolset, defaultConfig, PermissionManager, AgentLoop, parseAskInput, formatAskResponse,
  type AgentEvents, type AskFormRequest, type AskFormResponse, type ProviderAdapter,
  type SessionData, type TagentConfig, type ToolContext,
} from '../packages/core/src/index'
import { askUserTool } from '../packages/core/src/tools/ask'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra?: string) => {
  cond ? pass++ : fail++
  console.log(`${cond ? '✔' : '✗'} ${name}${!cond && extra ? ` — ${extra}` : ''}`)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-ask-'))
fs.mkdirSync(path.join(root, '.tagent'), { recursive: true })
const cfg: TagentConfig = defaultConfig()

const names = (mode: 'build' | 'plan' | 'test', depth = 0) =>
  buildToolset({ config: cfg, mode, depth, readOnly: mode === 'plan' }).map((t) => t.name)

console.log('1) toolset registration')
ok('ask_user in build toolset', names('build').includes('ask_user'))
ok('ask_user in plan (readOnly) toolset', names('plan').includes('ask_user'))
ok('ask_user in test toolset', names('test').includes('ask_user'))
ok('ask_user NOT in subagent toolset', !names('build', 1).includes('ask_user'))
ok('default permission allow', cfg.permissions.tools.ask_user === 'allow')

console.log('\n2) parseAskInput — happy path + defaults')
{
  const { form, error } = parseAskInput({
    title: 'stack choice',
    intro: 'before I start',
    fields: [
      { label: 'database?', type: 'option', options: ['postgres', ' mysql ', 'sqlite'] },
      { label: 'features?', type: 'multi', options: ['auth', 'payments'] },
      { label: 'app name?', type: 'input', placeholder: 'my-app' },
    ],
  })
  ok('parses without error', !error && !!form)
  if (form) {
    ok('ids auto-assigned', form.fields.map((f) => f.id).join(',') === 'f1,f2,f3')
    ok('options trimmed', form.fields[0].options?.[1] === 'mysql')
    ok('allowNotes defaults true', form.allowNotes === true)
    ok('add-option allowed by default (absence = true)', form.fields[0].allowAddOption === undefined)
    ok('placeholder kept', form.fields[2].placeholder === 'my-app')
    ok('allowAddOption=false respected', parseAskInput({ fields: [{ label: 'q', type: 'option', options: ['a'], allowAddOption: false }] }).form?.fields[0].allowAddOption === false)
    ok('required respected', parseAskInput({ fields: [{ label: 'q', type: 'input', required: true }] }).form?.fields[0].required === true)
  }
}

console.log('\n3) parseAskInput — validation errors')
ok('empty fields rejected', !!parseAskInput({}).error)
ok('missing label rejected', !!parseAskInput({ fields: [{ type: 'option', options: ['a'] }] }).error)
ok('bad type rejected', !!parseAskInput({ fields: [{ label: 'q', type: 'yesno', options: ['a'] }] }).error)
ok('option field without options rejected', !!parseAskInput({ fields: [{ label: 'q', type: 'option' }] }).error)
ok('input ignores options', parseAskInput({ fields: [{ label: 'q', type: 'input', options: ['a'] }] }).form?.fields[0].options === undefined)
ok('7 fields rejected', !!parseAskInput({ fields: Array.from({ length: 7 }, (_, i) => ({ label: `q${i}`, type: 'input' })) }).error)
ok('6 fields accepted', !parseAskInput({ fields: Array.from({ length: 6 }, (_, i) => ({ label: `q${i}`, type: 'input' })) }).error)
ok('duplicate ids rejected', !!parseAskInput({ fields: [{ id: 'x', label: 'a', type: 'input' }, { id: 'x', label: 'b', type: 'input' }] }).error)
ok('9 options capped to 8', parseAskInput({ fields: [{ label: 'q', type: 'option', options: '123456789'.split('') }] }).form?.fields[0].options?.length === 8)

console.log('\n4) run() — headless + subagent fallbacks')
const mkCtx = (events: AgentEvents, depth = 0): ToolContext => ({
  workspaceRoot: root, sessionId: 's', depth, config: cfg, events, todos: [],
})
{
  const out = await askUserTool.run(
    { fields: [{ label: 'q', type: 'input' }] },
    mkCtx({} as AgentEvents),
  )
  ok('headless → honest unavailable', out.includes('No interactive user') && out.includes('best judgment'), out)
}
{
  let asked = false
  const out = await askUserTool.run(
    { fields: [{ label: 'q', type: 'input' }] },
    mkCtx({ onAskUser: async () => { asked = true; return null } } as AgentEvents, 1),
  )
  ok('subagent never triggers the form', !asked)
  ok('subagent → unavailable message', out.includes('subagent'), out)
}
{
  let got: AskFormRequest | undefined
  const out = await askUserTool.run(
    {
      title: 'interview',
      fields: [
        { label: 'db?', type: 'option', options: ['postgres', 'sqlite'] },
        { label: 'extras?', type: 'multi', options: ['a', 'b'] },
        { label: 'name?', type: 'input' },
      ],
    },
    mkCtx({
      onAskUser: async (f) => {
        got = f
        return { answers: { f1: 'postgres', f2: ['a', 'b'], f3: 'acme' }, notes: 'keep it cheap' }
      },
    } as AgentEvents),
  )
  ok('form handed to the host', got?.title === 'interview' && got?.fields.length === 3)
  ok('answers formatted for the model', out.includes('THE USER ANSWERED YOUR FORM') && out.includes('db?: postgres') && out.includes('extras?: a, b') && out.includes('name?: acme'), out)
  ok('notes included', out.includes('notes: keep it cheap'))
  ok('proceed instruction present', out.includes('Proceed with these answers'))
}
{
  const out = await askUserTool.run(
    { fields: [{ label: 'q', type: 'input' }] },
    mkCtx({ onAskUser: async () => null } as AgentEvents),
  )
  ok('dismissed → told to state assumptions', out.includes('dismissed') && out.includes('assumptions'), out)
}
{
  const out = formatAskResponse(parseAskInput({ fields: [{ label: 'q', type: 'option', options: ['a'] }] }).form!, { answers: {} })
  ok('blank answers rendered as (left blank)', out.includes('(left blank)') && out.includes('(none)'), out)
}

console.log('\n5) full loop pipeline — scripted model calls ask_user')
{
  const seenForms: AskFormRequest[] = []
  let turn = 0
  let fedBack = ''
  const fake: ProviderAdapter = {
    id: 'fake', label: 'fake', supportsNativeTools: false, models: [],
    complete: async () => '',
    completeStream: async (req) => {
      turn++
      if (turn === 1) {
        return {
          text:
            'quick question first\n```tagent:action\n{"tool":"ask_user","input":{"title":"stack","fields":[{"label":"Database?","type":"option","options":["postgres","mysql"]},{"label":"App name?","type":"input"}]}}\n```',
        }
      }
      fedBack = req.messages.filter((m) => m.role === 'user').pop()?.content ?? ''
      return { text: 'Understood — building with postgres.' }
    },
  }
  const session: SessionData = {
    id: 's1', workspaceId: root, title: 't', model: 'fake', mode: 'build',
    createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, messages: [], todos: [],
  }
  const loop = new AgentLoop({
    session, provider: fake, model: 'fake',
    events: {
      onAskUser: async (form) => {
        seenForms.push(form)
        return { answers: { f1: 'postgres', f2: '' }, notes: 'name it later' }
      },
    } as AgentEvents,
    permissions: new PermissionManager(cfg), config: cfg, mode: 'build',
  })
  const summary = await loop.run('build the app')
  ok('run completed', summary.finished === 'complete')
  ok('form reached the host handler', seenForms.length === 1 && seenForms[0].title === 'stack' && seenForms[0].fields.length === 2)
  ok('answers fed back to the model', fedBack.includes('Database?: postgres') && fedBack.includes('notes: name it later'), fedBack.slice(0, 300))
  ok('tool recorded as done', session.messages.some((m) => m.toolCalls?.some((c) => c.tool === 'ask_user' && c.status === 'done')))
}

console.log('\n6) host wiring — bus event + askRespond')
{
  const { AgentHost } = await import('../packages/cli/src/host')
  const TMP = path.join(root, 'hostws')
  fs.mkdirSync(path.join(TMP, '.tagent'), { recursive: true })
  const host = new AgentHost({ workspaceRoot: TMP })
  const bus = host.bus as import('node:events').EventEmitter

  let seen: AskFormRequest | null = null
  bus.on('ask:request', (f: AskFormRequest) => {
    seen = f
    host.askRespond(f.id, { answers: { f1: 'postgres' }, notes: 'from the bus' })
  })
  // drive the same onAskUser path the loop uses
  const events = (host as unknown as { makeEvents: (id: string) => AgentEvents }).makeEvents('sx')
  const form: AskFormRequest = {
    id: 'ask-1', fields: [{ id: 'f1', label: 'db?', type: 'option', options: ['postgres'] }], allowNotes: true,
  }
  const res: AskFormResponse | null = await events.onAskUser?.(form)
  ok('bus got the form', seen?.id === 'ask-1')
  ok('askRespond resolves the promise', res?.answers?.f1 === 'postgres' && res?.notes === 'from the bus')
  ok('unknown id is a no-op', host.askRespond('nope', null) === false)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
