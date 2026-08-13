# OpenSCAD 服务端-客户端 Demo

**架构**: 服务端渲染，浏览器预览。浏览器端绝不执行 SCAD 脚本。

```
┌─ 浏览器 (客户端) ────────────────────────────┐   ┌─ 服务端 (Node.js) ────┐
│                                              │   │                       │
│  CodeMirror 编辑器 ── POST /api/render ──────►│   │  openscad CLI          │
│  Customizer 参数面板 ── ?D=var=val ──────────►│   │  (HEADLESS 构建)       │
│  Three.js STL 预览  ◄── binary STL ──────────►│   │                        │
│  PNG 预览           ◄── image/png ───────────►│   │  进程池                 │
│  文件导出下载        ◄── file ───────────────►│   │  超时控制               │
│                                              │   │                        │
│  自动参数检测 ◄── POST /api/params ──────────►│   │  --export-format=param  │
└──────────────────────────────────────────────┘   └────────────────────────┘
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
HOST=0.0.0.0 OPENSCAD_BIN=../../build-cli/openscad node server.js
```

或使用默认路径（仅本机可访问）：
```bash
npm start
```

服务端启动于 `http://127.0.0.1:3000`（`HOST=0.0.0.0` 时其他设备可通过局域网访问，见下文"局域网访问"章节）。

### 3. 打开客户端

在浏览器中访问 `http://127.0.0.1:3000`。

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/health` | 服务状态、版本、并发数 |
| `POST` | `/api/render` | SCAD 源码 → 二进制 STL（3D 网格） |
| `POST` | `/api/preview` | SCAD 源码 → PNG 图片 |
| `POST` | `/api/export?format=<格式>` | SCAD 源码 → 任意导出格式 |
| `POST` | `/api/params` | SCAD 源码 → Customizer 参数定义 JSON |

所有渲染/导出接口均支持查询参数 `?D=var=val` 注入变量，可多次使用：
```
POST /api/render?D=width=50&D=material="ABS"
```

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

# 提取参数定义
curl -X POST --data-binary @demo-box.scad http://127.0.0.1:3000/api/params

# 带变量注入的渲染
curl -X POST --data-binary @demo-box.scad \
  'http://127.0.0.1:3000/api/render?D=box_width%3D50&D=material%3D"ABS"' -o result.stl
```

## Customizer 参数面板

客户端内置 Customizer 参数自动识别功能：

1. **自动检测**：编辑器输入 SCAD 后，自动调用 `/api/params` 提取参数定义（600ms 防抖）
2. **分组显示**：参数按 `/*[Group]*/` 注释分组折叠，`/*[Hidden]*/` 组自动过滤
3. **类型适配**：每种参数类型渲染对应控件
4. **参数注入**：仅修改过的参数通过 `?D=name=val` 传递到服务端

### 支持的参数类型

| SCAD 注释语法 | 参数类型 | 客户端控件 |
|---------------|----------|-----------|
| `x = 30; // [20:5:60]` | Number（范围+步进） | Slider + Number input |
| `x = 2; // [1, 2, 3]` | Number（枚举） | Dropdown |
| `x = true;` | Boolean | Checkbox |
| `x = "PLA"; // ["PLA", "ABS"]` | String（枚举） | Dropdown |
| `x = "hello";` | String | Text input |
| `x = [1,2,3];` | Vector | 多个 Number input |

### SCAD 参数标注示例

```openscad
/* [尺寸] */
// 盒体宽度
box_width = 30;   // [20:5:60]
// 盒体深度
box_depth = 20;   // [15:5:40]
// 壁厚
wall = 2;         // [1:0.5:5]

/* [孔洞] */
// 螺丝孔径
hole_d = 3.5;     // [2, 2.5, 3, 3.5, 4, 5]
// 显示孔洞
show_holes = true;

/* [材质] */
material = "PLA"; // ["PLA", "ABS", "PETG", "TPU"]

/* [Hidden] */
$fn = 60;  // Hidden 组不会出现在参数面板中
```

> 客户端点击 "参数化" 按钮可加载完整的参数化圆角盒体示例（7 个参数，3 个分组）。

### 参数定义 JSON 格式

`/api/params` 返回的 JSON 由 `openscad --export-format=param` 直接输出，服务端零解析开销：

```json
{
  "title": "model",
  "parameters": [
    {
      "name": "box_width",        // 变量名
      "caption": "盒体宽度",       // 描述（变量上一行注释）
      "group": "尺寸",            // 分组（/*[尺寸]*/）
      "type": "number",          // 类型: number | string | boolean
      "initial": 30.0,           // 默认值
      "min": 20.0,               // 最小值（仅 number）
      "max": 60.0,               // 最大值（仅 number）
      "step": 5.0                // 步进（仅 number）
    },
    {
      "name": "hole_d",          // 数值枚举：type="number" + options
      "group": "孔洞",
      "type": "number",
      "initial": 3.5,
      "options": [
        {"name": "2.5", "value": 2.5},
        {"name": "3.5", "value": 3.5}
      ]
    },
    {
      "name": "show_holes",      // 布尔：type="boolean"
      "type": "boolean",
      "initial": true
    },
    {
      "name": "material",        // 字符串枚举：type="string" + options
      "group": "材质",
      "type": "string",
      "initial": "PLA",
      "options": [
        {"name": "PLA",  "value": "PLA"},
        {"name": "ABS",  "value": "ABS"}
      ]
    }
  ]
}
```

### 客户端控件映射逻辑

```javascript
if (param.type === 'boolean')       → Checkbox
if (param.options)                  → Dropdown（枚举）
if (Array.isArray(param.initial))   → 多个 Number input（Vector）
if (param.type === 'number')        → Slider + Number input
if (param.type === 'string')        → Text input
```

### 参数传递流程

修改后的参数通过 URL 查询字符串传递给服务端，仅传递与默认值不同的参数：

```
用户操作                    客户端                        服务端
─────────                   ──────                        ──────
拖动 box_width 滑块
  → paramValues[name] = 50
  → 点击"3D 预览"
  → sendToServer() 遍历参数
    仅 box_width ≠ 30 (initial)  ✓
    wall = 2 (未修改)            ✗ 跳过
    material = "PLA" (未修改)    ✗ 跳过
  → 拼接 URL:
    POST /api/render?D=box_width%3D50
                         ↓
                    extractDVars(url)
                    → ['-D', 'box_width=50']
                         ↓
                    spawn('openscad', [
                      '-o', 'output.stl',
                      '-D', 'box_width=50',
                      'model.scad'
                    ])
                         ↓
                    CLI 把 -D 参数追加到 SCAD 末尾
                    等效于在源码尾部添加: box_width=50;
                    覆盖原始变量定义
                         ↓
                    返回用新参数渲染的 STL
```

**值格式化规则**（`app.js`）：

| JS 类型 | `-D` 格式 | 示例 |
|---------|-----------|------|
| Number | `name=N` | `-D box_width=50` |
| String | `name="V"` | `-D material="ABS"` |
| Boolean | `name=true/false` | `-D show_holes=false` |
| Array | `name=[a,b,c]` | `-D pos=[10,20,30]` |

**调试**：F12 → Network → 点击 `render` 请求 → 查看 URL 中的 `?D=...` 参数。

## 配置项

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `PORT` | `3000` | HTTP 服务端口 |
| `HOST` | `127.0.0.1` | 绑定地址（`0.0.0.0` 表示公网可访问） |
| `OPENSCAD_BIN` | `../../build-cli/openscad` | openscad 二进制路径 |
| `RENDER_TIMEOUT` | `60000` | 单次渲染最大耗时（毫秒） |
| `MAX_CONCURRENT` | `4` | 最大并发渲染数 |
| `MAX_BODY_SIZE` | `2097152` | SCAD 源码最大体积（2MB） |

## OpenSCAD CLI 运行时参数

服务端底层调用 `openscad` 命令行工具，以下是其支持的完整参数列表。

### 基本用法

```
openscad [options] file.scad
```

### 导出控制

| 参数 | 说明 |
|------|------|
| `-o <file>` | 导出文件路径。文件扩展名决定导出格式。支持多个 `-o` 同时导出多种格式。使用 `-` 输出到 stdout |
| `--export-format <fmt>` | 覆盖 `-o` 的扩展名自动检测。例如 `asciistl`（ASCII STL）、`binstl`（二进制 STL）、`3mf_v4`（OrcaSlicer 兼容 3MF） |

### 导出格式

`-o` 文件扩展名支持的格式：

| 格式 | 用途 |
|------|------|
| `stl` | 3D 网格（默认 ASCII，推荐显式指定 `--export-format binstl`） |
| `off` | OFF 3D 网格 |
| `wrl` | VRML |
| `amf` | Additive Manufacturing Format |
| `3mf` | 3D Manufacturing Format（含 `3mf_v4` OrcaSlicer 兼容版） |
| `csg` | CSG 树文本 |
| `dxf` | 2D DXF 线框 |
| `svg` | 2D SVG 矢量图 |
| `pdf` | 2D PDF |
| `png` | PNG 渲染图片 |
| `echo` | 仅输出 echo() 结果，不计算几何体 |
| `ast` | AST 抽象语法树 |
| `term` | CSG 表达式树 |
| `nef3` / `nefdbg` | CGAL Nef 多面体（调试用） |
| `param` | 自定义参数文件 |
| `pov` | POV-Ray 场景文件 |

### 导出设置

| 参数 | 说明 |
|------|------|
| `-O <section/key=value>` | 设置导出选项。例如 `-O export-pdf/paper-size=a3`。使用 `--help-export` 查看所有可用设置 |

### 变量与参数

| 参数 | 说明 |
|------|------|
| `-D var=val` | 预定义变量，可多次使用 |
| `-p <file>` | 自定义参数文件（JSON） |
| `-P <set>` | 自定义参数集名称 |

### 相机控制（PNG 导出）

| 参数 | 说明 |
|------|------|
| `--camera <params>` | 相机参数：`translate_x,y,z,rot_x,y,z,dist` 或 `eye_x,y,z,center_x,y,z` |
| `--autocenter` | 自动居中到物体中心 |
| `--viewall` | 自动调整相机以包含全部物体 |
| `--projection <o\|p>` | 投影模式：`o` 正交 / `p` 透视 |
| `--imgsize <w,h>` | PNG 导出尺寸（像素） |

### 渲染控制

| 参数 | 说明 |
|------|------|
| `--render` | 导出 PNG 时进行完整几何求值 |
| `--preview [=throwntogether]` | 预览模式 PNG（OpenCSG，加 `throwntogether` 切换风格） |
| `--backend <CGAL\|Manifold>` | 3D 渲染后端（默认 Manifold，CGAL 精确但慢） |
| `--csglimit <n>` | 预览模式下 CSG 元素上限 |

### 动画

| 参数 | 说明 |
|------|------|
| `--animate <N>` | 导出 N 帧动画（需要 `$t` 变量） |
| `--animate_sharding <shard/num>` | 并行渲染拆分：`2/5` 表示处理 5 分片中的第 2 份 |

### 视图与调试

| 参数 | 说明 |
|------|------|
| `--view <options>` | 视图选项（逗号分隔）：`axes`、`crosshairs`、`edges`、`scales` |
| `--colorscheme <name>` | 配色方案。可用：`Cornfield`（默认）、`Metallic`、`Sunset`、`Starnight`、`BeforeDawn`、`Nature`、`Daylight Gem`、`Nocturnal Gem`、`DeepOcean`、`Solarized`、`Tomorrow`、`Tomorrow Night`、`ClearSky`、`Monotone` |
| `--summary <items>` | 启用渲染统计：`all`、`cache`、`time`、`camera`、`geometry`、`bounding-box`、`area` |
| `--summary-file <file>` | 统计信息 JSON 输出（`-` 为 stdout） |

### 其他

| 参数 | 说明 |
|------|------|
| `-d <file>` | 生成 Make 依赖文件 |
| `-m <cmd>` | 文件缺失时调用 make 命令 |
| `-q` / `--quiet` | 安静模式（仅输出错误） |
| `--hardwarnings` | 遇到第一个警告即停止 |
| `--trace-depth <n>` | 最大 trace 输出深度 |
| `--check-parameters <true/false>` | 用户模块/函数的参数检查 |
| `--check-parameter-ranges <true/false>` | 内置模块参数范围检查 |
| `--debug <all\|files>` | 调试输出（指定 `all` 或源文件名） |
| `-h` / `--help` | 显示帮助信息 |
| `--help-export` | 列出所有可用的导出设置 |
| `-v` / `--version` | 显示版本号 |
| `--info` | 显示构建信息和库依赖 |

### 实验性功能

使用 `--enable <feature>` 启用，`--enable all` 启用全部：

| 功能 | 说明 |
|------|------|
| `roof` | roof() 模块 |
| `lazy-union` | 惰性求值 union |
| `textmetrics` | textmetrics() 函数 |
| `import-function` | import() 函数 |
| `object-function` | object() 函数 |
| `predictible-output` | 可预测输出 |
| `vector-swizzle` | 向量分量访问 |
| `discretization-by-error` | 按误差离散化 |
| `ai-features` | AI 功能 |

### 服务端当前使用的参数

`server.js` 中各 API 实际传递的参数（`...dArgs` 为用户通过 `?D=` 注入的变量）：

```javascript
// /api/params (参数定义提取)
['-o', outputPath, '--export-format=param', inputPath]

// /api/render (STL)
['-o', outputPath, ...dArgs, inputPath]

// /api/preview (PNG)
['-o', outputPath, ...dArgs, '--render', '--viewall', '--autocenter',
 '--imgsize=800,600', '--colorscheme=Cornfield', inputPath]

// /api/export?format=3mf (3MF v4 OrcaSlicer)
['-o', outputPath, ...dArgs, '--export-format', '3mf_v4', inputPath]

// /api/export?format=png (PNG 导出)
['-o', outputPath, ...dArgs, '--render', '--viewall', '--autocenter',
 '--imgsize=1024,768', inputPath]
```

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
├── server.js           # Node.js HTTP 服务（零依赖，6 个 API 端点）
├── client/
│   ├── index.html      # Web 前端页面
│   ├── app.js          # 客户端逻辑（Three.js + CodeMirror + 参数面板）
│   └── style.css       # Catppuccin Mocha 深色主题
├── demo-box.scad       # 示例：带孔圆角盒体
├── demo-gear.scad      # 示例：参数化齿轮
├── demo-csg.scad       # 示例：复杂 CSG 布尔运算
├── package.json        # 项目元信息
└── README.md           # 本文件
```
