# OpenSCAD 服务端-客户端 Demo

**架构**: 服务端渲染，浏览器预览。浏览器端绝不执行 SCAD 脚本。

```
┌─ 浏览器 (客户端) ────────────────────────┐   ┌─ 服务端 (Node.js) ────┐
│                                          │   │                       │
│  CodeMirror 编辑器 ── POST /api/render ─►│   │  openscad CLI          │
│  Three.js STL 预览  ◄── binary STL ─────►│   │  (HEADLESS 构建)       │
│  PNG 预览           ◄── image/png ──────►│   │                        │
│  文件导出下载        ◄── file ───────────►│   │  进程池                 │
│                                          │   │  超时控制               │
└──────────────────────────────────────────┘   └────────────────────────┘
```

## 快速开始

### 1. 编译 OpenSCAD CLI（无头模式）

```bash
cd /path/to/openscad
mkdir -p build-cli && cd build-cli
cmake -DHEADLESS=ON -DCMAKE_BUILD_TYPE=Release ..
make -j$(nproc)
```

编译产出 `openscad` 二进制文件（无需 GUI，无需 OpenGL）。

### 2. 启动服务端

```bash
cd examples/ServerClient
OPENSCAD_BIN=../../build-cli/openscad node server.js
```

或使用默认路径：
```bash
npm start
```

服务端启动于 `http://127.0.0.1:3000`。

### 3. 打开客户端

在浏览器中访问 `http://127.0.0.1:3000`。

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/health` | 服务状态、版本、并发数 |
| `POST` | `/api/render` | SCAD 源码 → 二进制 STL（3D 网格） |
| `POST` | `/api/preview` | SCAD 源码 → PNG 图片 |
| `POST` | `/api/export?format=<格式>` | SCAD 源码 → 任意导出格式 |

### curl 命令行等价示例

```bash
# STL 渲染
curl -X POST --data-binary @demo-box.scad http://127.0.0.1:3000/api/render -o result.stl

# PNG 预览
curl -X POST --data-binary @demo-box.scad http://127.0.0.1:3000/api/preview -o result.png

# 3MF 导出
curl -X POST --data-binary @demo-box.scad 'http://127.0.0.1:3000/api/export?format=3mf' -o result.3mf

# 健康检查
curl http://127.0.0.1:3000/api/health
```

## 配置项

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `PORT` | `3000` | HTTP 服务端口 |
| `HOST` | `127.0.0.1` | 绑定地址（`0.0.0.0` 表示公网可访问） |
| `OPENSCAD_BIN` | `../../build-cli/openscad` | openscad 二进制路径 |
| `RENDER_TIMEOUT` | `60000` | 单次渲染最大耗时（毫秒） |
| `MAX_CONCURRENT` | `4` | 最大并发渲染数 |
| `MAX_BODY_SIZE` | `2097152` | SCAD 源码最大体积（2MB） |

## 局域网/本机跨系统访问

### 场景一：Windows 宿主机访问 WSL 内服务

WSL2 与 Windows 处于同一虚拟子网，Windows 可直接访问 WSL IP。

```bash
# 1. WSL 中启动服务端时绑定 0.0.0.0（而非默认的 127.0.0.1）
HOST=0.0.0.0 OPENSCAD_BIN=../../build-cli/openscad node server.js

# 2. 查看 WSL IP
hostname -I | awk '{print $1}'
# 示例输出: 172.26.236.81

# 3. Windows 浏览器访问
# http://172.26.236.81:3000
```

### 场景二：局域网其他电脑访问

WSL2 默认使用 NAT 网络，局域网电脑无法直接访问 WSL 内网 IP。
需要通过 Windows 端口转发将流量代理到 WSL。

**前提**：服务端已按场景一绑定 `0.0.0.0`。

**步骤 1** — Windows 端口转发（PowerShell 管理员）：

```powershell
# WSL 服务运行在 172.26.236.81:3000
# Windows 监听 0.0.0.0:3000 → 转发到 WSL
netsh interface portproxy add v4tov4 listenport=3000 listenaddress=0.0.0.0 connectport=3000 connectaddress=127.0.0.1

# 查看已有转发规则
netsh interface portproxy show v4tov4
```

> **说明**：WSL2 会自动将 Windows `127.0.0.1` 的端口映射到 WSL 内部对应端口，
> 因此不需要写 WSL 内部 IP，直接用 `127.0.0.1` 即可（与 SSH 转发 2222→127.0.0.1:22 同理）。

**步骤 2** — 防火墙放行（PowerShell 管理员）：

```powershell
New-NetFirewallRule -DisplayName "OpenSCAD Server" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
```

**步骤 3** — 查看 Windows 局域网 IP：

```powershell
ipconfig | findstr "172.16"
# 示例输出: 172.16.3.218
```

**步骤 4** — 局域网其他电脑访问：

```
http://172.16.3.218:3000
```

### WSL2 重启后更新端口转发

WSL2 重启后内部 IP 可能变化，需要更新转发规则：

```bash
# 在 WSL 中执行，自动更新 Windows 端口转发
WSL_IP=$(hostname -I | awk '{print $1}')
netsh.exe interface portproxy delete v4tov4 listenport=3000 listenaddress=0.0.0.0 2>/dev/null
netsh.exe interface portproxy add v4tov4 listenport=3000 listenaddress=0.0.0.0 connectport=3000 connectaddress=$WSL_IP
echo "端口转发已更新 → $WSL_IP:3000"
```

## 安全提醒

这是一个 **演示项目** —— 不适合直接用于生产环境：

- `openscad` 以子进程方式运行，拥有完整系统访问权限
- SCAD 脚本可通过 `include<>` 读取文件系统
- 无沙箱隔离、无身份认证、无频率限制
- 生产环境建议：在 Docker/容器中运行，配合文件系统隔离

## 架构决策

**为什么不在浏览器中用 WASM？**
- Manifold SIMD 加速在 WASM 中受限
- 大型/复杂模型会阻塞 UI 线程
- 服务端可以实现缓存、队列和硬件扩展

**为什么用原生 CLI（而非 Node.js + WASM）？**
- 完整性能（SIMD、多线程）
- 每个请求进程级隔离
- 更易约束资源（cgroups、ulimit、seccomp）
- 经过多年生产验证的成熟 CLI

**浏览器端的职责：**
- 编辑器：CodeMirror（仅语法高亮）
- 预览：Three.js STLLoader（纯渲染，不涉及几何运算）
- 所有计算：服务端 OpenSCAD CLI 完成

## 文件清单

```
ServerClient/
├── server.js           # Node.js HTTP 服务（零依赖）
├── client/
│   ├── index.html      # Web 前端页面
│   ├── app.js          # 客户端逻辑（Three.js + CodeMirror）
│   └── style.css       # 深色主题样式
├── demo-box.scad       # 示例：带孔圆角盒体
├── demo-gear.scad      # 示例：参数化齿轮
├── demo-csg.scad       # 示例：复杂 CSG 布尔运算
├── package.json        # 项目元信息
└── README.md           # 本文件
```
