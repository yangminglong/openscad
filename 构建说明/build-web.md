# OpenSCAD build-web 构建说明

## 概述

`build-web` 是 OpenSCAD 的 WebAssembly 版本，可在浏览器中运行，无需安装。

## 构建环境

- **构建方式**: Docker (openscad/wasm-base)
- **工具链**: Emscripten (emsdk)
- **产物**: openscad.js + openscad.wasm

## 构建步骤

### 准备 Docker 镜像

```bash
docker pull openscad/wasm-base:latest

# 构建含 ccache 的本地镜像（加速增量编译）
./scripts/wasm-base-docker-run.sh true
```

### 配置

```bash
# 浏览器版（默认）
./scripts/wasm-base-docker-run.sh emcmake cmake -B build-web -S . \
  -DCMAKE_BUILD_TYPE=Release \
  -DEXPERIMENTAL=ON

# Node.js 版
./scripts/wasm-base-docker-run.sh emcmake cmake -B build-node -S . \
  -DWASM_BUILD_TYPE=node \
  -DCMAKE_BUILD_TYPE=Release \
  -DEXPERIMENTAL=ON
```

### 编译

```bash
# 编译
./scripts/wasm-base-docker-run.sh cmake --build build-web -j$(nproc)

# 产物：build-web/openscad.js + build-web/openscad.wasm
```

### 增量编译

```bash
# 修改源码后只编译变更文件
./scripts/wasm-base-docker-run.sh cmake --build build-web -j$(nproc)
```

## 产物结构

```
build-web/
├── openscad.js               ← JS 胶水代码 (~100KB)
├── openscad.wasm             ← WASM 二进制 (~11MB)
└── ...
```

## 运行

### 浏览器

```bash
cd examples/web
python3 -m http.server 8080
# 浏览器访问 http://localhost:8080
```

`examples/web/` 通过符号链接引用 `build-web/` 产物：

```
examples/web/
├── index.html                ← Web UI
├── openscad.js -> ../../build-web/openscad.js
├── openscad.wasm -> ../../build-web/openscad.wasm
└── resources/
    └── filaments.json        ← 耗材数据库
```

### Node.js

```bash
build-node/openscad.js -h
```

## 导出接口 (WASM)

WASM 导出的 C 接口（供 JS 调用）：

| 函数 | 说明 |
|---|---|
| `openscad_get_binary_mesh_ptr()` | 获取二进制网格指针 |
| `openscad_get_binary_mesh_size()` | 获取二进制网格大小 |
| `openscad_export_3mf_v3(ptr, size, filamentInfos)` | 导出 3MF v4（接口名保留 v3） |
| `openscad_get_3mf_output_ptr()` | 获取 3MF 输出指针 |
| `openscad_get_3mf_output_size()` | 获取 3MF 输出大小 |
| `openscad_free_binary_mesh()` | 释放二进制网格 |
| `openscad_free_3mf_output()` | 释放 3MF 输出 |

## 相关文档

- [build-cli.md](build-cli.md) — CLI 构建说明
- [OpenSCAD 3MF v4 (OrcaSlicer) 导出完整参考.md](../OpenSCAD%203MF%20v4%20(OrcaSlicer)%20导出完整参考.md)
