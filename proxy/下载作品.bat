@echo off
chcp 65001 >nul
setlocal

echo.
echo  This lists the works found in the Douyin client cache and lets you pick
echo  which ones to download -- including works whose download button is greyed out.
echo.

call "%~dp0_node_raw.cmd" "%~dp0works.mjs" %*
set "RC=%ERRORLEVEL%"

echo.
echo ============================================================
echo  exit code %RC%
echo ============================================================
echo.
echo  Press any key to close this window ...
pause >nul
