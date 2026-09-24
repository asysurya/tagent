/**
 * ask_user — the agent's interview form.
 *
 * The agent calls this whenever it needs decisions from the human BEFORE
 * committing to work: plan-mode interviews, build-mode material deviations,
 * test-mode scope questions. The host renders the form (interactive overlay
 * in the TUI, dialog in the web GUI) and resolves with the answers.
 *
 * Form shape (3 field kinds, by explicit product decision):
 *   option — single choice (radio)
 *   multi  — multiple choice (checkboxes)
 *   input  — free text
 * option/multi fields let the user ADD a custom option; every form carries
 * an optional notes textarea below the fields.
 *
 * Headless runs (no interactive host) and subagents get an honest
 * "user unavailable" answer instead of a hang — the model is told to proceed
 * with best judgment and state its assumptions.
 */
import type { AskFormField, AskFormRequest, AskFormResponse, ToolContext, ToolDefinition } from '../types'
import { uid } from '../util'

const MAX_FIELDS = 6
const MAX_OPTIONS = 8

/** Parse + sanitize the model's input into a valid form. Returns an error string on failure. */
export function parseAskInput(input: Record<string, unknown>): { form?: AskFormRequest; error?: string } {
  const rawFields = Array.isArray(input.fields) ? input.fields : []
  if (rawFields.length === 0) return { error: 'fields is required — provide 1-6 questions' }
  if (rawFields.length > MAX_FIELDS) return { error: `too many fields (${rawFields.length}) — max ${MAX_FIELDS}` }

  const fields: AskFormField[] = []
  for (let i = 0; i < rawFields.length; i++) {
    const rf = (rawFields[i] ?? {}) as Record<string, unknown>
    const label = String(rf.label ?? rf.question ?? '').trim()
    if (!label) return { error: `fields[${i}].label is required` }
    const type = String(rf.type ?? 'option') as AskFormField['type']
    if (type !== 'option' && type !== 'multi' && type !== 'input') {
      return { error: `fields[${i}].type must be option | multi | input (got "${type}")` }
    }
    const id = String(rf.id ?? `f${i + 1}`).trim() || `f${i + 1}`
    if (fields.some((f) => f.id === id)) return { error: `duplicate field id "${id}"` }

    let options: string[] | undefined
    if (type !== 'input') {
      const raw = Array.isArray(rf.options) ? rf.options : []
      options = raw.map((o) => String(o ?? '').trim()).filter(Boolean).slice(0, MAX_OPTIONS)
      if (options.length < 1) return { error: `fields[${i}] (${label}) needs 1-${MAX_OPTIONS} options for type ${type}` }
    }

    fields.push({
      id,
      label,
      type,
      ...(options ? { options } : {}),
      ...(rf.allowAddOption === undefined ? {} : { allowAddOption: rf.allowAddOption !== false }),
      ...(type === 'input' && typeof rf.placeholder === 'string' && rf.placeholder ? { placeholder: rf.placeholder } : {}),
      ...(rf.required === undefined ? {} : { required: rf.required !== false }),
    })
  }

  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : undefined
  const intro = typeof input.intro === 'string' && input.intro.trim() ? input.intro.trim() : undefined
  return {
    form: {
      id: uid(),
      ...(title ? { title } : {}),
      ...(intro ? { intro } : {}),
      fields,
      allowNotes: input.allowNotes !== false,
      ...(typeof input.notesLabel === 'string' && input.notesLabel.trim() ? { notesLabel: input.notesLabel.trim() } : {}),
    },
  }
}

/** Render the answers back as compact, model-friendly text. */
export function formatAskResponse(form: AskFormRequest, res: AskFormResponse): string {
  const lines: string[] = ['THE USER ANSWERED YOUR FORM:']
  for (const f of form.fields) {
    const a = res.answers?.[f.id]
    const value = Array.isArray(a)
      ? a.length
        ? a.join(', ')
        : '(none selected)'
      : typeof a === 'string' && a.trim()
        ? a.trim()
        : '(left blank)'
    lines.push(`- ${f.label}: ${value}`)
  }
  const notes = res.notes?.trim()
  lines.push(`- notes: ${notes || '(none)'}`)
  lines.push('Proceed with these answers. Only ask again if something new and material comes up.')
  return lines.join('\n')
}

export const askUserTool: ToolDefinition = {
  name: 'ask_user',
  description:
    'Ask the user questions through an interactive form — use it whenever a decision materially changes the work ' +
    '(plan-mode interviews, scope choices, naming, tech picks). Fields come in 3 kinds: "option" (single choice), ' +
    '"multi" (multiple choice) and "input" (free text). The user can add their own options to option/multi fields ' +
    'and leave an optional note under the form. Ask focused questions in ONE call (max 6 fields) instead of ' +
    'many round-trips; you get the answers verbatim. If no interactive user is attached you get an explicit ' +
    'unavailable message — proceed with best judgment and state assumptions.',
  risk: 'low',
  params: {
    title: 'string (optional) — short form title, e.g. "Database choice"',
    intro: 'string (optional) — one context line above the fields',
    fields:
      'array (required, 1-6) — questions: { label: string (required), type: "option"|"multi"|"input", ' +
      'options: string[] (required for option/multi, max 8), id?: string, placeholder?: string (input), ' +
      'required?: boolean, allowAddOption?: boolean (default true) }',
    allowNotes: 'boolean (optional, default true) — notes textarea below the fields',
  },
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short form title' },
      intro: { type: 'string', description: 'One context line above the fields' },
      fields: {
        type: 'array',
        minItems: 1,
        maxItems: 6,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Stable key the answers come back under' },
            label: { type: 'string', description: 'The question shown to the user' },
            type: { type: 'string', enum: ['option', 'multi', 'input'] },
            options: { type: 'array', items: { type: 'string' }, description: 'Choices for option/multi (max 8)' },
            allowAddOption: { type: 'boolean', description: 'User may add a custom option (default true)' },
            placeholder: { type: 'string', description: 'Hint for input fields' },
            required: { type: 'boolean' },
          },
          required: ['label'],
        },
      },
      allowNotes: { type: 'boolean' },
    },
    required: ['fields'],
  },
  async run(input, ctx: ToolContext) {
    const { form, error } = parseAskInput(input as Record<string, unknown>)
    if (!form) return `Error: ${error}`

    // subagents never get a form — only the primary agent faces the human
    if ((ctx.depth ?? 0) > 0) {
      return 'No interactive user is attached to this subagent. Do not ask — proceed with your best judgment and state assumptions in one line.'
    }
    // headless host (no handler registered) — honest unavailability, never a hang
    if (!ctx.events.onAskUser) {
      return 'No interactive user is attached to this session (headless run). Proceed with your best judgment and state your assumptions in one line.'
    }

    const res = (await ctx.events.onAskUser(form)) as AskFormResponse | null
    if (!res) {
      return 'The user dismissed the form without answering. Proceed with your best judgment, state your assumptions, and mention that you asked but got no answer.'
    }
    return formatAskResponse(form, res)
  },
}
