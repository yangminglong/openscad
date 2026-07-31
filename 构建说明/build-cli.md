# OpenSCAD build-cli 构建说明

## 概述

`build-cli` 是 OpenSCAD 的无 GUI 命令行版本，用于离线批量导出、CI 集成、WASM 配套工具等场景。

## 构建环境

- **系统**: Ubuntu 24.04 (x86_64)
- **编译器**: GCC 13.3.0
- **构建系统**: CMake 3.22 + GNU Make

## 依赖安装

```bash
sudo apt-get install -y \
  build-essential cmake git \
  libeigen3-dev libboost-all-dev \
  libgmp-dev libmpfr-dev libcgal-dev \
  libopencsg-dev libdouble-conversion-dev \
  libzip-dev lib3mf-dev libxml2-dev \
  libcairo2-dev libharfbuzz-dev libfreetype-dev libfontconfig-dev \
  libglew-dev libegl-dev mesa-common-dev \
  libtbb-dev libpcre2-dev \
  flex bison gettext
```

## 构建步骤

```bash
cd /home/hanson/OpenSCAD/openscad

# 配置
cmake -B build-cli -S . \
  -DCMAKE_BUILD_TYPE=Release \
  -DHEADLESS=ON \
  -DEXPERIMENTAL=ON

# 编译
cmake --build build-cli -j$(nproc)

# 产物：build-cli/openscad
```

### CMake 选项说明

| 选项 | 值 | 说明 |
|---|---|---|
| `CMAKE_BUILD_TYPE` | `Release` | 优化构建 |
| `HEADLESS` | `ON` | 无 GUI，生成命令行版本 |
| `EXPERIMENTAL` | `ON` | 启用实验功能（含 3MF v4） |
| `ENABLE_CGAL` | `ON` (自动) | CGAL 几何引擎 |
| `ENABLE_MANIFOLD` | `ON` (自动) | Manifold 几何引擎 |
| `ENABLE_LIBZIP` | `ON` (自动) | libzip（3MF v4 打包） |
| `ENABLE_LIB3MF` | `ON` (自动) | lib3mf（标准 3MF 导出） |

### 产物结构

```
build-cli/
├── openscad                  ← CLI 可执行文件
├── OpenSCADUnitTests         ← 单元测试
├── libopenscadinternal.a     ← 内核静态库
└── locale/                   ← 编译后的 .mo 语言文件
```

## 增量编译

```bash
cd build-cli
cmake .. -DCMAKE_BUILD_TYPE=Release -DHEADLESS=ON -DEXPERIMENTAL=ON
make -j$(nproc)
```

## 打包发布

```bash
./scripts/pack-openscad-cli.sh build-cli YYYY.MM.DD
```

### 打包产物

```
build-cli/
├── openscad-cli-YYYY.MM.DD-linux-x86_64.tar.gz     ← 发布包
└── openscad-cli-YYYY.MM.DD/                        ← 解压后目录
    ├── bin/openscad          ← 启动脚本 (LD_LIBRARY_PATH)
    ├── lib/openscad/         ← 二进制 + 依赖 .so
    ├── libraries/            ← SCAD 第三方库 (BOSL2, MCAD...)
    ├── examples/             ← 示例
    ├── color-schemes/
    ├── fonts/
    ├── locale/
    └── shaders/
```

## 验证

```bash
# 版本
./build-cli/openscad --version

# 标准 3MF 导出
./build-cli/openscad -o test.3mf --export-format 3mf - <<< "cube(10);"

# 3MF v4 (OrcaSlicer) 导出
./build-cli/openscad -o test.3mf --export-format 3mf_v4 \
  -O 'export-3mf/filament-colors=PLA|#FF0000FF\nPETG|#0066FFFF' \
  - <<< "color(\"red\") cube(10); color(\"blue\") sphere(r=5);"

# 单元测试
./build-cli/OpenSCADUnitTests
```

## 相关文档

- [build-web.md](build-web.md) — WASM 构建说明
- [build-cli-musl.md](build-cli-musl.md) — 静态链接 musl 构建说明
- [OpenSCAD 3MF v4 (OrcaSlicer) 导出完整参考.md](../OpenSCAD%203MF%20v4%20(OrcaSlicer)%20导出完整参考.md)
