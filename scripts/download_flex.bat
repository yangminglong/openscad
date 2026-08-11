@echo off
REM ==============================================
REM  Download WinFlexBison for Windows MSVC builds
REM  Downloads to the directory above this script
REM  Extract to your chosen directory (e.g. D:\Dev\winflexbison)
REM ==============================================

set "DOWNLOAD_URL=https://github.com/lexxmark/winflexbison/releases/download/v2.5.25/win_flex_bison-2.5.25.zip"
set "OUTPUT=%~dp0..\win_flex_bison.zip"

echo Downloading WinFlexBison v2.5.25...
powershell -Command "& {[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%DOWNLOAD_URL%' -OutFile '%OUTPUT%' -UseBasicParsing}"
if %ERRORLEVEL% NEQ 0 (
    echo PowerShell failed, trying curl...
    curl -L -o "%OUTPUT%" "%DOWNLOAD_URL%"
)

if exist "%OUTPUT%" (
    echo Download successful: %OUTPUT%
    echo Extract to a directory and set WIN_FLEX_BISON_DIR or add to PATH.
) else (
    echo Download FAILED.
    exit /b 1
)
