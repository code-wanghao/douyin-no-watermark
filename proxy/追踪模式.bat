@echo off
chcp 65001 >nul
setlocal

rem Same as the normal launcher, but with --trace: logs every image request the client makes.
call "%~dp0_node.cmd" --trace
set "RC=%ERRORLEVEL%"

echo.
echo ============================================================
echo  proxy exited with code %RC%
echo  Logs: %~dp0logs\
echo ============================================================
echo.
echo  Press any key to close this window ...
pause >nul
