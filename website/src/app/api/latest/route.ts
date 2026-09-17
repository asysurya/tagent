import { NextResponse } from "next/server"
import { RELEASES } from "@/data/releases"

/**
 * Machine-readable "latest release" endpoint — same data the CLI update
 * checker reads via raw.githubusercontent.com. Long-cacheable: it only
 * changes when a release is published.
 */
export async function GET() {
  const newest = RELEASES[0]
  return NextResponse.json(
    {
      version: newest.version,
      date: newest.date,
      notes: newest.summary,
      url: `https://github.com/asysurya/tagent/releases/tag/v${newest.version}`,
    },
    {
      headers: {
        "cache-control": "public, max-age=300, s-maxage=3600",
      },
    },
  )
}
