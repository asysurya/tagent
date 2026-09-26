import { handleLsApi } from '@/lib/source-ls'

export const dynamic = 'force-dynamic'

/**
 * GET /source/ls/quickref — the curated "where does X live" map: the
 * system prompt, the agentic loop, the updater, … each with its path.
 * Entries are validated against the snapshot at request time; stale ones
 * are reported instead of silently dropped.
 *
 * JSON by default; plain text with `Accept: text/plain` or `?format=text`.
 */
export async function GET(request: Request): Promise<Response> {
  return handleLsApi(request, 'quickref')
}
