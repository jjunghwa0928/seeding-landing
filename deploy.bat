@echo off
REM ENCLU seeding landing + quote API deploy (Windows)
REM Usage: run from the repo root on the server (or double-click)
REM Steps: git pull -> npm ci (api) -> pm2 restart seeding-quote-api -> pm2 save -> health check

setlocal
cd /d "%~dp0"

if not exist "api\.env" (
  echo api\.env not found. copy api\.env.example api\.env and fill SMTP_PASS first.
  goto fail
)

echo [1/5] git pull origin main
git pull origin main
if errorlevel 1 goto fail

echo [2/5] npm ci (api, production only)
cd api
call npm ci --omit=dev
if errorlevel 1 goto fail

echo [3/5] pm2 restart seeding-quote-api
call pm2 delete seeding-quote-api >nul 2>&1
call pm2 start ecosystem.config.js
if errorlevel 1 goto fail

echo [4/5] pm2 save
call pm2 save
cd ..

echo [5/5] health check
timeout /t 3 /nobreak >nul
curl -s http://localhost:3201/api/health
echo.

echo done
endlocal
exit /b 0

:fail
echo deploy failed (see output above)
cd /d "%~dp0"
endlocal
exit /b 1
