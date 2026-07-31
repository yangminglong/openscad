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

# 4. Package (in-container packaging avoids symlink issues)
RUN mkdir -p /pkg/bin /pkg/lib/openscad && \
    cp /opt/openscad-cli/bin/openscad /pkg/lib/openscad/ && \
    cp /lib/ld-musl-x86_64.so.1 /pkg/lib/openscad/ && \
    for lib in $(ldd /opt/openscad-cli/bin/openscad 2>/dev/null | grep -o '/[^ ]*'); do \
      [ -f "$lib" ] && cp -P "$lib" /pkg/lib/openscad/; \
    done && \
    printf '#!/bin/sh\nDIR="$$(cd "$$(dirname "$$0")" && pwd)"\nLIBDIR="$$DIR/../lib/openscad"\nexport OPENSCADPATH="$$DIR/.."\nexec "$$LIBDIR/ld-musl-x86_64.so.1" --library-path "$$LIBDIR" "$$LIBDIR/openscad" "$$@"\n' > /pkg/bin/openscad && \
    chmod +x /pkg/bin/openscad && \
    for d in color-schemes examples fonts libraries locale shaders; do \
      if [ -d "/opt/openscad-cli/share/openscad/$d" ]; then \
        cp -a "/opt/openscad-cli/share/openscad/$d" /pkg/; \
      elif [ -d "/src/$d" ]; then \
        cp -a "/src/$d" /pkg/; \
      fi; \
    done && \
    cp -a /opt/openscad-cli/share/openscad/locale /pkg/ 2>/dev/null || true && \
    strip /pkg/lib/openscad/openscad 2>/dev/null || true && \
    echo "Packaging done"

# 5. Extract package from container
#    docker build -t openscad-musl . && docker run --rm openscad-musl tar czf - -C /pkg . > openscad-musl.tar.gz
