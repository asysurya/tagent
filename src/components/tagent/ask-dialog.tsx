'use client'

/**
 * AskDialog — the ask_user form in the web GUI.
 *
 * The agent asks, the user answers: option fields (single choice), multi
 * fields (checkboxes), input fields (free text). Option/multi fields let the
 * user add their own options; an optional notes textarea sits under the
 * fields. Cancel dismisses the form (the model is told and proceeds with
 * best judgment).
 */
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { HelpCircle, MessageSquareText, Plus, SendHorizontal } from 'lucide-react'
import { useTagent } from '@/lib/tagent/store'
import type { AskFormRequest, AskFormResponse } from '@/lib/tagent/types'
import { useEffect, useMemo, useState } from 'react'

export function AskDialog() {
  const pending = useTagent((s) => s.pendingAsk)
  const respond = useTagent((s) => s.respondAsk)

  return (
    <Dialog open={!!pending} onOpenChange={(o) => { if (!o) respond(null) }}>
      {/* keyed by request id — every new form starts fresh */}
      <DialogContent key={pending?.id ?? 'none'} className="bg-zinc-900 border-zinc-800 max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto pretty-scroll">
        {pending && <AskFormBody form={pending} respond={respond} />}
      </DialogContent>
    </Dialog>
  )
}

function AskFormBody({ form, respond }: { form: AskFormRequest; respond: (r: AskFormResponse | null) => void }) {
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [custom, setCustom] = useState<Record<string, string[]>>({})
  const [adding, setAdding] = useState<string | null>(null)   // field id being extended
  const [draft, setDraft] = useState('')
  const [notes, setNotes] = useState('')
  const [tried, setTried] = useState(false)

  useEffect(() => {
    setSelected({})
    setInputs({})
    setCustom({})
    setAdding(null)
    setDraft('')
    setNotes('')
    setTried(false)
  }, [form.id])

  const optionsOf = (fieldId: string, base: string[] | undefined) => [...(base ?? []), ...(custom[fieldId] ?? [])]

  const missingRequired = useMemo(
    () =>
      form.fields
        .filter((f) => {
          if (!f.required) return false
          if (f.type === 'input') return !(inputs[f.id] ?? '').trim()
          return (selected[f.id] ?? []).length === 0
        })
        .map((f) => f.id),
    [form.fields, inputs, selected],
  )

  const submit = () => {
    setTried(true)
    if (missingRequired.length) return
    const answers: Record<string, string | string[]> = {}
    for (const f of form.fields) {
      if (f.type === 'input') answers[f.id] = (inputs[f.id] ?? '').trim()
      else answers[f.id] = f.type === 'option' ? (selected[f.id]?.[0] ?? '') : (selected[f.id] ?? [])
    }
    respond({ answers, notes: notes.trim() || undefined })
  }

  const addOption = (fieldId: string) => {
    const t = draft.trim()
    if (!t) {
      setAdding(null)
      return
    }
    const exists = optionsOf(fieldId, form.fields.find((f) => f.id === fieldId)?.options).some(
      (o) => o.toLowerCase() === t.toLowerCase(),
    )
    if (!exists) {
      setCustom((c) => ({ ...c, [fieldId]: [...(c[fieldId] ?? []), t] }))
      setSelected((s) => ({ ...s, [fieldId]: [...(s[fieldId] ?? []), t] }))
    }
    setDraft('')
    setAdding(null)
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-zinc-100">
          <span className="grid place-items-center size-8 rounded-lg bg-orange-500/15 text-orange-400">
            <HelpCircle className="size-4.5" />
          </span>
          {form.title ?? 'The agent asks'}
        </DialogTitle>
        {form.intro && (
          <DialogDescription className="text-zinc-400">{form.intro}</DialogDescription>
        )}
      </DialogHeader>

      <div className="space-y-5 py-1">
        {form.fields.map((f, i) => {
          const opts = optionsOf(f.id, f.options)
          const missing = tried && f.required && missingRequired.includes(f.id)
          return (
            <div key={f.id} className="space-y-2">
              <div className="text-sm font-medium text-zinc-200">
                <span className="text-zinc-500 mr-1.5">{i + 1}.</span>
                {f.label}
                {f.required && <span className="text-red-400 ml-1">*</span>}
                <span className="ml-2 text-[11px] text-zinc-500">
                  {f.type === 'option' ? 'pick one' : f.type === 'multi' ? 'pick any' : 'type an answer'}
                </span>
              </div>

              {f.type === 'input' ? (
                <Input
                  autoFocus={i === 0}
                  value={inputs[f.id] ?? ''}
                  onChange={(e) => setInputs((v) => ({ ...v, [f.id]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
                  placeholder={f.placeholder ?? 'your answer…'}
                  className={`bg-zinc-950/70 border-zinc-800 ${missing ? 'border-red-500/60' : ''}`}
                />
              ) : (
                <div className="space-y-1.5">
                  {opts.map((o) => {
                    const sel = (selected[f.id] ?? []).includes(o)
                    const isCustom = (custom[f.id] ?? []).includes(o)
                    return (
                      <label
                        key={o}
                        className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-sm cursor-pointer transition-colors ${
                          sel ? 'border-orange-500/50 bg-orange-500/10 text-orange-200' : 'border-zinc-800 bg-zinc-950/50 text-zinc-300 hover:border-zinc-700'
                        }`}
                      >
                        {f.type === 'option' ? (
                          <span
                            className={`size-3.5 rounded-full border flex items-center justify-center shrink-0 ${sel ? 'border-orange-400 bg-orange-500/30' : 'border-zinc-600'}`}
                          >
                            {sel && <span className="size-1.5 rounded-full bg-orange-400" />}
                          </span>
                        ) : (
                          <Checkbox
                            checked={sel}
                            onCheckedChange={() => {
                              setSelected((s) => ({
                                ...s,
                                [f.id]: sel ? (s[f.id] ?? []).filter((x) => x !== o) : [...(s[f.id] ?? []), o],
                              }))
                            }}
                            className="shrink-0 data-[state=checked]:border-orange-400 data-[state=checked]:bg-orange-500/30"
                          />
                        )}
                        <span className="flex-1">{o}</span>
                        {isCustom && <span className="text-[10px] text-zinc-500 uppercase tracking-wide">yours</span>}
                      </label>
                    )
                  })}

                  {adding === f.id ? (
                    <div className="flex gap-2">
                      <Input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); addOption(f.id) }
                          if (e.key === 'Escape') { setAdding(null); setDraft('') }
                        }}
                        placeholder="your own option…"
                        className="bg-zinc-950/70 border-zinc-800 h-8 text-sm"
                      />
                      <Button size="sm" className="h-8 bg-orange-500 hover:bg-orange-400 text-zinc-950" onClick={() => addOption(f.id)}>
                        add
                      </Button>
                    </div>
                  ) : f.allowAddOption !== false ? (
                    <button
                      type="button"
                      onClick={() => { setAdding(f.id); setDraft('') }}
                      className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-orange-300 transition-colors"
                    >
                      <Plus className="size-3.5" /> add your own option
                    </button>
                  ) : null}

                  {missing && <p className="text-xs text-red-400">this one needs an answer</p>}
                </div>
              )}
            </div>
          )
        })}

        {form.allowNotes !== false && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-sm font-medium text-zinc-200">
              <MessageSquareText className="size-3.5 text-zinc-500" />
              {form.notesLabel ?? 'notes for the agent'}
              <span className="text-[11px] font-normal text-zinc-500">(optional)</span>
            </div>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="anything else the agent should know…"
              className="bg-zinc-950/70 border-zinc-800 min-h-[64px] text-sm"
            />
          </div>
        )}
      </div>

      <DialogFooter className="gap-2">
        <Button variant="outline" className="border-zinc-700" onClick={() => respond(null)}>
          Cancel
        </Button>
        <Button
          className="bg-orange-500 hover:bg-orange-400 text-zinc-950 gap-1.5"
          onClick={submit}
          disabled={tried && missingRequired.length > 0}
        >
          <SendHorizontal className="size-4" /> Send answers
        </Button>
      </DialogFooter>
    </>
  )
}
