'use client'

/**
 * Demo mode — a scripted, offline simulation of the daemon protocol so the
 * GUI is fully explorable even when no daemon is reachable.
 * It uses the exact same store reducers as the live socket events.
 */
import { useTagent } from './store'
import type { ChatMessage, FileNode } from './types'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const DEMO_FILES: Record<string, string> = {
  'README.md': '# Demo Workspace (offline)\n\nThe daemon is not reachable right now.\nEverything you see is a scripted simulation.\n',
  'index.html': '<!doctype html>\n<html>\n  <head><title>Demo</title></head>\n  <body>\n    <h1>Hello, Tagent</h1>\n    <script src="app.js"></script>\n  </body>\n</html>\n',
  'app.js': '// demo file\nconsole.log("hello from demo")\n',
  'styles.css': 'body { font-family: system-ui; }\n',
  'WORKLOG.md': '# Worklog\n\n## 2026-09-17\n\n- **09:12 — demo mode** Daemon offline — this is a scripted journal.\n- **09:14** read app.js, found the todo-counter bug.\n- **09:15 — fix counter** patched off-by-one in updateCount(); all tests pass.\n',
}

export function demoTree(): FileNode {
  const leaf = (name: string): FileNode => ({ name, path: name, type: 'file', size: DEMO_FILES[name]?.length })
  return {
    name: '.',
    path: '.',
    type: 'dir',
    children: [leaf('README.md'), leaf('index.html'), leaf('app.js'), leaf('styles.css')],
  }
}

export function demoReadFile(path: string): string {
  return DEMO_FILES[path] ?? `// ${path}: not found in demo data`
}

export function startDemo(): void {
  const st = useTagent.getState()
  useTagent.setState({
    connection: 'demo',
    workspace: { id: 'demo', name: 'demo-workspace', path: '~/projects/demo' },
    config: {
      defaultProvider: 'zai',
      defaultModel: 'glm-4.7',
      providers: [
        { id: 'zai', label: 'Z.ai (built-in)', kind: 'builtin', needsKey: false, hasKey: true, models: [{ id: 'glm-4.7', label: 'GLM-4.7', provider: 'zai' }] },
        { id: 'openai', label: 'OpenAI', kind: 'openai', needsKey: true, hasKey: false, models: [], docsUrl: 'https://platform.openai.com/api-keys' },
      ],
      permissions: { defaultMode: 'ask', tools: { write_file: 'ask', edit_file: 'ask', bash: 'ask' } },
      tools: { bash: true, browser: false },
      github: { connected: false, login: null, repo: null },
      mega: { enabled: false, email: null },
      autoCheckpoint: true,
      maxTurns: 40,
      worklog: { enabled: true },
      caveman: false,
      webGui: false,
      cache: { fileState: true, web: true, webTtlMin: 10 },
      fallback: [],
    },
    skills: [
      { name: 'web-app-builder', description: 'Playbook for building a complete web app', source: 'builtin', path: '' },
      { name: 'bug-hunter', description: 'Debug-first workflow', source: 'builtin', path: '' },
    ],
    memory: {
      agents: { global: '', workspace: '# Demo\nThis memory is simulated.' },
      facts: [{ id: 'f1', text: 'User prefers TypeScript.', createdAt: Date.now() }],
    },
    sessions: [
      { id: 's1', title: 'Fix todo counter bug', model: 'glm-4.7', mode: 'build', createdAt: Date.now(), updatedAt: Date.now(), messageCount: 4 },
    ],
    fileTree: demoTree(),
    worklogExists: true,
    worklogContent: DEMO_FILES['WORKLOG.md']!,
  })
  st._apply.todos([{ id: 't1', content: 'Read app.js', status: 'completed' }, { id: 't2', content: 'Patch counter', status: 'in_progress' }])
}

export function demoNewSession(): void {
  useTagent.setState({
    session: {
      id: `demo-${Date.now()}`,
      title: 'New session',
      model: 'glm-4.7',
      mode: 'build',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0,
      messages: [],
      todos: [],
    },
    subagents: [],
    stream: '',
    status: null,
  })
}

export async function runDemoChat(text: string): Promise<void> {
  const st = useTagent.getState()
  const apply = st._apply
  const id = (r: string) => `demo-${r}-${Date.now()}`

  if (!useTagent.getState().session) demoNewSession()

  useTagent.setState((s) => ({
    running: true,
    session: s.session
      ? {
          ...s.session,
          messages: [
            ...s.session.messages,
            { id: id('u'), role: 'user', content: text, createdAt: Date.now() } as ChatMessage,
          ],
        }
      : s.session,
  }))

  apply.status({ phase: 'thinking', detail: 'turn 1' })
  await sleep(700)

  apply.message({ id: id('a1'), role: 'assistant', content: 'Let me look at the files first.', createdAt: Date.now() })
  apply.toolStart({ id: id('tc1'), tool: 'list_files', input: { path: '.' }, status: 'running' })
  await sleep(900)
  apply.toolEnd({ id: id('tc1'), tool: 'list_files', input: { path: '.' }, status: 'done', output: 'README.md\nindex.html\napp.js\nstyles.css' })

  apply.status({ phase: 'acting', detail: '1 action(s)' })
  await sleep(600)

  apply.message({ id: id('a2'), role: 'assistant', content: 'Reading app.js…', createdAt: Date.now() })
  apply.toolStart({ id: id('tc2'), tool: 'read_file', input: { path: 'app.js' }, status: 'running' })
  await sleep(800)
  apply.toolEnd({ id: id('tc2'), tool: 'read_file', input: { path: 'app.js' }, status: 'done', output: demoReadFile('app.js').slice(0, 400) })

  apply.status({ phase: 'thinking', detail: 'turn 2' })
  await sleep(700)

  useTagent.setState({ pendingPermission: { id: id('perm'), tool: 'edit_file', input: { path: 'app.js' }, reason: 'Agent wants to run `edit_file`' } })
  apply.status({ phase: 'waiting-permission' })
  await sleep(2500)
  useTagent.setState({ pendingPermission: null })

  apply.message({
    id: id('a3'),
    role: 'assistant',
    content:
      '**Demo mode** — the daemon is not reachable, so this is a scripted replay of what a real run looks like.\n\nIn live mode, Tagent would:\n1. `read_file` the relevant sources,\n2. ask permission before writing,\n3. apply the edit and show you the diff,\n4. snapshot a checkpoint you can undo.\n\nStart the daemon with `bun packages/cli/src/index.ts` to go live.',
    createdAt: Date.now(),
    toolCalls: [
      { id: id('tc1'), tool: 'list_files', input: { path: '.' }, status: 'done', output: 'README.md\nindex.html\napp.js\nstyles.css' },
      { id: id('tc2'), tool: 'read_file', input: { path: 'app.js' }, status: 'done', output: '(file content)' },
    ],
  })
  apply.status({ phase: 'done', detail: 'turns: 2 (simulated)' })
  useTagent.setState({ running: false })
}
