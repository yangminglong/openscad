#pragma once

#include "io/export.h"

#ifdef __EMSCRIPTEN__
#include <cstdint>

extern "C" {
  uint8_t* openscad_get_binary_mesh_ptr();
  uint32_t openscad_get_binary_mesh_size();
  void openscad_free_binary_mesh();
}

#endif // __EMSCRIPTEN__
