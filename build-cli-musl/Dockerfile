FROM alpine:edge AS builder

# 1. Build dependencies (no Qt5 needed — export_3mf_v3.cc is Qt-free)
RUN apk add --no-cache \
    build-base cmake git curl linux-headers \
    eigen-dev boost-dev \
    gmp-dev mpfr-dev cgal-dev \
    opencsg-dev double-conversion-dev \
    libzip-dev libxml2-dev cairo-dev \
    harfbuzz-dev freetype-dev fontconfig-dev \
    mesa-dev glew-dev onetbb-dev pcre2-dev \
    flex bison gettext bash

# 2. Build lib3mf from source (not available in Alpine repos)
RUN git clone --depth=1 --branch v2.3.0 \
    https://github.com/3MFConsortium/lib3mf.git /opt/lib3mf && \
    cmake -B /opt/lib3mf/build -S /opt/lib3mf \
        -DCMAKE_CXX_FLAGS="-include cstdint" \
        -DCMAKE_BUILD_TYPE=Release \
        -DUSE_INCLUDED_ZLIB=OFF \
        -DUSE_INCLUDED_LIBZIP=OFF \
        -DUSE_INCLUDED_XML2=OFF \
        -DUSE_INCLUDED_AUTOCONF=OFF \
        -DCMAKE_POLICY_VERSION_MINIMUM=3.5 && \
    cmake --build /opt/lib3mf/build -j$(nproc) && \
    cmake --install /opt/lib3mf/build --prefix /usr/local

# 3. Build OpenSCAD (headless, musl)
COPY . /src
WORKDIR /src/build
RUN rm -f CMakeCache.txt && rm -rf CMakeFiles && \
    cmake .. \
    -DCMAKE_BUILD_TYPE=Release \
    -DHEADLESS=ON \
    -DEXPERIMENTAL=ON \
    -DNULLGL=ON && \
    cmake --build . -j$(nproc) && \
    cmake --install . --prefix /opt/openscad-cli
