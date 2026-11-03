@echo off
rem Weekly review refresh for Windows Task Scheduler. See README.md.
chcp 65001 >nul
setlocal
cd /d "%~dp0.." || exit /b 1
if not exist logs mkdir logs
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
call :main >> "logs\refresh-reviews.log" 2>&1
exit /b %ERRORLEVEL%

:main
echo [%date% %time%] start
call :run_py scripts\refresh_reviews.py --git-sync-only
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto done
call :run_py scripts\refresh_reviews.py
set "RC=%ERRORLEVEL%"
:done
echo [%date% %time%] end exit=%RC%
exit /b %RC%

:run_py
if defined PYTHON (
  "%PYTHON%" %*
) else (
  py -3 %*
)
exit /b %ERRORLEVEL%
