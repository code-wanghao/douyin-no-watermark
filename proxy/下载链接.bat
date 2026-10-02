@echo off
chcp 65001 >nul
setlocal

echo.
echo  Paste a Douyin share link below and press Enter.
echo  (In the app: share - copy link, then paste here with right-click)
echo.
set /p "LINK=Link: "

if "%LINK%"=="" (
  echo No link given.
  pause
  exit /b 1
)

call "%~dp0_node.cmd" "%~dp0linkdl.mjs" "%LINK%" %*
set "RC=%ERRORLEVEL%"

echo.
echo ============================================================
echo  exit code %RC%
echo ============================================================
echo.
echo  Press any key to close this window ...
pause >nul
