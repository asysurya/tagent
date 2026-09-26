import { handleLsApi } from '@/lib/source-ls'

export const dynamic = 'force-dynamic'

/**
 * GET /source/ls — `ls` one folder of the Tagent source snapshot.
 *
 * Query params:
 *   path       folder to list (default: / — leading slash optional)
 *   recursive  true → nested tree instead of a flat listing
 *   depth      levels below `path` when recursive (default 1, max 8)
 *   all        true → also list the dir names that are never in the snapshot
 *   detail     true → add path · lastModified · rawUrl · jsonUrl (files)
 *              and aggregates + dirUrl (dirs) to every entry
 *   layer      filter to a layer: core · cli · gui · website · native · scripts
 *
 * JSON by default; plain text (`tree`-style) with `Accept: text/plain`
 * or `?format=text`. Data comes from the build-time snapshot — see
 * website/src/lib/source-ls.ts.
 */
export async function GET(request: Request): Promise<Response> {
  return handleLsApi(request, 'ls')
}
