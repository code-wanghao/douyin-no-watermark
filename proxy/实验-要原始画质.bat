@echo off
chcp 65001 >nul
setlocal

rem Experimental: ask the comment API for a non-WebP original image.
rem The request URL carries an a_bogus signature, so this may simply be rejected.
call "%~dp0_node.cmd" --img-format jpeg
set "RC=%ERRORLEVEL%"

echo.
echo ============================================================
echo  exit code %RC%
echo  Logs: %~dp0logs\
echo ============================================================
echo.
echo  Press any key to close this window ...
pause >nul
