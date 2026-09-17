import type { ToolDefinition, TodoItem } from '../types'
import { uid } from '../util'

export const todoWriteTool: ToolDefinition = {
  name: 'todowrite',
  description:
    'Create or update the session task list. Send the FULL list each time. Use for multi-step work so the user can follow progress.',
  risk: 'low',
  params: {
    todos:
      'array (required) — [{content: string, status: "pending"|"in_progress"|"completed", priority?: "high"|"medium"|"low"}]',
  },
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The FULL task list (send every time)',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Task description' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  async run(input, ctx) {
    const raw = Array.isArray(input.todos) ? input.todos : []
    const todos: TodoItem[] = raw.slice(0, 30).map((t: Record<string, unknown>) => ({
      id: uid(),
      content: String(t.content ?? '').slice(0, 200),
      status: (['pending', 'in_progress', 'completed'].includes(String(t.status))
        ? t.status
        : 'pending') as TodoItem['status'],
      priority: (['high', 'medium', 'low'].includes(String(t.priority))
        ? t.priority
        : undefined) as TodoItem['priority'],
    }))
    ctx.todos.length = 0
    ctx.todos.push(...todos)
    ctx.events.onTodos?.(ctx.todos)
    return `Task list updated (${todos.length} items).`
  },
}
