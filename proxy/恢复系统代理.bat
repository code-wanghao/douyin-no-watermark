@echo off
chcp 65001 >nul
setlocal
call "%~dp0_node.cmd" --restore-proxy
pause
