/**
 * theme.ts — the TUI color system (v0.23.0).
 *
 * Six built-in themes; every color in the app flows through ONE mutable
 * "active theme" record. The slots are SEMANTIC (red = error, green =
 * success, cyan = selection…) so a theme recolors the whole UI — navbar,
 * editor box, tool boxes, banners, markdown — without touching layout code.
 *
 *  - dark        the classic palette (default — byte-identical to v0.22)
 *  - light       white-background terminals
 *  - tokyo-night · dracula · nord · gruvbox — the editor favorites
 *
 * Colors are 256-color SGR codes (`38;5;NNN`) — they render everywhere
 * (xterm, Termux, Blink, tmux) without truecolor support. NO_COLOR still
 * wins over everything: the app's color gate (USE_COLOR) is checked by the
 * callers, never here.
 *
 * Persistence: the theme name lives in the GLOBAL config (~/.tagent,
 * `theme` key) — a personal preference, not a workspace fact. /theme
 * switches live and writes it; boot applies it before the first frame.
 */

export interface ThemeSgr {
  bold: string
  dim: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  /** the assistant accent — the ● message mark and the running editor rail */
  orange: string
  /** selection / cursor highlight (list cursors, the palette…) */
  accent: string
}

/** markdown body colors — the renderer reads these live, so a theme
 *  switch recolors the next render with zero reload. */
export interface ThemeMd {
  /** h1–h6 inline styles */
  heading: [string, string, string, string, string, string]
  /** fenced code content */
  soft: string
  /** list markers · fence language label · inline code chip */
  mark: string
  fenceLang: string
  /** inline `code` chip — bg;fg pair */
  code: string
}

export interface Theme {
  name: string
  label: string
  /** true = built for a dark terminal background */
  dark: boolean
  sgr: ThemeSgr
  md: ThemeMd
}

/* ------------------------------------------------------------------ */
/* the themes                                                           */
/* ------------------------------------------------------------------ */

/** dark — the classic v0.22 palette, kept byte-identical */
const DARK: Theme = {
  name: 'dark',
  label: 'Dark',
  dark: true,
  sgr: {
    bold: '1', dim: '2',
    red: '31', green: '32', yellow: '33', blue: '34', magenta: '35', cyan: '36',
    orange: '38;5;208', accent: '36',
  },
  md: {
    heading: ['1;36', '1;35', '1;33', '1', '1', '1'],
    soft: '38;5;152',
    mark: '36',
    fenceLang: '36',
    code: '48;5;237;38;5;222',
  },
}

/** light — dark-leaning 256 shades that stay readable on white paper */
const LIGHT: Theme = {
  name: 'light',
  label: 'Light',
  dark: false,
  sgr: {
    bold: '1', dim: '2',
    red: '38;5;160', green: '38;5;28', yellow: '38;5;94', blue: '38;5;25',
    magenta: '38;5;127', cyan: '38;5;30', orange: '38;5;166', accent: '38;5;30',
  },
  md: {
    heading: ['1;160', '1;127', '1;94', '1', '1', '1'],
    soft: '38;5;24',
    mark: '38;5;30',
    fenceLang: '38;5;30',
    code: '48;5;253;38;5;52',
  },
}

/** tokyo-night — #1a1b26 · blue-first neon */
const TOKYO_NIGHT: Theme = {
  name: 'tokyo-night',
  label: 'Tokyo Night',
  dark: true,
  sgr: {
    bold: '1', dim: '2',
    red: '38;5;210', green: '38;5;156', yellow: '38;5;179', blue: '38;5;111',
    magenta: '38;5;140', cyan: '38;5;117', orange: '38;5;215', accent: '38;5;117',
  },
  md: {
    heading: ['1;117', '1;140', '1;179', '1', '1', '1'],
    soft: '38;5;146',
    mark: '38;5;117',
    fenceLang: '38;5;117',
    code: '48;5;61;38;5;223',
  },
}

/** dracula — #282a36 · purple & neon pastel */
const DRACULA: Theme = {
  name: 'dracula',
  label: 'Dracula',
  dark: true,
  sgr: {
    bold: '1', dim: '2',
    red: '38;5;203', green: '38;5;84', yellow: '38;5;228', blue: '38;5;111',
    magenta: '38;5;213', cyan: '38;5;117', orange: '38;5;215', accent: '38;5;213',
  },
  md: {
    heading: ['1;117', '1;213', '1;228', '1', '1', '1'],
    soft: '38;5;146',
    mark: '38;5;117',
    fenceLang: '38;5;117',
    code: '48;5;61;38;5;231',
  },
}

/** nord — #2e3440 · cold frost, easy on the eyes */
const NORD: Theme = {
  name: 'nord',
  label: 'Nord',
  dark: true,
  sgr: {
    bold: '1', dim: '2',
    red: '38;5;131', green: '38;5;150', yellow: '38;5;222', blue: '38;5;110',
    magenta: '38;5;139', cyan: '38;5;109', orange: '38;5;173', accent: '38;5;110',
  },
  md: {
    heading: ['1;110', '1;139', '1;222', '1', '1', '1'],
    soft: '38;5;145',
    mark: '38;5;109',
    fenceLang: '38;5;109',
    code: '48;5;60;38;5;223',
  },
}

/** gruvbox — #282828 · warm, muddy, beloved */
const GRUVBOX: Theme = {
  name: 'gruvbox',
  label: 'Gruvbox',
  dark: true,
  sgr: {
    bold: '1', dim: '2',
    red: '38;5;203', green: '38;5;148', yellow: '38;5;214', blue: '38;5;109',
    magenta: '38;5;175', cyan: '38;5;108', orange: '38;5;208', accent: '38;5;108',
  },
  md: {
    heading: ['1;108', '1;175', '1;214', '1', '1', '1'],
    soft: '38;5;187',
    mark: '38;5;108',
    fenceLang: '38;5;108',
    code: '48;5;239;38;5;222',
  },
}

export const THEMES: Theme[] = [DARK, LIGHT, TOKYO_NIGHT, DRACULA, NORD, GRUVBOX]

/* ------------------------------------------------------------------ */
/* active theme state — read on every paint, swapped by /theme          */
/* ------------------------------------------------------------------ */

let active = DARK

export function activeTheme(): Theme {
  return active
}

/** switch the live theme. Unknown names keep the current one (returns false). */
export function setTheme(name: string): boolean {
  const t = THEMES.find((x) => x.name === name || x.label.toLowerCase() === name.toLowerCase())
  if (!t) return false
  active = t
  return true
}

/** convenience for call sites that only need one SGR code */
export function themeSgr(slot: keyof ThemeSgr): string {
  return active.sgr[slot]
}

export function isTheme(name: string): boolean {
  return THEMES.some((x) => x.name === name || x.label.toLowerCase() === name.toLowerCase())
}

/** label lookup for the picker's current-theme mark */
export function themeLabel(name: string): string | undefined {
  return THEMES.find((x) => x.name === name)?.label
}

/* ------------------------------------------------------------------ */
/* swatches — one preview line per theme for the picker                 */
/* ------------------------------------------------------------------ */

/** a one-line colored preview: ● accents over the theme's own hues.
 *  `colored=false` returns the plain bg hint — callers pass their own gate. */
export function themeSwatch(t: Theme, colored = true): string {
  if (!colored) return t.dark ? 'dark background' : 'light background'
  const s = (code: string, ch: string) => `\x1b[${code}m${ch}\x1b[0m`
  const dots = [
    s(t.sgr.red, '●'), s(t.sgr.green, '●'), s(t.sgr.yellow, '●'),
    s(t.sgr.blue, '●'), s(t.sgr.magenta, '●'), s(t.sgr.cyan, '●'),
    s(t.sgr.orange, '●'),
  ].join(' ')
  const bg = t.dark ? 'dark bg' : 'light bg'
  return `${dots}  ${t.sgr.dim ? '' : ''}${bg}`
}
