@echo off
chcp 65001 >nul
setlocal
set "LOGDIR=%~dp0logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
start "" "%LOGDIR%"
