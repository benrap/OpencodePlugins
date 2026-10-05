@echo off
rem Launch the patched opencode build. Binary-first: prefer the standalone
rem executable shipped with the artifact, and only fall back to running the
rem TypeScript source with bun when no binary is present.
rem
rem Every path is resolved at runtime from this file's location (%SHIM_DIR%) or
rem from environment variables, so this file is portable across machines.
rem
rem Standalone binary resolution order:
rem   1. %OPENCODE_PATCHED_BIN%                 (explicit override)
rem   2. %~dp0..\bin\opencode.exe               (artifact layout: scripts\..\bin)
rem   3. %~dp0bin\opencode.exe                  (binary beside this shim)
rem   4. %~dp0opencode-patched.exe              (legacy name beside this shim)
rem
rem Source fallback (only used when no binary is found):
rem   bun run --cwd %OPENCODE_PATCHED_SOURCE% src/index.ts
setlocal
set "SHIM_DIR=%~dp0"

rem 0) Explicit override wins.
if defined OPENCODE_PATCHED_BIN if exist "%OPENCODE_PATCHED_BIN%" (
    "%OPENCODE_PATCHED_BIN%" %*
    exit /b %errorlevel%
)

rem 1) Artifact layout: scripts\..\bin\opencode.exe
if exist "%SHIM_DIR%..\bin\opencode.exe" (
    "%SHIM_DIR%..\bin\opencode.exe" %*
    exit /b %errorlevel%
)

rem 2) Binary placed next to this shim.
if exist "%SHIM_DIR%bin\opencode.exe" (
    "%SHIM_DIR%bin\opencode.exe" %*
    exit /b %errorlevel%
)

rem 3) Legacy single-file name next to this shim.
if exist "%SHIM_DIR%opencode-patched.exe" (
    "%SHIM_DIR%opencode-patched.exe" %*
    exit /b %errorlevel%
)

rem 4) No binary found: fall back to the TypeScript source with bun.
if not defined OPENCODE_PATCHED_SOURCE set "OPENCODE_PATCHED_SOURCE=%SHIM_DIR%opencode-src\packages\cli"
if defined BUN_EXE (
    "%BUN_EXE%" run --cwd "%OPENCODE_PATCHED_SOURCE%" src/index.ts %*
) else (
    bun run --cwd "%OPENCODE_PATCHED_SOURCE%" src/index.ts %*
)
exit /b %errorlevel%
