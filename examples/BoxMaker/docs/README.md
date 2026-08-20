# BoxMaker — 参数化收纳盒生成器

基于浏览器的收纳盒/分隔件设计工具：在 2D 打印板上绘制轮廓（可导入照片草图描线），由 **OpenSCAD WASM 在浏览器内**渲染生成 STL 模型，Three.js 实时 3D 预览。零构建工具、纯原生 JS + 本地 vendored 库。

## 功能

- **2D 编辑器**（Fabric.js）：矩形/圆形/正多边形/钢笔工具、顶点编辑（双击增删节点）、多选、滚轮缩放、床面平移、属性面板
- **照片草图**：导入多角度照片 → 主画布 4 点透视矫正（DLT 单应矩阵 + 反向映射双线性 warp）→ 双标定（A4/银行卡预设 或 参考线+长度）→ 草图层（锁定/解锁拖动、X/Y/W/H 编辑、透明度）；可生成 A4 标定纸（300dpi PNG）
- **对象列表**：选中同步、显隐（隐藏不导出）、删除
- **3D 预览**：官方 OrbitControls（Z 天顶、3/4 透视默认视角、左/右键旋转、中键平移、滚轮缩放）、平台 XY + 高度 Z（与 SCAD 坐标 1:1）、圆角平台、可交换视图
- **SCAD 代码视图**（CodeMirror 5 只读）：预览窗下方浮动窗口、左侧拉手调宽、折叠/复制、随模型防抖同步；输出模块化结构 `module plate(){...} module walls(){...} plate(); walls();`
- **应用设置**（持久化 localStorage）：
  - 轮廓模式：原始轮廓（嵌套实体/孔语义）/ 墙模式
  - 墙模式：偏置方向（内/外/两侧，两侧各偏壁厚一半）、默认壁厚
  - 默认拉伸高度（每图形属性初始值，任意模式）
  - 底板：类型（无/轮廓/边界框/凸包）、厚度（=全局底板厚）、外边距（外偏置）
- **每图形导出属性**：壁厚（墙模式）、拉伸高度（右侧属性面板可编辑）
- **导出**：STL（WASM 渲染 + 下载）、3MF 选项（未接管线）、复制 SCAD 代码

## 运行

仓库根目录起 HTTP 服务（WASM 相对路径 `../../build-web/` 要求 HTTP，不能 file://）：

```bash
cd <openscad 仓库根目录>
python -m http.server 8080
# 或 npx http-server
```

打开 `http://localhost:8080/examples/BoxMaker/index.html`。

依赖本仓库的 Emscripten 构建产物 `build-web/openscad.js` + `openscad.wasm`（见仓库 WASM 构建配置）。

## 架构（详见 [design.md](design.md)）

```text
用户操作 → Model 数据更新 → Renderer 重建 Fabric 对象 → renderAll()
```

- **单一数据源**：图形坐标统一存 Model（bed mm）；Fabric 对象只是视图，每次修改全量重建
- **单一坐标入口**：bed ↔ canvas 换算只在 Scene；原点 = 打印区左下角，范围 [0,w]×[0,h]，四周 5mm 边距仅视觉
- **Bed 对象（OO）**：`Bed {w, h, margin}` + `BED_CATALOG`，Scene 视口持有当前床（setBed/findSmallestBed），2D 网格/轴、SCAD、3D 平台同源
- **导出管线**：`generateSCAD()` → WASM FS.writeFile → `callMain(["--export-format","binstl",...])` → 二进制 STL → 下载 + Three.js 预览（3D 纯下游，不回写）
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
node docs/test-scad-expr.js        # SCAD 表达式回归 (8 项)
```

手动清单见 design.md「测试」章节。

## 已知限制

1. 工具栏 3MF 选项未接管线（下载固定 STL）
2. 嵌套第 3 层（孔中岛, depth≥2）不导出
3. 草图不持久化；镜头桶形畸变不矫正（建议 2× 变焦拍摄）
4. 2D 中键平移床面后重建会重新居中（平移未真正生效）
5. 交换视图的 2D mini 模式下顶点编辑覆盖层会错位
6. 全局参数·壁厚滑条（外壳移除后）暂无用途，保留待重新定义
