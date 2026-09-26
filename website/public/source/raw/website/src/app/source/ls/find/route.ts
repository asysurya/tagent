import { handleLsApi } from '@/lib/source-ls'

export const dynamic = 'force-dynamic'

/**
 * GET /source/ls/find?q=<keyword> — search file AND folder names.
 *
 * Query params:
 *   q       the keyword (required; matches the name first, then the path)
 *   layer   optional layer filter (core · cli · gui · website · native · scripts)
 *   limit   max results (default 50, max 200)
 *
 * JSON by default; plain text with `Accept: text/plain` or `?format=text`.
 */
export async function GET(request: Request): Promise<Response> {
  return handleLsApi(request, 'find')
}
