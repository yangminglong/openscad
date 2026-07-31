#!/usr/bin/env bash
# Package OpenSCAD CLI into a self-contained release directory
# Usage: ./pack-openscad-cli.sh [build_dir] [output_name]
set -euo pipefail

BUILD_DIR="${1:-build-cli}"
VERSION="${2:-$(date +%Y.%m.%d)}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

OUT_DIR="${BUILD_DIR}/openscad-cli-${VERSION}"
BIN_DIR="${OUT_DIR}/bin"
LIB_DIR="${OUT_DIR}/lib/openscad"

echo "=== Packaging OpenSCAD CLI ${VERSION} ==="

# Clean old
rm -rf "$OUT_DIR"
mkdir -p "$BIN_DIR" "$LIB_DIR"

# 1. Copy binary
echo "Copying binary..."
cp "${BUILD_DIR}/openscad" "${LIB_DIR}/"

# 2. Copy shared libraries
echo "Copying shared libraries..."
ldd "${BUILD_DIR}/openscad" 2>/dev/null | grep -oP '=> \K\S+' | while read -r lib; do
  if [ -f "$lib" ]; then
    base=$(basename "$lib")
    # Skip already-copied files
    [ -f "${LIB_DIR}/${base}" ] && continue
    cp -P "$lib" "${LIB_DIR}/"
  fi
done

# Also copy the linker (ld-linux) for maximum compatibility
# Not usually needed but helps on older systems

# 3. Copy resource directories
echo "Copying resources..."
for dir in color-schemes examples fonts libraries locale shaders; do
  src="${PROJECT_DIR}/${dir}"
  if [ -d "$src" ]; then
    cp -a "$src" "${OUT_DIR}/"
  fi
done

# Copy .mo files from build dir
if [ -d "${BUILD_DIR}/locale" ]; then
  mkdir -p "${OUT_DIR}/locale"
  cp -a "${BUILD_DIR}/locale"/* "${OUT_DIR}/locale/"
fi

# 4. Create launcher script
echo "Creating launcher..."
cat > "${BIN_DIR}/openscad" << 'LAUNCHER'
#!/bin/bash
# OpenSCAD CLI wrapper
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$DIR/.."
LIBDIR="$ROOT/lib/openscad"
export LD_LIBRARY_PATH="$LIBDIR${LD_LIBRARY_PATH:+:}$LD_LIBRARY_PATH"
export OPENSCADPATH="$ROOT"
exec "$LIBDIR/openscad" "$@"
LAUNCHER
chmod +x "${BIN_DIR}/openscad"

# 5. Create tar.gz
echo "Creating archive..."
cd "${BUILD_DIR}"
tar czf "openscad-cli-${VERSION}-linux-x86_64.tar.gz" "openscad-cli-${VERSION}"
cd - > /dev/null

# 6. Verify
echo "=== Verification ==="
"${BIN_DIR}/openscad" --version 2>&1 || true
echo
echo "Package: ${BUILD_DIR}/openscad-cli-${VERSION}-linux-x86_64.tar.gz"
echo "Directory: ${OUT_DIR}"
du -sh "${OUT_DIR}"
echo "Done."
