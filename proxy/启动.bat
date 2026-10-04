@echo off
chcp 65001 >nul
setlocal

call "%~dp0_node.cmd"
set "RC=%ERRORLEVEL%"

echo.
echo ============================================================
echo  proxy exited with code %RC%
echo  Logs: %~dp0logs\
echo ============================================================
echo.
echo  WARNING: the proxy has ALREADY stopped at this point.
echo  Pressing a key here just closes this window.
echo  If it exited earlier than you expected, read the lines above.
echo.
echo  Press any key to close this window ...
pause >nul
