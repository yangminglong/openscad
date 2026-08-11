@echo off
REM ==============================================
REM  OpenSCAD Windows MSVC Build Script
REM  Requires: Visual Studio 2022, vcpkg, WinFlexBison
REM
REM  Configurable via environment variables:
REM    VCPKG_ROOT        - path to vcpkg (default: D:\Dev\vcpkg)
REM    WIN_FLEX_BISON_DIR - path to win_flex_bison (default: D:\Dev\winflexbison)
REM ==============================================

REM --- Configurable paths ---
if not defined VCPKG_ROOT        set "VCPKG_ROOT=D:\Dev\vcpkg"
if not defined WIN_FLEX_BISON_DIR set "WIN_FLEX_BISON_DIR=D:\Dev\winflexbison"

set "PATH=%WIN_FLEX_BISON_DIR%;%PATH%"

REM Convert backslashes to forward slashes for CMake
set "PROJECT_DIR=%CD:\=/%"

REM --- CMake Configure ---
echo === Configuring OpenSCAD (Release, Headless) ===
cmake -B build -S . -G "Visual Studio 17 2022" -A x64 ^
  -DCMAKE_TOOLCHAIN_FILE="%VCPKG_ROOT%/scripts/buildsystems/vcpkg.cmake" ^
  -DHEADLESS=ON ^
  -DUSE_BUILTIN_OPENCSG=TRUE ^
  -DCMAKE_REQUIRE_FIND_PACKAGE_Lib3MF=OFF ^
  -DTBB_DIR="%VCPKG_ROOT%/installed/x64-windows/share/tbb" ^
  -DCMAKE_EXE_LINKER_FLAGS="/manifest:no /LIBPATH:%PROJECT_DIR%/build/vcpkg_installed/x64-windows/lib /LIBPATH:%PROJECT_DIR%/build/vcpkg_installed/x64-windows/debug/lib" ^
  -DCMAKE_MODULE_LINKER_FLAGS="/manifest:no" ^
  -DCMAKE_SHARED_LINKER_FLAGS="/manifest:no"

if %ERRORLEVEL% NEQ 0 (
    echo === CMake Configure FAILED ===
    exit /b 1
)

REM --- Build ---
echo === Building Release ===
cmake --build build --config Release
if %ERRORLEVEL% NEQ 0 (
    echo === Build FAILED ===
    exit /b 1
)

echo ==============================================
echo  BUILD SUCCESS
echo ==============================================
dir build\Release\openscad.exe
