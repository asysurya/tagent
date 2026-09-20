"use client"

import { useEffect, useState } from "react"
import { LATEST } from "@/data/releases"
import { DOWNLOAD_TARGETS, NATIVE_TARGETS, releaseAsset, type DownloadTarget } from "./downloads"

const FALLBACK = DOWNLOAD_TARGETS[0] // windows-x64

/** what the picker decided to offer this visitor */
interface Pick {
  primary: DownloadTarget
  /** the other flavor of the same OS — native edition on 64-bit Windows,
   *  full binary under a 32-bit/WOW64 user agent */
  secondary?: DownloadTarget
}

function fullFor(os: DownloadTarget["os"], arch: "x64" | "arm64") {
  return DOWNLOAD_TARGETS.find((d) => d.os === os && d.arch === arch)
}

function nativeFor(os: DownloadTarget["os"], arch: "x64" | "386") {
  return NATIVE_TARGETS.find((d) => d.os === os && d.arch === arch)
}

/** 32-bit clues in a raw Windows UA: "WOW64" = 32-bit browser; the absence of
 *  any 64-bit token (Win64 / x64 / x86_64) = a 32-bit OS or an old browser —
 *  either way the native 386 build is the safe primary. */
function uaLooks32BitWindows(ua: string): boolean {
  if (/WOW64/i.test(ua)) return true
  return !/Win64|x64|x86_64/i.test(ua)
}

/** Windows 7 / 8 / 8.1 report Windows NT 6.1–6.3 — the full binary needs 10. */
function uaLooksLegacyWindows(ua: string): boolean {
  return /Windows NT 6\.[0-3]/i.test(ua)
}

function pickFor(os: DownloadTarget["os"], arch: "x64" | "arm64", windows32bit: boolean, windowsLegacy: boolean): Pick {
  if (os === "windows") {
    if (arch === "arm64") return { primary: fullFor("windows", "arm64")! }
    // 32-bit / WOW64 / unknown-arch: the Go build is the primary — it covers
    // Windows 7/8 and 32-bit machines the main binaries cannot run on.
    if (windows32bit) {
      return { primary: nativeFor("windows", "386")!, secondary: fullFor("windows", "x64") }
    }
    // Windows 7/8/8.1 on a 64-bit machine: the full binary needs Windows 10,
    // so the native amd64 build leads here too.
    if (windowsLegacy) {
      return { primary: nativeFor("windows", "x64")!, secondary: fullFor("windows", "x64") }
    }
    // plain 64-bit Windows: full binary first, native as the lightweight option
    return { primary: fullFor("windows", "x64")!, secondary: nativeFor("windows", "x64") }
  }
  // macOS keeps getting the full binary only; Linux likewise (there is no
  // linux-386 native build, so 32-bit Linux is not covered either way).
  return { primary: fullFor(os, arch)! }
}

function detect(): Promise<Pick> {
  // Prefer the high-entropy client hints (Chromium); fall back to UA sniffing.
  const nav = navigator as Navigator & {
    userAgentData?: {
      getHighEntropyValues: (hints: string[]) => Promise<{ architecture?: string; bitness?: string; platform?: string }>
    }
  }
  const ua = navigator.userAgent
  let os: DownloadTarget["os"] = "windows"
  if (/Windows/i.test(ua)) os = "windows"
  else if (/Macintosh|Mac OS X/i.test(ua)) os = "macos"
  else if (/Linux|X11|Ubuntu/i.test(ua) && !/Android/i.test(ua)) os = "linux"

  // start from the UA guess, refine when client hints arrive
  let bits32 = os === "windows" && uaLooks32BitWindows(ua)
  const legacy = os === "windows" && uaLooksLegacyWindows(ua)

  return new Promise((resolve) => {
    let settled = false
    const done = (p: Pick | undefined) => {
      if (!settled) { settled = true; resolve(p ?? { primary: FALLBACK }) }
    }
    // No client hints (Safari/Firefox): assume x64 everywhere except macOS,
    // where Apple silicon is the safe default (Intel macs still run via Rosetta… pickers below).
    const fallbackArch: Record<DownloadTarget["os"], "x64" | "arm64"> = {
      windows: "x64",
      linux: "x64",
      macos: "arm64",
    }
    // Chromium on ARM (Windows/Mac/Linux) exposes the real architecture here;
    // "bitness" is the browser's bitness — "32" means WOW64 or a true 32-bit OS.
    // (Guarded: some UA-Data implementations predate getHighEntropyValues.)
    try {
      const uaData = nav.userAgentData
      if (uaData && typeof uaData.getHighEntropyValues === "function") {
        uaData
          .getHighEntropyValues(["architecture", "bitness"])
          .then((h) => {
            const arch: "x64" | "arm64" = /arm/i.test(h.architecture ?? "") ? "arm64" : "x64"
            if (h.bitness === "32") bits32 = true
            else if (h.bitness === "64") bits32 = false
            done(pickFor(os, arch, bits32, legacy))
          })
          .catch(() => done(pickFor(os, "x64", bits32, legacy)))
      } else {
        done(pickFor(os, fallbackArch[os], bits32, legacy))
      }
    } catch {
      done(pickFor(os, fallbackArch[os], bits32, legacy))
    }
    setTimeout(() => done(pickFor(os, fallbackArch[os], bits32, legacy)), 350)
  })
}

export function DownloadPicker() {
  const [pick, setPick] = useState<Pick>({ primary: FALLBACK })
  const [detected, setDetected] = useState(false)

  useEffect(() => {
    let live = true
    detect().then((p) => {
      if (live) { setPick(p); setDetected(true) }
    })
    return () => { live = false }
  }, [])

  const target = pick.primary
  const secondary = pick.secondary
  const isNative = target.edition === "native"
  const osIcon = target.os === "windows" ? "🪟" : target.os === "macos" ? "🍎" : "🐧"
  const osName =
    target.label === "Windows on ARM"
      ? "Windows on ARM"
      : target.os === "macos"
        ? "macOS"
        : target.os === "linux"
          ? "Linux"
          : "Windows"

  return (
    <div className="mt-8 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6 sm:p-8">
      <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-center">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 text-3xl">
          {osIcon}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-zinc-500">
            {detected ? "Detected your platform" : "Most people need this one"}
          </p>
          <h2 className="text-xl font-bold text-zinc-100">
            Download for {osName}
            {isNative && (
              <span className="ml-2 rounded-full border border-orange-500/40 bg-orange-500/10 px-2 py-0.5 align-middle font-mono text-[11px] font-semibold text-orange-300">
                native edition
              </span>
            )}
            <span className="ml-2 font-mono text-sm font-normal text-zinc-500">{target.sub}</span>
          </h2>
        </div>
        <a
          href={releaseAsset(LATEST, target.file)}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-orange-500 px-6 py-3 text-base font-semibold text-zinc-950 shadow-lg shadow-orange-500/20 transition hover:bg-orange-400"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Download
        </a>
      </div>
      <p className="mt-4 break-all font-mono text-xs text-zinc-500">
        {target.file} ·{" "}
        {isNative ? "static Go binary · ~10–15 MB · download and run" : "self-contained · no runtime to install"}
        {target.note ? ` · ${target.note}` : ""}
      </p>
      {isNative && (
        <p className="mt-2 text-sm font-medium text-orange-300">
          Native edition — supports Windows 7/8 and 32-bit.
        </p>
      )}
      {secondary && (
        <p className="mt-2 text-xs text-zinc-500">
          Also available:{" "}
          <a
            className="font-medium text-orange-400 underline decoration-orange-800 hover:text-orange-300"
            href={releaseAsset(LATEST, secondary.file)}
          >
            {secondary.edition === "native" ? "Native edition (Go)" : "Full edition"} — {secondary.file}
          </a>
          {secondary.edition === "native"
            ? " · the lightweight core agent, also for Windows 7/8"
            : " · needs 64-bit Windows 10 or later"}
        </p>
      )}
      <p className="mt-1 text-xs text-zinc-500">
        Every platform is in the table below — or grab the{" "}
        <a className="text-zinc-400 underline decoration-zinc-700 hover:text-zinc-200" href={releaseAsset(LATEST, "SHA256SUMS.txt")}>checksums</a>.
      </p>
    </div>
  )
}
