# BoxMaker — 参数化收纳盒生成器

基于浏览器的收纳盒/分隔件设计工具：在 2D 打印板上绘制轮廓（可导入照片草图描线），由本地 **OpenSCAD CLI 服务端**渲染生成 STL/3MF，Three.js 在浏览器中实时预览。前端是原生 JS + 本地 vendored 库，SCAD 执行不在浏览器内进行。

## 功能

- **2D 编辑器**（Fabric.js）：矩形/圆形/正多边形/钢笔工具、顶点编辑（双击增删节点）、多选、滚轮缩放、床面平移、属性面板
- **照片草图**：导入多角度照片 → 主画布 4 点透视矫正（DLT 单应矩阵 + 反向映射双线性 warp）→ 双标定（A4/银行卡预设 或 参考线+长度）→ 草图层（锁定/解锁拖动、X/Y/W/H 编辑、透明度）；可生成 A4 标定纸（300dpi PNG）
- **对象列表**：选中同步、显隐（隐藏不导出）、删除
- **3D 预览**：官方 OrbitControls（Z 天顶、3/4 透视默认视角、左/右键旋转、中键平移、滚轮缩放）、平台 XY + 高度 Z（与 SCAD 坐标 1:1）、圆角平台、可交换视图
- **SCAD 代码编辑器**（CodeMirror 5）：预览窗下方浮动窗口、左侧拉手调宽、折叠/复制；可手写 SCAD，点“预览”或 Ctrl/Cmd+Enter 发给服务端。图形/设置修改会用最新生成代码覆盖未预览草稿。
- **应用设置**（持久化 localStorage）：
  - 轮廓模式：原始轮廓（嵌套实体/孔语义）/ 墙模式
  - 墙模式：偏置方向（内/外/两侧，两侧各偏壁厚一半）、默认壁厚
  - 默认拉伸高度（每图形属性初始值，任意模式）
  - 底板：类型（无/轮廓/边界框/凸包）、厚度（=全局底板厚）、外边距（外偏置）
- **每图形导出属性**：壁厚（墙模式）、拉伸高度（右侧属性面板可编辑）
- **导出**：服务端生成并下载二进制 STL；CLI 构建启用 3MF 时同步支持 3MF（未启用时界面会禁用 3MF）；复制 SCAD 代码。

## 运行

需要先构建可执行的无头 CLI（见 [构建说明/build-cli.md](../../../构建说明/build-cli.md)），并确保 `libraries/BOSL2/std.scad` 可用；BoxMaker 生成的圆角矩形使用 BOSL2。

```bash
cd <openscad 仓库根目录>
# Windows 当前默认路径：build-cli/Release/openscad.exe
# 可按需显式指定任意已构建的 CLI：
OPENSCAD_BIN=/path/to/openscad node examples/BoxMaker/server.js
# Windows PowerShell 示例：
# $env:OPENSCAD_BIN = "D:\\Dev\\OpenSCAD\\openscad\\build-cli\\Release\\openscad.exe"; node examples/BoxMaker/server.js
```

默认监听 `http://127.0.0.1:3001`，打开该地址即可。可用 `HOST`、`PORT`、`RENDER_TIMEOUT`、`MAX_CONCURRENT` 和 `MAX_BODY_SIZE` 覆盖服务配置。

> **安全边界**：编辑器中的 SCAD 会被本机服务直接执行。仅应在可信的本地开发环境运行；不要把服务暴露给不可信用户。SCAD 的 `include`/`import` 等语句可访问服务进程可见的文件。

## 架构（详见 [design.md](design.md)）

```text
用户操作 → Model 数据更新 → Renderer 重建 Fabric 对象 → renderAll()
```

- **单一数据源**：图形坐标统一存 Model（bed mm）；Fabric 对象只是视图，每次修改全量重建
- **单一坐标入口**：bed ↔ canvas 换算只在 Scene；原点 = 打印区左下角，范围 [0,w]×[0,h]，四周 5mm 边距仅视觉
- **Bed 对象（OO）**：`Bed {w, h, margin}` + `BED_CATALOG`，Scene 视口持有当前床（setBed/findSmallestBed），2D 网格/轴、SCAD、3D 平台同源
- **导出管线**：`generateSCAD()` / 手写 SCAD → `POST /api/render` 或 `/api/export` → 独立临时目录中的 OpenSCAD CLI (`binstl` / `3mf`) → 二进制响应 → Three.js 预览或下载。
- **模块**：model / scene(Bed+Scene) / sketch / renderer / overlay / controller / preview(OrbitControls) / codeview / settings / app

## 库（lib/，全部本地 vendored）

| 库 | 版本 | 来源 |
| --- | --- | --- |
| fabric.min.js | 5.3 | Fabric.js |
| three.min.js | r15x | Three.js |
| OrbitControls.js | r157 | threejs.org（ESM→全局转换） |
| codemirror/ | 5.65.18 | cdnjs（css/js/clike/material-darker） |

## 测试

```bash
cd examples/BoxMaker
node docs/test-sketch-math.js      # 单应矩阵数学 (11 项)
node docs/test-sketch-warp.js      # warp 坐标换算 (11 项)
node docs/test-model-outline.js    # 轮廓展开/命中/包含深度 (13 项)
node docs/test-scad-expr.js        # SCAD/BOSL2 表达式回归
node docs/test-library-pan.js       # 图库模板与持久床面平移回归
node docs/test-library-management.js # 图库管理、删除与存储失败回归
node docs/test-controller-input.js  # 编辑器快捷键与绘图工具点击回归
```

手动清单见 design.md「测试」章节。

## 已知限制

1. 3MF 是否可用取决于运行服务的 OpenSCAD CLI 是否在构建时启用了 3MF；服务健康检查会据此禁用选项。
2. 嵌套第 3 层（孔中岛, depth≥2）不导出。
3. 草图不持久化；镜头桶形畸变不矫正（建议 2× 变焦拍摄）。
4. 当前手写 SCAD 仅是一次性草稿；任何图形或设置修改都会按设计覆盖它。
5. 将服务暴露给不可信网络前必须容器化/隔离文件系统与进程资源。
6. 全局参数·壁厚滑条（外壳移除后）暂无用途，保留待重新定义。
