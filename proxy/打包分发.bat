@echo off
chcp 65001 >nul
setlocal

rem Build a clean zip that can be handed to someone else.
rem certs\ (machine-specific CA), logs\ and downloaded images are intentionally excluded.

set "SRC=%~dp0"
set "OUT=%~dp0douyin-nowm-proxy.zip"
rem Avoid overriding system variables like TMP/TEMP - powershell fails to start
set "PACKDIR=%TEMP%\dy-nowm-pack-%RANDOM%%RANDOM%"

if exist "%OUT%" del /q "%OUT%"
mkdir "%PACKDIR%" 2>nul

copy /y "%SRC%*.bat" "%PACKDIR%\" >nul
copy /y "%SRC%*.cmd" "%PACKDIR%\" >nul
copy /y "%SRC%*.mjs" "%PACKDIR%\" >nul
copy /y "%SRC%*.md"  "%PACKDIR%\" >nul

if exist "%SRC%node\node.exe" (
  mkdir "%PACKDIR%\node" 2>nul
  copy /y "%SRC%node\node.exe" "%PACKDIR%\node\" >nul
  copy /y "%SRC%node\README.txt" "%PACKDIR%\node\" >nul
  echo [pack] bundled node.exe included
) else (
  echo [pack] no bundled node.exe - the recipient must install Node.js
)

rem Compress-Archive depends on a module that may not be loadable; use .NET ZipFile instead
powershell -NoProfile -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('%PACKDIR%', '%OUT%'); if (Test-Path '%OUT%') { 'zip ok' } else { 'zip FAILED' }"
rmdir /s /q "%PACKDIR%"

echo.
echo Built: %OUT%
echo Excluded: certs\, logs\, downloaded images
echo.
pause
