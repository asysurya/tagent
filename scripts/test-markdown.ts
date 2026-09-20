/**
 * test-markdown.ts — test suite for packages/cli/src/markdown.ts
 *
 * run: bun scripts/test-markdown.ts   (exit code 0 = all pass, 1 = failures)
 */
import { renderMarkdown, mdStats } from '../packages/cli/src/markdown'

// pin the suite's own color state: the styling assertions below specify the
// ANSI codes the module must emit when color is ON, so an ambient NO_COLOR
// from the developer's shell must not silently disable them. (The dedicated
// NO_COLOR section further down sets the var explicitly for its own checks.)
delete process.env.NO_COLOR

let pass = 0
let fail = 0
const failures: string[] = []

/** strip SGR escape codes (the only escapes this module emits) */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;:]*m/g, '')
}

/** independent CJK-aware visible width of a (possibly styled) line */
function vis(s: string): number {
  const t = stripAnsi(s)
  let w = 0
  for (let i = 0; i < t.length; ) {
    const cp = t.codePointAt(i) ?? 32
    if (cp >= 0x0300 && cp <= 0x036f) {
      i += 1
      continue
    }
    w +=
      cp >= 0x1100 &&
      (cp <= 0x115f ||
        (cp >= 0x2e80 && cp <= 0xa4cf) ||
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe30 && cp <= 0xfe4f) ||
        (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6) ||
        (cp >= 0x1f300 && cp <= 0x1f9ff))
        ? 2
        : 1
    i += cp < 0x10000 ? 1 : 2
  }
  return w
}

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    failures.push(name)
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(name, a === e, `actual=${a} expected=${e}`)
}

function stripped(lines: string[]): string[] {
  return lines.map(stripAnsi)
}

function allFit(lines: string[], width: number): boolean {
  return lines.every((l) => vis(l) <= width)
}

console.log('renderMarkdown — basic blocks')
{
  // empty input
  eq('empty input → []', renderMarkdown(''), [])
  eq('whitespace-only input → []', renderMarkdown('   \n\n  \n'), [])

  // plain text passthrough
  eq('plain text passthrough', renderMarkdown('hello world'), ['hello world'])

  // heading render: colored + bold, blank before/after, #'s stripped
  const h = renderMarkdown('# Title\n\nBody follows here')
  eq('heading: blank before/after', stripped(h), ['Title', '', 'Body follows here'])
  ok('heading h1 styled 1;36 + bold', h[0].startsWith('\x1b[1;36m') && h[0].includes('Title'))
  eq('heading h1 visible width', vis(h[0]), 5)
  ok('heading ansi not counted in width', h[0].length > 5 && vis(h[0]) === 5)

  const h2 = renderMarkdown('## Sub Head')
  ok('heading h2 magenta bold', h2[0].startsWith('\x1b[1;35m') && stripAnsi(h2[0]) === 'Sub Head')
  const h3 = renderMarkdown('### Deep')
  ok('heading h3 yellow bold', h3[0].startsWith('\x1b[1;33m') && stripAnsi(h3[0]) === 'Deep')
  const h4 = renderMarkdown('#### Four')
  eq('heading h4+ → plain bold line', h4, ['\x1b[1mFour\x1b[0m'])

  // multiple blank lines collapse to one separator
  eq('blank runs collapse', stripped(renderMarkdown('a\n\n\n\nb')), ['a', '', 'b'])
}

console.log('renderMarkdown — inline styles')
{
  const l = renderMarkdown('plain **bold** and *ital* and `code` end')
  eq('bold+italic+code single line', l.length, 1)
  eq('bold+italic+code text kept', stripAnsi(l[0]), 'plain bold and ital and code end')
  ok('**bold** → SGR 1', l[0].includes('\x1b[1mbold\x1b[0m'))
  ok('*ital* → SGR 3', l[0].includes('\x1b[3mital\x1b[0m'))
  ok('`code` → SGR 33', l[0].includes('\x1b[33mcode\x1b[0m'))

  const c = renderMarkdown('`a **b** c`')
  eq('inline code keeps content verbatim', stripAnsi(c[0]), 'a **b** c')
  ok('no bold inside inline code', !c[0].includes('\x1b[1m'))

  const u = renderMarkdown('_em_ and __strong__')
  ok('_em_ italic', u[0].includes('\x1b[3mem\x1b[0m'))
  ok('__strong__ bold', u[0].includes('\x1b[1mstrong\x1b[0m'))

  const snake = renderMarkdown('snake_case_word stays plain')
  ok('intraword underscore not italic', !snake[0].includes('\x1b[3m'))

  const esc = renderMarkdown('\\*not italic\\*')
  eq('backslash escape', stripAnsi(esc[0]), '*not italic*')
}

console.log('renderMarkdown — fenced code blocks')
{
  const f = renderMarkdown('para\n\n```ts\nconst x = 1\n```\n\nafter', 30)
  eq(
    'fence: structure (blank + borders + blank)',
    stripped(f),
    [
      'para',
      '',
      '╭─ ts ' + '─'.repeat(23) + '╯',
      '│ const x = 1',
      '╰' + '─'.repeat(28) + '╯',
      '',
      'after',
    ],
  )
  ok('fence: top border dim', f[2].startsWith('\x1b[2m╭─ ts'))
  ok('fence: content soft hue', f[3].includes('\x1b[38;5;152mconst x = 1\x1b[0m'))
  ok('fence: border is dim │ prefix', f[3].startsWith('\x1b[2m│ \x1b[0m'))
  ok('fence: width respected', allFit(f, 30))

  // long lines hard-wrap by character, never exceed width-2 of content
  const long = renderMarkdown('```\n' + 'x'.repeat(100) + '\n```', 30)
  eq('fence long: line count', long.length, 6)
  ok('fence long: all lines fit width', allFit(long, 30))
  eq(
    'fence long: content preserved across wraps',
    stripped(long)
      .slice(1, 5)
      .map((s) => s.slice(2))
      .join(''),
    'x'.repeat(100),
  )
  ok('fence long: no reflow (exact 28-col chunks)', vis(long[1]) === 30 && vis(long[2]) === 30 && vis(long[3]) === 30)

  // unclosed fence (streaming cut-off) still renders
  const unclosed = renderMarkdown('```js\nfoo()')
  // top border totals `width` columns (2 + 4-char label + 73 + 1 = 80),
  // same as the bottom border — 72 was a hand-count slip
  eq('unclosed fence: structure', stripped(unclosed), ['╭─ js ' + '─'.repeat(73) + '╯', '│ foo()', '╰' + '─'.repeat(78) + '╯'])

  // raw ESC in code content is stripped (escape safety)
  const inj = renderMarkdown('```\n\x1b[31mred\x1b[0m\n```', 20)
  eq('fence: raw ESC stripped from content', stripAnsi(inj[1]), '│ red')
  ok('fence: injected SGR 31 not present', !inj[1].includes('\x1b[31m'))
}

console.log('renderMarkdown — lists')
{
  const nest = renderMarkdown('- a\n  - b\n    - c\n- d')
  const sn = stripped(nest)
  eq('nested list: level prefixes', sn, ['• a', '  ◦ b', '    ▪ c', '• d'])
  ok('nested list: marker styled cyan', nest[0].startsWith('\x1b[36m•\x1b[0m a'))

  const ord = renderMarkdown('1. first\n2. second')
  eq('ordered list: markers kept', stripped(ord), ['1. first', '2. second'])
  ok('ordered list: marker styled', ord[0].includes('\x1b[36m1.\x1b[0m'))

  // hanging indent: continuation lines align under the item text
  const hang = renderMarkdown('- ' + 'ab '.repeat(20).trim(), 20)
  ok('list wrap: all lines fit', allFit(hang, 20))
  ok('list wrap: hanging indent under text', stripAnsi(hang[1]).startsWith('  ab'))
  eq('list wrap: continuation aligns at text column', vis(hang[1]) - vis(stripAnsi(hang[1]).replace(/^ +/, '')) + 0, 2)
  ok('list wrap: first line has bullet prefix', stripAnsi(hang[0]).startsWith('• ab'))

  // loose list (blank between items)
  const loose = renderMarkdown('- one\n\n- two')
  eq('loose list: blank between items', stripped(loose), ['• one', '', '• two'])

  // lazy continuation line joins the item
  const lazy = renderMarkdown('- item\n  continued text')
  eq('lazy continuation joins item', stripped(lazy), ['• item continued text'])
}

console.log('renderMarkdown — blockquote / hr / links')
{
  const q = renderMarkdown('> quoted text', 30)
  eq('blockquote: border + text', stripAnsi(q[0]), '│ quoted text')
  ok('blockquote: dim border', q[0].startsWith('\x1b[2m│ '))
  ok('blockquote: content dim italic', q[0].includes('\x1b[2;3mquoted text\x1b[0m'))

  const hr = renderMarkdown('---', 30)
  eq('hr: dim line of ─ at width', stripped(hr), ['─'.repeat(30)])
  eq('hr: default width 80', stripped(renderMarkdown('***')), ['─'.repeat(80)])

  const link = renderMarkdown('see [docs](https://example.com) now')
  eq('link: text (url)', stripAnsi(link[0]), 'see docs (https://example.com) now')
  ok('link: url dim', link[0].includes('\x1b[2m(https://example.com)\x1b[0m'))

  // text+url exceed width → keep url, truncate middle of text
  const lt = renderMarkdown('[' + 'a'.repeat(60) + '](https://example.com/long/path)', 40)
  eq('long link: one line', lt.length, 1)
  ok('long link: fits width', vis(lt[0]) <= 40)
  ok('long link: url kept intact', stripAnsi(lt[0]).includes('(https://example.com/long/path)'))
  ok('long link: text middle-truncated', stripAnsi(lt[0]).includes('…'))

  const bare = renderMarkdown('go https://example.com/a?b=c now')
  eq('bare url: text kept', stripAnsi(bare[0]), 'go https://example.com/a?b=c now')
  ok('bare url: dim underline', bare[0].includes('\x1b[2;4mhttps://example.com/a?b=c\x1b[0m'))
}

console.log('renderMarkdown — CJK width + wrapping')
{
  const src = 'これは日本語のテキストです。とても長いです。'
  const cjk = renderMarkdown(src, 20)
  ok('CJK: all lines fit', allFit(cjk, 20))
  ok('CJK: wrapped (multi-line)', cjk.length >= 2)
  eq('CJK: content preserved', stripped(cjk).join(''), src)
  eq('CJK: counts columns not chars', [vis(cjk[0]), cjk[0].length], [20, 10])
  ok('CJK: narrow lines left short', vis(cjk[cjk.length - 1]) <= 20)

  const mix = renderMarkdown('中文abc中文def', 8)
  ok('CJK+latin mix: fits', allFit(mix, 8))
  eq('CJK+latin mix: content preserved', stripped(mix).join(''), '中文abc中文def')

  // combining marks count 0 columns
  const comb = renderMarkdown('e\u0301'.repeat(30), 20)
  eq('combining: line count', comb.length, 2)
  eq('combining: width 20/10', [vis(comb[0]), vis(comb[1])], [20, 10])

  // emoji are wide
  const emoji = renderMarkdown('🎉'.repeat(30), 20)
  eq('emoji: wide chars → 3 lines', emoji.length, 3)
  ok('emoji: all fit', allFit(emoji, 20))
}

console.log('renderMarkdown — tables')
{
  const t = renderMarkdown('| a | b |\n|---|---|\n| 1 | 22 |', 40)
  eq('table: 3 rows', t.length, 3)
  ok('table: header bold', t[0].includes('\x1b[1ma\x1b[0m') && t[0].includes('\x1b[1mb\x1b[0m'))
  eq('table: separator', stripAnsi(t[1]), ' ───┼──── ')
  eq('table: cells padded', stripAnsi(t[2]), ' 1  │ 22  ')
  ok('table: all fit', allFit(t, 40))
  // the expected separator/row strings above are each 10 visible columns
  // (Σw=3 + 4·ncols−1 overhead = 10); 9 was a hand-count slip
  eq('table: header/sep/row same width', [vis(t[0]), vis(t[1]), vis(t[2])], [10, 10, 10])

  // CJK-aware padding: rows stay aligned
  // (widths [4,2] → Σw=6 + 4·ncols−1 overhead = 13, same geometry as above)
  const t2 = renderMarkdown('| 名前 | 値 |\n|---|---|\n| あ | い |', 40)
  eq('CJK table: aligned widths', [vis(t2[0]), vis(t2[1]), vis(t2[2])], [13, 13, 13])
  ok('CJK table: header bold', t2[0].includes('\x1b[1m'))

  // malformed: no separator under the pipe line → paragraph, not a table
  const mt = renderMarkdown('a | b\nnot a separator', 40)
  eq('malformed table → paragraph', stripped(mt), ['a | b not a separator'])
  ok('malformed table: no table borders', !mt.some((l) => l.includes('┼')))

  // ragged table: renders best-effort without crashing
  const rg = renderMarkdown('| a | b |\n|---|\n| 1 | 2 |', 40)
  ok('ragged table: renders', rg.length >= 3 && rg[1].includes('┼'))
}

console.log('renderMarkdown — escape safety / NO_COLOR')
{
  // every line of a kitchen-sink doc fits its width
  const doc =
    '# Big Head 中文\n\n' +
    'paragraph with **bold** *ital* `code` and [link](https://example.com/very/long/url/path) 中文字符混在 English text 里。 '.repeat(3) +
    '\n\n```python\nprint("hello 世界" * 3)\n```\n\n' +
    '- item one **strong**\n  - nested 日本語アイテム\n- item two\n\n' +
    '> a quote with 中文 and `code`\n\n---\n\n' +
    '| left | 中 | right |\n|---|:-:|--:|\n| a | あ | b |\n'
  const out = renderMarkdown(doc, 40)
  ok('kitchen sink: every line ≤ width', allFit(out, 40))
  ok('kitchen sink: produced output', out.length > 10)
  const out80 = renderMarkdown(doc)
  ok('kitchen sink @80: every line ≤ 80', allFit(out80, 80))

  // NO_COLOR disables every escape
  process.env.NO_COLOR = '1'
  const nc = renderMarkdown('# Head\n\n**bold** `code`')
  delete process.env.NO_COLOR
  ok('NO_COLOR → no escapes at all', nc.every((l) => !l.includes('\x1b')))
  eq('NO_COLOR → plain text', stripped(nc), ['Head', '', 'bold code'])
}

console.log('mdStats')
{
  const s = mdStats('# hi there\n\nsome words here\n\n```ts\ncode\n```\n\ndone')
  eq('mdStats: words', s.words, 7)
  eq('mdStats: lines', s.lines, 9)
  eq('mdStats: codeBlocks', s.codeBlocks, 1)
  const e = mdStats('')
  eq('mdStats: empty', e, { words: 0, lines: 0, codeBlocks: 0 })
  const cjk = mdStats('これは日本語です')
  eq('mdStats: CJK counts as words', cjk.words, 1)
}

console.log('performance — 50k char message')
{
  const chunks: string[] = []
  let total = 0
  let n = 0
  while (total < 52000) {
    const b =
      `# Section ${n} with some heading\n\n` +
      'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore. '.repeat(2) +
      'The quick brown fox 日本語のテキストも含まれます jumps over the lazy dog. '.repeat(2) +
      '\n\n- first item with **bold** text\n- second item\n  - nested item with a [link](https://example.com/path/to/page)\n- third item\n\n' +
      '```ts\nconst data' + n + ' = ' + 'x'.repeat(150) + ';\n```\n\n' +
      '> a quoted note with some longer text that wraps nicely across the terminal width\n\n' +
      '| col a | col b |\n|---|---|\n| 1 | 2 |\n\n'
    chunks.push(b)
    total += b.length
    n++
  }
  const big = chunks.join('')
  const t0 = Date.now()
  const out = renderMarkdown(big, 80)
  const dt = Date.now() - t0
  ok(`perf: ${big.length} chars rendered in ${dt}ms`, dt < 2500)
  ok('perf: all lines ≤ 80 columns', allFit(out, 80))
  ok('perf: substantial output', out.length > 200)
  const t1 = Date.now()
  const st = mdStats(big)
  ok('perf: mdStats cheap', Date.now() - t1 < 500 && st.codeBlocks === n)
}

console.log('')
console.log(`markdown tests: ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log('failed:', failures.join(', '))
  process.exitCode = 1
}
