#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <sstream>
#include <vector>

#include "geometry/Geometry.h"
#include "geometry/PolySet.h"
#include "geometry/linalg.h"
#include "geometry/manifold/ManifoldGeometry.h"
#include "glview/ColorMap.h"
#include "utils/printutils.h"

#ifdef __EMSCRIPTEN__
#include "wasm/binary_mesh_export.h"

// Static buffer for storing the binary mesh export result.
static std::vector<uint8_t> binaryMeshBuffer;

// Static buffer for storing the 3MF v3 export result.
static std::vector<uint8_t> _3mfOutputBuffer;

extern "C" {

uint8_t* openscad_get_binary_mesh_ptr() {
  return binaryMeshBuffer.data();
}

uint32_t openscad_get_binary_mesh_size() {
  return static_cast<uint32_t>(binaryMeshBuffer.size());
}

void openscad_free_binary_mesh() {
  binaryMeshBuffer.clear();
  binaryMeshBuffer.shrink_to_fit();
}

void openscad_export_3mf(const uint8_t* binaryMeshData, uint32_t binaryMeshSize,
                            const char* filamentInfos) {
  _3mfOutputBuffer.clear();
  std::ostringstream oss;
  std::vector<uint8_t> meshData(binaryMeshData, binaryMeshData + binaryMeshSize);

  std::vector<FilamentColor> infos = parseFilamentInfos(
      filamentInfos ? std::string(filamentInfos) : std::string());
  export_3mf_v4(meshData, infos, oss);
  std::string result = oss.str();
  _3mfOutputBuffer.assign(result.begin(), result.end());
}

uint8_t* openscad_get_3mf_output_ptr() {
  return _3mfOutputBuffer.data();
}

uint32_t openscad_get_3mf_output_size() {
  return static_cast<uint32_t>(_3mfOutputBuffer.size());
}

void openscad_free_3mf_output() {
  _3mfOutputBuffer.clear();
  _3mfOutputBuffer.shrink_to_fit();
}

} // extern "C"

#else // !__EMSCRIPTEN__

// Non-WASM build: binary mesh buffer is local
static std::vector<uint8_t> binaryMeshBuffer;

#endif // __EMSCRIPTEN__

// Binary mesh format (little-endian):
//   Header: 4 × uint32 = 16 bytes
//     [0] numVertices
//     [4] numFaces
//     [8] numColors
//     [12] numIndices
//   Positions: float32[3] × numVertices
//   Indices: uint32 × numIndices
//   ColorIndices: int32 × numFaces
//   ColorPalette: float32[4] × numColors (RGBA)

static void writeUint32LE(std::vector<uint8_t>& buf, uint32_t val) {
  buf.push_back(static_cast<uint8_t>(val & 0xFF));
  buf.push_back(static_cast<uint8_t>((val >> 8) & 0xFF));
  buf.push_back(static_cast<uint8_t>((val >> 16) & 0xFF));
  buf.push_back(static_cast<uint8_t>((val >> 24) & 0xFF));
}

static void writeFloat32LE(std::vector<uint8_t>& buf, float val) {
  uint32_t bits;
  std::memcpy(&bits, &val, sizeof(bits));
  writeUint32LE(buf, bits);
}

static void writeInt32LE(std::vector<uint8_t>& buf, int32_t val) {
  writeUint32LE(buf, static_cast<uint32_t>(val));
}

// Collect all triangles from multiple geometry nodes into flat arrays
struct TriangleCollector {
  std::vector<float> positions;      // flat: x,y,z per vertex
  std::vector<uint32_t> indices;     // 3 per triangle face
  std::vector<int32_t> colorIndices; // 1 per triangle face → palette index
  std::vector<Color4f> palette;      // merged color palette
  uint32_t numFaces = 0;
};

static int32_t getOrInsertColor(TriangleCollector& collector, const Color4f& c) {
  for (size_t i = 0; i < collector.palette.size(); ++i) {
    if (collector.palette[i].r() == c.r() &&
        collector.palette[i].g() == c.g() &&
        collector.palette[i].b() == c.b() &&
        collector.palette[i].a() == c.a()) {
      return static_cast<int32_t>(i);
    }
  }
  collector.palette.push_back(c);
  return static_cast<int32_t>(collector.palette.size() - 1);
}

static void collectPolySet(TriangleCollector& collector, const PolySet& polyset)
{
  if (polyset.isEmpty()) return;

  const uint32_t vertexBase = static_cast<uint32_t>(collector.positions.size() / 3);

  // Copy vertices
  for (const auto& v : polyset.vertices) {
    collector.positions.push_back(static_cast<float>(v.x()));
    collector.positions.push_back(static_cast<float>(v.y()));
    collector.positions.push_back(static_cast<float>(v.z()));
  }

  // Triangulate faces (fan triangulation) with per-polygon colors
  const bool hasColors = !polyset.color_indices.empty() && !polyset.colors.empty();
  for (size_t pi = 0; pi < polyset.indices.size(); ++pi) {
    const auto& poly = polyset.indices[pi];
    if (poly.size() < 3) continue;

    // Resolve color for this polygon
    int32_t paletteIdx = static_cast<int32_t>(collector.palette.size()); // default = new entry
    if (hasColors && pi < polyset.color_indices.size()) {
      int32_t ci = polyset.color_indices[pi];
      if (ci >= 0 && ci < static_cast<int32_t>(polyset.colors.size())) {
        paletteIdx = getOrInsertColor(collector, polyset.colors[ci]);
      } else {
        paletteIdx = -1; // -1 = use default (will be mapped to 0 below)
      }
    } else {
      paletteIdx = -1;
    }
    // Ensure default color is always at index 0
    if (paletteIdx < 0) paletteIdx = 0; // resolved to default index

    for (size_t i = 1; i + 1 < poly.size(); ++i) {
      collector.indices.push_back(vertexBase + poly[0]);
      collector.indices.push_back(vertexBase + poly[i]);
      collector.indices.push_back(vertexBase + poly[i + 1]);
      collector.colorIndices.push_back(paletteIdx);
      ++collector.numFaces;
    }
  }
}

static void collectGeometry(TriangleCollector& collector,
                             const std::shared_ptr<const Geometry>& geom)
{
  if (const auto geomlist = std::dynamic_pointer_cast<const GeometryList>(geom)) {
    for (const auto& item : geomlist->getChildren()) {
      collectGeometry(collector, item.second);
    }
  } else if (const auto ps = std::dynamic_pointer_cast<const PolySet>(geom)) {
    collectPolySet(collector, *ps);
#ifdef ENABLE_MANIFOLD
  } else if (const auto mani = std::dynamic_pointer_cast<const ManifoldGeometry>(geom)) {
    auto ps = mani->toPolySet();
    if (ps) collectPolySet(collector, *ps);
#endif
  }
}

void export_binary_mesh_to_static_buffer(const std::shared_ptr<const Geometry>& geom,
                                          std::ostream& output)
{
  binaryMeshBuffer.clear();

  if (!geom) return;

  TriangleCollector collector;

  collectGeometry(collector, geom);

  if (collector.palette.size() == 0) {
    // Ensure default color from render color scheme at palette index 0
    getOrInsertColor(collector, ColorMap::getColor(
        ColorMap::instance().defaultColorScheme(),
        RenderColor::CGAL_FACE_FRONT_COLOR));
  }

  uint32_t numVertices = static_cast<uint32_t>(collector.positions.size() / 3);
  uint32_t numIndices = static_cast<uint32_t>(collector.indices.size());

  if (numVertices == 0 || numIndices == 0) return;

  uint32_t numColors = static_cast<uint32_t>(collector.palette.size());

  // Write single unified header + data
  writeUint32LE(binaryMeshBuffer, numVertices);
  writeUint32LE(binaryMeshBuffer, collector.numFaces);
  writeUint32LE(binaryMeshBuffer, numColors);
  writeUint32LE(binaryMeshBuffer, numIndices);

  // Positions
  for (auto v : collector.positions) {
    writeFloat32LE(binaryMeshBuffer, v);
  }

  // Indices
  for (auto idx : collector.indices) {
    writeUint32LE(binaryMeshBuffer, idx);
  }

  // Color indices
  for (auto ci : collector.colorIndices) {
    writeInt32LE(binaryMeshBuffer, ci);
  }

  // Color palette from collected colors
  for (const auto& c : collector.palette) {
    writeFloat32LE(binaryMeshBuffer, c.r());
    writeFloat32LE(binaryMeshBuffer, c.g());
    writeFloat32LE(binaryMeshBuffer, c.b());
    writeFloat32LE(binaryMeshBuffer, c.a());
  }
  // Also write to output stream
  output.write(reinterpret_cast<const char*>(binaryMeshBuffer.data()), binaryMeshBuffer.size());
}
