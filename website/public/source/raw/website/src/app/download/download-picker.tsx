"use client"

import { useEffect, useState } from "react"
import { LATEST } from "@/data/releases"
import { DOWNLOAD_TARGETS, releaseAsset, type DownloadTarget } from "./downloads"

const FALLBACK = DOWNLOAD_TARGETS[0] // windows-x64

/** what the picker decided to offer this visitor */
interface Pick {
  primary: DownloadTarget
}

function fullFor(os: DownloadTarget["os"], arch: "x64" | "arm64") {
  return DOWNLOAD_TARGETS.find((d) => d.os === os && d.arch === arch)
}

function pickFor(os: DownloadTarget["os"], arch: "x64" | "arm64"): Pick {
  return { primary: fullFor(os, arch) ?? FALLBACK }
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

  return new Promise((resolve) => {
    let settled = false
    const done = (p: Pick | undefined) => {
      if (!settled) { settled = true; resolve(p ?? { primary: FALLBACK }) }
    }
    // No client hints (Safari/Firefox): assume x64 everywhere except macOS,
    // where Apple silicon is the safe default (Intel macs still run via Rosetta).
    const fallbackArch: Record<DownloadTarget["os"], "x64" | "arm64"> = {
      windows: "x64",
      linux: "x64",
      macos: "arm64",
    }
    // Chromium on ARM (Windows/Mac/Linux) exposes the real architecture here.
    // (Guarded: some UA-Data implementations predate getHighEntropyValues.)
    try {
      const uaData = nav.userAgentData
      if (uaData && typeof uaData.getHighEntropyValues === "function") {
        uaData
          .getHighEntropyValues(["architecture"])
          .then((h) => {
            const arch: "x64" | "arm64" = /arm/i.test(h.architecture ?? "") ? "arm64" : "x64"
            done(pickFor(os, arch))
          })
          .catch(() => done(pickFor(os, "x64")))
      } else {
        done(pickFor(os, fallbackArch[os]))
      }
    } catch {
      done(pickFor(os, fallbackArch[os]))
    }
    setTimeout(() => done(pickFor(os, fallbackArch[os])), 350)
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
        {target.file} · self-contained · no runtime to install
        {target.note ? ` · ${target.note}` : ""}
      </p>
      <p className="mt-1 text-xs text-zinc-500">
        Every platform is in the table below — or grab the{" "}
        <a className="text-zinc-400 underline decoration-zinc-700 hover:text-zinc-200" href={releaseAsset(LATEST, "SHA256SUMS.txt")}>checksums</a>.
      </p>
    </div>
  )
}
