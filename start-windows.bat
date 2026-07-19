@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required.
  echo Download it from https://nodejs.org/
  pause
  exit /b 1
)
set "NODE_MAJOR="
for /f %%v in ('node -p "process.versions.node.split('.')[0]"') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR (
  echo Could not determine the installed Node.js version.
  pause
  exit /b 1
)
if %NODE_MAJOR% LSS 22 (
  echo Node.js 22 or newer is required. Found major version %NODE_MAJOR%.
  pause
  exit /b 1
)
node scripts\source-preflight.mjs
if errorlevel 1 (
  pause
  exit /b 1
)
echo Starting Codebate. Your browser will open automatically when the local server is ready.
node server\index.js
pause
