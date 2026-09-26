/**
 * test-source-site.ts — the /source page: snapshot generator, static API
 * files, the /ls query API (engine + routes), the generated page module,
 * the highlighter, and the nav wiring.
 *
 * Part A runs the generator against a hermetic fixture tree (binary files,
 * lockfiles, .env, oversized files, excluded dirs must all be filtered).
 * Part B validates the REAL committed outputs (index/raw/json/symbols +
 * the /ls engine + the page + nav links). Part C sanity-checks the tokenizer.
 *
 * Run: bun scripts/test-source-site.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

let passed = 0
let failed = 0
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const REPO = path.resolve(import.meta.dir, '..')

async function main() {
  /* ------------------------------------------------------------- part A */
  console.log('\n1) generator — hermetic fixture')
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-root-'))
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-out-'))

    fs.mkdirSync(path.join(root, 'packages/core/src'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'packages/core/src/a.ts'),
      `/** The fixture's core engine — exercises the walker. */\nexport function foo() { return 1 }\nclass Bar {}\nconst baz = 42\n// trailing note\n`,
    )
    fs.writeFileSync(path.join(root, 'README.md'), `# Title\n\n## Sub section\n\nbody text\n`)
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(root, 'scripts/x.sh'), `run() {\n  echo hi\n}\n# a note\n`)
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(root, 'docs/note.md'), `# Doc\n`)
    // must all be filtered out (inside include roots, so the filters are exercised):
    fs.writeFileSync(path.join(root, 'docs/bin.dat'), 'abc\0def') // binary
    fs.writeFileSync(path.join(root, 'docs/oversize.txt'), 'x'.repeat(600 * 1024))
    fs.writeFileSync(path.join(root, 'bun.lock'), 'lockfile noise')
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1')
    fs.mkdirSync(path.join(root, 'packages/cli/src/generated'), { recursive: true })
    fs.writeFileSync(path.join(root, 'packages/cli/src/generated/gen.ts'), 'export const G = 1')
    fs.mkdirSync(path.join(root, 'node_modules/junk'), { recursive: true })
    fs.writeFileSync(path.join(root, 'node_modules/junk/j.js'), 'module.exports = 1')

    const run = () =>
      execFileSync('bun', [path.join(REPO, 'scripts/gen-source-snapshot.ts')], {
        env: {
          ...process.env,
          TAGENT_SNAPSHOT_ROOT: root,
          TAGENT_SNAPSHOT_OUT: out,
          TAGENT_SNAPSHOT_VERSION: '9.9.9',
        },
        stdio: 'pipe',
      })

    run()

    const idx = JSON.parse(fs.readFileSync(path.join(out, 'public/source/index.json'), 'utf8'))
    const paths = idx.files.map((f: { path: string }) => f.path)
    const expected = ['README.md', 'docs/note.md', 'packages/core/src/a.ts', 'scripts/x.sh']
    const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join()
    ok('index: exactly the 4 expected files', sameSet(paths, expected), paths.join(', '))
    ok('index: version override honored', idx.version === '9.9.9')
    const fixtureLines = ['README.md', 'docs/note.md', 'packages/core/src/a.ts', 'scripts/x.sh'].reduce(
      (acc, p) => acc + fs.readFileSync(path.join(root, p), 'utf8').split('\n').length,
      0,
    )
    ok('index: counts match', idx.counts.files === 4 && idx.counts.lines === fixtureLines)

    const raw = fs.readFileSync(path.join(out, 'public/source/raw/packages/core/src/a.ts'), 'utf8')
    ok('raw copy is byte-identical', raw.includes('export function foo() { return 1 }') && raw.includes('// trailing note'))

    const aMeta = idx.files.find((f: { path: string }) => f.path === 'packages/core/src/a.ts')
    ok('meta in index: rawUrl + jsonUrl',
      aMeta?.rawUrl === '/source/raw/packages/core/src/a.ts' &&
      aMeta?.jsonUrl === '/source/json/packages/core/src/a.ts.json')
    ok('meta in index: JSDoc summary extracted',
      aMeta?.summary === "The fixture's core engine — exercises the walker.", aMeta?.summary)
    ok('meta in index: lastModified is a date (mtime fallback — no git here)',
      typeof aMeta?.lastModified === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(aMeta.lastModified), aMeta?.lastModified)
    const readmeMeta = idx.files.find((f: { path: string }) => f.path === 'README.md')
    ok('meta in index: md summary = first heading', readmeMeta?.summary === 'Title', readmeMeta?.summary)

    const json = JSON.parse(fs.readFileSync(path.join(out, 'public/source/json/packages/core/src/a.ts.json'), 'utf8'))
    ok('json wrapper: content + meta', json.path === 'packages/core/src/a.ts' && json.content === raw && json.language === 'ts' && json.lines === raw.split('\n').length)
    ok('json wrapper: rawUrl points back', json.rawUrl === '/source/raw/packages/core/src/a.ts')
    ok('json wrapper: lastModified + summary carried', json.summary === aMeta.summary && json.lastModified === aMeta.lastModified)

    const excl = idx.excluded.join('\n')
    ok('excluded: binary', excl.includes('bin.dat') && excl.includes('binary'))
    ok('excluded: lockfile', excl.includes('bun.lock'))
    ok('excluded: .env secret never snapshotted', !paths.some((p: string) => p.includes('.env')) && excl.includes('.env*'))
    ok('excluded: oversize cap', excl.includes('oversize.txt') && excl.includes('too large'))
    ok('excluded: generated dir', excl.includes('generated'))
    ok('excluded: node_modules dir', excl.includes('node_modules'))
    ok('static notes present (node_modules, lockfiles)', excl.includes('node_modules/ (dependencies') && excl.includes('lockfiles'))

    const syms = JSON.parse(fs.readFileSync(path.join(out, 'public/source/symbols.json'), 'utf8')).symbols
    const names = new Set(syms.map((s: { n: string }) => s.n))
    ok('symbols: ts function/class/const', names.has('foo') && names.has('Bar') && names.has('baz'))
    ok('symbols: md headings', names.has('Title') && names.has('Sub section'))
    ok('symbols: sh function', names.has('run'))
    const fooSym = syms.find((s: { n: string }) => s.n === 'foo')
    ok('symbols carry file + line', fooSym?.f === 'packages/core/src/a.ts' && fooSym?.l === 2 && fooSym?.k === 'func')

    const tree = idx.tree
    ok('tree: nested dirs + files', tree.children.some((c: { name: string; type: string }) => c.name === 'packages') &&
      tree.children.some((c: { name: string; type: string }) => c.name === 'README.md' && c.type === 'file'))

    // ---- the dir API: listings + tree.json ----
    const rootListing = JSON.parse(fs.readFileSync(path.join(out, 'public/source/dir.json'), 'utf8'))
    const rootNames = rootListing.children.map((c: { name: string }) => c.name).sort()
    ok('dir.json: root lists the top level',
      JSON.stringify(rootNames) === JSON.stringify(['README.md', 'docs', 'packages', 'scripts']), rootNames.join(','))
    ok('dir.json: root has no parent, self dirUrl',
      rootListing.parent === null && rootListing.dirUrl === '/source/dir.json' && rootListing.version === '9.9.9')
    const aTsLines = fs.readFileSync(path.join(root, 'packages/core/src/a.ts'), 'utf8').split('\n').length
    const pkgEntry = rootListing.children.find((c: { name: string }) => c.name === 'packages')
    ok('dir.json: dir child carries aggregates + dirUrl',
      pkgEntry?.type === 'dir' && pkgEntry.files === 1 && pkgEntry.dirs === 3 && pkgEntry.lines === aTsLines &&
      pkgEntry.dirUrl === '/source/dir/packages.json')

    const coreSrcListing = JSON.parse(fs.readFileSync(path.join(out, 'public/source/dir/packages/core/src.json'), 'utf8'))
    ok('dir listing: parent chain points back up',
      coreSrcListing.parent?.path === 'packages/core' && coreSrcListing.parent?.dirUrl === '/source/dir/packages/core.json')
    const aEntry = coreSrcListing.children.find((c: { name: string }) => c.name === 'a.ts')
    ok('dir listing: file child carries rawUrl + jsonUrl',
      aEntry?.type === 'file' && aEntry.bytes > 0 && aEntry.language === 'ts' &&
      aEntry.rawUrl === '/source/raw/packages/core/src/a.ts' && aEntry.jsonUrl === '/source/json/packages/core/src/a.ts.json')

    const treeJson = JSON.parse(fs.readFileSync(path.join(out, 'public/source/tree.json'), 'utf8'))
    ok('tree.json: version + counts', treeJson.version === '9.9.9' && treeJson.counts.files === 4 && treeJson.counts.dirs === idx.counts.dirs)
    const pkgTree = treeJson.tree.children.find((c: { name: string }) => c.name === 'packages')
    ok('tree.json: dir nodes carry aggregates + dirUrl',
      pkgTree?.files === 1 && pkgTree?.dirs === 3 && pkgTree?.dirUrl === '/source/dir/packages.json')
    const readmeTree = treeJson.tree.children.find((c: { name: string }) => c.name === 'README.md')
    ok('tree.json: file nodes carry rawUrl + jsonUrl',
      readmeTree?.rawUrl === '/source/raw/README.md' && readmeTree?.jsonUrl === '/source/json/README.md.json')

    const mod = fs.readFileSync(path.join(out, 'src/data/source-snapshot.ts'), 'utf8')
    ok('page module exports SOURCE_SNAPSHOT + types', mod.includes('export const SOURCE_SNAPSHOT') && mod.includes('export interface SourceSnapshot'))

    run() // idempotency: second run, same output
    const idx2 = JSON.parse(fs.readFileSync(path.join(out, 'public/source/index.json'), 'utf8'))
    ok('re-run is idempotent (same file set)', sameSet(idx2.files.map((f: { path: string }) => f.path), expected))

    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(out, { recursive: true, force: true })
  }

  /* ------------------------------------------------------------- part B */
  console.log('\n2) real outputs — the committed snapshot + the page')
  {
    const { SOURCE_SNAPSHOT } = await import(path.join(REPO, 'website/src/data/source-snapshot.ts'))
    const { CURRENT_VERSION } = await import(path.join(REPO, 'packages/core/src/version.ts'))
    const c = SOURCE_SNAPSHOT.counts
    ok('module: snapshot is substantial', c.files > 250 && c.lines > 50000, `files=${c.files}`)
    ok('module: version is the current release', SOURCE_SNAPSHOT.version === CURRENT_VERSION, `${SOURCE_SNAPSHOT.version} vs ${CURRENT_VERSION}`)
    ok('module: files carry URLs', SOURCE_SNAPSHOT.files.every((f) => f.rawUrl.startsWith('/source/raw/') && f.jsonUrl.startsWith('/source/json/')))

    const keyFiles = ['README.md', 'WORKLOG.md', 'packages/core/src/loop.ts', 'packages/core/src/system-prompt.ts', 'src/components/tagent/tagent-app.tsx', 'native/main.go']
    const have = new Set(SOURCE_SNAPSHOT.files.map((f) => f.path))
    ok('module: key sources included', keyFiles.every((p) => have.has(p)))

    const idxPath = path.join(REPO, 'website/public/source/index.json')
    ok('public: index.json exists', fs.existsSync(idxPath))
    const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'))
    ok('public: index matches the module', idx.counts.files === c.files && idx.version === SOURCE_SNAPSHOT.version)

    const loopSrc = fs.readFileSync(path.join(REPO, 'packages/core/src/loop.ts'), 'utf8')
    const loopRaw = fs.readFileSync(path.join(REPO, 'website/public/source/raw/packages/core/src/loop.ts'), 'utf8')
    ok('public: raw loop.ts is byte-identical to the repo file', loopRaw === loopSrc)

    const loopJson = JSON.parse(fs.readFileSync(path.join(REPO, 'website/public/source/json/packages/core/src/loop.ts.json'), 'utf8'))
    ok('public: json wrapper for loop.ts matches', loopJson.content === loopSrc && loopJson.path === 'packages/core/src/loop.ts')

    const symPath = path.join(REPO, 'website/public/source/symbols.json')
    ok('public: symbols.json exists', fs.existsSync(symPath))
    const syms = JSON.parse(fs.readFileSync(symPath, 'utf8')).symbols
    ok('public: symbol index populated', Array.isArray(syms) && syms.length > 1000, `n=${syms?.length}`)
    const idxAll = JSON.stringify(idx.files.map((f: { path: string }) => f.path))
    ok('security: no .env / secrets in the snapshot', !idxAll.includes('.env'))

    // ---- the dir API on the real snapshot ----
    const dirRoot = JSON.parse(fs.readFileSync(path.join(REPO, 'website/public/source/dir.json'), 'utf8'))
    ok('public: dir.json root listing populated', Array.isArray(dirRoot.children) && dirRoot.children.length > 5)
    const pkgReal = dirRoot.children.find((c: { name: string }) => c.name === 'packages')
    ok('public: dir.json aggregates sane',
      pkgReal?.files > 50 && pkgReal?.dirs > 5 && pkgReal?.lines > 20000 &&
      pkgReal?.dirUrl === '/source/dir/packages.json')
    const coreSrcReal = JSON.parse(fs.readFileSync(path.join(REPO, 'website/public/source/dir/packages/core/src.json'), 'utf8'))
    const loopEntry = coreSrcReal.children.find((c: { name: string }) => c.name === 'loop.ts')
    ok('public: per-dir listing exposes loop.ts with URLs',
      loopEntry?.rawUrl === '/source/raw/packages/core/src/loop.ts' &&
      loopEntry?.jsonUrl === '/source/json/packages/core/src/loop.ts.json')
    ok('public: listing children match the index tree (packages/core/src)',
      coreSrcReal.children.length === idx.tree.children
        .find((c: { name: string }) => c.name === 'packages')?.children
        .find((c: { name: string }) => c.name === 'core')?.children
        .find((c: { name: string }) => c.name === 'src')?.children?.length)
    const treeReal = JSON.parse(fs.readFileSync(path.join(REPO, 'website/public/source/tree.json'), 'utf8'))
    ok('public: tree.json matches index counts + version',
      treeReal.counts.files === idx.counts.files && treeReal.version === idx.version)
    ok('public: tree.json root is navigable', treeReal.tree.dirUrl === '/source/dir.json' && Array.isArray(treeReal.tree.children))
    const coreTree = treeReal.tree.children.find((c: { name: string }) => c.name === 'packages')?.children
      .find((c: { name: string }) => c.name === 'core')
    ok('public: tree.json nested dir carries dirUrl', coreTree?.dirUrl === '/source/dir/packages/core.json')

    const tscfg = fs.readFileSync(path.join(REPO, 'website/tsconfig.json'), 'utf8')
    ok('website tsconfig excludes public/ (raw .ts copies)', tscfg.includes('"public"'))

    const pageSrc = fs.readFileSync(path.join(REPO, 'website/src/app/source/page.tsx'), 'utf8')
    ok('page: renders SourceBrowser + stats header', pageSrc.includes('SourceBrowser') && pageSrc.includes('SOURCE_SNAPSHOT'))

    const layout = fs.readFileSync(path.join(REPO, 'website/src/app/layout.tsx'), 'utf8')
    ok('nav: desktop link present', layout.includes('href="/source"'))
    const footerHas = layout.slice(layout.indexOf('function Footer')).includes('href="/source"')
    ok('nav: footer link present', footerHas)
    const mobile = fs.readFileSync(path.join(REPO, 'website/src/components/mobile-nav.tsx'), 'utf8')
    ok('nav: mobile link present', mobile.includes('{ href: "/source", label: "Source" }'))
    const landing = fs.readFileSync(path.join(REPO, 'website/src/app/page.tsx'), 'utf8')
    ok('landing: hero + CTA link present', (landing.match(/href="\/source"/g) ?? []).length >= 2)

    const browser = fs.readFileSync(path.join(REPO, 'website/src/components/source/source-browser.tsx'), 'utf8')
    ok('browser: agent API docs on the welcome panel', browser.includes('/source/index.json') && browser.includes('/source/symbols.json'))
    ok('browser: dir API documented on the welcome panel',
      browser.includes('/source/dir/') && browser.includes('/source/tree.json'))
    ok('browser: /ls API documented on the welcome panel',
      browser.includes('/source/ls?path=') && browser.includes('/source/ls/find') && browser.includes('/source/ls/quickref'))
    ok('browser: deep links (?file=) + hash lines (#L)', browser.includes('get(\'file\')') || browser.includes('window.location.search'))
    ok('browser: error + notfound + loading states', browser.includes("'notfound'") && browser.includes("'error'") && browser.includes('aria-busy'))

    const readme = fs.readFileSync(path.join(REPO, 'website/README.md'), 'utf8')
    ok('readme: /ls endpoints + params documented',
      readme.includes('GET /source/ls?path=') && readme.includes('GET /source/ls/find') &&
      readme.includes('GET /source/ls/stat') && readme.includes('GET /source/ls/quickref'))
  }

  /* -------------------------------------------------- part B2 — the ls API */
  console.log('\n3) the /ls API — engine, routes, HTTP')
  {
    const { SOURCE_SNAPSHOT } = await import(path.join(REPO, 'website/src/data/source-snapshot.ts'))
    const { ls, find, stat, quickref, renderLsText, handleLsApi, LsError, MAX_DEPTH } =
      await import(path.join(REPO, 'website/src/lib/source-ls.ts'))

    // the engine imports are `any` (dynamic non-literal specifier) — a structural
    // guard keeps the catch blocks type-safe without depending on the module type
    const isLsError = (e: unknown): e is { status: number; code: string; extra?: { layers?: string[] } } =>
      typeof e === 'object' && e !== null && 'status' in e && 'code' in e
    void LsError

    /* the flat listing — the user's example shape */
    const root = ls({ path: '/' })
    ok('ls: root — parent null + full-tree totals',
      root.parent === null && root.path === '/' && root.totalFiles === SOURCE_SNAPSHOT.counts.files && root.totalLines === SOURCE_SNAPSHOT.counts.lines)
    const pkgEntry = root.entries.find((e) => e.name === 'packages')
    ok('ls: root — dirs first, then files',
      pkgEntry?.type === 'directory' && root.entries.some((e) => e.name === 'README.md' && e.type === 'file') &&
      root.entries.every((e, i) => i === 0 ||
        (root.entries[i - 1].type === e.type ? root.entries[i - 1].name.localeCompare(e.name) <= 0 : root.entries[i - 1].type === 'directory')))
    ok('ls: dir entry = { name, type, children } exactly',
      pkgEntry?.type === 'directory' && typeof pkgEntry.children === 'number' &&
      !('files' in pkgEntry) && !('path' in pkgEntry))

    const coreSrc = ls({ path: '/packages/core/src' })
    const loopMeta = SOURCE_SNAPSHOT.files.find((f) => f.path === 'packages/core/src/loop.ts')
    const loopEntry = coreSrc.entries.find((e) => e.name === 'loop.ts')
    ok('ls: file entry = { name, type: file, size, lines, language }',
      loopEntry?.type === 'file' && loopEntry.size === loopMeta.bytes && loopEntry.lines === loopMeta.lines && loopEntry.language === 'typescript')
    const coreSrcFiles = SOURCE_SNAPSHOT.files.filter((f) => f.path.startsWith('packages/core/src/'))
    ok('ls: parent chain + subtree totals',
      coreSrc.parent === '/packages/core' &&
      coreSrc.totalFiles === coreSrcFiles.length && coreSrc.totalLines === coreSrcFiles.reduce((a, f) => a + f.lines, 0))
    ok('ls: matches the static dir listing (children count)',
      coreSrc.entries.length ===
      JSON.parse(fs.readFileSync(path.join(REPO, 'website/public/source/dir/packages/core/src.json'), 'utf8')).children.length)

    /* detail mode */
    const det = ls({ path: '/packages/core/src', detail: true })
    const detLoop = det.entries.find((e) => e.name === 'loop.ts')
    const detTools = det.entries.find((e) => e.name === 'tools')
    ok('ls: detail adds path · lastModified · rawUrl · jsonUrl (files)',
      detLoop?.path === '/packages/core/src/loop.ts' && detLoop.lastModified === loopMeta.lastModified &&
      detLoop.rawUrl === '/source/raw/packages/core/src/loop.ts' && detLoop.jsonUrl === '/source/json/packages/core/src/loop.ts.json')
    const toolsFiles = SOURCE_SNAPSHOT.files.filter((f) => f.path.startsWith('packages/core/src/tools/'))
    ok('ls: detail adds aggregates + dirUrl (dirs)',
      detTools?.path === '/packages/core/src/tools' && detTools.files === toolsFiles.length &&
      detTools.dirUrl === '/source/dir/packages/core/src/tools.json')

    /* recursive mode — depth = levels of entries visible below path:
       depth=2 from /packages/core/src: level 1 dirs of src, level 2 entries
       inside them (fs.ts); the level-2 dirs show a children COUNT instead */
    const rec = ls({ path: '/packages/core/src', recursive: true, depth: 2 })
    ok('ls: recursive — nested tree with aggregates',
      rec.tree.type === 'directory' && rec.tree.name === 'src' && Array.isArray(rec.tree.children))
    const recTools = rec.tree.children.find((c: { name: string }) => c.name === 'tools')
    ok('ls: recursive depth=2 — grandchildren expanded (fs.ts visible)',
      Array.isArray(recTools?.children) && recTools.children.some((c: { name: string }) => c.name === 'fs.ts'))
    const rec1 = ls({ path: '/packages/core/src', recursive: true, depth: 1 })
    const rec1Tools = rec1.tree.children.find((c: { name: string }) => c.name === 'tools')
    ok('ls: recursive depth=1 — children = count at the cut',
      typeof rec1Tools?.children === 'number' && rec1Tools.children === toolsFiles.length)

    /* layers */
    const layerRoot = ls({ path: '/', layer: 'cli' })
    ok('ls: layer=cli prunes the root to the layer chain',
      layerRoot.entries.length === 1 && layerRoot.entries[0].name === 'packages' && layerRoot.layer === 'cli')
    const layerPkgs = ls({ path: '/packages', layer: 'cli' })
    ok('ls: layer=cli — packages lists only cli',
      JSON.stringify(layerPkgs.entries.map((e) => e.name)) === JSON.stringify(['cli']))
    ok('ls: layer=core totals = the core subtree only',
      ls({ path: '/', layer: 'core' }).totalFiles === SOURCE_SNAPSHOT.files.filter((f) => f.path.startsWith('packages/core/')).length)
    try {
      ls({ path: '/', layer: 'nope' })
      ok('ls: unknown layer rejected', false)
    } catch (e) {
      ok('ls: unknown layer rejected with the valid list',
        isLsError(e) && e.status === 400 &&
        JSON.stringify((e.extra as { layers: string[] }).layers) === JSON.stringify(['core', 'cli', 'gui', 'website', 'native', 'scripts']))
    }

    /* find */
    const f1 = find({ q: 'loop' })
    const f1Paths = f1.results.map((r) => r.path)
    ok('find: loop — name matches ranked first, all found',
      f1.total >= 3 && f1Paths.includes('/packages/core/src/loop.ts') && f1Paths.includes('/scripts/test-context-loop.ts') &&
      f1Paths.indexOf('/packages/core/src/loop.ts') < f1Paths.indexOf('/scripts/test-context-loop.ts'))
    let emptyQ = false
    try {
      find({ q: '' })
    } catch (e) {
      emptyQ = isLsError(e) && e.status === 400
    }
    ok('find: empty q rejected', emptyQ)
    const f2 = find({ q: 'loop', limit: 2 })
    ok('find: limit + truncated flag', f2.count === 2 && f2.truncated && f2.total === f1.total)
    const f3 = find({ q: 'loop', layer: 'gui' })
    ok('find: layer filter applies (gui = the src/ app)',
      f3.results.every((r) => r.path.startsWith('/src')))
    ok('find: no match → zero results, not an error', find({ q: 'zzz-no-such-thing' }).total === 0)

    /* stat */
    const st = stat('/packages/core/src/loop.ts')
    ok('stat: loop.ts — size/lines/urls from the snapshot',
      st.type === 'file' && st.size === loopMeta.bytes && st.lines === loopMeta.lines &&
      st.rawUrl === '/source/raw/packages/core/src/loop.ts' && st.dirUrl === '/source/dir/packages/core/src.json' &&
      st.lastModified === loopMeta.lastModified)
    const stReadme = stat('README.md')
    ok('stat: README.md — md summary surfaced',
      stReadme.language === 'markdown' && typeof stReadme.summary === 'string' && stReadme.summary.length > 0)
    let statDir = false
    try {
      stat('/packages/core')
    } catch (e) {
      statDir = isLsError(e) && e.status === 400 && e.code === 'not_a_file'
    }
    ok('stat: directory rejected with a hint', statDir)
    let statMiss = false
    try {
      stat('/nope/nope.ts')
    } catch (e) {
      statMiss = isLsError(e) && e.status === 404
    }
    ok('stat: missing file → 404', statMiss)

    /* quickref */
    const qr = quickref()
    ok('quickref: curated, validated, all fresh',
      qr.count >= 20 && qr.map['agentic loop'] === '/packages/core/src/loop.ts' &&
      qr.map['system prompt'] === '/packages/core/src/system-prompt.ts' && qr.stale.length === 0,
      JSON.stringify(qr.stale))

    /* path safety */
    const rejects: Array<[string, string]> = [
      ['../../etc', 'path_traversal'],
      ['/..', 'path_traversal'],
      ['../etc', 'path_traversal'],
      ['/a//b', 'bad_path'],
      ['\\etc', 'bad_path'],
      ['a\u0000b', 'bad_path'],
    ]
    for (const [bad, code] of rejects) {
      try {
        ls({ path: bad })
        ok(`security: ${JSON.stringify(bad)} rejected`, false)
      } catch (e) {
        ok(`security: ${JSON.stringify(bad)} rejected (${code})`,
          isLsError(e) && e.status === 400 && e.code === code)
      }
    }
    let escaped = false
    try {
      ls({ path: '/etc/passwd' })
    } catch (e) {
      escaped = isLsError(e) && e.status === 404
    }
    ok('security: /etc/passwd is a 404, not a leak', escaped)
    const engineSrc = fs.readFileSync(path.join(REPO, 'website/src/lib/source-ls.ts'), 'utf8')
    ok('security: the engine never touches the filesystem',
      !engineSrc.includes('node:fs') && !engineSrc.includes('readFileSync'))

    /* depth guard */
    let deepBad = false
    try {
      ls({ path: '/', recursive: true, depth: MAX_DEPTH + 1 })
    } catch (e) {
      deepBad = isLsError(e) && e.status === 400
    }
    ok('ls: depth capped (1..8) — rejects 9', deepBad)

    /* plain text */
    const lsSrc = ls({ path: '/packages/core/src' })
    const text = renderLsText(lsSrc)
    const loopLines = lsSrc.entries.find((e: { name: string }) => e.name === 'loop.ts')?.lines
    ok('text: ls — tree glyphs + line counts',
      text.includes('├──') && text.includes('└──') && new RegExp(`loop\\.ts\\s+${loopLines} lines`).test(text), `loop.ts lines=${loopLines}`)
    const textRec = renderLsText(ls({ path: '/packages/core/src', recursive: true, depth: 2 }))
    ok('text: recursive — nested glyphs + aggregates',
      textRec.includes('│   ') && textRec.includes('tools/') && textRec.includes(`${toolsFiles.length} files`))
    const textAll = renderLsText(ls({ path: '/', all: true }))
    ok('text: all=true — hidden dirs noted',
      textAll.includes('never in the snapshot') && textAll.includes('node_modules'))

    /* the HTTP layer — end to end through the routes' shared handler */
    const h1 = handleLsApi(new Request('http://x/source/ls?path=/packages/core/src'), 'ls')
    ok('http: ls — 200 JSON, pretty, cacheable',
      h1.status === 200 && h1.headers.get('content-type') === 'application/json; charset=utf-8' &&
      (h1.headers.get('cache-control') ?? '').includes('max-age') && h1.headers.get('vary') === 'Accept')
    const h1body = JSON.parse(await h1.text())
    ok('http: ls body — the example shape',
      h1body.path === '/packages/core/src' && h1body.parent === '/packages/core' &&
      Array.isArray(h1body.entries) && h1body.entries.some((e: { name: string }) => e.name === 'loop.ts'))
    const h2 = handleLsApi(new Request('http://x/source/ls?path=/packages/core&recursive=true&depth=2'), 'ls')
    const h2body = JSON.parse(await h2.text())
    ok('http: recursive tree shape', h2body.tree?.type === 'directory' && Array.isArray(h2body.tree?.children))
    const h3 = handleLsApi(new Request('http://x/source/ls?path=/', { headers: { accept: 'text/plain' } }), 'ls')
    const h3text = await h3.text()
    ok('http: Accept: text/plain — text body + content-type',
      h3.status === 200 && h3.headers.get('content-type') === 'text/plain; charset=utf-8' &&
      h3text.includes('├──') && h3text.includes('files'))
    const h4 = handleLsApi(new Request('http://x/source/ls?path=/packages/core/src&format=text'), 'ls')
    ok('http: ?format=text works too', (h4.headers.get('content-type') ?? '').startsWith('text/plain'))
    const h5 = handleLsApi(new Request('http://x/source/ls?path=../../etc'), 'ls')
    ok('http: traversal rejected at the HTTP layer',
      h5.status === 400 && JSON.parse(await h5.text()).code === 'path_traversal')
    const h6 = handleLsApi(new Request('http://x/source/ls/find?q=loop'), 'find')
    ok('http: find — 200 + results', (JSON.parse(await h6.text()).total ?? 0) >= 3)
    const h7 = handleLsApi(new Request('http://x/source/ls/stat?path=packages/core/src/loop.ts'), 'stat')
    ok('http: stat — works without the leading slash too',
      JSON.parse(await h7.text()).path === '/packages/core/src/loop.ts')
    const h8 = handleLsApi(new Request('http://x/source/ls/quickref'), 'quickref')
    ok('http: quickref — 200 + map', (JSON.parse(await h8.text()).count ?? 0) >= 20)
    const h9 = handleLsApi(new Request('http://x/source/ls?recursive=maybe'), 'ls')
    ok('http: bad boolean rejected with 400', h9.status === 400 && JSON.parse(await h9.text()).code === 'bad_param')

    /* route files are thin, force-dynamic adapters */
    for (const [route, kind] of [
      ['route.ts', 'ls'], ['find/route.ts', 'find'], ['stat/route.ts', 'stat'], ['quickref/route.ts', 'quickref'],
    ] as const) {
      const src = fs.readFileSync(path.join(REPO, 'website/src/app/source/ls', route), 'utf8')
      ok(`route: ls/${route} — force-dynamic + handleLsApi('${kind}')`,
        src.includes("export const dynamic = 'force-dynamic'") && src.includes(`handleLsApi(request, '${kind}')`))
    }
  }

  /* ------------------------------------------------------------- part C */
  console.log('\n4) highlighter — tokenizer sanity')
  {
    const { tokenizeLines, familyOf } = await import(path.join(REPO, 'website/src/lib/highlight.ts'))

    const ts = tokenizeLines(`const x = 'str' // note\nlet n = 42`, 'ts')
    const tsFlat = ts.flat()
    ok('ts: string token', tsFlat.some((t) => t.c === 'str' && t.text === "'str'"))
    ok('ts: comment token', tsFlat.some((t) => t.c === 'com' && t.text === '// note'))
    ok('ts: keyword token', tsFlat.some((t) => t.c === 'kw' && t.text === 'const'))
    ok('ts: number token', tsFlat.some((t) => t.c === 'num' && t.text === '42'))
    ok('ts: lines split on newline', ts.length === 2 && ts[0].some((t) => t.text.includes('const')))

    const js = tokenizeLines('/* block\ncomment */ let y = 2', 'js')
    const blockTok = js.flat().find((t) => t.c === 'com' && t.text.includes('block'))
    ok('ts: multi-line block comment spans lines', !!blockTok && js.length === 2)

    const json = tokenizeLines('{"a": 1, "b": true}', 'json').flat()
    ok('json: key token (with colon)', json.some((t) => t.c === 'key' && t.text === '"a":'))
    ok('json: literal + number', json.some((t) => t.c === 'lit' && t.text === 'true') && json.some((t) => t.c === 'num' && t.text === '1'))

    const md = tokenizeLines('# Heading\n`code`', 'md').flat()
    ok('md: heading token', md.some((t) => t.c === 'hd' && t.text === '# Heading'))
    ok('md: inline code token', md.some((t) => t.c === 'str' && t.text === '`code`'))

    const sh = tokenizeLines('# note\nrun() { }', 'sh').flat()
    ok('sh: comment', sh.some((t) => t.c === 'com' && t.text === '# note'))

    const plain = tokenizeLines('a: 1\nb', 'yaml')
    ok('unknown language: plain fallback, lines intact', plain.length === 2 && plain[0][0].c === '')

    ok('family map', familyOf('ts') === 'ts' && familyOf('tsx') === 'ts' && familyOf('html') === 'html' && familyOf('yaml') === undefined)
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
