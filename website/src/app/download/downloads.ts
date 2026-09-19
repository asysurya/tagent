import { LATEST } from "@/data/releases"

/**
 * The per-platform single-file binaries, one per `bun build --compile` target
 * (see scripts/build-binaries.sh). Files live as GitHub release assets;
 * URLs follow the standard download pattern.
 */

export interface DownloadTarget {
  /** used for auto-detection in the picker */
  os: "windows" | "linux" | "macos"
  /** "386" only exists in the native edition (32-bit Windows build) */
  arch: "x64" | "arm64" | "386"
  /** "full" (default) = the Bun-compiled binary with everything inside; "native" = the Go port */
  edition?: "full" | "native"
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

/**
 * The native edition — the agent core rewritten in pure Go (stdlib only,
 * CGO_ENABLED=0) and cross-compiled with Go 1.21, the last toolchain that
 * still targets Windows 7/8. Truly static single files of ~10–15 MB (the full
 * binaries are 60–95 MB) that run on machines the main build cannot:
 * Windows 7, 8, 8.1 — including 32-bit (x86) machines.
 *
 * Unlike the full binaries, these file names carry no version infix — the
 * release URL (see releaseAsset) is what pins them to a release.
 */
export const NATIVE_TARGETS: DownloadTarget[] = [
  {
    os: "windows",
    arch: "386",
    edition: "native",
    label: "Windows 32-bit",
    sub: "Windows 7, 8, 8.1, 10, 11 · x86 (386)",
    file: "tagent-native-windows-386.exe",
    note: "PE32 i386 — the build that finally covers Windows 7/8 and 32-bit machines.",
  },
  {
    os: "windows",
    arch: "x64",
    edition: "native",
    label: "Windows 64-bit",
    sub: "Windows 7 to 11 · x86-64 · lightweight",
    file: "tagent-native-windows-amd64.exe",
    note: "The featherweight option for modern boxes too (~10–15 MB).",
  },
  {
    os: "linux",
    arch: "x64",
    edition: "native",
    label: "Linux",
    sub: "x86-64 · fully static",
    file: "tagent-native-linux-amd64",
    note: "No glibc dependency — runs on any distro, musl/Alpine included.",
  },
  {
    os: "linux",
    arch: "arm64",
    edition: "native",
    label: "Linux ARM64",
    sub: "Raspberry Pi · ARM servers · static",
    file: "tagent-native-linux-arm64",
    note: "No glibc dependency — runs on any distro.",
  },
]
