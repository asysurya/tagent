@echo off
rem Build tagent-native for all targets into native\dist\ (Go 1.21+ must be in PATH).
rem On Windows 7/8 install Go 1.21.x — the last Go line that still works there.
setlocal
cd /d "%~dp0"

set CGO_ENABLED=0
set GOTOOLCHAIN=local
set LDFLAGS=-s -w
if not exist dist mkdir dist

set GOOS=windows
set GOARCH=386
go build -trimpath -ldflags "%LDFLAGS%" -o dist\tagent-native-windows-386.exe . && echo built dist\tagent-native-windows-386.exe || exit /b 1

set GOOS=windows
set GOARCH=amd64
go build -trimpath -ldflags "%LDFLAGS%" -o dist\tagent-native-windows-amd64.exe . && echo built dist\tagent-native-windows-amd64.exe || exit /b 1

set GOOS=linux
set GOARCH=amd64
go build -trimpath -ldflags "%LDFLAGS%" -o dist\tagent-native-linux-amd64 . && echo built dist\tagent-native-linux-amd64 || exit /b 1

set GOOS=linux
set GOARCH=arm64
go build -trimpath -ldflags "%LDFLAGS%" -o dist\tagent-native-linux-arm64 . && echo built dist\tagent-native-linux-arm64 || exit /b 1

cd dist
if exist SHA256SUMS.txt del SHA256SUMS.txt
for %%f in (tagent-native-*) do (
  for /f "skip=1 delims=" %%h in ('certutil -hashfile "%%f" SHA256 ^| findstr /r "^[0-9a-f]*$"') do echo %%h  %%f>> SHA256SUMS.txt
)
echo wrote dist\SHA256SUMS.txt
endlocal
