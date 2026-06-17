// Expose WASM memory so JS can read binary mesh directly from heap
if (typeof Module !== 'undefined') {
  Module['wasmMemory'] = wasmMemory;
}
