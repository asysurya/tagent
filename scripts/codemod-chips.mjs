#!/usr/bin/env node
/**
 * codemod-chips.mjs — v0.23.1 one-shot codemod over tui-app.ts:
 * converts the `green(\`  ✔ …\`)` / `red(\`  ✗ …\`)` / `yellow(\`  ⚠ …\`)`
 * one-liner confirmations into the pill vocabulary:
 *   `  ${okPill()} …` / `  ${errPill()} ${red(…)}` / `  ${warnPill()} ${yellow(…)}`
 * Only touches calls whose template contains no nested backticks, so
 * complex interpolations are left untouched for manual review.
 */
import fs from 'node:fs'

const FILE = '/home/z/my-project/packages/cli/src/tui-app.ts'
let src = fs.readFileSync(FILE, 'utf8')
const before = src

// backtick form: green(`  ✔ text…`)  — text free of backticks
const reTpl = /(green|red|yellow)\(\x60  ([✔✗⚠]) ([^\x60]*)\x60\)/g
src = src.replace(reTpl, (_m, fn, icon, text) => {
  if (icon === '✔') return `\x60  \${okPill()} ${text}\x60`
  if (icon === '✗') return `\x60  \${errPill()} \${red(\x60${text}\x60)}\x60`
  return `\x60  \${warnPill()} \${yellow(\x60${text}\x60)}\x60`
})

// single-quote form: green('  ✔ text…') — text free of quotes
const reStr = /(green|red|yellow)\('  ([✔✗⚠]) ([^']*)'\)/g
src = src.replace(reStr, (_m, _fn, icon, text) => {
  if (icon === '✔') return `\x60  \${okPill()} ${text}\x60`
  if (icon === '✗') return `\x60  \${errPill()} \${red(\x60${text}\x60)}\x60`
  return `\x60  \${warnPill()} \${yellow(\x60${text}\x60)}\x60`
})

// strip a leading bold/dim wrap that used to ride inside the color fn — none
// expected, but report if the replacement produced obviously empty pills.
let n = 0
for (const m of before.match(reTpl) ?? []) void m
const countTpl = (before.match(reTpl) ?? []).length
const countStr = (before.match(reStr) ?? []).length

fs.writeFileSync(FILE, src)
console.log(`codemod: converted ${countTpl} template + ${countStr} quoted confirmations`)
