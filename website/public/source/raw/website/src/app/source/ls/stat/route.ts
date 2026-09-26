import { handleLsApi } from '@/lib/source-ls'

export const dynamic = 'force-dynamic'

/**
 * GET /source/ls/stat?path=<file> — one file, in detail: size, lines,
 * language, lastModified, the JSDoc-header summary, and its raw/json URLs.
 *
 * Directories are rejected with a 400 pointing at /source/ls?path=… .
 * JSON by default; plain text with `Accept: text/plain` or `?format=text`.
 */
export async function GET(request: Request): Promise<Response> {
  return handleLsApi(request, 'stat')
}
