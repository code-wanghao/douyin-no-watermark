@echo off
chcp 65001 >nul
setlocal

rem Pick which features to enable, save to features.json, then exit.
call "%~dp0_node.cmd" --choose-only
set "RC=%ERRORLEVEL%"

echo.
echo ============================================================
echo  exit code %RC%
echo ============================================================
echo.
echo  Press any key to close this window ...
pause >nul
