@echo off
rem Helper for the sibling .bat files: locate node.exe, then forward args to proxy.mjs.
rem Keep this file pure ASCII -- cmd.exe parses it with the OEM codepage.
setlocal

set "LOGDIR=%~dp0logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "LAUNCHLOG=%LOGDIR%\launcher.log"

>>"%LAUNCHLOG%" echo [%DATE% %TIME%] launcher start args="%*"

set "NODEEXE="
rem 1) portable node shipped next to this script (makes the folder self-contained)
if exist "%~dp0node\node.exe" set "NODEEXE=%~dp0node\node.exe"
if not defined NODEEXE if exist "%~dp0node.exe" set "NODEEXE=%~dp0node.exe"

rem 2) node on PATH
if not defined NODEEXE (
  for %%I in (node.exe) do set "NODEEXE=%%~$PATH:I"
)

rem 3) common install locations
if not defined NODEEXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODEEXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODEEXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODEEXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODEEXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODEEXE (
  >>"%LAUNCHLOG%" echo [%DATE% %TIME%] node NOT FOUND
  echo.
  echo Node.js not found.
  echo   Option A: put node.exe into the "node" subfolder next to this script
  echo   Option B: install Node.js from https://nodejs.org
  echo.
  exit /b 1
)

>>"%LAUNCHLOG%" echo [%DATE% %TIME%] node="%NODEEXE%"

"%NODEEXE%" "%~dp0proxy.mjs" %*
set "RC=%ERRORLEVEL%"

>>"%LAUNCHLOG%" echo [%DATE% %TIME%] node exited rc=%RC%
exit /b %RC%
