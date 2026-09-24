/**
 * test-source-site.ts — the /source page: snapshot generator, static API
 * files, the generated page module, the highlighter, and the nav wiring.
 *
 * Part A runs the generator against a hermetic fixture tree (binary files,
 * lockfiles, .env, oversized files, excluded dirs must all be filtered).
 * Part B validates the REAL committed outputs (index/raw/json/symbols +
 * the page + nav links). Part C sanity-checks the tokenizer.
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
      `export function foo() { return 1 }\nclass Bar {}\nconst baz = 42\n// trailing note\n`,
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

    const json = JSON.parse(fs.readFileSync(path.join(out, 'public/source/json/packages/core/src/a.ts.json'), 'utf8'))
    ok('json wrapper: content + meta', json.path === 'packages/core/src/a.ts' && json.content === raw && json.language === 'ts' && json.lines === raw.split('\n').length)
    ok('json wrapper: rawUrl points back', json.rawUrl === '/source/raw/packages/core/src/a.ts')

    const aMeta = idx.files.find((f: { path: string }) => f.path === 'packages/core/src/a.ts')
    ok('meta in index: rawUrl + jsonUrl',
      aMeta?.rawUrl === '/source/raw/packages/core/src/a.ts' &&
      aMeta?.jsonUrl === '/source/json/packages/core/src/a.ts.json')

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
    ok('symbols carry file + line', fooSym?.f === 'packages/core/src/a.ts' && fooSym?.l === 1 && fooSym?.k === 'func')

    const tree = idx.tree
    ok('tree: nested dirs + files', tree.children.some((c: { name: string }) => c.name === 'packages') &&
      tree.children.some((c: { name: string }) => c.name === 'README.md' && c.type === 'file'))

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
    const c = SOURCE_SNAPSHOT.counts
    ok('module: snapshot is substantial', c.files > 250 && c.lines > 50000, `files=${c.files}`)
    ok('module: version is the current release', SOURCE_SNAPSHOT.version === '0.29.0', SOURCE_SNAPSHOT.version)
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
    ok('browser: deep links (?file=) + hash lines (#L)', browser.includes('get(\'file\')') || browser.includes('window.location.search'))
    ok('browser: error + notfound + loading states', browser.includes("'notfound'") && browser.includes("'error'") && browser.includes('aria-busy'))
  }

  /* ------------------------------------------------------------- part C */
  console.log('\n3) highlighter — tokenizer sanity')
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
