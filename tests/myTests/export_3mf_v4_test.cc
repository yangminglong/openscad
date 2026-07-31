#include <catch2/catch_all.hpp>

#include "io/export.h"

#include <sstream>
#include <vector>
#include <cstring>

// =============================================================================
// FilamentColorRGBA tests
// =============================================================================

TEST_CASE("FilamentColorRGBA::toHex produces #RRGGBBAA", "[FilamentColorRGBA][toHex]") {
  SECTION("Opaque red") {
    FilamentColorRGBA c{255, 0, 0, 255};
    CHECK(c.toHex() == "#FF0000FF");
  }

  SECTION("Semi-transparent blue") {
    FilamentColorRGBA c{0, 0, 255, 128};
    CHECK(c.toHex() == "#0000FF80");
  }

  SECTION("Black with zero alpha") {
    FilamentColorRGBA c{0, 0, 0, 0};
    CHECK(c.toHex() == "#00000000");
  }

  SECTION("Default is opaque white") {
    FilamentColorRGBA c;
    CHECK(c.toHex() == "#000000FF");
  }
}

TEST_CASE("FilamentColorRGBA::fromHex parses #RRGGBBAA", "[FilamentColorRGBA][fromHex]") {
  SECTION("Standard hex") {
    auto c = FilamentColorRGBA::fromHex("#FF8800FF");
    CHECK(c.R == 0xFF);
    CHECK(c.G == 0x88);
    CHECK(c.B == 0x00);
    CHECK(c.A == 0xFF);
  }

  SECTION("Lowercase hex") {
    auto c = FilamentColorRGBA::fromHex("#aabbccdd");
    CHECK(c.R == 0xAA);
    CHECK(c.G == 0xBB);
    CHECK(c.B == 0xCC);
    CHECK(c.A == 0xDD);
  }

  SECTION("Short string returns default") {
    auto c = FilamentColorRGBA::fromHex("#FF");
    CHECK(c.R == 0);
    CHECK(c.G == 0);
    CHECK(c.B == 0);
    CHECK(c.A == 255);
  }
}

// =============================================================================
// FilamentColor tests
// =============================================================================

TEST_CASE("FilamentColor default name is PLA", "[FilamentColor][default]") {
  FilamentColor fc;
  CHECK(fc.name == "PLA");
  CHECK(fc.type == FilamentColorType::Solid);
  CHECK(fc.colors.empty());
  CHECK(fc.angle == 0);
}

TEST_CASE("FilamentColor::serialize / deserialize round-trip", "[FilamentColor][serialize]") {
  SECTION("Solid color") {
    FilamentColor fc;
    fc.name = "PLA";
    fc.type = FilamentColorType::Solid;
    fc.colors.push_back(FilamentColorRGBA{255, 0, 0, 255});

    std::string s = fc.serialize();
    CHECK(s == "#FF0000FF");

    auto restored = FilamentColor::deserialize(s);
    CHECK(restored.type == FilamentColorType::Solid);
    CHECK(restored.colors.size() == 1);
    CHECK(restored.colors[0].toHex() == "#FF0000FF");
  }

  SECTION("Gradient color") {
    FilamentColor fc;
    fc.name = "PLA Gradient";
    fc.type = FilamentColorType::Gradient;
    fc.colors.push_back(FilamentColorRGBA{255, 0, 0, 255});
    fc.colors.push_back(FilamentColorRGBA{0, 255, 0, 255});
    fc.colors.push_back(FilamentColorRGBA{0, 0, 255, 255});
    fc.angle = 90;

    std::string s = fc.serialize();
    CHECK(s.find("gradient:") == 0);
    CHECK(s.find(";angle:90") != std::string::npos);

    auto restored = FilamentColor::deserialize(s);
    CHECK(restored.type == FilamentColorType::Gradient);
    CHECK(restored.colors.size() == 3);
    CHECK(restored.angle == 90);
  }

  SECTION("Glow color") {
    FilamentColor fc;
    fc.name = "PLA Glow";
    fc.type = FilamentColorType::Glow;
    fc.colors.push_back(FilamentColorRGBA{0xFF, 0xFF, 0x00, 0xFF});
    fc.colors.push_back(FilamentColorRGBA{0x00, 0x00, 0xFF, 0xFF});

    std::string s = fc.serialize();
    CHECK(s.find("glow:") == 0);

    auto restored = FilamentColor::deserialize(s);
    CHECK(restored.type == FilamentColorType::Glow);
    CHECK(restored.colors.size() == 2);
  }
}

// =============================================================================
// parseFilamentInfos tests
// =============================================================================

TEST_CASE("parseFilamentInfos parses single solid color", "[parseFilamentInfos][solid]") {
  auto result = parseFilamentInfos("PLA|#FF0000FF");

  REQUIRE(result.size() == 1);
  CHECK(result[0].name == "PLA");
  CHECK(result[0].type == FilamentColorType::Solid);
  REQUIRE(result[0].colors.size() == 1);
  CHECK(result[0].colors[0].toHex() == "#FF0000FF");
}

TEST_CASE("parseFilamentInfos parses gradient with newline separator", "[parseFilamentInfos][gradient]") {
  auto result = parseFilamentInfos(
      "PLA Silk|gradient:#FF0000FF,#00FF00FF;angle:90\n"
      "PETG|#0066FFFF");

  REQUIRE(result.size() == 2);
  CHECK(result[0].name == "PLA Silk");
  CHECK(result[0].type == FilamentColorType::Gradient);
  CHECK(result[0].angle == 90);

  CHECK(result[1].name == "PETG");
  CHECK(result[1].type == FilamentColorType::Solid);
}

TEST_CASE("parseFilamentInfos handles escaped \\n separator", "[parseFilamentInfos][escaped]") {
  auto result = parseFilamentInfos("PLA|#FF0000FF\\nPETG|#0066FFFF");

  REQUIRE(result.size() == 2);
  CHECK(result[0].name == "PLA");
  CHECK(result[1].name == "PETG");
}

TEST_CASE("parseFilamentInfos handles glow type", "[parseFilamentInfos][glow]") {
  auto result = parseFilamentInfos("PLA Glow|glow:#FFFF00FF,#0000FFFF");

  REQUIRE(result.size() == 1);
  CHECK(result[0].name == "PLA Glow");
  CHECK(result[0].type == FilamentColorType::Glow);
  REQUIRE(result[0].colors.size() == 2);
}

TEST_CASE("parseFilamentInfos empty input returns empty", "[parseFilamentInfos][empty]") {
  SECTION("Empty string") {
    auto result = parseFilamentInfos("");
    CHECK(result.empty());
  }
}

TEST_CASE("parseFilamentInfos defaults name to PLA", "[parseFilamentInfos][default]") {
  // No pipe = just a serialized value, default name "PLA"
  auto result = parseFilamentInfos("#FF0000FF");
  REQUIRE(result.size() == 1);
  CHECK(result[0].name == "PLA");
  CHECK(result[0].type == FilamentColorType::Solid);
}

// =============================================================================
// autoDetectFilamentColors tests
// =============================================================================

// Helper: build minimal binary mesh buffer for testing
static std::vector<uint8_t> makeMinimalMeshData(
    const std::vector<std::array<float, 3>>& vertices,
    const std::vector<std::array<uint32_t, 3>>& faces,
    const std::vector<int32_t>& colorIndices,
    const std::vector<std::array<float, 4>>& palette)
{
  std::vector<uint8_t> buf;
  auto w32 = [&buf](uint32_t v) {
    buf.push_back(v & 0xFF);
    buf.push_back((v >> 8) & 0xFF);
    buf.push_back((v >> 16) & 0xFF);
    buf.push_back((v >> 24) & 0xFF);
  };
  auto wf32 = [&](float v) {
    uint32_t bits;
    std::memcpy(&bits, &v, sizeof(bits));
    w32(bits);
  };
  auto wi32 = [&](int32_t v) {
    uint32_t bits;
    std::memcpy(&bits, &v, sizeof(bits));
    w32(bits);
  };

  uint32_t nv = static_cast<uint32_t>(vertices.size());
  uint32_t nf = static_cast<uint32_t>(faces.size());
  uint32_t nc = static_cast<uint32_t>(palette.size());
  uint32_t ni = nf * 3;

  // Header
  w32(nv);
  w32(nf);
  w32(nc);
  w32(ni);

  // Positions
  for (auto& v : vertices) {
    wf32(v[0]); wf32(v[1]); wf32(v[2]);
  }

  // Indices
  for (auto& f : faces) {
    w32(f[0]); w32(f[1]); w32(f[2]);
  }

  // Color indices (per face)
  for (auto ci : colorIndices) {
    wi32(ci);
  }

  // Palette
  for (auto& c : palette) {
    wf32(c[0]); wf32(c[1]); wf32(c[2]); wf32(c[3]);
  }

  return buf;
}

TEST_CASE("autoDetectFilamentColors extracts palette colors", "[autoDetectFilamentColors][basic]") {
  auto mesh = makeMinimalMeshData(
      {{0,0,0}, {1,0,0}, {0,1,0}},          // 3 vertices
      {{0,1,2}},                              // 1 face
      {0},                                    // color index 0
      {{1.0f, 0.0f, 0.0f, 1.0f}}            // red palette
  );

  auto result = autoDetectFilamentColors(mesh);
  REQUIRE(result.size() == 1);
  CHECK(result[0].name == "PLA");
  CHECK(result[0].type == FilamentColorType::Solid);
  REQUIRE(result[0].colors.size() == 1);
  CHECK(result[0].colors[0].R == 255);
  CHECK(result[0].colors[0].G == 0);
  CHECK(result[0].colors[0].B == 0);
  CHECK(result[0].colors[0].A == 255);
}

TEST_CASE("autoDetectFilamentColors handles multi-color palette", "[autoDetectFilamentColors][multi]") {
  auto mesh = makeMinimalMeshData(
      {{0,0,0}, {1,0,0}, {0,1,0}, {1,1,0}},  // 4 vertices
      {{0,1,2}, {1,3,2}},                      // 2 faces
      {0, 1},                                   // different colors per face
      {{1.0f, 0.0f, 0.0f, 1.0f},              // red
       {0.0f, 0.0f, 1.0f, 0.5f}}              // blue, semi-transparent
  );

  auto result = autoDetectFilamentColors(mesh);
  REQUIRE(result.size() == 2);
  CHECK(result[0].name == "PLA");
  CHECK(result[0].colors[0].toHex() == "#FF0000FF");
  CHECK(result[1].name == "PLA");
  CHECK(result[1].colors[0].toHex() == "#0000FF7F");  // 0.5 alpha → 127 → 0x7F
}

TEST_CASE("autoDetectFilamentColors invalid data returns empty", "[autoDetectFilamentColors][error]") {
  std::vector<uint8_t> invalid = {0, 0, 0, 0};  // too short
  auto result = autoDetectFilamentColors(invalid);
  CHECK(result.empty());
}

TEST_CASE("autoDetectFilamentColors empty mesh returns empty", "[autoDetectFilamentColors][empty]") {
  std::vector<uint8_t> empty;
  auto result = autoDetectFilamentColors(empty);
  CHECK(result.empty());
}
