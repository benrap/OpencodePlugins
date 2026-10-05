@echo off
rem Launch the patched opencode build. Every path is resolved at runtime, so
rem this file is portable across machines.
rem
rem Resolution order for the patched source (the checkout's packages\cli):
rem   1. %OPENCODE_PATCHED_SOURCE%
rem   2. %~dp0opencode-src\packages\cli   (a checkout copied next to this shim)
setlocal
set "SHIM_DIR=%~dp0"

if not defined OPENCODE_PATCHED_SOURCE set "OPENCODE_PATCHED_SOURCE=%SHIM_DIR%opencode-src\packages\cli"

rem 1) A compiled binary placed next to this shim wins.
if exist "%SHIM_DIR%opencode-patched.exe" (
    "%SHIM_DIR%opencode-patched.exe" %*
    exit /b %errorlevel%
)

rem 2) Otherwise run the TypeScript source with bun. BUN_EXE overrides PATH.
if defined BUN_EXE (
    "%BUN_EXE%" run --cwd "%OPENCODE_PATCHED_SOURCE%" src/index.ts %*
) else (
    bun run --cwd "%OPENCODE_PATCHED_SOURCE%" src/index.ts %*
)
exit /b %errorlevel%
