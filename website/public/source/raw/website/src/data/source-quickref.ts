/**
 * source-quickref.ts — the curated "where does X live" map behind
 * /source/ls/quickref.
 *
 * Maintained by hand; validated at request time against the snapshot.
 * An entry whose paths no longer exist is reported in `stale` (and marked
 * [stale] in the plain-text view) instead of silently disappearing —
 * quickref must stay honest across refactors.
 */

export interface QuickrefItem {
  /** what an agent would call the thing */
  label: string
  /** one or more snapshot paths (repo-relative, no leading slash) */
  paths: string[]
  note?: string
}

export const SOURCE_QUICKREF: QuickrefItem[] = [
  {
    label: 'system prompt',
    paths: ['packages/core/src/system-prompt.ts'],
    note: 'the agent contract: loop, personas, finishing block',
  },
  { label: 'agentic loop', paths: ['packages/core/src/loop.ts'], note: 'PLAN→BUILD→TEST, tool dispatch, retries' },
  { label: 'tool registry', paths: ['packages/core/src/tools/index.ts'], note: 'every tool the agent can call' },
  { label: 'worklog tool', paths: ['packages/core/src/tools/worklog.ts'], note: 'the shared multi-agent journal' },
  { label: 'version', paths: ['packages/core/src/version.ts'], note: 'CURRENT_VERSION — bump here first' },
  { label: 'provider adapters', paths: ['packages/core/src/providers/index.ts', 'packages/core/src/providers/registry.ts'] },
  { label: 'skills', paths: ['packages/core/src/skills.ts'] },
  { label: 'memory', paths: ['packages/core/src/memory.ts'] },
  { label: 'subagents (task tool)', paths: ['packages/core/src/tools/task.ts', 'packages/core/src/subagents.ts'] },
  { label: 'model roles', paths: ['packages/core/src/modelroles.ts'], note: 'main · subagent · media categories' },
  { label: 'vision QA', paths: ['packages/core/src/tools/vision.ts'] },
  { label: 'browser tool', paths: ['packages/core/src/tools/browser.ts'] },
  { label: 'filesystem tool', paths: ['packages/core/src/tools/fs.ts'] },
  { label: 'CLI entrypoint', paths: ['packages/cli/src/index.ts'] },
  { label: 'TUI app', paths: ['packages/cli/src/tui-app.ts', 'packages/cli/src/tui.ts'] },
  { label: 'updater', paths: ['packages/cli/src/updater.ts'], note: 'the update checker' },
  { label: 'GUI app', paths: ['src/components/tagent/tagent-app.tsx'] },
  { label: 'website landing', paths: ['website/src/app/page.tsx'] },
  { label: 'source browser', paths: ['website/src/components/source/source-browser.tsx'], note: 'this site\u2019s /source page' },
  { label: 'syntax highlighter', paths: ['website/src/lib/highlight.ts'] },
  { label: 'ls engine (this API)', paths: ['website/src/lib/source-ls.ts'] },
  { label: 'quickref data', paths: ['website/src/data/source-quickref.ts'] },
  { label: 'snapshot generator', paths: ['scripts/gen-source-snapshot.ts'], note: 'regenerates everything under /source' },
  { label: 'release script', paths: ['scripts/gh-release.sh'] },
  { label: 'releases data', paths: ['website/src/data/releases.ts'], note: 'the /releases page source' },
]
