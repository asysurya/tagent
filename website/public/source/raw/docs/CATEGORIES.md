# Taceen Capability Categories — Design (PART C)

**Audience:** Taceen, the future external Tool & Capability Resolver model.
**Question Taceen answers:** *"tool/MCP/skill apa yang tersedia untuk X?"* —
via a **two-stage flow**: (1) pick ONE category from a small curated list,
(2) return only that category's capabilities.

**Machine format:** [`.tagent/taceen/categories.json`](../.tagent/taceen/categories.json) (this doc is the design + rationale).
**Model:** "Model A2" — categories are FUNCTIONAL and CROSS-KIND: one category
holds tools + MCP tools + skills together (e.g. `quality_assurance` =
`serve` [tool] + `bug-hunter` [skill]). Skills are ordinary tool-callable
capabilities (via `search_skills` → `load_skill`).

**Source of truth for the inventory:** WORKLOG Task 6 (explore) — 25 registered
tools in `packages/core/src/tools/index.ts` `ALL_TOOLS`, MCP injected from
`config.mcp.servers` (stdio, named `mcp_<server>_<tool>`, ≤60 chars, risk
medium), 3 builtin skills in `builtin-skills/`.

> ⚠️ **MCP entries are EXAMPLES.** The 13 `type:"mcp"` entries in
> categories.json are *representative entries for common servers* so the
> catalog demonstrates cross-kind categories. The LIVE MCP tool list is
> per-user config (`config.mcp.servers`); mapping live servers in is a
> generator concern — see Design Answer 7.

---

## 1. The category set

| id | name | description | count |
|---|---|---|---|
| `filesystem` | Filesystem | Read, search, and modify workspace files and directories | 9 |
| `web_research` | Web Research | Fetch web pages and search the internet | 4 |
| `web_ui` | Web & UI | Build and verify web interfaces: drive browsers, inspect screenshots | 6 |
| `execution` | Execution | Run shell commands and manage background processes | 4 |
| `quality_assurance` | Quality Assurance | Run, exercise, and verify projects; debug and review code | 4 |
| `delegation` | Delegation | Spawn subagents and control the current run | 3 |
| `workflow` | Workflow | Track session work: todos, journal, and human questions | 3 |
| `knowledge` | Knowledge | Persistent memory and skill discovery across sessions | 3 |
| `data` | Data | Query databases through MCP servers | 2 |
| `repo_collab` | Repo Collaboration | Manage repositories, issues, and pull requests via MCP | 3 |
| **total** | | **10 categories** | **41 capabilities** |

**Why this set (coverage / balance / no overlap):**

- **Coverage:** all 25 registered tools, all 3 builtin skills, and 13
  representative MCP entries appear exactly once (25 + 3 + 13 = 41; within the
  30–50 budget). Every capability a user can ask "what's available for X?"
  about has a home.
- **Balance:** sizes run 2–9; no category is a dumping ground and none is a
  synonym of another. The two thin categories (`data`, `repo_collab`) are thin
  *by nature* — tagent has no native database or GitHub tools; those functions
  arrive via MCP. They exist so that the very common intents "query database"
  and "open a PR" have a precise landing slot instead of polluting a broader
  category. Small categories are cheap: returning 2 capabilities costs fewer
  tokens than mis-returning a 9-item category.
- **No overlap:** each capability is assigned to the category matching its
  *primary function* (e.g. `grep` → filesystem content search, NOT web
  research; `serve` → QA run flow, NOT execution, because its whole purpose is
  "start project and wait until reachable" for exercising the app; `vision` →
  web_ui because in practice it judges UI screenshots). A verifier asserts
  global uniqueness of every `(type, n, s)` triple.
- **Mode gating is deliberately NOT encoded.** Plan/test/subagent gating lives
  in `buildToolset()` (`tools/index.ts`) — categories are per-capability static
  metadata. Taceen may add a caveat "availability depends on the current mode"
  in its answer, but the per-mode allowlists stay in the toolset builder, the
  single source of truth.

---

## 2. Subcategory policy

**Convention (one rule, applied everywhere):** capabilities ALWAYS live inside
`subcategories` — the parser never has to handle two shapes. A category with
**8+ capabilities** is partitioned into meaningful subcategories; a category
below the threshold gets exactly **one** subcategory with id `"general"`.

- Threshold rationale: below ~8 items, a flat list is still scannable by a
  small model; above it, subcategory ids (`read_ops` vs `write_ops`) act as a
  free second-level routing signal and chunk the answer for rendering.
- Subcategories, when present, MUST **partition** the category: every
  capability belongs to exactly one subcategory; subcategory ids are unique
  within their category (so `"general"` may repeat across categories).
- Example: `filesystem` (9) → `read_ops` (6) / `write_ops` (3).
- Near-example: `web_ui` (6) stays `general`; if it grows past 8 it would split
  into `drive` (browser + MCP browser) and `verify` (vision, screenshots).
- Adding a capability = one entry in the right subcategory (see Maintenance).

---

## 3. Capability format spec

```json
{ "type": "tool" | "mcp" | "skill",  "n": "<name>", "d": "<description>", "s": "<server>" }
```

- `type` — kind: builtin tool, MCP-injected tool, or skill.
- `n` — the CALLABLE name: tool name (`read_file`), the generated MCP name
  (`mcp_<slug(server)>_<slug(tool)>`, ≤60 chars — matches `toolName()` in
  `mcp.ts`), or the skill id (`bug-hunter`, loadable via `load_skill`).
- `d` — 8–14 words: what it does + the key qualifier (limit, risk, or when).
- `s` — server slug, **MCP entries only** (matches the key in
  `config.mcp.servers`); absent for tools and skills.

**Token-budget rationale:** each entry is ~30 tokens (`type`+`n`+`d`+`s`);
the full 41-capability catalog is well under ~1.5k tokens — cheap enough that
Taceen (a small model) can hold ALL category descriptions (~10 × 15 words)
plus the chosen category's payload in one context with room for the user's
question. That is why descriptions are telegraphic, category descriptions are
one sentence, and there is no per-capability schema/params/risk data: Taceen
answers "what's available", not "how do I call it" (the host's tool-call UI
and `load_skill` handle usage).

---

## 4. The 8 design answers

### (1) Category list + rationale
The 10 categories in the table above. They are derived from the *queries users
actually ask* ("baca file", "cari di web", "test app", "buka PR"), not from the
code layout — that is what makes a two-stage picker viable: stage 1 is a
10-way classification, which a small model does reliably. `filesystem`,
`execution`, `web_research`, `web_ui` are the four verbs of agent work
(read/write, run, look-up, verify); `quality_assurance`, `delegation`,
`workflow`, `knowledge` are the agent managing itself and its session
(verify, delegate, track, remember); `data` and `repo_collab` exist because
MCP servers deliver whole functional domains that the native inventory lacks.
Ten is the deliberate ceiling: enough slots for distinct intents, few enough
that category descriptions fit in a few hundred tokens.

### (2) Subcategories — when and why
Only when a category reaches 8+ capabilities (see §2). Reason: subcategories
cost tokens (ids + brackets) and cost the picker an extra decision; they pay
off only when the payload is big enough to need internal structure or when two
clearly different sub-functions share a category (reading vs writing files).
`filesystem` is the live example: `read_ops` vs `write_ops` lets Taceen answer
"apa yang tersedia untuk baca file?" with just the read half if it wants.
Everything smaller ships flat under `"general"` — uniform shape, zero parser
branching. If a flat category later crosses the threshold, splitting it is a
mechanical, backward-compatible edit (move entries into new subcategory ids).

### (3) Category descriptions — style guide
One sentence, ~15 words, format: `<verb phrase covering all members> (<2–4
Indonesian keywords>)`. The sentence must (a) name the function, not the
members — "Read, search, and modify workspace files" not "read_file and
friends"; (b) cover EVERY member, since the picker trusts it as the summary;
(c) end with a short Indonesian keyword parenthetical, because real queries
are often Bahasa Indonesia ("baca", "cari di internet", "uji") and a small
model matches literal keywords best. Banned: member name dumps, marketing
adjectives, mode/permission notes (that's the toolset builder's job).

### (4) Capability format + token budget
`{type, n, d, s}` as specced in §3. `n` is always the exact callable name
(MCP names generated with the real `mcp_<slug>_<slug>` convention so the
answer is copy-pasteable into a tool call). `d` is 8–14 words because shorter
(3–4 words) fails to disambiguate near-synonyms (`read_file` vs
`read_files` vs `mcp_filesystem_read_file`) and longer (~25 words) doubles
catalog cost for no picking benefit. The `s` field exists ONLY for MCP because
the server identity is the datum Taceen needs to say "requires the *sqlite*
server in your config" — tools and skills have no server, so the key is
omitted, not set to null.

### (5) Exposure mechanism — how Taceen reads this
Options compared:
- **Static versioned JSON file** (chosen): `categories.json` shipped in the
  repo, `version` field for schema evolution. Works offline, diffable in git,
  loadable by `taceen.py` in one `json.load`, no running tagent required, and
  trivially cacheable.
- **CLI output** (e.g. `tagent tools --json`): always fresh but requires a
  live tagent install + process spawn per resolution, is host/version
  dependent, and mixes in per-mode/per-config state that Taceen should not
  bake into its catalog.
- **MCP endpoint** (expose the catalog AS a tool): elegant symmetry but needs
  a running server, adds a bootstrapping paradox (Taceen is itself the
  resolver for MCP), and is the slowest path for a static dataset.

**Recommendation: static versioned JSON as the base, plus a regenerate step.**
Sync with the LIVE registry: a generator (part of `taceen.py` or a small
script) reads the three live sources — `ALL_TOOLS` in
`packages/core/src/tools/index.ts`, resolved `config.mcp.servers` (+ each
server's tool list), and the skills dirs (builtin + user) — and rewrites
`categories.json` when the derived content differs. Run it **on startup and on
MCP config change** (the host already resolves MCP servers at startup, so the
hook point is free); on generator failure, fall back to the shipped static
file, which is always a valid (if slightly stale) answer. Schema changes bump
`version`; content regenerations do not (content is derived, not hand-curated,
except the example MCP entries which the generator replaces wholesale).

### (6) Fallbacks
- **No category matches:** return (a) a hint ("nothing in the catalog matches
  — try one of: <10 category names>"), (b) the **flattened name-only list** of
  all capabilities (~41 short names, a few hundred tokens — bounded, cheap),
  and (c) for skill-shaped queries, **delegate to `search_skills`** live
  (query + tags). Justification: the flattened list keeps the answer grounded
  in real callable names instead of a bare "not found", while delegating to
  `search_skills` covers the user-installed long tail that the static file
  cannot know. We do NOT auto-merge every category: an unfiltered 41-item dump
  with descriptions is exactly the token bloat the two-stage design avoids.
- **Two or more categories match:** **rank by keyword score, return the top
  one**, and mention runners-up by name only ("also relevant: `web_ui`").
  Score = overlap between query tokens and the category's id + name +
  description + its capability names/descriptions; tie-break by smaller
  category (more precise payload). Justification: merging breaks the two-stage
  contract (stage 2 assumes ONE category's payload; merged lists grow
  unbounded and blur the answer), while ranking keeps the returned set tight
  and still tells the user where else to look. (Worked example B below.)

### (7) MCP handling (live servers → categories)
Live MCP tools are named `mcp_<slug(server)>_<slug(tool)>` (≤60 chars, hash
suffix on truncation) at injection time, so the mapping is
**convention-based on the server slug** — a small table (in the generator,
NOT in categories.json): `filesystem`→filesystem, `fetch`/`brave-search`→
web_research, `browser`→web_ui, `github`→repo_collab, `sqlite`/`postgres`→
data, `memory`→knowledge, `everything-else-known`→best keyword match on the
server's tool descriptions. **Unknown servers** land in a runtime
`extensions` catch-all category ("tools from your <server> MCP server"),
created only when unknown servers exist — the shipped file does not carry an
empty shell category. Hot-reload: the generator re-runs whenever MCP config
changes (same hook as answer 5), so a newly added server appears without a
release. Note: subagents never see MCP tools today (`spawnSubagent` passes no
`extraTools`) — the generator ignores that; it is mode/runtime gating, not
catalog data.

### (8) Skill handling
**Recommendation: keep known skills as entries in categories.json AND treat
`search_skills` as the live long-tail fallback.** Reasons: builtin skills are
a small, stable, versioned set — perfect static catalog material — and listing
them in categories makes them first-class answers to "apa yang tersedia untuk
debug?" (bug-hunter) instead of requiring a second live call. But user skill
dirs are unbounded and per-user, so they must NOT be hardcoded: the
regenerator adds discovered skills by tag/function, and at answer time a
no-match or skill-flavored query falls through to `search_skills` (design
answer 6). This preserves the two-stage flow: category first (cheap, static,
covers the common case), live search second (fresh, covers the long tail).
Skills are ordinary tool-callable capabilities — `load_skill` is the call
mechanism, which is why they sit in the same catalog as tools rather than a
separate one.

---

## 5. Worked examples

**A. "apa yang tersedia untuk baca dan mengedit file?"**
Stage 1 — keywords `baca/edit file` → **filesystem**.
Stage 2 — Taceen returns:

```
filesystem > read_ops:
  tool  read_file                        Read one workspace file; smart-cached, ~200KB
  tool  read_files                       Batch-read up to 12 files in one call
  tool  list_files                       List files and directories in the workspace
  tool  grep                             Regex content search; path:line:text matches
  mcp   mcp_filesystem_read_file         (server: filesystem) read file contents
  mcp   mcp_filesystem_list_directory    (server: filesystem) list a directory
filesystem > write_ops:
  tool  write_file                       Create or fully overwrite a file
  tool  edit_file                        Exact-string replacement edit
  mcp   mcp_filesystem_write_file        (server: filesystem) create/overwrite files
```
(MCP lines carry the caveat: available only if the *filesystem* server is
configured; `read_file`/`edit_file` always are.)

**B. "what can I use to test the web app I just built?"**
Stage 1 — matches TWO categories: `quality_assurance` (keywords *test,
verify, uji*) and `web_ui` (*web app*, the `web-app-builder` skill name).
Ranking: score(quality_assurance)=3, score(web_ui)=2 → return
**quality_assurance**: `serve`, `test_report`, `bug-hunter` [skill],
`code-review` [skill] — plus the one-line hint "also relevant: `web_ui`
(browser, vision, web-app-builder)". This is the design answer 6 flow:
rank, don't merge.

**C. "gimana cara query database sqlite?"**
Stage 1 — keywords *database/query/sqlite* → **data**.
Stage 2 — `mcp_sqlite_query` (s: sqlite), `mcp_postgres_query` (s: postgres).
Taceen's answer is honest about MCP-only categories: "no native database
tool; these require the *sqlite* (or *postgres*) server in your MCP config"
— and suggests `bash` as the fallback if a CLI client exists. If the user has
NO such server configured, the live regenerator (answer 7) yields an empty
`data` category and Taceen says exactly that instead of hallucinating.

---

## 6. Maintenance

- **Add a capability** = add ONE entry `{"type","n","d"[,"s"]}` to the right
  category; if that category crosses 8 capabilities, split its `general`
  subcategory into meaningful ids first. No other file changes.
- **Add a category** = last resort (max 10): only when a genuinely new
  function arrives that no existing category covers without distortion; then
  id (lowercase snake_case), name (Title Case), one-sentence description, and
  re-check that no capability was reassigned away from its primary function.
- **Versioning:** `version` bumps on SCHEMA change (new key, changed meaning)
  — 1.0 today. Content refreshes from the regenerator (answers 5 & 7) do not
  bump the version; they rewrite derived entries in place.
- **CI check (recommended):** re-run the generator against the live registry
  (`ALL_TOOLS` + configured MCP + skills dirs) and fail if it would drop any
  of the 25 builtin tools or 3 builtin skills — catching removed/renamed
  tools before release.
- **Self-verification** (ran against the shipped file):
  `python3 -m json.tool` passes; 41 capabilities (30–50 ✓); 10 categories
  (≤10 ✓); all `(type,n,s)` triples globally unique.
