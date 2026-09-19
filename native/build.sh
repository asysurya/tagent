#!/usr/bin/env bash
# Build tagent-native for all targets (go1.21 = last Windows 7/8 toolchain).
# Usage: bash native/build.sh [windows|linux|darwin|all|<os/arch>]
set -euo pipefail
cd "$(dirname "$0")"

GO="${GO:-go}"                       # or: GO=/path/to/go1.21/bin/go
OUT="dist"
mkdir -p "$OUT"

targets_windows="windows/386 windows/amd64"
targets_linux="linux/amd64 linux/arm64"
targets_all="$targets_windows $targets_linux"

filter="${1:-all}"
case "$filter" in
  windows) targets="$targets_windows" ;;
  linux)   targets="$targets_linux" ;;
  all)     targets="$targets_all" ;;
  *)       targets="$filter" ;;
esac

export CGO_ENABLED=0
"$GO" vet ./... || true
"$GO" fmt .

for t in $targets; do
  os="${t%/*}"; arch="${t#*/}"
  ext=""; [ "$os" = "windows" ] && ext=".exe"
  out="$OUT/tagent-native-$os-$arch$ext"
  echo "== building $t → $out"
  GOOS="$os" GOARCH="$arch" "$GO" build -trimpath -ldflags "-s -w" -o "$out" .
done

cd "$OUT" && (command -v sha256sum >/dev/null && sha256sum tagent-native-* > SHA256SUMS.txt || shasum -a 256 tagent-native-* > SHA256SUMS.txt)
echo "done:"
ls -la
