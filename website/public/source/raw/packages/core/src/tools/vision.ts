import fs from 'node:fs'
import path from 'node:path'
import type { ToolContext, ToolDefinition } from '../types'
import { jailPath, trunc } from '../util'
import { getAdapter, acceptsImages } from '../providers'
import { resolveMediaModel } from '../modelroles'
import { completeWithFallback, fallbackTailFor, type ResolvedChainEntry } from '../fallback'

/**
 * The `vision` tool — send images to the DEDICATED vision model and get a
 * QA report back. The main agent (and any subagent) hands over screenshot
 * or design-image paths; the media model (models.media.vision — a separate,
 * possibly different model from the coding agent) analyzes them.
 *
 * The report is not just "does it run": the built-in rubric covers
 * functionality, visual layout, typography, responsiveness, contrast and
 * accessibility — exactly what a QA pass on a web UI needs.
 *
 * Resolution: models.media.vision → (fallback) the main model when it
 * accepts images → a setup error pointing at /model media vision.
 * Failover: the vision chain — fallbacks.vision — is walked on adapter
 * errors, exactly like the main agent walks its own chain.
 */

/** test seam — the adapter factory is swappable so tests never hit the network */
export const visionInternals = {
  resolveAdapter: getAdapter,
  /** the vision failover tail — swappable in tests */
  resolveTailFor: fallbackTailFor,
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const MEDIA_TYPE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}

/** max images per call — matches the loop's per-request image budget */
const MAX_IMAGES = 4
const MAX_BYTES = 2_500_000 // ~1.9MB base64 — same cap the loop uses

function newestShots(dir: string): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(dir, e.name))
    .filter((p) => {
      try {
        return fs.statSync(p).size <= MAX_BYTES
      } catch {
        return false
      }
    })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, MAX_IMAGES)
}

/** Expand the images param: comma-separated paths; a directory = its newest shots. */
function expandImagePaths(raw: string, ctx: ToolContext): { files: string[]; error?: string } {
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!parts.length) return { files: [], error: 'images is required — one or more image paths (or a shots directory)' }
  const files: string[] = []
  for (const part of parts) {
    let abs: string
    try {
      abs = jailPath(ctx.workspaceRoot, part)
    } catch {
      return { files: [], error: `path escapes the workspace: ${part}` }
    }
    let st: fs.Stats
    try {
      st = fs.statSync(abs)
    } catch {
      return { files: [], error: `not found: ${part}` }
    }
    if (st.isDirectory()) {
      const shots = newestShots(abs)
      if (!shots.length) return { files: [], error: `no images in ${part}` }
      files.push(...shots.filter((f) => !files.includes(f)))
      continue
    }
    if (!IMAGE_EXT.has(path.extname(abs).toLowerCase())) {
      return { files: [], error: `not an image (png/jpg/webp/gif/bmp): ${part}` }
    }
    if (st.size > MAX_BYTES) {
      return { files: [], error: `too large (>2.5MB): ${part}` }
    }
    if (!files.includes(abs)) files.push(abs)
  }
  if (files.length > MAX_IMAGES) files.length = MAX_IMAGES
  if (!files.length) return { files: [], error: 'no usable images given' }
  return { files }
}

/** The QA rubric the vision model runs against — UI, not just "does it load". */
const VISION_SYSTEM = `You are the vision analysis engine inside tagent — a senior UI/QA reviewer. You receive screenshots or design images and produce a precise, evidence-based report.

ALWAYS cover, in this order (skip a section only when the image provably contains no UI):
1. FUNCTIONALITY — what the screen(s) show; anything visibly broken: error states, blank areas, failed/missing images, overlapping elements, loading spinners that suggest a hang.
2. LAYOUT & UI — structure, alignment, spacing consistency, visual hierarchy, cut-off or clipped content, elements overflowing their containers.
3. TYPOGRAPHY — font-size hierarchy (is scale sane?), line length/height, truncated or wrapping text, inconsistent fonts/weights, all-caps abuse, tiny (<12px) body text.
4. RESPONSIVE — when multiple viewports of the same screen are given, compare them: does the layout adapt (stack, hide, reflow) or break? Horizontal overflow, cramped or overlapping elements on small widths, tap-target size. When only one viewport is given, judge whether the layout would survive a narrower screen.
5. COLOR & CONTRAST — readability of text on its background, low-contrast combos, clashing or inconsistent palette use.
6. ACCESSIBILITY (quick pass) — missing apparent labels, icon-only buttons without tooltips, focus/keyboard hints visible in the shot.
7. VERDICT — one of: PASS / WARN (usable, issues listed) / FAIL (broken), then the issue list, each as: [severity: high|medium|low] <element/area> — <what is wrong> — <suggested fix>.

Rules:
- Describe ONLY what is actually visible in the images — never invent elements.
- Be specific (name the component, the region, the text); no generic filler like "looks good".
- Severity honest: cosmetic ≠ high. Missing core content = high.
- Keep it tight: bullets over prose, no restating the task, no conclusions without pointing at pixels.`

export const visionTool: ToolDefinition = {
  name: 'vision',
  description:
    'Analyze images with the dedicated vision model (models.media.vision) and get a UI/QA report: ' +
    'functionality, layout, typography, responsiveness, contrast, accessibility, verdict. ' +
    'Pass screenshots (e.g. .tagent/test/shots — a directory takes its newest shots), design mockups, or any image. ' +
    'The report comes from a SEPARATE model — the coding agent stays on its own model.',
  risk: 'low',
  params: {
    images:
      'string (required) — image path(s), comma-separated; a directory takes its newest ≤4 shots (e.g. .tagent/test/shots)',
    task:
      'string — what to check (default: full UI QA). e.g. "did the login form render correctly after my fix?"',
  },
  inputSchema: {
    type: 'object',
    properties: {
      images: { type: 'string', description: 'Image path(s), comma-separated, or a shots directory' },
      task: { type: 'string', description: 'What to check — default: the full UI QA rubric' },
    },
    required: ['images'],
  },
  async run(input, ctx) {
    const raw = String(input.images ?? '')
    const task = String(input.task ?? '').trim() || 'Full UI QA review of the attached screenshot(s).'
    const { files, error } = expandImagePaths(raw, ctx)
    if (error) return `Error: ${error}`

    /* ---- which model does the looking? ---- */
    const ref = resolveMediaModel('vision', ctx.config)
    let providerId: string
    let model: string
    let adapter
    if (ref) {
      providerId = ref.provider
      model = ref.model
      try {
        adapter = visionInternals.resolveAdapter(providerId, ctx.config, ctx.workspaceRoot)
      } catch (e) {
        return `Error: the configured vision model (${providerId}/${model}) is unavailable: ${(e as Error).message}`
      }
    } else {
      // no dedicated model → the main model, but only if it can see images
      providerId = ctx.config.defaultProvider
      model = ctx.config.defaultModel
      try {
        adapter = visionInternals.resolveAdapter(providerId, ctx.config, ctx.workspaceRoot)
      } catch (e) {
        return `Error: could not build the main provider (${(e as Error).message})`
      }
      if (!acceptsImages(adapter, model)) {
        return (
          `Error: no vision model. The main model (${providerId}/${model}) does not accept image input.\n` +
          `Set a dedicated one: /model media vision <provider>/<model>  (e.g. zai/glm-4.6 or openai/gpt-4o)`
        )
      }
    }

    /* ---- read the images ---- */
    const parts: { data: string; mediaType: string }[] = []
    const named: string[] = []
    for (const f of files) {
      try {
        const buf = fs.readFileSync(f)
        parts.push({ data: buf.toString('base64'), mediaType: MEDIA_TYPE[path.extname(f).toLowerCase()] ?? 'image/png' })
        named.push(path.relative(ctx.workspaceRoot, f))
      } catch {
        return `Error: could not read ${f}`
      }
    }
    if (!parts.length) return 'Error: no readable images'

    /* ---- ask the vision model (no tools — one clean report) ---- */
    const user =
      `${task}\n\n` +
      `${parts.length} image${parts.length > 1 ? 's' : ''} attached: ${named.join(', ')}.` +
      (parts.length > 1
        ? ' When they are the same screen at different viewports, run the RESPONSIVE comparison across them.'
        : '')
    try {
      // the vision failover lane: primary first, then fallbacks.vision
      const chain: ResolvedChainEntry[] = [
        { adapter, model, label: 'primary' },
        ...visionInternals.resolveTailFor(ctx.config, 'vision'),
      ]
      const res = await completeWithFallback(chain, {
        model,
        messages: [
          { role: 'system', content: VISION_SYSTEM },
          { role: 'user', content: user, images: parts },
        ],
        signal: ctx.signal,
      })
      const text = (res.text ?? '').trim()
      if (!text) return `Error: the vision model (${providerId}/${model}) returned no text`
      return `VISION REPORT — ${providerId}/${model}\nimages: ${named.join(', ')}\n\n${trunc(text, 12_000)}`
    } catch (e) {
      return `Error: vision call failed (${providerId}/${model}): ${(e as Error).message}`
    }
  },
}
