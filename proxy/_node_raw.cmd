@echo off
rem Helper for sibling .bat files: locate node.exe, then run it with the arguments as-is.
rem Unlike _node.cmd (which always runs proxy.mjs), this one lets the caller pick the script.
rem Keep this file pure ASCII -- cmd.exe parses it with the OEM codepage.
setlocal

set "LOGDIR=%~dp0logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "LAUNCHLOG=%LOGDIR%\launcher.log"

>>"%LAUNCHLOG%" echo [%DATE% %TIME%] raw launcher start args="%*"

set "NODEEXE="
if exist "%~dp0node\node.exe" set "NODEEXE=%~dp0node\node.exe"
if not defined NODEEXE if exist "%~dp0node.exe" set "NODEEXE=%~dp0node.exe"
if not defined NODEEXE (
  for %%I in (node.exe) do set "NODEEXE=%%~$PATH:I"
)
if not defined NODEEXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODEEXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODEEXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODEEXE (
  >>"%LAUNCHLOG%" echo [%DATE% %TIME%] node NOT FOUND
  echo.
  echo Node.js not found. See _node_raw.cmd
  echo.
  exit /b 1
)

"%NODEEXE%" %*
set "RC=%ERRORLEVEL%"
>>"%LAUNCHLOG%" echo [%DATE% %TIME%] raw launcher exit rc=%RC%
exit /b %RC%
