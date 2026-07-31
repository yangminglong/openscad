#!/usr/bin/env bash
#
# CLI integration tests for export_3mf_v4 (OrcaSlicer-compatible 3MF)
#
# Usage:
#   ./tests/myTests/export_3mf_v4_cli_test.sh [path/to/openscad]
#
# Requires: python3, zipfile module
#
set -euo pipefail

OPENSCAD="${1:-./build-cli/openscad}"
TMPDIR=$(mktemp -d)
PASS=0
FAIL=0

cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }

pass() { green "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { red    "  FAIL: $1"; FAIL=$((FAIL + 1)); }

check_zip_entry() {
  local file="$1" entry="$2" desc="$3"
  if python3 -c "import zipfile; z=zipfile.ZipFile('$file'); z.getinfo('$entry')" 2>/dev/null; then
    pass "$desc"
  else
    fail "$desc (missing $entry)"
  fi
}

check_json_field() {
  local file="$1" entry="$2" field="$3" expected="$4" desc="$5"
  local actual
  actual=$(python3 -c "
import zipfile, json
z=zipfile.ZipFile('$file')
cfg=json.loads(z.read('$entry'))
print(cfg.get('$field',''))
" 2>/dev/null)
  if [ "$actual" = "$expected" ]; then
    pass "$desc"
  else
    fail "$desc (expected '$expected', got '$actual')"
  fi
}

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------

if [ ! -x "$OPENSCAD" ]; then
  echo "OpenSCAD binary not found: $OPENSCAD"
  echo "Usage: $0 /path/to/openscad"
  exit 1
fi

echo "Testing: $OPENSCAD"
echo

# ---------------------------------------------------------------------------
# Test 1: Basic 3MF v4 export (auto-detect)
# ---------------------------------------------------------------------------
echo "=== Test 1: Basic 3MF v4 export (auto-detect colors) ==="

echo 'cube(10);' > "$TMPDIR/basic.scad"
"$OPENSCAD" "$TMPDIR/basic.scad" -o "$TMPDIR/basic.3mf" --export-format 3mf_v4 2>/dev/null

check_zip_entry "$TMPDIR/basic.3mf" "[Content_Types].xml"     "[Content_Types].xml exists"
check_zip_entry "$TMPDIR/basic.3mf" "_rels/.rels"              "_rels/.rels exists"
check_zip_entry "$TMPDIR/basic.3mf" "3D/3dmodel.model"        "3D/3dmodel.model exists"
check_zip_entry "$TMPDIR/basic.3mf" "3D/_rels/3dmodel.model.rels" "3D model rels exists"
check_zip_entry "$TMPDIR/basic.3mf" "Metadata/project_settings.config" "project_settings.config exists"
check_zip_entry "$TMPDIR/basic.3mf" "Metadata/slice_info.config" "slice_info.config exists"
check_json_field "$TMPDIR/basic.3mf" "Metadata/project_settings.config" \
  "filament_settings_id" "['Anycubic PLA @Anycubic Kobra X 0.4 nozzle']" \
  "auto-detect defaults to PLA filament"

# ---------------------------------------------------------------------------
# Test 2: Multi-color auto-detect
# ---------------------------------------------------------------------------
echo "=== Test 2: Multi-color auto-detect ==="

echo 'color("red") cube(10); color("blue") translate([15,0,0]) sphere(r=5);' > "$TMPDIR/multi.scad"
"$OPENSCAD" "$TMPDIR/multi.scad" -o "$TMPDIR/multi.3mf" --export-format 3mf_v4 2>/dev/null

ACTUAL_COUNT=$(python3 -c "
import zipfile, json
z=zipfile.ZipFile('$TMPDIR/multi.3mf')
cfg=json.loads(z.read('Metadata/project_settings.config'))
print(len(cfg['filament_settings_id']))
")
if [ "$ACTUAL_COUNT" = "2" ]; then
  pass "multi-color auto-detect: 2 extruders"
else
  fail "multi-color auto-detect: expected 2 extruders, got $ACTUAL_COUNT"
fi

# ---------------------------------------------------------------------------
# Test 3: Custom filament colors via -O
# ---------------------------------------------------------------------------
echo "=== Test 3: Custom filament colors via -O ==="

echo 'cube(10);' > "$TMPDIR/custom.scad"
"$OPENSCAD" "$TMPDIR/custom.scad" -o "$TMPDIR/custom.3mf" --export-format 3mf_v4 \
  -O 'export-3mf/filament-colors=PLA Silk|gradient:#FF0000FF,#00FF00FF;angle:90\nPETG|#0066FFFF' \
  2>/dev/null

check_json_field "$TMPDIR/custom.3mf" "Metadata/project_settings.config" \
  "filament_colour" "['#FF0000FF', '#0066FFFF']" \
  "custom filament colors parsed correctly"

# ---------------------------------------------------------------------------
# Test 4: Standard 3MF still works
# ---------------------------------------------------------------------------
echo "=== Test 4: Standard 3MF export unchanged ==="

echo 'cube(10);' > "$TMPDIR/std.scad"
"$OPENSCAD" "$TMPDIR/std.scad" -o "$TMPDIR/std.3mf" --export-format 3mf 2>/dev/null

check_zip_entry "$TMPDIR/std.3mf" "[Content_Types].xml" "standard 3MF: Content_Types.xml"
check_zip_entry "$TMPDIR/std.3mf" "3D/3dmodel.model"    "standard 3MF: 3dmodel.model"
# Standard 3MF should NOT have Metadata/
if python3 -c "import zipfile; z=zipfile.ZipFile('$TMPDIR/std.3mf'); z.getinfo('Metadata/project_settings.config')" 2>/dev/null; then
  fail "standard 3MF should not contain Metadata/project_settings.config"
else
  pass "standard 3MF has no v4 Metadata"
fi

# ---------------------------------------------------------------------------
# Test 5: BINMESH format
# ---------------------------------------------------------------------------
echo "=== Test 5: BINMESH format export ==="

echo 'cube(10);' > "$TMPDIR/bm.scad"
"$OPENSCAD" "$TMPDIR/bm.scad" -o "$TMPDIR/bm.binmesh" --export-format binmesh 2>/dev/null

if [ -f "$TMPDIR/bm.binmesh" ]; then
  SIZE=$(stat -c%s "$TMPDIR/bm.binmesh" 2>/dev/null || echo 0)
  if [ "$SIZE" -gt 0 ]; then
    pass "binmesh export produces non-empty file ($SIZE bytes)"
  else
    fail "binmesh export file is empty"
  fi
else
  fail "binmesh export file not created"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo
echo "=========================================="
printf "Results: "
green "$PASS passed"
if [ "$FAIL" -gt 0 ]; then
  red "$FAIL failed"
  exit 1
else
  echo "All tests passed!"
  exit 0
fi
