@echo off
setlocal EnableExtensions DisableDelayedExpansion

rem Downloads WinFlexBison for the Windows MSVC build workflow.
rem Extract the resulting archive and set WIN_FLEX_BISON_DIR to that directory.

for %%I in ("%~dp0..") do set "REPO_ROOT=%%~fI"
set "DOWNLOAD_URL=https://github.com/lexxmark/winflexbison/releases/download/v2.5.25/win_flex_bison-2.5.25.zip"
set "OUTPUT=%REPO_ROOT%\win_flex_bison.zip"
set "TEMP_OUTPUT=%OUTPUT%.download"

if exist "%TEMP_OUTPUT%" del /q "%TEMP_OUTPUT%" >nul 2>&1
if exist "%TEMP_OUTPUT%" (
  echo ERROR: Could not remove stale temporary download "%TEMP_OUTPUT%".
  goto :failure
)

echo Downloading WinFlexBison v2.5.25...
where curl.exe >nul 2>&1
if not errorlevel 1 (
  curl.exe --fail --location --retry 3 --retry-delay 2 --output "%TEMP_OUTPUT%" "%DOWNLOAD_URL%"
  if not errorlevel 1 goto :validate
  echo curl failed; trying PowerShell...
  if exist "%TEMP_OUTPUT%" del /q "%TEMP_OUTPUT%" >nul 2>&1
) else (
  echo curl was not found; trying PowerShell...
)

where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo ERROR: Neither curl nor PowerShell is available.
  goto :failure
)

powershell.exe -NoProfile -Command "$ProgressPreference = 'SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%DOWNLOAD_URL%' -OutFile '%TEMP_OUTPUT%' -UseBasicParsing"
if errorlevel 1 (
  echo ERROR: PowerShell download failed.
  goto :failure
)

:validate
if not exist "%TEMP_OUTPUT%" (
  echo ERROR: Download did not create "%TEMP_OUTPUT%".
  goto :failure
)
for %%I in ("%TEMP_OUTPUT%") do set "DOWNLOAD_SIZE=%%~zI"
if "%DOWNLOAD_SIZE%"=="0" (
  echo ERROR: Download produced an empty file.
  goto :failure
)

move /y "%TEMP_OUTPUT%" "%OUTPUT%" >nul
if errorlevel 1 (
  echo ERROR: Could not move the downloaded archive to "%OUTPUT%".
  goto :failure
)

echo Download successful: "%OUTPUT%"
echo Extract the archive, then set WIN_FLEX_BISON_DIR to the extracted directory.
endlocal & exit /b 0

:failure
if exist "%TEMP_OUTPUT%" del /q "%TEMP_OUTPUT%" >nul 2>&1
endlocal & exit /b 1
