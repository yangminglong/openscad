@echo off
setlocal EnableExtensions DisableDelayedExpansion

rem Non-manifest mode installation (uncomment if manifest mode is disabled).
rem vcpkg install boost eigen3 cgal harfbuzz fontconfig double-conversion opencsg libxml2 libzip glib gperf tbb cairo

for %%I in ("%~dp0..") do set "REPO_ROOT=%%~fI"
set "SOURCE_DIR=%REPO_ROOT%"
set "BUILD_DIR=%REPO_ROOT%\build"

where cmake >nul 2>&1
if errorlevel 1 (
  echo ERROR: CMake was not found on PATH.
  goto :failure
)

if not defined VCPKG_ROOT (
  echo ERROR: VCPKG_ROOT must point to a vcpkg installation.
  goto :failure
)

for %%I in ("%VCPKG_ROOT%") do set "VCPKG_ROOT=%%~fI"
set "VCPKG_TOOLCHAIN=%VCPKG_ROOT%\scripts\buildsystems\vcpkg.cmake"
if not exist "%VCPKG_TOOLCHAIN%" (
  echo ERROR: vcpkg toolchain file was not found: "%VCPKG_TOOLCHAIN%"
  goto :failure
)

if defined WIN_FLEX_BISON_DIR (
  for %%I in ("%WIN_FLEX_BISON_DIR%") do set "WIN_FLEX_BISON_DIR=%%~fI"
  if not exist "%WIN_FLEX_BISON_DIR%\win_flex.exe" (
    echo ERROR: win_flex.exe was not found in "%WIN_FLEX_BISON_DIR%".
    goto :failure
  )
  if not exist "%WIN_FLEX_BISON_DIR%\win_bison.exe" (
    echo ERROR: win_bison.exe was not found in "%WIN_FLEX_BISON_DIR%".
    goto :failure
  )
  set "PATH=%WIN_FLEX_BISON_DIR%;%PATH%"
) else (
  where win_flex.exe >nul 2>&1
  if errorlevel 1 (
    echo ERROR: win_flex.exe was not found on PATH. Set WIN_FLEX_BISON_DIR or update PATH.
    goto :failure
  )
  where win_bison.exe >nul 2>&1
  if errorlevel 1 (
    echo ERROR: win_bison.exe was not found on PATH. Set WIN_FLEX_BISON_DIR or update PATH.
    goto :failure
  )
)

echo === Configuring OpenSCAD (headless, MSVC x64) ===
cmake -S "%SOURCE_DIR%" -B "%BUILD_DIR%" -G "Visual Studio 17 2022" -A x64 ^
  "-DCMAKE_TOOLCHAIN_FILE=%VCPKG_TOOLCHAIN%" ^
  -DHEADLESS=ON ^
  -DUSE_BUILTIN_OPENCSG=TRUE ^
  -DCMAKE_REQUIRE_FIND_PACKAGE_Lib3MF=OFF ^
  "-DTBB_DIR=%VCPKG_ROOT%\installed\x64-windows\share\tbb" ^
  "-DCMAKE_EXE_LINKER_FLAGS=/manifest:no /LIBPATH:%BUILD_DIR%\vcpkg_installed\x64-windows\lib /LIBPATH:%BUILD_DIR%\vcpkg_installed\x64-windows\debug\lib" ^
  "-DCMAKE_MODULE_LINKER_FLAGS=/manifest:no" ^
  "-DCMAKE_SHARED_LINKER_FLAGS=/manifest:no"
if errorlevel 1 (
  echo ERROR: CMake configuration failed.
  goto :failure
)

echo === Building Debug ===
cmake --build "%BUILD_DIR%" --config Debug
if errorlevel 1 (
  echo ERROR: Debug build failed.
  goto :failure
)

echo === Building Release ===
cmake --build "%BUILD_DIR%" --config Release
if errorlevel 1 (
  echo ERROR: Release build failed.
  goto :failure
)

if not exist "%BUILD_DIR%\Debug\openscad.exe" (
  echo ERROR: Debug executable was not produced: "%BUILD_DIR%\Debug\openscad.exe"
  goto :failure
)
if not exist "%BUILD_DIR%\Release\openscad.exe" (
  echo ERROR: Release executable was not produced: "%BUILD_DIR%\Release\openscad.exe"
  goto :failure
)

echo ==============================================
echo BUILD SUCCESS
echo Debug:   "%BUILD_DIR%\Debug\openscad.exe"
echo Release: "%BUILD_DIR%\Release\openscad.exe"
echo ==============================================
endlocal & exit /b 0

:failure
endlocal & exit /b 1
