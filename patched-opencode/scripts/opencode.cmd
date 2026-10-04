@echo off
"%USERPROFILE%\AppData\Roaming\npm\node_modules\bun\bin\bun.exe" run --cwd "<opencode-checkout>\packages\cli" src/index.ts %*
exit /b %errorlevel%
