# OpenSCAD build-cli-musl 构建说明

## 概述

`build-cli-musl` 是基于 Alpine musl libc 的可移植 CLI 版本。将二进制 + musl loader + 依赖 .so 打包在一起，通过 `ld-musl` 启动，可在任意 Linux x86_64 系统上运行。

## 构建环境

- **构建方式**: Docker (Alpine Edge)
- **libc**: musl（动态链接，.so 随包携带）
- **产物**: 自包含目录 + tar.gz 压缩包

## 构建步骤

### 1. 构建 Docker 镜像

Dockerfile 位于 `build-cli-musl/Dockerfile`，分三个阶段：

1. **安装构建依赖** — Alpine 系统包（不含 Qt5）
2. **编译 lib3mf** — 从 GitHub 源码构建 v2.3.0
3. **编译 OpenSCAD** — HEADLESS + NULLGL 模式
4. **打包** — 收集二进制 + .so + musl loader + 资源

```bash
cd /home/hanson/OpenSCAD/openscad

docker build \
  --platform=linux/amd64 \
  -t openscad-musl:latest \
  -f build-cli-musl/Dockerfile \
  .
```

### 2. 打包发布（在容器内完成，避免 symlink 断链）

```bash
cd /home/hanson/OpenSCAD/openscad

docker run --rm --platform=linux/amd64 \
  -v "$PWD/build-cli-musl:/out" \
  openscad-musl:latest sh -c '
set -e
VERSION=2026.07.31
PKG=/tmp/openscad-musl-${VERSION}
rm -rf $PKG
mkdir -p $PKG/bin $PKG/lib/openscad

cp /opt/openscad-cli/bin/openscad $PKG/lib/openscad/
cp /lib/ld-musl-x86_64.so.1 $PKG/lib/openscad/

# 关键：用 readlink -f 解析 symlink，复制真实 .so 文件
for lib in $(ldd /opt/openscad-cli/bin/openscad 2>/dev/null | grep -o "/[^ ]*"); do
  real=$(readlink -f "$lib" 2>/dev/null || echo "$lib")
  if [ -f "$real" ]; then
    base=$(basename "$real")
    cp "$real" "$PKG/lib/openscad/$base"
    linkname=$(basename "$lib")
    [ "$linkname" != "$base" ] && ln -sf "$base" "$PKG/lib/openscad/$linkname"
  fi
done

# 启动脚本
cat > $PKG/bin/openscad << LAUNCHER
#!/bin/sh
DIR="\$(cd "\$(dirname "\$0")" && pwd)"
LIBDIR="\$DIR/../lib/openscad"
export OPENSCADPATH="\$DIR/.."
exec "\$LIBDIR/ld-musl-x86_64.so.1" --library-path "\$LIBDIR" "\$LIBDIR/openscad" "\$@"
LAUNCHER
chmod +x $PKG/bin/openscad

# 资源文件
for d in color-schemes examples fonts libraries locale shaders; do
  [ -d "/opt/openscad-cli/share/openscad/$d" ] && cp -a /opt/openscad-cli/share/openscad/$d $PKG/
done

# 验证 & 打包
$PKG/bin/openscad --version
cd /tmp
tar czf /out/openscad-musl-${VERSION}-linux-x86_64.tar.gz openscad-musl-${VERSION}
'
```

### 快捷方式

```bash
# 一键构建 + 打包
cd /home/hanson/OpenSCAD/openscad
docker build --platform=linux/amd64 -t openscad-musl:latest -f build-cli-musl/Dockerfile . && \
docker run --rm --platform=linux/amd64 -v "$PWD/build-cli-musl:/out" openscad-musl:latest \
  sh -c 'cd /tmp && ...'  # 见上方完整脚本
```

或者用已有的打包脚本（需在容器内运行）：

```bash
# scripts/pack-openscad-cli.sh 设计为宿主机使用，musl 版本需传 LIB_SRC 路径
# 推荐直接用上面的 docker run 方式，更可靠
```

## CMake 选项说明

| 选项 | 值 | 说明 |
|---|---|---|
| `HEADLESS` | `ON` | 无 GUI |
| `NULLGL` | `ON` | 无 OpenGL 依赖 |
| `EXPERIMENTAL` | `ON` | 启用 3MF v4 等实验功能 |

## 与 build-cli 的区别

| 项目 | build-cli | build-cli-musl |
|---|---|---|
| libc | glibc 动态链接 | musl（.so 随包携带） |
| 启动方式 | LD_LIBRARY_PATH | ld-musl --library-path |
| 可移植性 | 需匹配 glibc 版本 | 任意 Linux x86_64 |
| 体积 | ~17MB (不含库) | ~200MB (含全部 .so) |
| 构建 | 本地 cmake | Docker Alpine |
| NULLGL | OFF | ON |

## 产物结构

```
build-cli-musl/
├── openscad-musl-YYYY.MM.DD-linux-x86_64.tar.gz   ← 发布包 (~110MB)
└── openscad-musl-YYYY.MM.DD/                      ← 解压后 (~200MB)
    ├── bin/openscad          ← 启动脚本（调用 ld-musl）
    ├── lib/openscad/         ← 二进制 + musl loader + 全部 .so
    ├── color-schemes/
    ├── examples/
    ├── fonts/
    ├── libraries/
    ├── locale/
    └── shaders/
```

## 验证

```bash
# 查看依赖（应为 musl .so，非系统 glibc）
./build-cli-musl/openscad-musl-*/bin/openscad --version
# OpenSCAD version 2026.07.31

# 检查启动器使用的 loader
head -1 build-cli-musl/openscad-musl-*/lib/openscad/ld-musl-x86_64.so.1
# ELF 64-bit LSB shared object, x86-64

# 不依赖系统 .so
ldd build-cli-musl/openscad-musl-*/lib/openscad/openscad 2>&1 | grep "not found"
# (应无输出，或仅有 ld-musl 相关)
```

## 常见问题

### `docker cp` 提取 .so 时 symlink 断链

**原因**: `docker cp` 保留 symlink，但目标文件不在同一路径。

**解决**: 必须**在容器内打包**（tar 在容器内解析 symlink），然后从 `/out` 挂载目录获取 tar.gz。

### 构建缓存

Alpine `apk` 下载每次都走网络，慢时可用 `--no-cache` 外的本地缓存镜像加速。

## 相关文档

- [build-cli.md](build-cli.md) — 动态链接 CLI 构建说明
- [build-web.md](build-web.md) — WASM 构建说明
- [build.md](build.md) — 构建总览
