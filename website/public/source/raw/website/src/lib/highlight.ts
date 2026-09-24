/**
 * highlight.ts — dependency-free syntax highlighter for the /source page.
 *
 * One compact tokenizer per language family (TS/JS, JSON, Markdown, shell,
 * CSS, HTML, Go, Python): a single alternation regex walked once, capture
 * group index → semantic class key. Good enough for display, deterministic,
 * ~0 KB of dependencies — the website stays a 4-dep project.
 *
 * Returns tokens split per line: `Tok[][]` — a line per entry, tokens inside.
 */

export interface Tok {
  text: string
  /** semantic class key — mapped to Tailwind classes by the view layer */
  c: string
}

interface Rule {
  re: RegExp
  /** class key per capture group; '' = plain */
  cls: (string | undefined)[]
}

const TS_RE =
  /(\/\*[\s\S]*?\*\/)|(\/\/[^\n]*)|(`(?:\\[\s\S]|[^`\\])*`)|('(?:\\.|[^'\\\n])*')|("(?:\\.|[^"\\\n])*")|(\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?\b)|(\b(?:abstract|as|async|await|break|case|catch|class|const|continue|debugger|declare|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|instanceof|interface|is|keyof|let|new|of|private|protected|public|readonly|return|satisfies|set|static|super|switch|this|throw|try|type|typeof|var|void|while|yield|true|false|null|undefined|NaN|Infinity)\b)|(\b[A-Z][A-Za-z0-9_$]*\b)|([A-Za-z_$][\w$]*(?=\s*\())/

const JSON_RE =
  /("(?:\\.|[^"\\\n])*"\s*:)|("(?:\\.|[^"\\\n])*")|(\b(?:true|false|null)\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/

const MD_RE =
  /(^#{1,6}[^\n]*)|(^```[^\n]*)|(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]*\]\([^)\n]*\))|(^[ \t]*(?:[-*+]|\d+\.) )|(^>[^\n]*)/

const SH_RE =
  /(#[^\n]*)|('(?:\\.|[^'\\\n])*')|("(?:\\.|[^"\\\n])*")|(\$\{?[A-Za-z_][\w]*\}?)|(\b(?:if|then|else|elif|fi|for|in|do|done|while|case|esac|function|return|local|export|source|set|echo|exit|cd)\b)|(^\s*[a-zA-Z_]\w*(?=\s*\(\)))/

const CSS_RE =
  /(\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\\n])*')|("(?:\\.|[^"\\\n])*")|(#[0-9a-fA-F]{3,8}\b)|(@[\w-]+)|(\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|ms|s|fr|ch)?\b)|([.#][\w-]+)|(:{1,2}[\w-]+)/

const HTML_RE =
  /(<!--[\s\S]*?-->)|(<\/?[\w-]+)|(\/?>)|([\w-]+(?==))|("(?:\\.|[^"\\\n])*")|('(?:\\.|[^'\\\n])*')/

const GO_RE =
  /(\/\*[\s\S]*?\*\/)|(\/\/[^\n]*)|(`(?:\\[\s\S]|[^`\\])*`)|("(?:\\.|[^"\\\n])*")|(\b\d[\d_]*(?:\.\d+)?\b)|(\b(?:break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var|nil|true|false|string|int|int64|int32|uint|uint64|float64|bool|byte|rune|error|any)\b)|(\b[A-Z][A-Za-z0-9_]*\b)|([A-Za-z_]\w*(?=\s*\())/

const PY_RE =
  /(#[^\n]*)|("""[\s\S]*?""")|('''[\s\S]*?''')|('(?:\\.|[^'\\\n])*')|("(?:\\.|[^"\\\n])*')|(\b\d+(?:\.\d+)?\b)|(\b(?:def|class|return|if|elif|else|for|while|import|from|as|with|try|except|finally|raise|lambda|yield|pass|break|continue|global|nonlocal|assert|del|in|is|not|and|or|None|True|False|async|await|self)\b)|([A-Za-z_]\w*(?=\s*\())/

const RULES: Record<string, Rule> = {
  ts: { re: new RegExp(TS_RE.source, 'g'), cls: ['com', 'com', 'str', 'str', 'str', 'num', 'kw', 'typ', 'fn'] },
  json: { re: new RegExp(JSON_RE.source, 'g'), cls: ['key', 'str', 'lit', 'num'] },
  md: { re: new RegExp(MD_RE.source, 'gm'), cls: ['hd', 'fence', 'str', 'bold', 'link', '', 'com'] },
  sh: { re: new RegExp(SH_RE.source, 'gm'), cls: ['com', 'str', 'str', 'var', 'kw', 'fn'] },
  css: { re: new RegExp(CSS_RE.source, 'g'), cls: ['com', 'str', 'str', 'num', 'at', 'num', 'sel', 'sel'] },
  html: { re: new RegExp(HTML_RE.source, 'g'), cls: ['com', 'tag', 'tag', 'attr', 'str', 'str'] },
  go: { re: new RegExp(GO_RE.source, 'g'), cls: ['com', 'com', 'str', 'str', 'num', 'kw', 'typ', 'fn'] },
  py: { re: new RegExp(PY_RE.source, 'g'), cls: ['com', 'str', 'str', 'str', 'str', 'num', 'kw', 'fn'] },
}

const FAMILY: Record<string, string> = {
  ts: 'ts',
  tsx: 'ts',
  js: 'ts',
  jsx: 'ts',
  json: 'json',
  md: 'md',
  sh: 'sh',
  css: 'css',
  html: 'html',
  go: 'go',
  py: 'py',
}

export function familyOf(language: string): string | undefined {
  return FAMILY[language]
}

/** Tokenize source into per-line token arrays. Falls back to plain text. */
export function tokenizeLines(code: string, language: string): Tok[][] {
  const rule = RULES[FAMILY[language] ?? '']
  if (!rule) return code.split('\n').map((l) => (l ? [{ text: l, c: '' }] : []))

  const { re, cls } = rule
  re.lastIndex = 0
  const toks: Tok[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    if (m.index > last) toks.push({ text: code.slice(last, m.index), c: '' })
    for (let g = 1; g < m.length; g++) {
      if (m[g] !== undefined) {
        const c = cls[g - 1]
        if (c) toks.push({ text: m[g], c })
        else toks.push({ text: m[g], c: '' })
        break
      }
    }
    last = m.index + m[0].length
    if (m[0].length === 0) re.lastIndex++ // zero-width safety
  }
  if (last < code.length) toks.push({ text: code.slice(last), c: '' })

  // split tokens that span newlines into separate lines
  const lines: Tok[][] = [[]]
  for (const t of toks) {
    const parts = t.text.split('\n')
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push([])
      if (parts[i]) lines[lines.length - 1].push({ text: parts[i], c: t.c })
    }
  }
  return lines
}
