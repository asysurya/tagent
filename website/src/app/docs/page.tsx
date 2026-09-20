import type { Metadata } from "next"
import Link from "next/link"
import { Code } from "@/components/code"
import { LATEST } from "@/data/releases"

export const metadata: Metadata = {
  title: "Docs — Tagent",
  description: "Install Tagent on Linux, macOS, Windows (WSL2) or an Android phone; configure providers; drive the agent.",
}

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="mt-16 scroll-mt-20 border-b border-zinc-800 pb-2 text-2xl font-bold tracking-tight text-zinc-100">
      {children}
    </h2>
  )
}

const TOC = [
  ["install-laptop", "Install — laptop & desktop"],
  ["userland", "Install — Android phone (UserLAnd)"],
  ["first-run", "First run"],
  ["usage", "Using the agent"],
  ["github-sync", "GitHub login & sync"],
  ["mcp", "MCP servers"],
  ["plugins", "Plugins"],
  ["config", "Configuration"],
  ["update", "Updates & version check"],
  ["troubleshooting", "Troubleshooting"],
]

export default function DocsPage() {
  return (
    <div className="mx-auto grid max-w-6xl gap-12 px-4 py-12 lg:grid-cols-[13rem_1fr]">
      {/* TOC — hidden on mobile; lg:block is required alongside lg:sticky
          (position alone does not undo display:none) */}
      <aside className="top-24 hidden h-fit self-start lg:sticky lg:block">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">On this page</div>
        <nav className="flex flex-col gap-1 text-sm">
          {TOC.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="rounded-md px-2 py-1 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200">
              {label}
            </a>
          ))}
        </nav>
      </aside>

      <article className="min-w-0">
        <h1 className="text-4xl font-bold tracking-tight">Docs</h1>
        <p className="mt-3 text-zinc-400">
          Current release: <span className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-sm font-mono text-orange-300">v{LATEST}</span>{" "}
          — see the <Link className="text-orange-400 hover:text-orange-300" href="/releases">changelog</Link>.
        </p>

        <H2 id="install-laptop">Install — laptop &amp; desktop</H2>
        <p className="mt-4 text-zinc-300">
          Tagent needs a Linux/Unix environment with <b>git</b> and <b>curl</b>; the installer adds the
          Bun runtime and dependencies. The web GUI ships pre-built in the repo, so there is nothing to
          compile. Debian, Ubuntu 20.04+ and WSL2 are tested.
        </p>
        <div className="mt-4 space-y-4">
          <Code>{`git clone https://github.com/asysurya/tagent.git
cd tagent
bash scripts/setup-ubuntu.sh    # bun + deps; --with-browser adds Playwright Chromium`}</Code>
          <Code>{`# start it on any folder:
bun link
tagent start ~/my-project
# → http://localhost:4020  (GUI + agent, one process)`}</Code>
        </div>
        <p className="mt-4 text-sm text-zinc-500">
          macOS works too (installer detects it), and Windows via WSL2. Prefer manual setup? Install
          Bun from <a className="text-orange-400 hover:text-orange-300" href="https://bun.sh" target="_blank" rel="noreferrer">bun.sh</a>, then <code className="rounded bg-zinc-800 px-1 text-xs">bun install</code> inside the repo.
        </p>

        <H2 id="userland">Install — Android phone (UserLAnd)</H2>
        <p className="mt-4 text-zinc-300">
          No root needed. UserLAnd runs a real Ubuntu filesystem on top of Android via proot, and
          shares the network — so the daemon is reachable from your phone browser at localhost.
        </p>
        <div className="mt-4 space-y-4">
          <Code>{`# 1. install "UserLAnd" from the Play Store, create an Ubuntu session
# 2. inside the UserLAnd terminal:
sudo apt-get update && sudo apt-get install -y git curl
git clone https://github.com/asysurya/tagent.git
cd tagent && bash scripts/setup-ubuntu.sh`}</Code>
          <Code>{`# 3. start the agent, then open http://localhost:4020 in Chrome:
tagent web ~/my-project --no-open`}</Code>
        </div>
        <p className="mt-4 text-sm text-zinc-500">
          The setup script detects phones automatically (skips heavy Chromium, prints mobile hints).
          Full guide with battery/background/RAM tips:{" "}
          <a
            className="text-orange-400 hover:text-orange-300"
            href="https://github.com/asysurya/tagent/blob/main/docs/USERLAND.md"
            target="_blank"
            rel="noreferrer"
          >
            docs/USERLAND.md
          </a>
          . iOS users: run Tagent on a PC/VPS and open <code className="rounded bg-zinc-800 px-1 text-xs">http://its-ip:4020</code> (start with <code className="rounded bg-zinc-800 px-1 text-xs">--host 0.0.0.0</code>, use a tunnel on untrusted networks).
        </p>

        <H2 id="first-run">First run</H2>
        <ol className="mt-4 list-decimal space-y-2 pl-5 text-zinc-300">
          <li>Open <span className="font-mono text-orange-300">http://localhost:4020</span> — the GUI connects over websocket automatically.</li>
          <li>Click the gear icon → add an API key for any provider (OpenAI, Anthropic, Google, OpenRouter, Groq, Ollama, Z.ai). Keys are stored locally only.</li>
          <li>Pick a workspace folder when starting the daemon — that&apos;s the agent&apos;s playground.</li>
          <li>Try the demo: clone Tagent, point the daemon at <span className="font-mono text-orange-300">demo-workspace</span> and ask it to &quot;fix both bugs in the README&quot;.</li>
        </ol>

        <H2 id="usage">Using the agent</H2>
        <ul className="mt-4 space-y-2 text-zinc-300">
          <li><b>Chat</b> — describe the task; the loop plans, calls tools, and reports back. Interrupt any time; steer mid-run.</li>
          <li><b>Markdown</b> — assistant replies render properly in the terminal: headings, bold/italic, code blocks, lists and tables.</li>
          <li><b>Keys</b> — ESC stops a running agent; while the transcript is scrolled up, ↑/↓ scroll it (input history stays on history recall — pgup/pgdn work too); the stats bar under the input keeps model · mode · tokens · time · workspace visible.</li>
          <li><b>Permissions</b> — every risky action (bash, write, edit, MCP tools) asks first — an arrow-key menu in the TUI, a dialog in the GUI. Choose once / session / always.</li>
          <li><b>Checkpoints</b> — auto-snapshots before writes; <span className="font-mono text-orange-300">/undo</span> restores.</li>
          <li><b>Plan mode</b> — read-only exploration before committing to changes.</li>
          <li><b>Subagents</b> — &quot;spawn a subagent to review X&quot; runs research in an isolated context.</li>
          <li><b>Slash commands</b> — <span className="font-mono text-orange-300">/model /mcp /plugins /sessions /undo /update</span> and plugin-defined ones. Menus are interactive: arrow keys + Enter, type to filter.</li>
          <li><b>Smart cache</b> — re-reading an unchanged file returns a tiny stub (the bytes are already in context); <span className="font-mono text-orange-300">read_files</span> batches up to 12 paths in one call; attach a file inline by mentioning <span className="font-mono text-orange-300">@src/file.ts</span> in chat. <span className="font-mono text-orange-300">tagent cache</span> inspects and clears it all.</li>
        </ul>

        <H2 id="github-sync">GitHub login &amp; sync</H2>
        <p className="mt-4 text-zinc-300">
          Guest-first: everything works locally, no account needed. When you want
          your projects on GitHub, log in once. In a terminal the picker defaults
          to <b>web connect</b>: a one-time page opens in your browser (served on
          127.0.0.1 with a one-time secret URL), you paste the token there and
          the terminal takes it from there — nothing is ever typed into the
          terminal itself. On UserLAnd/Termux the printed URL opens fine in the
          phone's own browser. The token is stored in{" "}
          <code className="rounded bg-zinc-800 px-1 text-xs">~/.tagent/credentials.json</code> (chmod 600,
          never in config.json). After login, if the current workspace has files and
          is not linked yet, tagent asks <b>once</b>: sync this project to a private
          GitHub repo? — <b>Sync now</b> / <b>Later</b> / <b>Not this project</b> (remembered).
        </p>
        <div className="mt-4">
          <Code>{`tagent auth              # login — picker: web connect (browser page) or paste a PAT
                          #   --web  straight to the browser flow
                          #   --device  OAuth device flow (needs TAGENT_GH_CLIENT_ID)
tagent sync              # snapshot the current project: commit + push
tagent sync "docs: readme" # …with a custom commit message
tagent projects          # linked projects — name, repo, last sync
tagent clone my-app      # continue a project on this machine
tagent whoami            # guest or login?
tagent logout            # remove the local token only`}</Code>
        </div>
        <ul className="mt-4 space-y-2 text-zinc-300">
          <li><b>Web connect</b> — a local one-time page on <code className="rounded bg-zinc-800 px-1 text-xs">127.0.0.1</code>: the repo scope is pre-selected via the create-token link, the token is validated against the GitHub API and stored exactly like the paste flow. Loopback-only bind, secret URL path, Origin checks, and the server dies after the login.</li>
          <li><b>Sync</b> — commits the workspace and pushes with a one-shot token; the remote URL stays clean in <code className="rounded bg-zinc-800 px-1 text-xs">.git/config</code> and the repo stays private.</li>
          <li><b>Clone</b> — <span className="font-mono text-orange-300">tagent clone owner/repo</span> (or just the project name from your registry) restores it, then <span className="font-mono text-orange-300">cd</span> in and run <span className="font-mono text-orange-300">tagent start</span>.</li>
          <li><b>Web GUI</b> — the same flow as dialogs: GitHub login, sync workspace, and a project list with last-sync times.</li>
        </ul>

        <H2 id="mcp">MCP servers</H2>
        <p className="mt-4 text-zinc-300">
          Tagent speaks the <a className="text-orange-400 hover:text-orange-300" href="https://modelcontextprotocol.io" target="_blank" rel="noreferrer">Model Context Protocol</a> over
          stdio. Connect any server — Context7 for up-to-date library docs, filesystem,
          memory, sequential-thinking or your own — and its tools become agent-callable
          natives named <code className="rounded bg-zinc-800 px-1 text-xs">mcp_&lt;server&gt;_&lt;tool&gt;</code> behind the same permission gates.
        </p>
        <div className="mt-4">
          <Code>{`# interactive manager — status, one-click templates, custom servers
#   TUI: /mcp                     GUI: Settings → MCP

# or .tagent/config.json:
"mcp": { "servers": {
  "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }
}}`}</Code>
        </div>

        <H2 id="plugins">Plugins</H2>
        <p className="mt-4 text-zinc-300">
          A plugin is a hot-reloading <code className="rounded bg-zinc-800 px-1 text-xs">.mjs</code> file in
          <code className="rounded bg-zinc-800 px-1 text-xs">.tagent/plugins/</code> exporting any mix of: lifecycle hooks, custom agent
          tools (<code className="rounded bg-zinc-800 px-1 text-xs">plugin_&lt;name&gt;_&lt;tool&gt;</code>) and custom slash commands. Scaffold one from
          <span className="font-mono text-orange-300">/plugins</span> in the TUI or Settings → Plugins in the GUI.
        </p>

        <H2 id="config">Configuration</H2>
        <p className="mt-4 text-zinc-300">
          Workspace-local <code className="rounded bg-zinc-800 px-1 text-xs text-orange-300">.tagent/config.json</code> overrides{" "}
          <code className="rounded bg-zinc-800 px-1 text-xs text-orange-300">~/.tagent/config.json</code>. Both are gitignored.
        </p>
        <div className="mt-4">
          <Code>{`{
  "defaultProvider": "openai",
  "defaultModel": "gpt-5",
  "apiKeys": { "openai": "sk-…" },
  "permissions": { "tools": { "bash": "ask", "write_file": "ask" } },
  "tools": { "bash": true, "browser": false },
  "github": { "repo": "my-workspace" },
  "maxTurns": 40
}`}</Code>
        </div>
        <p className="mt-4 text-sm text-zinc-500">
          GitHub auth is not configured here — <code className="rounded bg-zinc-800 px-1 text-xs">tagent auth</code>
          stores the token in the credentials store; the <code className="rounded bg-zinc-800 px-1 text-xs">github.repo</code> key
          only overrides the repo name <code className="rounded bg-zinc-800 px-1 text-xs">tagent sync</code> pushes to.
        </p>

        <H2 id="update">Updates &amp; version check</H2>
        <p className="mt-4 text-zinc-300">
          On startup the TUI checks for a newer release (at most once a day, result cached
          locally) and, when one exists, offers an <b>arrow-key y/N update prompt</b>. Answer
          yes and Tagent updates itself in place — binaries download the matching release
          asset and swap it, npm/bun installs run the global upgrade, source checkouts
          <code className="rounded bg-zinc-800 px-1 text-xs">git pull</code>. An outdated Tagent that declines the update <b>keeps working
          fully</b> — nothing breaks, nothing locks. Checks are silent when offline.
        </p>
        <div className="mt-4">
          <Code>{`tagent update            # check + self-update (y/N) from the shell
tagent --version         # print the running version
tagent --check-update   # force a check right now
# override the endpoint (e.g. self-hosted mirror):
export TAGENT_UPDATE_URL=https://your-host/latest.json`}</Code>
        </div>
        <p className="mt-4 text-sm text-zinc-500">
          Update path: <code className="rounded bg-zinc-800 px-1 text-xs">git pull &amp;&amp; bash scripts/setup-ubuntu.sh</code> —
          the pre-built GUI updates with the pull.
        </p>

        <H2 id="troubleshooting">Troubleshooting</H2>
        <div className="mt-4 overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-zinc-800/70">
              {[
                ["Port 4020 already in use", "tagent <folder> --port 4021"],
                ["GUI shows “demo mode”", "daemon not running — start it with tagent web <folder>"],
                ["bun: command not found", "export PATH=\"$HOME/.bun/bin:$PATH\""],
                ["No provider key", "Settings → add a key, or run a local Ollama and pick it as provider"],
                ["Accidental edit", "/undo restores the last auto-checkpoint"],
                ["Version warning wrong", "rm ~/.tagent/update-check.json; tagent --check-update"],
              ].map(([a, b]) => (
                <tr key={a} className="bg-zinc-900/30">
                  <td className="px-4 py-2.5 font-medium text-zinc-200">{a}</td>
                  <td className="px-4 py-2.5 text-zinc-400"><code className="text-xs text-orange-300/90">{b}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>
    </div>
  )
}
