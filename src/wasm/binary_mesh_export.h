#pragma once

#include "io/export.h"

#ifdef __EMSCRIPTEN__
#include <cstdint>

extern "C" {
  uint8_t* openscad_get_binary_mesh_ptr();
  uint32_t openscad_get_binary_mesh_size();
  void openscad_free_binary_mesh();

  // PrusaSlicer 3MF v3 export (with MMU segmentation)
  void openscad_export_3mf_v3(const uint8_t* binaryMeshData, uint32_t binaryMeshSize,
                            const char* filamentInfos);
  uint8_t* openscad_get_3mf_output_ptr();
  uint32_t openscad_get_3mf_output_size();
  void openscad_free_3mf_output();
}

#endif // __EMSCRIPTEN__
