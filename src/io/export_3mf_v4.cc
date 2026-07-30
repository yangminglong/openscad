/*
  Export 3MF v4 — OrcaSlicer-compatible 3MF with split object structure

  This file implements export_3mf_v4(), a standalone 3MF exporter that:
  - Reads the binary mesh format directly (does NOT use lib3mf)
  - Writes OrcaSlicer-compatible 3MF with Production Extension
  - Splits mesh data into per-object files under 3D/Objects/
  - Generates Metadata/model_settings.config for object/plate/assemble info
  - Generates Metadata/Slic3r_PE.config for extruder colour palette
  - Uses libzip for zip archive creation

  Binary mesh format (little-endian):
    Header (16 bytes): numVertices(u32) numFaces(u32) numColors(u32) numIndices(u32)
    Positions:  float32[numVertices * 3]
    Indices:    uint32[numIndices]
    ColorIndices: int32[numFaces]     — per-face index into ColorPalette (-1 = default → 0)
    ColorPalette: float32[numColors * 4] — RGBA, 0..1 range

  OrcaSlicer 3MF file structure:
    [Content_Types].xml
    _rels/.rels
    3D/_rels/3dmodel.model.rels
    3D/3dmodel.model
    3D/Objects/<name>_<id>.model
    Metadata/model_settings.config
    Metadata/Slic3r_PE.config
*/

#ifdef ENABLE_LIBZIP

#include "io/export.h"
#include "io/3mf_templates.h"
#include "geometry/linalg.h"

#include "json/json.hpp"         // nlohmann::json

#include <zip.h>

#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <iomanip>
#include <random>
#include <sstream>

#include <algorithm>
#include <array>
#include <cstring>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

// --- Constants ---------------------------------------------------------------

static const char* const SLIC3R_VERSION = "2.0.0.0";
static const char* const DEFAULT_MODEL_NAME = "OpenSCAD_Model";

// --- PAINT_COLOR_MAP ---------------------------------------------------------
// Indexed by 0-based extruder number: extruder 0 → '', extruder 1 → '8', ...
static const char* PAINT_COLOR_MAP[] = {
  "", "8", "0C", "1C", "2C", "3C", "4C", "5C",
  "6C", "7C", "8C", "9C", "AC", "BC", "CC", "DC"
};

static std::string getPaintColor(int extruderId) {
  int idx = extruderId;
  if (idx < 0 || idx >= static_cast<int>(sizeof(PAINT_COLOR_MAP) / sizeof(PAINT_COLOR_MAP[0]))) {
    return "";
  }
  return PAINT_COLOR_MAP[idx];
}

// --- Binary mesh parsing -----------------------------------------------------

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

// --- Color helpers -----------------------------------------------------------

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

// Derive object name from filament infos (use first filament name as suffix)
static std::string deriveModelName(const std::vector<FilamentColor>& infos) {
  if (!infos.empty() && !infos[0].name.empty()) {
    // Sanitize the name for use as a filename component
    std::string name = infos[0].name;
    // Replace problematic characters
    for (auto& c : name) {
      if (c == '/' || c == '\\' || c == ':' || c == '<' || c == '>' || c == '"' || c == '|' || c == '?' || c == '*') {
        c = '_';
      }
    }
    if (!name.empty()) return name;
  }
  return DEFAULT_MODEL_NAME;
}

// --- Color palette / extruder mapping ----------------------------------------

// Build extruder-to-color mapping from FilamentColor list.
// Returns: map of extruder index (0-based) → hex color string "#RRGGBBAA"
static std::map<int, std::string> buildExtruderColorMap(
    const std::vector<FilamentColor>& filamentColors)
{
  std::map<int, std::string> colorMap;
  for (size_t i = 0; i < filamentColors.size(); ++i) {
    const auto& fc = filamentColors[i];
    if (!fc.colors.empty()) {
      auto& c = fc.colors[0];
      colorMap[static_cast<int>(i)] = floatColorToHexRGBA(
          c.R / 255.0f, c.G / 255.0f, c.B / 255.0f, c.A / 255.0f);
    }
  }
  // Fallback: ensure at least one color exists
  if (colorMap.empty()) {
    colorMap[0] = "#FF0000FF"; // red default
  }
  return colorMap;
}

// Build extruder-to-filament_name mapping from FilamentColor list.
static std::map<int, std::string> buildExtruderNameMap(
    const std::vector<FilamentColor>& filamentColors)
{
  std::map<int, std::string> nameMap;
  for (size_t i = 0; i < filamentColors.size(); ++i) {
    if (!filamentColors[i].name.empty()) {
      nameMap[static_cast<int>(i)] = filamentColors[i].name;
    }
  }
  return nameMap;
}

// Build color-palette-index → extruder mapping.
// Uses the binary mesh's palette colors to match against filamentColors.
static std::vector<int> buildPaletteToExtruder(
    const BinaryMesh& mesh,
    const std::vector<FilamentColor>& filamentColors)
{
  std::vector<int> extruderIds(mesh.numColors, 0);
  if (filamentColors.empty() || mesh.numColors == 0) return extruderIds;

  for (uint32_t ci = 0; ci < mesh.numColors; ++ci) {
    extruderIds[ci] = static_cast<int>(ci < filamentColors.size() ? ci : 0);
  }
  return extruderIds;
}

// Build paintColorByColorIndex: maps palette index → segmentation hex string
static std::vector<std::string> buildPaintColors(const std::vector<int>& paletteToExtruder) {
  std::vector<std::string> paintColors;
  for (size_t i = 0; i < paletteToExtruder.size(); ++i) {
    paintColors.push_back(getPaintColor(paletteToExtruder[i]));
  }
  return paintColors;
}

// --- XML builders ------------------------------------------------------------

// [Content_Types].xml
static std::string buildContentTypesXML() {
  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
         "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\n"
         " <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\n"
         " <Default Extension=\"model\" ContentType=\"application/vnd.ms-package.3dmanufacturing-3dmodel+xml\"/>\n"
         "</Types>";
}

// _rels/.rels — OrcaSlicer format
static std::string buildRelsXML() {
  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
         "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\n"
         " <Relationship Target=\"/3D/3dmodel.model\" Id=\"rel-1\""
         " Type=\"http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel\"/>\n"
         "</Relationships>\n";
}

// 3D/_rels/3dmodel.model.rels — references per-object .model files
static std::string buildModelRelsXML(const std::string& objectFileName) {
  std::ostringstream xml;
  xml << "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n";
  xml << "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\n";
  xml << " <Relationship Target=\"/3D/Objects/" << objectFileName << "\" Id=\"rel-1\""
         " Type=\"http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel\"/>\n";
  xml << "</Relationships>";
  return xml.str();
}

// Coordinate formatter: round-trippable float, shortest possible
static char* formatCoordinate(float f, char *buf) {
  return buf + sprintf(buf, "%.9g", f);
}

// 3D/Objects/<name>_<id>.model — per-object mesh data (Production Extension)
static std::string buildObjectModelXML(
    const BinaryMesh& mesh,
    const std::string& objectUuid,
    const std::vector<std::string>& paintColors)
{
  std::ostringstream xml;
  xml << std::setprecision(std::numeric_limits<float>::max_digits10);

  xml << "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n";
  xml << "<model unit=\"millimeter\" xml:lang=\"en-US\""
         " xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\""
         " xmlns:BambuStudio=\"http://schemas.bambulab.com/package/2021\""
         " xmlns:p=\"http://schemas.microsoft.com/3dmanufacturing/production/2015/06\""
         " requiredextensions=\"p\">\n";

  // Metadata
  xml << " <metadata name=\"BambuStudio:3mfVersion\">1</metadata>\n";

  // Resources — single object with mesh
  xml << " <resources>\n";
  xml << "  <object id=\"1\" p:UUID=\"" << objectUuid << "\" type=\"model\">\n";
  xml << "   <mesh>\n";

  // Vertices
  xml << "    <vertices>\n";
  char buf[256];
  for (uint32_t vi = 0; vi < mesh.numVertices; ++vi) {
    float x = mesh.positions[vi * 3 + 0];
    float y = mesh.positions[vi * 3 + 1];
    float z = mesh.positions[vi * 3 + 2];
    char* ptr = buf;
    ptr = formatCoordinate(x, ptr);
    xml << "     <vertex x=\"" << buf << "\"";
    ptr = formatCoordinate(y, buf);
    xml << " y=\"" << buf << "\"";
    ptr = formatCoordinate(z, buf);
    xml << " z=\"" << buf << "\"/>\n";
  }
  xml << "    </vertices>\n";

  // Triangles
  xml << "    <triangles>\n";
  for (uint32_t fi = 0; fi < mesh.numFaces; ++fi) {
    uint32_t v0 = mesh.indices[fi * 3 + 0];
    uint32_t v1 = mesh.indices[fi * 3 + 1];
    uint32_t v2 = mesh.indices[fi * 3 + 2];
    int32_t colorIdx = mesh.colorIndices[fi];

    xml << "     <triangle v1=\"" << v0 << "\" v2=\"" << v1 << "\" v3=\"" << v2 << "\"";

    // MMU segmentation (extruder paint color)
    if (!paintColors.empty() && colorIdx >= 0 &&
        static_cast<uint32_t>(colorIdx) < paintColors.size()) {
      const auto& pc = paintColors[colorIdx];
      if (!pc.empty()) {
        xml << " slic3rpe:mmu_segmentation=\"" << pc << "\"";
      }
    }

    xml << "/>\n";
  }
  xml << "    </triangles>\n";

  xml << "   </mesh>\n";
  xml << "  </object>\n";
  xml << " </resources>\n";

  // Empty build (build items go into the main model file)
  xml << " <build/>\n";
  xml << "</model>\n";

  return xml.str();
}

// Minimal XML escape for text content
static std::string xmlEscape(const std::string& s) {
  std::string result;
  result.reserve(s.size());
  for (char c : s) {
    switch (c) {
      case '&':  result += "&amp;"; break;
      case '<':  result += "&lt;"; break;
      case '>':  result += "&gt;"; break;
      case '"':  result += "&quot;"; break;
      default:   result += c; break;
    }
  }
  return result;
}

// 3D/3dmodel.model — main model with metadata, components, and build items
static std::string buildMainModelXML(
    const std::string& objectFileName,
    const std::string& componentUuid,
    const std::string& modelUuid,
    const std::string& buildUuid,
    const std::string& buildItemUuid,
    const std::string& modelName,
    float translateX, float translateY, float translateZ)
{
  std::ostringstream xml;
  xml << std::setprecision(std::numeric_limits<float>::max_digits10);

  xml << "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n";
  xml << "<model unit=\"millimeter\" xml:lang=\"en-US\""
         " xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\""
         " xmlns:BambuStudio=\"http://schemas.bambulab.com/package/2021\""
         " xmlns:p=\"http://schemas.microsoft.com/3dmanufacturing/production/2015/06\""
         " requiredextensions=\"p\">\n";

  // Metadata tags (OrcaSlicer-compatible)
  auto version = std::string("BambuStudio-") + SLIC3R_VERSION;
  xml << " <metadata name=\"Application\">" << xmlEscape(version) << "</metadata>\n";
  xml << " <metadata name=\"BambuStudio:3mfVersion\">1</metadata>\n";
  xml << " <metadata name=\"Copyright\"></metadata>\n";
  xml << " <metadata name=\"CreationDate\"></metadata>\n";
  xml << " <metadata name=\"Description\"></metadata>\n";
  xml << " <metadata name=\"Designer\"></metadata>\n";
  xml << " <metadata name=\"DesignerCover\"></metadata>\n";
  xml << " <metadata name=\"DesignerUserId\"></metadata>\n";
  xml << " <metadata name=\"License\"></metadata>\n";
  xml << " <metadata name=\"ModificationDate\"></metadata>\n";
  xml << " <metadata name=\"Origin\"></metadata>\n";
  xml << " <metadata name=\"Title\">" << xmlEscape(modelName) << "</metadata>\n";

  // Resources — composite object with component references
  xml << " <resources>\n";
  // The composite object (id="2") references the sub-object (id="1")
  xml << "  <object id=\"2\" p:UUID=\"" << modelUuid << "\" type=\"model\">\n";
  xml << "   <components>\n";
  xml << "    <component p:path=\"/3D/Objects/" << xmlEscape(objectFileName) << "\""
         " objectid=\"1\" p:UUID=\"" << componentUuid << "\""
         " transform=\"1 0 0 0 1 0 0 0 1 0 0 0\"/>\n";
  xml << "   </components>\n";
  xml << "  </object>\n";
  xml << " </resources>\n";

  // Build — placement of the composite object
  xml << " <build p:UUID=\"" << buildUuid << "\">\n";
  xml << "  <item objectid=\"2\" p:UUID=\"" << buildItemUuid << "\""
         " transform=\"1 0 0 0 1 0 0 0 1 "
      << translateX << " " << translateY << " " << translateZ
      << "\" printable=\"1\"/>\n";
  xml << " </build>\n";
  xml << "</model>\n";

  return xml.str();
}

// --- Filament candidates from Anycubic.json (fuzzy matching pool) -------------
// Parsed at runtime from ANYCUBIC_PROFILE_JSON (embedded full Anycubic.json).
// Cached in a static local to avoid re-parsing on every call.
static const std::vector<std::string>& getFilamentCandidates() {
  static std::vector<std::string> candidates = []() {
    std::vector<std::string> result;
    try {
      nlohmann::json data = nlohmann::json::parse(ANYCUBIC_PROFILE_JSON);
      if (data.contains("filament_list") && data["filament_list"].is_array()) {
        for (const auto& item : data["filament_list"]) {
          if (!item.contains("name")) continue;
          std::string name = item["name"].get<std::string>();
          if (name == "fdm_filament_common" ||
              (name.size() >= 7 && name.compare(name.size() - 7, 7, "@acbase") == 0) ||
              (name.size() >= 7 && name.compare(0, 7, "Generic") == 0))
            continue;
          result.push_back(name);
        }
      }
    } catch (const std::exception& e) {
      // Fallback: empty list → fuzzy match will return default
    }
    return result;
  }();
  return candidates;
}

// --- Filament fuzzy matching --------------------------------------------------

// Extract keyword from filament name: "Anycubic PLA Silk @Anycubic Kobra X 0.4" → "Anycubic PLA Silk"
static std::string extractFilamentKeyword(const std::string& name) {
  size_t at_pos = name.find('@');
  std::string keyword = (at_pos != std::string::npos) ? name.substr(0, at_pos) : name;
  size_t start = keyword.find_first_not_of(" \t");
  if (start == std::string::npos) return "";
  size_t end = keyword.find_last_not_of(" \t");
  return keyword.substr(start, end - start + 1);
}

static std::string strToLower(const std::string& s) {
  std::string r = s;
  for (char& c : r) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return r;
}

static std::vector<std::string> splitTokens(const std::string& s) {
  std::vector<std::string> tokens;
  std::string token;
  for (char c : s) {
    if (c == ' ') {
      if (!token.empty()) { tokens.push_back(token); token.clear(); }
    } else {
      token += c;
    }
  }
  if (!token.empty()) tokens.push_back(token);
  return tokens;
}

// Fuzzy match a user filament name (e.g. "PLA") to an Anycubic filament_settings_id
// (e.g. "Anycubic PLA @Anycubic Kobra X 0.4 nozzle")
static std::string fuzzyMatchFilamentId(const std::string& filamentName) {
  static const char* DEFAULT_PRINTER = "Anycubic Kobra X";
  static const char* DEFAULT_NOZZLE = "0.4 nozzle";
  static const char* DEFAULT_ID = "Anycubic PLA @Anycubic Kobra X 0.4 nozzle";

  std::string keyword = extractFilamentKeyword(filamentName);
  if (keyword.empty()) keyword = filamentName;
  std::vector<std::string> tokens = splitTokens(keyword);

  std::string best_match;
  int best_score = 0;

  const auto& candidates = getFilamentCandidates();
  for (const auto& candidate : candidates) {
    std::string local_key = extractFilamentKeyword(candidate);
    if (local_key.empty()) continue;

    std::string local_lower = strToLower(local_key);
    bool isDefaultPrinter = candidate.find(DEFAULT_PRINTER) != std::string::npos;
    bool isDefaultNozzle  = candidate.find(DEFAULT_NOZZLE) != std::string::npos;
    int score = isDefaultPrinter ? 2 : (isDefaultNozzle ? 1 : 0);

    for (const auto& token : tokens) {
      if (!token.empty() && local_lower.find(strToLower(token)) != std::string::npos) {
        ++score;
      }
    }

    if (score > best_score) {
      best_score = score;
      best_match = candidate;
    }
  }

  return best_match.empty() ? std::string(DEFAULT_ID) : best_match;
}



// --- Project settings config builder ------------------------------------------
// Uses PROJECT_SETTINGS_TEMPLATE from 3mf_templates.h, replaces filament arrays.
static std::string buildProjectSettingsConfig(
    const std::vector<FilamentColor>& filamentColors)
{
    std::set<std::string> filament_option_keys = {
        "filament_diameter", "min_layer_height", "max_layer_height",
        "retraction_length", "z_hop", "z_hop_types", "retract_lift_above", "retract_lift_below", "retract_lift_enforce", "retraction_speed", "deretraction_speed",
        "retract_before_wipe", "retract_restart_extra", "retraction_minimum_travel", "wipe", "wipe_distance",
        "retract_when_changing_layer", "retract_length_toolchange", "retract_restart_extra_toolchange", "filament_colour", "filament_colour_info",
        "default_filament_profile","retraction_distances_when_cut","long_retractions_when_cut"/*,"filament_seam_gap"*/
    };

    std::set<std::string> filament_retract_keys = {
        "deretraction_speed",
        "long_retractions_when_cut",
        "retract_before_wipe",
        "retract_lift_above",
        "retract_lift_below",
        "retract_lift_enforce",
        "retract_restart_extra",
        "retract_when_changing_layer",
        "retraction_distances_when_cut",
        "retraction_length",
        "retraction_minimum_travel",
        "retraction_speed",
        "wipe",
        "wipe_distance",
        "z_hop",
        "z_hop_types"
    };
  // Build filament arrays
  std::vector<std::string> filament_settings_id;
  std::vector<std::string> filament_colour;
  std::vector<std::string> filament_colour_info;

  for (const auto& fc : filamentColors) {
    filament_settings_id.push_back(fuzzyMatchFilamentId(fc.name));
    if (!fc.colors.empty()) {
      filament_colour.push_back(fc.colors[0].toHex());
    } else {
      filament_colour.push_back("#000000");
    }
    filament_colour_info.push_back(fc.serialize());
  }

  // Fallback: ensure at least one extruder
  if (filament_settings_id.empty()) {
    filament_settings_id.push_back("Anycubic PLA @Anycubic Kobra X 0.4 nozzle");
    filament_colour.push_back("#FF0000FF");
    filament_colour_info.push_back("#FF0000FF");
  }

  // Parse template and replace filament arrays using nlohmann::json
  try {
    nlohmann::json cfg = nlohmann::json::parse(PROJECT_SETTINGS_TEMPLATE);
    cfg["filament_settings_id"] = filament_settings_id;
    cfg["filament_colour"]      = filament_colour;
    cfg["filament_colour_info"] = filament_colour_info;

    // Expand per-extruder filament_* arrays to match filament count.
    // Template defaults to 1 extruder; replicate if more filaments are present.
    size_t n_filaments = filament_settings_id.size();
    if (n_filaments > 1) {
      for (auto it = cfg.begin(); it != cfg.end(); ++it) {
        const std::string& key = it.key();
        nlohmann::json& val = it.value();
        if (!val.is_array() || val.size() != 1) continue;
        if (filament_option_keys.count(key) || filament_retract_keys.count(key) ||
            (key.size() > 9 && key.compare(0, 9, "filament_") == 0)) {
          nlohmann::json first = val[0];
          val = nlohmann::json::array();
          for (size_t i = 0; i < n_filaments; ++i) {
            val.push_back(first);
          }
        }
      }
    }

    return cfg.dump(4);
  } catch (const std::exception& e) {
    LOG(message_group::Export_Error,
        std::string("Failed to build project_settings.config: ") + e.what());
    return "";
  }
}


// --- UUID generator ----------------------------------------------------------

static std::string generateUUID() {
  static std::random_device rd;
  static std::mt19937_64 gen(rd());
  static std::uniform_int_distribution<uint64_t> dist;

  uint64_t a = dist(gen);
  uint64_t b = dist(gen);

  // Set UUID version 4 (random) and variant 1 bits
  a = (a & 0xFFFFFFFFFFFF0FFFULL) | 0x0000000000004000ULL;
  b = (b & 0x3FFFFFFFFFFFFFFFULL) | 0x8000000000000000ULL;

  std::ostringstream oss;
  oss << std::hex << std::setfill('0')
      << std::setw(8) << ((a >> 32) & 0xFFFFFFFF)
      << '-' << std::setw(4) << ((a >> 16) & 0xFFFF)
      << '-' << std::setw(4) << (a & 0xFFFF)
      << '-' << std::setw(4) << ((b >> 48) & 0xFFFF)
      << '-' << std::setw(12) << (b & 0xFFFFFFFFFFFF);
  return oss.str();
}

// --- libzip helpers ----------------------------------------------------------

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

// --- Public API --------------------------------------------------------------

void export_3mf_v4(const std::vector<uint8_t>& binaryMeshBuffer,
                   const std::vector<FilamentColor>& filamentColors,
                   std::ostream& output)
{
  // 1. Parse binary mesh
  BinaryMesh mesh;
  if (!parseBinaryMesh(binaryMeshBuffer, mesh)) {
    LOG(message_group::Export_Error, "Failed to parse binary mesh buffer for 3MF v4 export");
    return;
  }

  // 2. Derive model name from filament infos
  std::string modelName = deriveModelName(filamentColors);
  // Build a safe filename version for use in paths
  std::string safeModelName = modelName;
  for (auto& c : safeModelName) {
    if (c == ' ' || c == '/' || c == '\\' || c == ':' || c == '<' ||
        c == '>' || c == '"' || c == '|' || c == '?' || c == '*') {
      c = '_';
    }
  }

  // 3. Build color mappings
  std::map<int, std::string> extruderColors = buildExtruderColorMap(filamentColors);
  std::map<int, std::string> extruderNames = buildExtruderNameMap(filamentColors);
  std::vector<int> paletteToExtruder = buildPaletteToExtruder(mesh, filamentColors);
  std::vector<std::string> paintColors = buildPaintColors(paletteToExtruder);

  // 4. Generate UUIDs
  std::string objectUuid    = generateUUID();  // UUID for sub-object (mesh data)
  std::string componentUuid = generateUUID();  // UUID for component reference
  std::string modelUuid     = generateUUID();  // UUID for composite model object
  std::string buildUuid     = generateUUID();  // UUID for build section
  std::string buildItemUuid = generateUUID();  // UUID for build item

  // 5. Object file path
  std::string objectFileName = safeModelName + "_1.model";

  // Compute bounding box from mesh data for platform placement
  float meshMinZ = 0.0f;
  if (mesh.numVertices > 0) {
    meshMinZ = mesh.positions[2]; // first vertex Z
    for (uint32_t vi = 1; vi < mesh.numVertices; ++vi) {
      float z = mesh.positions[vi * 3 + 2];
      if (z < meshMinZ) meshMinZ = z;
    }
  }
  // Platform center offset (256x256 build plate → center at 128,128)
  float transformX = 128;
  float transformY = 128;
  float transformZ = -meshMinZ;  // Move model to sit on the platform
  
  // 6. Build XML strings
  std::string objectModelXml  = buildObjectModelXML(mesh, objectUuid, paintColors);
  std::string mainModelXml    = buildMainModelXML(objectFileName, componentUuid,
                                                   modelUuid, buildUuid, buildItemUuid,
                                                   modelName, transformX, transformY, transformZ);
  std::string modelRelsXml    = buildModelRelsXML(objectFileName);
  std::string contentTypes    = buildContentTypesXML();
  std::string rels            = buildRelsXML();
  // std::string modelSettings   = buildModelSettingsConfig(modelName,
  //                                                        extruderColors,
  //                                                        transformX, transformY, transformZ);
  // 7. Create zip via libzip
  std::string tmpPath = (std::filesystem::temp_directory_path() /
                         ("openscad_3mf_v4_" + safeModelName + ".3mf")).string();

  int zipError = 0;
  zip_t *z = zip_open(tmpPath.c_str(), ZIP_CREATE | ZIP_TRUNCATE, &zipError);
  if (!z) {
    LOG(message_group::Export_Error, "Failed to create zip archive for 3MF v4 export");
    return;
  }

  bool ok = true;
  // Package-level files
  ok = ok && addStringToZip(z, "[Content_Types].xml", contentTypes);
  ok = ok && addStringToZip(z, "_rels/.rels", rels);
  // 3D model files
  ok = ok && addStringToZip(z, "3D/3dmodel.model", mainModelXml);
  ok = ok && addStringToZip(z, "3D/_rels/3dmodel.model.rels", modelRelsXml);
  ok = ok && addStringToZip(z, "3D/Objects/" + objectFileName, objectModelXml);
  // Metadata files
  std::string projectSettings = buildProjectSettingsConfig(filamentColors);
  ok = ok && addStringToZip(z, "Metadata/project_settings.config", projectSettings);
  ok = ok && addStringToZip(z, "Metadata/slice_info.config", std::string(SLICE_INFO_CONFIG));

  if (zip_close(z) < 0 || !ok) {
    LOG(message_group::Export_Error, "Failed to write zip archive for 3MF v4 export");
    return;
  }

  // 8. Read back and write to ostream
  FILE *fp = fopen(tmpPath.c_str(), "rb");
  if (!fp) {
    LOG(message_group::Export_Error, "Failed to read back 3MF file");
    return;
  }
  fseek(fp, 0, SEEK_END);
  long sz = ftell(fp);
  fseek(fp, 0, SEEK_SET);
  std::vector<char> buf(sz);
  fread(buf.data(), 1, sz, fp);
  fclose(fp);
  output.write(buf.data(), sz);
  // Clean up temp file
  std::remove(tmpPath.c_str());
}

#else  // !ENABLE_LIBZIP

void export_3mf_v4(const std::vector<uint8_t>&,
                   const std::vector<FilamentColor>&,
                   std::ostream&)
{
  LOG(message_group::Export_Error,
      "Export to 3MF v4 format was not enabled when building the application.");
}

#endif // ENABLE_LIBZIP

// --- FilamentColor / FilamentColorRGBA method implementations ---------------

std::string FilamentColorRGBA::toHex() const {
  char buf[10];
  snprintf(buf, sizeof(buf), "#%02X%02X%02X%02X", R, G, B, A);
  return std::string(buf);
}

FilamentColorRGBA FilamentColorRGBA::fromHex(const std::string& hex) {
  FilamentColorRGBA c;
  if (hex.size() >= 9 && hex[0] == '#') {
    auto parsePair = [](char h, char l) -> uint8_t {
      auto hexVal = [](char ch) -> int {
        if (ch >= '0' && ch <= '9') return ch - '0';
        if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
        if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
        return 0;
      };
      return static_cast<uint8_t>(hexVal(h) * 16 + hexVal(l));
    };
    c.R = parsePair(hex[1], hex[2]);
    c.G = parsePair(hex[3], hex[4]);
    c.B = parsePair(hex[5], hex[6]);
    c.A = parsePair(hex[7], hex[8]);
  }
  return c;
}

std::string FilamentColor::serialize() const {
  std::ostringstream oss;
  switch (type) {
    case FilamentColorType::Solid:
      if (!colors.empty()) oss << colors[0].toHex();
      break;
    case FilamentColorType::Gradient:
      oss << "gradient:";
      for (size_t i = 0; i < colors.size(); ++i) {
        if (i > 0) oss << ",";
        oss << colors[i].toHex();
      }
      oss << ";angle:" << angle;
      break;
    case FilamentColorType::Glow:
      oss << "glow:";
      for (size_t i = 0; i < colors.size(); ++i) {
        if (i > 0) oss << ",";
        oss << colors[i].toHex();
      }
      break;
  }
  return oss.str();
}

FilamentColor FilamentColor::deserialize(const std::string& str) {
  FilamentColor fc;
  if (str.empty()) return fc;

  if (str[0] == '#') {
    fc.type = FilamentColorType::Solid;
    fc.colors.push_back(FilamentColorRGBA::fromHex(str));
  } else if (str.compare(0, 9, "gradient:") == 0) {
    fc.type = FilamentColorType::Gradient;
    std::string rest = str.substr(9);
    auto semi = rest.find(';');
    std::string colorPart = (semi != std::string::npos) ? rest.substr(0, semi) : rest;
    size_t pos = 0;
    while (pos < colorPart.size()) {
      auto next = colorPart.find(',', pos);
      std::string hex = colorPart.substr(pos, (next == std::string::npos) ? next : next - pos);
      fc.colors.push_back(FilamentColorRGBA::fromHex(hex));
      if (next == std::string::npos) break;
      pos = next + 1;
    }
    if (semi != std::string::npos) {
      std::string anglePart = rest.substr(semi + 1);
      if (anglePart.compare(0, 6, "angle:") == 0) {
        fc.angle = std::stoi(anglePart.substr(6));
      }
    }
  } else if (str.compare(0, 5, "glow:") == 0) {
    fc.type = FilamentColorType::Glow;
    std::string colorPart = str.substr(5);
    size_t pos = 0;
    while (pos < colorPart.size()) {
      auto next = colorPart.find(',', pos);
      std::string hex = colorPart.substr(pos, (next == std::string::npos) ? next : next - pos);
      fc.colors.push_back(FilamentColorRGBA::fromHex(hex));
      if (next == std::string::npos) break;
      pos = next + 1;
    }
  }
  return fc;
}
