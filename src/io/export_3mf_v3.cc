/*
  Export 3MF v3 — PrusaSlicer-compatible 3MF with MMU segmentation

  This file implements export_3mf_v3(), a standalone 3MF exporter that:
  - Reads the binary mesh format directly (does NOT use lib3mf)
  - Writes PrusaSlicer-compatible 3MF with slic3rpe:mmu_segmentation
  - Generates Metadata/Slic3r_PE.config for extruder colour palette
  - Uses libzip for zip archive creation

  Binary mesh format (little-endian):
    Header (16 bytes): numVertices(u32) numFaces(u32) numColors(u32) numIndices(u32)
    Positions:  float32[numVertices * 3]
    Indices:    uint32[numIndices]
    ColorIndices: int32[numFaces]     — per-face index into ColorPalette (-1 = default → 0)
    ColorPalette: float32[numColors * 4] — RGBA, 0..1 range
*/

#ifdef ENABLE_LIBZIP

#include "io/export.h"
#include "geometry/linalg.h"

#include <zip.h>

#ifndef __EMSCRIPTEN__
#include <QDir>
#include <QFile>
#include <QTemporaryFile>
#include <QUuid>
#else
#include <cstdio>
#include <cstdlib>
#include <ctime>
#endif

#include <algorithm>
#include <array>
#include <cstring>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

// --- PAINT_COLOR_MAP -------------------------------------------------------
// Reverse-engineered from PrusaSlicer / BambuStudio's output.
// Indexed by 0-based extruder number: extruder 0 → '', extruder 1 → '8', ...
static const char* PAINT_COLOR_MAP[] = {
  "", "8", "0C", "1C", "2C", "3C", "4C", "5C",
  "6C", "7C", "8C", "9C", "AC", "BC", "CC", "DC"
};

static std::string getPaintColor(int extruderId) {
  // extruderId is 1-based. Map to 0-based PAINT_COLOR_MAP index.
  int idx = extruderId - 1;
  if (idx < 0 || idx >= static_cast<int>(sizeof(PAINT_COLOR_MAP) / sizeof(PAINT_COLOR_MAP[0]))) {
    return "";
  }
  return PAINT_COLOR_MAP[idx];
}

// --- Binary mesh parsing ---------------------------------------------------

struct BinaryMesh {
  uint32_t numVertices = 0;
  uint32_t numFaces = 0;
  uint32_t numColors = 0;
  uint32_t numIndices = 0;
  const float *positions = nullptr;       // [numVertices * 3]
  const uint32_t *indices = nullptr;      // [numIndices]
  const int32_t *colorIndices = nullptr;  // [numFaces]
  const float *colorPalette = nullptr;    // [numColors * 4]
};

static uint32_t readU32LE(const uint8_t *p) {
  return static_cast<uint32_t>(p[0])
       | (static_cast<uint32_t>(p[1]) << 8)
       | (static_cast<uint32_t>(p[2]) << 16)
       | (static_cast<uint32_t>(p[3]) << 24);
}

static bool parseBinaryMesh(const std::vector<uint8_t>& buf, BinaryMesh& mesh) {
  if (buf.size() < 16) return false;

  const uint8_t *data = buf.data();
  mesh.numVertices = readU32LE(data + 0);
  mesh.numFaces    = readU32LE(data + 4);
  mesh.numColors   = readU32LE(data + 8);
  mesh.numIndices  = readU32LE(data + 12);

  const size_t posOffset  = 16;
  const size_t idxOffset  = posOffset + mesh.numVertices * 3 * sizeof(float);
  const size_t colIdxOff  = idxOffset + mesh.numIndices * sizeof(uint32_t);
  const size_t colPalOff  = colIdxOff + mesh.numFaces * sizeof(int32_t);
  const size_t totalSize  = colPalOff + mesh.numColors * 4 * sizeof(float);

  if (buf.size() < totalSize) return false;

  mesh.positions     = reinterpret_cast<const float *>(data + posOffset);
  mesh.indices       = reinterpret_cast<const uint32_t *>(data + idxOffset);
  mesh.colorIndices  = reinterpret_cast<const int32_t *>(data + colIdxOff);
  mesh.colorPalette  = reinterpret_cast<const float *>(data + colPalOff);

  return true;
}

// --- Color helpers ---------------------------------------------------------

static std::string floatColorToHex(float r, float g, float b) {
  auto toHex = [](float v) {
    int iv = std::clamp(static_cast<int>(v * 255.0f), 0, 255);
    char buf[3];
    snprintf(buf, sizeof(buf), "%02X", iv);
    return std::string(buf);
  };
  return "#" + toHex(r) + toHex(g) + toHex(b);
}

static std::string floatColorToHexRGBA(float r, float g, float b, float a) {
  auto toHex = [](float v) {
    int iv = std::clamp(static_cast<int>(v * 255.0f), 0, 255);
    char buf[3];
    snprintf(buf, sizeof(buf), "%02X", iv);
    return std::string(buf);
  };
  return "#" + toHex(r) + toHex(g) + toHex(b) + toHex(a);
}

// --- XML builders ----------------------------------------------------------

static std::string buildModelXML(const BinaryMesh& mesh,
                                 const std::vector<int>& extruderColorsId,
                                 const std::string& objectUuid,
                                 const std::string& buildUuid) {
  std::ostringstream xml;

  xml << "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n";
  xml << "<model unit=\"millimeter\" xml:lang=\"en-US\""
         " xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\""
         " xmlns:p=\"http://schemas.microsoft.com/3dmanufacturing/production/2015/06\">\n";

  // Meta tags
  xml << "  <meta name=\"slic3rpe:Version3mf\" value=\"1\"/>\n";
  xml << "  <meta name=\"slic3rpe:MmPaintingVersion\" value=\"1\"/>\n";
  xml << "  <metadata name=\"Application\">PrusaSlicer</metadata>\n";

  // Resources
  xml << "  <resources>\n";

  // Base materials
  xml << "    <basematerials id=\"2\">\n";
  for (uint32_t ci = 0; ci < mesh.numColors; ++ci) {
    float r = mesh.colorPalette[ci * 4 + 0];
    float g = mesh.colorPalette[ci * 4 + 1];
    float b = mesh.colorPalette[ci * 4 + 2];
    xml << "      <base name=\"color_" << ci
        << "\" displaycolor=\"" << floatColorToHex(r, g, b) << "\"/>\n";
  }
  xml << "    </basematerials>\n";

  // Build paintColorByColorIndex: maps palette index → segmentation hex string
  std::vector<std::string> paintColorByColorIndex;
  if (!extruderColorsId.empty()) {
    for (size_t i = 0; i < static_cast<size_t>(mesh.numColors); ++i) {
      int extruderId = (i < extruderColorsId.size()) ? extruderColorsId[i] : 0;
      paintColorByColorIndex.push_back(getPaintColor(extruderId));
    }
  }

  // Object
  xml << "    <object id=\"1\" name=\"OpenSCAD Model\" type=\"model\""
         " p:UUID=\"" << objectUuid << "\" pid=\"2\" pindex=\"0\">\n";
  xml << "      <mesh>\n";

  // Vertices
  xml << "        <vertices>\n";
  for (uint32_t vi = 0; vi < mesh.numVertices; ++vi) {
    float x = mesh.positions[vi * 3 + 0];
    float y = mesh.positions[vi * 3 + 1];
    float z = mesh.positions[vi * 3 + 2];
    xml << "          <vertex x=\"" << x << "\" y=\"" << y << "\" z=\"" << z << "\"/>\n";
  }
  xml << "        </vertices>\n";

  // Triangles
  xml << "        <triangles>\n";
  for (uint32_t fi = 0; fi < mesh.numFaces; ++fi) {
    uint32_t v0 = mesh.indices[fi * 3 + 0];
    uint32_t v1 = mesh.indices[fi * 3 + 1];
    uint32_t v2 = mesh.indices[fi * 3 + 2];
    int32_t colorIdx = mesh.colorIndices[fi];

    xml << "          <triangle v1=\"" << v0 << "\" v2=\"" << v1 << "\" v3=\"" << v2 << "\"";

    // Base material reference (only for explicit colors, colorIndex > 0)
    if (colorIdx > 0) {
      xml << " pid=\"2\" p1=\"" << colorIdx << "\"";
    }

    // MMU segmentation
    if (!paintColorByColorIndex.empty() && colorIdx >= 0 &&
        static_cast<uint32_t>(colorIdx) < paintColorByColorIndex.size()) {
      const auto& pc = paintColorByColorIndex[colorIdx];
      if (!pc.empty()) {
        xml << " slic3rpe:mmu_segmentation=\"" << pc << "\"";
      }
    }

    xml << "/>\n";
  }
  xml << "        </triangles>\n";
  xml << "      </mesh>\n";
  xml << "    </object>\n";
  xml << "  </resources>\n";

  // Build
  xml << "  <build p:UUID=\"" << buildUuid << "\">\n";
  xml << "    <item objectid=\"1\" p:UUID=\"" << objectUuid << "\"/>\n";
  xml << "  </build>\n";
  xml << "</model>\n";

  return xml.str();
}

static std::string buildContentTypesXML() {
  return "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n"
         "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\n"
         "  <Default Extension=\"model\""
         " ContentType=\"application/vnd.ms-package.3dmanufacturing-3dmodel+xml\"/>\n"
         "</Types>\n";
}

static std::string buildRelsXML() {
  return "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n"
         "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\n"
         "  <Relationship"
         " Type=\"http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel\""
         " Target=\"/3D/3dmodel.model\" Id=\"rel0\"/>\n"
         "</Relationships>\n";
}

static std::string buildSlic3rPEConfig(const std::vector<int>& extruderColorsId,
                                       const float *colorPalette,
                                       uint32_t numColors) {
  // Collect unique extruder IDs with their colors
  std::map<int, std::string> idToColor;
  for (uint32_t i = 0; i < numColors; ++i) {
    int extruderId = (i < extruderColorsId.size()) ? extruderColorsId[i] : 0;
    if (extruderId == 0) continue; // skip unassigned
    if (idToColor.find(extruderId) != idToColor.end()) continue; // already collected
    float r = colorPalette[i * 4 + 0];
    float g = colorPalette[i * 4 + 1];
    float b = colorPalette[i * 4 + 2];
    float a = colorPalette[i * 4 + 3];
    idToColor[extruderId] = floatColorToHexRGBA(r, g, b, a);
  }

  if (idToColor.empty()) return "";

  std::ostringstream cfg;
  cfg << "; generated by AnycubicSlicer\n";
  cfg << "; extruder_colour = ";
  bool first = true;
  for (const auto& [id, hex] : idToColor) {
    if (!first) cfg << ";";
    cfg << hex;
    first = false;
  }
  cfg << "\n";
  return cfg.str();
}

// --- libzip helpers --------------------------------------------------------

static bool addStringToZip(zip_t *z, const std::string& name, const std::string& content) {
  zip_source_t *src = zip_source_buffer(z, content.data(), content.size(), 0);
  if (!src) return false;
  zip_int64_t idx = zip_file_add(z, name.c_str(), src, ZIP_FL_ENC_UTF_8);
  if (idx < 0) {
    zip_source_free(src);
    return false;
  }
  return true;
}

// --- UUID generator (no-Qt fallback) ---------------------------------------

#ifdef __EMSCRIPTEN__
#include <random>
static std::string generateUUID() {
  static std::mt19937 rng(static_cast<unsigned>(std::time(nullptr)));
  static std::uniform_int_distribution<int> dist(0, 15);
  const char *hex = "0123456789abcdef";
  // Format: 8-4-4-4-12 (standard UUID format, without braces)
  const int groups[] = {8, 4, 4, 4, 12};
  std::string uuid;
  for (size_t g = 0; g < sizeof(groups) / sizeof(groups[0]); ++g) {
    if (g > 0) uuid += '-';
    for (int i = 0; i < groups[g]; ++i) {
      uuid += hex[dist(rng)];
    }
  }
  return uuid;
}
#endif

// --- Public API ------------------------------------------------------------

void export_3mf_v3(const std::vector<uint8_t>& binaryMeshBuffer,
                   const std::vector<int>& extruderColorsId,
                   std::ostream& output)
{
  // 1. Parse binary mesh
  BinaryMesh mesh;
  if (!parseBinaryMesh(binaryMeshBuffer, mesh)) {
    LOG(message_group::Export_Error, "Failed to parse binary mesh buffer for 3MF v3 export");
    return;
  }

  // 2. Generate UUIDs
#ifdef __EMSCRIPTEN__
  std::string objectUuid = generateUUID();
  std::string buildUuid  = generateUUID();
#else
  std::string objectUuid = QUuid::createUuid().toString(QUuid::WithoutBraces).toStdString();
  std::string buildUuid  = QUuid::createUuid().toString(QUuid::WithoutBraces).toStdString();
#endif

  // 3. Build XML strings
  std::string modelXml     = buildModelXML(mesh, extruderColorsId, objectUuid, buildUuid);
  std::string contentTypes = buildContentTypesXML();
  std::string rels         = buildRelsXML();
  std::string slic3rConfig = buildSlic3rPEConfig(extruderColorsId, mesh.colorPalette, mesh.numColors);

  // 4. Create zip via libzip
#ifdef __EMSCRIPTEN__
  // Emscripten: use MEMFS temporary file
  std::string tmpPath = "/tmp/openscad_3mf_" + objectUuid.substr(0, 8) + ".3mf";
#else
  // Desktop: use QTemporaryFile
  QTemporaryFile tmpFile;
  tmpFile.setFileTemplate(QDir::tempPath() + "/openscad_3mf_XXXXXX.3mf");
  if (!tmpFile.open()) {
    LOG(message_group::Export_Error, "Failed to create temporary file for 3MF v3 export");
    return;
  }
  QString tmpPath = tmpFile.fileName();
  tmpFile.close(); // libzip will open it
#endif

  int zipError = 0;
#ifdef __EMSCRIPTEN__
  zip_t *z = zip_open(tmpPath.c_str(), ZIP_CREATE | ZIP_TRUNCATE, &zipError);
#else
  zip_t *z = zip_open(tmpPath.toUtf8().constData(),
                      ZIP_CREATE | ZIP_TRUNCATE, &zipError);
#endif
  if (!z) {
    LOG(message_group::Export_Error, "Failed to create zip archive for 3MF v3 export");
    return;
  }

  bool ok = true;
  ok = ok && addStringToZip(z, "3D/3dmodel.model", modelXml);
  ok = ok && addStringToZip(z, "[Content_Types].xml", contentTypes);
  ok = ok && addStringToZip(z, "_rels/.rels", rels);
  if (!slic3rConfig.empty()) {
    ok = ok && addStringToZip(z, "Metadata/Slic3r_PE.config", slic3rConfig);
  }

  if (zip_close(z) < 0 || !ok) {
    LOG(message_group::Export_Error, "Failed to write zip archive for 3MF v3 export");
    return;
  }

  // 5. Read back and write to ostream
#ifdef __EMSCRIPTEN__
  // Standard C FILE I/O on Emscripten MEMFS
  FILE *fp = fopen(tmpPath.c_str(), "rb");
  if (!fp) {
    LOG(message_group::Export_Error, "Failed to read back 3MF file from MEMFS");
    return;
  }
  fseek(fp, 0, SEEK_END);
  long sz = ftell(fp);
  fseek(fp, 0, SEEK_SET);
  std::vector<char> buf(sz);
  fread(buf.data(), 1, sz, fp);
  fclose(fp);
  output.write(buf.data(), sz);
  // Clean up MEMFS temp file
  std::remove(tmpPath.c_str());
#else
  QFile f(tmpPath);
  if (!f.open(QIODevice::ReadOnly)) {
    LOG(message_group::Export_Error, "Failed to read temporary 3MF file");
    return;
  }
  QByteArray data = f.readAll();
  f.close();
  output.write(data.constData(), data.size());
#endif
}

#else  // !ENABLE_LIBZIP

void export_3mf_v3(const std::vector<uint8_t>&,
                   const std::vector<int>&,
                   std::ostream&)
{
  LOG(message_group::Export_Error,
      "Export to 3MF v3 format was not enabled when building the application.");
}

#endif // ENABLE_LIBZIP
