#!/usr/bin/env bun
/**
 * test-ui-kit.ts — headless unit tests for packages/cli/src/ui.ts (the
 * v0.18.0 beauty kit): true-Unicode width (CJK ext, emoji, ZWJ, combining),
 * ANSI-preserving truncate/fit/pad, wrap-ansi hard wrap, cli-boxes roundBox
 * (every row exact outer width — the "garis rata" guarantee), label column
 * alignment (the banner bug), figures symbols and the color gate.
 */
import {
  vw, plainW, strip, truncateV, fitV, padCol, wrapV,
  roundBox, rule, labelRow, kvRow, toolIcon,
  SYM, setUiColor, uiColorOn,
} from '../packages/cli/src/ui'

let pass = 0, fail = 0
const ok = (cond: boolean, name: string, extra?: string) => {
  if (cond) { pass++ } else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}

/* ---------- vw: the alignment backbone ---------- */
ok(vw('hello') === 5, 'vw ascii')
ok(vw('你好') === 4, 'vw cjk basic')
ok(vw('𠀀') === 2, 'vw cjk ext B (U+20000) — missed by old cpWidth')
ok(vw('괴') === 2, 'vw hangul (U+AC00)')
ok(vw('✅') === 2, 'vw emoji U+2705 — missed by old cpWidth (was 1!)')
ok(vw('⚡') === 2, 'vw emoji U+26A1 — missed by old cpWidth (was 1!)')
ok(vw('⎿') === 1, 'vw U+23BF branch glyph is narrow')
ok(vw('👨‍👩‍👧') === 2, 'vw ZWJ family emoji = 2 (cluster)')
ok(vw('e\u0301') === 1, 'vw combining char = 1')
ok(vw('\x1b[31mred\x1b[0m') === 3, 'vw ANSI-styled = plain width')
ok(vw('\x1b[1m你\x1b[0m好') === 4, 'vw ANSI + CJK mix')
ok(vw('') === 0, 'vw empty')
ok(plainW('你好✅') === 6, 'plainW')
ok(strip('\x1b[31mred\x1b[0m') === 'red', 'strip')

/* ---------- truncateV / fitV ---------- */
const t1 = truncateV('\x1b[1mhello world\x1b[0m', 8)
ok(vw(t1) === 8, 'truncateV exact width', vw(t1).toString())
ok(t1.startsWith('\x1b[1m'), 'truncateV keeps leading SGR')
ok(truncateV('👨‍👩‍👧ab', 3) === '👨‍👩‍👧a', 'truncateV never splits a cluster')
ok(truncateV('abc', 10) === 'abc', 'truncateV no-op when shorter')
ok(vw(fitV('你', 5)) === 5, 'fitV pads to exact width')
ok(vw(fitV('\x1b[31m你\x1b[0m', 6)) === 6, 'fitV pads styled')
ok(fitV('', 3) === '   ', 'fitV empty pads')

/* ---------- padCol ---------- */
ok(padCol('ab', 5) === 'ab   ', 'padCol left')
ok(padCol('ab', 5, 'r') === '   ab', 'padCol right')
ok(padCol('ab', 5, 'c') === ' ab  ', 'padCol center')
ok(padCol('你✅', 8) === '你✅    ', 'padCol emoji+cjk width-aware')
ok(vw(padCol('\x1b[31mx\x1b[0m', 4)) === 4, 'padCol styled exact width')

/* ---------- wrapV ---------- */
const wl = wrapV('a very long word that needs wrapping around here somewhere', 20)
ok(wl.length === 4 && wl.every((l) => vw(l) <= 20), 'wrapV basic', JSON.stringify(wl))
const wh = wrapV('supercalifragilisticexpialidocious_and_more', 10)
ok(wh.every((l) => vw(l) <= 10), 'wrapV hard-splits long words', JSON.stringify(wh))
ok(wrapV('short', 20).length === 1, 'wrapV no-op')

/* ---------- roundBox ---------- */
const box = roundBox({ title: '✻ Tagent', rows: ['📂 workspace  /tmp/x', '🤖 model      glm-4.7'], footer: 'type to talk · / commands', width: 44 })
ok(box.length === 4, 'roundBox row count')
ok(box.every((r) => vw(r) === 44), 'roundBox ALL rows exact outer width', JSON.stringify(box.map((r) => vw(r))))
ok(box[0].startsWith('╭─') && box[0].endsWith('╮'), 'roundBox top has title')
ok(box[3].startsWith('╰─') && box[3].endsWith('╯'), 'roundBox bottom has footer')
ok(box[1].startsWith('│') && box[1].endsWith('│'), 'roundBox rails')
const boxD = roundBox({ title: 't', rows: ['a', 'b', 'c'], dividers: [0], width: 20 })
ok(boxD[2] === '├' + '─'.repeat(18) + '┤', 'roundBox divider row', boxD[2])
const boxC = roundBox({ rows: ['中文字'], width: 12 })
ok(boxC.every((r) => vw(r) === 12), 'roundBox cjk content stays rata')

/* ---------- rule / labelRow / kvRow ---------- */
ok(vw(rule(30)) === 30, 'rule width')
const r1 = labelRow('📂', 'workspace', '/a/b', 9)
const r2 = labelRow('🤖', 'model', 'glm-4.7', 9)
const c1 = r1.indexOf('/a/b'), c2 = r2.indexOf('glm-4.7')
ok(c1 === c2, 'labelRow value column ALIGNS across rows (the old bug)', `${c1} vs ${c2}`)
ok(r1.startsWith('📂'), 'labelRow icon prefix')

/* ---------- toolIcon ---------- */
ok(toolIcon('read_file') === '📖', 'toolIcon exact')
ok(toolIcon('bash') === '💻', 'toolIcon bash')
ok(toolIcon('mcp_server1_read_file') === '📖', 'toolIcon strips mcp prefix')
ok(toolIcon('totally_unknown') === '⚙', 'toolIcon fallback')
ok(toolIcon(undefined) === '⚙', 'toolIcon undefined')

/* ---------- symbols + color gate ---------- */
ok(SYM.tick && SYM.cross && SYM.pointer, 'figures symbols exist')
setUiColor(false)
ok(!uiColorOn(), 'setUiColor(false) honored')
setUiColor(true)

console.log(`\nui-kit: ${pass}/${pass + fail} pass${fail ? `, ${fail} FAIL` : ''}`)
process.exit(fail ? 1 : 0)
