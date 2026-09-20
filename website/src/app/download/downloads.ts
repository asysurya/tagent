import { LATEST } from "@/data/releases"

/**
 * The per-platform single-file binaries, one per `bun build --compile` target
 * (see scripts/build-binaries.sh). Files live as GitHub release assets;
 * URLs follow the standard download pattern.
 */

export interface DownloadTarget {
  /** used for auto-detection in the picker */
  os: "windows" | "linux" | "macos"
  arch: "x64" | "arm64"
  label: string
  sub: string
  file: string
  /** shown in the install section */
  note?: string
}

export function releaseAsset(version: string, file: string): string {
  return `https://github.com/asysurya/tagent/releases/download/v${version}/${file}`
}

export function windowsX64File(version = LATEST): string {
  return `tagent-v${version}-windows-x64.exe`
}

export const DOWNLOAD_TARGETS: DownloadTarget[] = [
  {
    os: "windows",
    arch: "x64",
    label: "Windows",
    sub: "Windows 10 or later · 64-bit",
    file: windowsX64File(),
    note: "Runs as-is. For the bash tool, install Git for Windows (tagent doctor checks it).",
  },
  {
    os: "windows",
    arch: "arm64",
    label: "Windows on ARM",
    sub: "Windows 10+ · ARM64 (Surface, Snapdragon)",
    file: `tagent-v${LATEST}-windows-arm64.exe`,
    note: "Also fine on x64 laptops — the x64 build runs through emulation.",
  },
  {
    os: "linux",
    arch: "x64",
    label: "Linux",
    sub: "glibc (Ubuntu, Debian, Fedora…) · x86-64",
    file: `tagent-v${LATEST}-linux-x64`,
  },
  {
    os: "linux",
    arch: "arm64",
    label: "Linux ARM64",
    sub: "Raspberry Pi 5 · ARM servers · netbooks",
    file: `tagent-v${LATEST}-linux-arm64`,
  },
  {
    os: "macos",
    arch: "x64",
    label: "macOS",
    sub: "Intel",
    file: `tagent-v${LATEST}-macos-x64`,
  },
  {
    os: "macos",
    arch: "arm64",
    label: "macOS",
    sub: "Apple silicon (M1–M4)",
    file: `tagent-v${LATEST}-macos-arm64`,
  },
]
