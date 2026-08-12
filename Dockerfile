# =======================================
# OpenSCAD ServerClient Dockerfile
# 多阶段构建：C++ CLI + Node.js 服务
# 启用 BuildKit: DOCKER_BUILDKIT=1
# =======================================

# ---- Stage 1: Build OpenSCAD CLI ----
FROM ubuntu:22.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive

# 使用 cache mount 缓存 apt 包，避免每次重新下载
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake ninja-build git wget pkg-config \
    libboost-all-dev libcgal-dev libgmp-dev libmpfr-dev \
    libqt6opengl6-dev qt6-base-dev qt6-tools-dev \
    libzip-dev libpng-dev libeigen3-dev libglib2.0-dev \
    libharfbuzz-dev libfontconfig1-dev libdouble-conversion-dev libopencsg-dev \
    libgl1-mesa-dev libglu1-mesa-dev libglew-dev libfreetype6-dev libxml2-dev libcairo2-dev \
    flex bison lib3mf-dev libtbb-dev gettext dos2unix \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# 复制源码（包含已初始化的子模块）
COPY . .

# 修复 Windows 换行符（CRLF → LF）
RUN for f in $(find . -type f -name "*.sh"); do tr -d '\r' < "$f" > "$f.tmp" && mv "$f.tmp" "$f"; done; find . -name "*.sh" -exec chmod +x {} \;
RUN echo '#!/bin/sh' > scripts/translation-make.sh && echo 'exit 0' >> scripts/translation-make.sh && chmod +x scripts/translation-make.sh

# 构建并手动安装 headless 版本（跳过 cmake install，直接复制二进制）
RUN cmake -S . -B build -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DHEADLESS=ON \
    -DENABLE_TESTS=OFF \
    && cmake --build build --parallel $(nproc) \
    && mkdir -p /usr/local/bin /usr/local/share/openscad \
    && cp build/openscad /usr/local/bin/ \
    && cp -r build/locale /usr/local/share/openscad/ 2>/dev/null || true

# ---- Stage 2: Runtime ----
FROM ubuntu:22.04

# 从官方镜像复制 Node.js（避免联网安装）
COPY --from=node:18-slim /usr/local/bin/node /usr/local/bin/
COPY --from=node:18-slim /usr/local/bin/npm /usr/local/bin/
COPY --from=node:18-slim /usr/local/lib/node_modules /usr/local/lib/node_modules

ENV DEBIAN_FRONTEND=noninteractive

# 运行时依赖（OpenSCAD CLI 需要）
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    libgmp10 libmpfr6 \
    libqt6core6 libqt6opengl6 \
    libzip4 libpng16-16 libxml2 \
    libharfbuzz0b libfontconfig1 \
    libdouble-conversion3 libtbb12 \
    libglew2.2 libopengl0 libglx0 libglu1-mesa libegl1 \
    libx11-6 libfreetype6 libglib2.0-0 \
    libboost-regex1.74.0 libboost-program-options1.74.0 \
    libcairo2 libopencsg1 lib3mf1 \
    && rm -rf /var/lib/apt/lists/*

# 复制 OpenSCAD CLI、locale 和库
COPY --from=builder /usr/local/bin/openscad /usr/local/bin/
COPY --from=builder /usr/local/share/openscad /usr/local/share/openscad

# 复制 BOSL2 库
COPY libraries/BOSL2 /usr/local/share/openscad/libraries/BOSL2

WORKDIR /app

# 复制服务端和前端
COPY examples/ServerClient/ .

# 添加 package.json 启用 ES Module
RUN echo '{"type": "module"}' > package.json

EXPOSE 3000

ENV HOST=0.0.0.0
ENV PORT=3000
ENV OPENSCADPATH=/usr/local/share/openscad/libraries
ENV OPENSCAD_BIN=/usr/local/bin/openscad

CMD ["node", "server.js"]
