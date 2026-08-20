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

## 实测踩坑记录（2026-08-13，Ubuntu 22.04 jammy）

本机实际环境为 Ubuntu 22.04 / GCC 11.4 / nproc=64，与上文"构建环境"（24.04 / GCC 13.3）不同，以下为实测成功的额外修补：

1. **子模块为空且无 .git 仓库**：`submodules/` 与 `libraries/MCAD` 均为空目录，需手动获取：
   - `git clone --depth=1 https://github.com/elalish/manifold.git`（实测 v3.5.1，已内置 utilities 无需递归子模块）
   - `git clone --depth=1 https://github.com/AngusJohnson/Clipper2.git`
   - `git clone --depth=1 --branch v2.1.8 https://github.com/microsoft/mimalloc.git`
   - `git clone --depth=1 https://github.com/arsenm/sanitizers-cmake.git`
   - MCAD：git 直连 GitHub 偶发 TLS 断连，改用
     `curl -L https://codeload.github.com/openscad/MCAD/tar.gz/refs/heads/master`
2. **必须补装 `libopengl-dev`**（文档列表遗漏）：缺少 `libOpenGL.so` 开发符号链接时，CMake 的 FindOpenGL 不会创建 `OpenGL::EGL`/`OpenGL::GLX` 导入目标，configure 报错 `Target "OpenGL::EGL" was not found`。
3. **CMake 需 ≥3.25**：jammy 自带 3.22 不够用，实测报错同上。解决：
   `pip3 install cmake`（安装 4.4.2 至 /usr/local/bin，建议走华为云 pip 镜像）
4. **Catch2 v3**：jammy 无 apt 包，从源码编译安装（否则不生成 OpenSCADUnitTests）：
   `git clone -b v3.8.1 https://github.com/catchorg/Catch2.git`，配置时需 `-DCATCH_INSTALL_EXTRAS=ON`（否则缺 Catch.cmake，configure 报 `include(Catch)` 失败），`cmake --install` 到 /usr/local。
5. **测试 venv 的 pip 装 numpy/Pillow 会卡死**（PyPI 直连慢）：configure 期间会卡在
   `build-cli/tests/venv/bin/python -m pip install numpy Pillow`。
   解决：`apt-get install -y python3-numpy python3-pil python3-venv`，venv 为 `--system-site-packages` 可直接使用。

按上述修补后，configure / 编译 / 验证（--version、标准 3MF、3MF v4、OpenSCADUnitTests）全部通过。

## 相关文档

- [build-web.md](build-web.md) — WASM 构建说明
- [build-cli-musl.md](build-cli-musl.md) — 静态链接 musl 构建说明
- [OpenSCAD 3MF v4 (OrcaSlicer) 导出完整参考.md](../OpenSCAD%203MF%20v4%20(OrcaSlicer)%20导出完整参考.md)
