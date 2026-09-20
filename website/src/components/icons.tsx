/**
 * icons.tsx — hand-tuned SVG icons (lucide-style, 24×24, stroke 2).
 * Real vector icons instead of unicode emoji — crisp on every platform,
 * no emoji-font roulette, no extra dependency.
 */
import type { SVGProps } from 'react'

function I({ children, ...p }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...p}
    >
      {children}
    </svg>
  )
}

/** ↻ — the agentic loop */
export const IconLoop = (p: SVGProps<SVGSVGElement>) => (
  <I {...p}>
    <path d="m17 2 4 4-4 4" />
    <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
    <path d="m7 22-4-4 4-4" />
    <path d="M21 13v1a4 4 0 0 1-4 4H3" />
  </I>
)

/** robot — subagents */
export const IconBot = (p: SVGProps<SVGSVGElement>) => (
  <I {...p}>
    <path d="M12 8V4H8" />
    <rect width="16" height="12" x="4" y="8" rx="2" />
    <path d="M2 14h2" />
    <path d="M20 14h2" />
    <path d="M15 13v2" />
    <path d="M9 13v2" />
  </I>
)

/** shield check — permissions */
export const IconShield = (p: SVGProps<SVGSVGElement>) => (
  <I {...p}>
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    <path d="m9 12 2 2 4-4" />
  </I>
)

/** brain — memory & skills */
export const IconBrain = (p: SVGProps<SVGSVGElement>) => (
  <I {...p}>
    <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
    <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
    <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
  </I>
)

/** plug — multi-provider BYOK */
export const IconPlug = (p: SVGProps<SVGSVGElement>) => (
  <I {...p}>
    <path d="M12 22v-5" />
    <path d="M9 8V2" />
    <path d="M15 8V2" />
    <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
  </I>
)

/** puzzle — plugins */
export const IconPuzzle = (p: SVGProps<SVGSVGElement>) => (
  <I {...p}>
    <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.283c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.283.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.229.586-.327.904-.262.437.09.76.44.927.872a2.5 2.5 0 1 0 3.166-3.169c-.432-.167-.782-.49-.872-.927-.065-.418.033-.664.262-.904L10.296 2.7c.47-.47 1.087-.706 1.704-.706.617 0 1.234.235 1.704.706l1.568 1.568c.23.23.556.338.877.289.425-.064.745-.398.915-.817a2.5 2.5 0 1 1 3.213 3.213c-.418.17-.752.49-.816.915Z" />
  </I>
)

/** globe — web & browser tools */
export const IconGlobe = (p: SVGProps<SVGSVGElement>) => (
  <I {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
    <path d="M2 12h20" />
  </I>
)

/** smartphone — runs on a phone */
export const IconPhone = (p: SVGProps<SVGSVGElement>) => (
  <I {...p}>
    <rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
    <path d="M12 18h.01" />
  </I>
)

/** network nodes — MCP */
export const IconNetwork = (p: SVGProps<SVGSVGElement>) => (
  <I {...p}>
    <rect x="16" y="16" width="6" height="6" rx="1" />
    <rect x="2" y="16" width="6" height="6" rx="1" />
    <rect x="9" y="2" width="6" height="6" rx="1" />
    <path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3" />
    <path d="M12 12V8" />
  </I>
)

/** terminal prompt — the TUI */
export const IconTerminal = (p: SVGProps<SVGSVGElement>) => (
  <I {...p}>
    <path d="m4 17 6-6-6-6" />
    <path d="M12 19h8" />
  </I>
)

/** zap — speed / bun */
export const IconZap = (p: SVGProps<SVGSVGElement>) => (
  <I {...p}>
    <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
  </I>
)

/** download */
export const IconDownload = (p: SVGProps<SVGSVGElement>) => (
  <I {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" x2="12" y1="15" y2="3" />
  </I>
)

/** package — single-file binary */
export const IconPackage = (p: SVGProps<SVGSVGElement>) => (
  <I {...p}>
    <path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" />
    <path d="M12 22V12" />
    <polyline points="3.29 7 12 12 20.71 7" />
    <path d="m7.5 4.27 9 5.15" />
  </I>
)

/** check */
export const IconCheck = (p: SVGProps<SVGSVGElement>) => (
  <I {...p}>
    <path d="M20 6 9 17l-5-5" />
  </I>
)

/** arrow right */
export const IconArrowRight = (p: SVGProps<SVGSVGElement>) => (
  <I {...p}>
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </I>
)

/** external link */
export const IconExternal = (p: SVGProps<SVGSVGElement>) => (
  <I {...p}>
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </I>
)

/** refresh / update */
export const IconRefresh = (p: SVGProps<SVGSVGElement>) => (
  <I {...p}>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M8 16H3v5" />
  </I>
)

/** laptop with browser — the web GUI */
export const IconMonitor = (p: SVGProps<SVGSVGElement>) => (
  <I {...p}>
    <rect width="20" height="14" x="2" y="3" rx="2" />
    <line x1="8" x2="16" y1="21" y2="21" />
    <line x1="12" x2="12" y1="17" y2="21" />
  </I>
)

/** keyboard keys — interactive TUI */
export const IconKeyboard = (p: SVGProps<SVGSVGElement>) => (
  <I {...p}>
    <path d="M10 8h.01" />
    <path d="M12 12h.01" />
    <path d="M14 8h.01" />
    <path d="M16 12h.01" />
    <path d="M18 8h.01" />
    <path d="M6 8h.01" />
    <path d="M7 16h10" />
    <path d="M8 12h.01" />
    <rect width="20" height="16" x="2" y="4" rx="2" />
  </I>
)

/** git branch — GitHub login & project sync */
export const IconBranch = (p: SVGProps<SVGSVGElement>) => (
  <I {...p}>
    <line x1="6" x2="6" y1="3" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  </I>
)

/** the "T" glyph — markdown rendering in the terminal */
export const IconType = (p: SVGProps<SVGSVGElement>) => (
  <I {...p}>
    <polyline points="4 7 4 4 20 4 20 7" />
    <line x1="9" x2="15" y1="20" y2="20" />
    <line x1="12" x2="12" y1="4" y2="20" />
  </I>
)
