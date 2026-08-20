# OpenSCAD 构建说明

## 构建目标一览

| 目标 | 目录 | 说明 | 产物 |
|---|---|---|---|
| CLI (glibc) | `build-cli/` | 动态链接，本地开发/测试 | `build-cli/openscad` |
| CLI (musl) | `build-cli-musl/` | 静态链接，可移植发布 | `openscad-musl-*.tar.gz` |
| Windows MSVC | `build/` | Visual Studio 2022 无 GUI 构建 | `build/Debug/openscad.exe`、`build/Release/openscad.exe` |
| WASM | `build-web/` | 浏览器运行 | `openscad.js` + `openscad.wasm` |

## 快速开始

```bash
# CLI (glibc) — 推荐开发使用
cmake -B build-cli -S . -DCMAKE_BUILD_TYPE=Release -DHEADLESS=ON -DEXPERIMENTAL=ON
cmake --build build-cli -j$(nproc)

# CLI (musl) — 推荐发布使用
docker build -t openscad-musl -f build-cli-musl/Dockerfile .

# WASM — 浏览器使用
./scripts/wasm-base-docker-run.sh emcmake cmake -B build-web -S . -DCMAKE_BUILD_TYPE=Release -DEXPERIMENTAL=ON
./scripts/wasm-base-docker-run.sh cmake --build build-web -j$(nproc)
```

## Windows MSVC 构建

构建脚本位于 [`scripts/`](../scripts/)；请勿将可执行脚本移动到本说明目录。详细的英文参考见 [doc/win-build.md](../doc/win-build.md)。

### 前置条件

- Visual Studio 2022，并安装 **Desktop development with C++** 工作负载
- CMake
- [vcpkg](https://vcpkg.io/)
- [WinFlexBison](https://github.com/lexxmark/winflexbison)（`win_flex.exe` 与 `win_bison.exe`）
- 已初始化 Visual Studio 编译环境的 Developer Command Prompt

在 PowerShell 中设置 vcpkg；若 WinFlexBison 未加入 `PATH`，也设置其解压目录：

```powershell
$env:VCPKG_ROOT = "C:\path\to\vcpkg"
$env:WIN_FLEX_BISON_DIR = "C:\path\to\winflexbison"
```

`WIN_FLEX_BISON_DIR` 是可选的：当 `win_flex.exe` 和 `win_bison.exe` 已在 `PATH` 中时可省略。

### 下载与构建

可从任意当前目录调用以下脚本。下载器仅将压缩包保存到仓库根目录的 `win_flex_bison.zip`；解压后再设置 `WIN_FLEX_BISON_DIR`。

```bat
call C:\path\to\openscad\scripts\win-msvc-download-winflexbison.bat
call C:\path\to\openscad\scripts\win-msvc-build.bat
```

构建器会生成 headless 的 Debug 和 Release 配置，产物为：

```text
build\Debug\openscad.exe
build\Release\openscad.exe
```

## 核心 CMake 选项

| 选项 | 默认 | 说明 |
|---|---|---|
| `CMAKE_BUILD_TYPE` | — | `Release` / `Debug` |
| `HEADLESS` | `OFF` | `ON`=无 GUI 命令行版 |
| `NULLGL` | `OFF` | `ON`=完全无 OpenGL |
| `EXPERIMENTAL` | `OFF` | `ON`=启用 3MF v4 等实验功能 |
| `ENABLE_CGAL` | `ON` | CGAL 几何引擎 |
| `ENABLE_MANIFOLD` | `ON` | Manifold 几何引擎 |

## 功能矩阵

| 功能 | build-cli | build-cli-musl | build-web |
|---|---|---|---|
| `--export-format 3mf` | ✅ | ✅ | — |
| `--export-format 3mf_v4` | ✅ | ✅ | ✅ |
| `--export-format stl/off/obj` | ✅ | ✅ | — |
| `--export-format binmesh` | ✅ | ✅ | ✅ |
| GUI | ❌ | ❌ | ✅ (浏览器) |
| `lib3mf` | ✅ | ✅ | ❌ |
| `libzip` | ✅ | ✅ | ✅ |
| 单元测试 | ✅ | ❌ | ❌ |

## 详细说明

- [build-cli.md](build-cli.md) — CLI 动态链接 (glibc)
- [build-cli-musl.md](build-cli-musl.md) — CLI 静态链接 (musl)
- [Windows MSVC 构建指南](../doc/win-build.md) — Visual Studio 与 vcpkg
- [build-web.md](build-web.md) — WebAssembly

## 导出格式

| 格式 | 标识符 | 扩展名 | 说明 |
|---|---|---|---|
| STL ASCII | `asciistl` | `.stl` | |
| STL Binary | `binstl` | `.stl` | |
| OBJ | `obj` | `.obj` | |
| OFF | `off` | `.off` | |
| AMF | `amf` | `.amf` | |
| 3MF | `3mf` | `.3mf` | 标准 3MF (lib3mf) |
| 3MF v4 | `3mf_v4` | `.3mf` | OrcaSlicer 兼容 |
| Binary Mesh | `binmesh` | `.binmesh` | 内部格式 |

## 导出命令示例

```bash
# 基础
openscad input.scad -o output.stl

# 指定格式
openscad input.scad -o output.3mf --export-format 3mf

# 3MF v4 + 耗材配置
openscad input.scad -o output.3mf --export-format 3mf_v4 \
  -O 'export-3mf/filament-colors=PLA|#FF0000FF\nPETG|#0066FFFF'

# 查看所有导出参数
openscad --help-export
```

## 单元测试

```bash
cd build-cli
./OpenSCADUnitTests                              # 全部
./OpenSCADUnitTests "FilamentColor*"             # 按名称过滤
./OpenSCADUnitTests --list-tests                 # 列出用例
```

## 相关文档

- [OpenSCAD 3MF v4 (OrcaSlicer) 导出完整参考.md](../OpenSCAD%203MF%20v4%20(OrcaSlicer)%20导出完整参考.md)
