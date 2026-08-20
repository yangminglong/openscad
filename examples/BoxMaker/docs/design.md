# BoxMaker — 数据驱动架构设计 (v5)

## 核心思想

```text
MakerWorld 模式:
  用户操作 → Model 数据更新 → rebuildFromModel() → Fabric 对象重建 → renderAll()
```

- **单一数据源**：所有图形坐标存 Model（bed mm），Fabric 对象只是视图，每次修改全量重建，避免 Fabric 内部坐标状态 bug
- **单一坐标换算入口**：画布 ↔ bed 换算只存在于 Scene；SCAD 导出、3D 预览、草图全部消费同一 bed 坐标系
- **3D 是纯下游**：2D → SCAD → OpenSCAD WASM → STL → Three.js，单向流动，3D 从不回写

## 坐标系（全链路一致）

| 空间 | 定义 |
| --- | --- |
| bed（2D 数据） | 原点 = **打印区左下角**，X 右 / Y 上，范围 [0, w]×[0, h]，单位 mm |
| 显示区 | 打印区 + 四周 margin（5mm）边框；边距**不参与坐标计算**，仅视觉 |
| SCAD | 与 bed 同构：`square([w,h])` + polygon 点原样导出，挤出方向 Z |
| 3D 世界 | **平台在 XY 平面，+Z 为高度** —— 与 SCAD (x,y)+z 一一对应，STL 顶点原样渲染 |
| 2D ↔ 3D 关系 | 2D 场景 = 3D 场景的正俯视（同一 XY 布局，网格同为 10mm/格） |

2D 换算（仅 Scene 内）：

- bed → canvas: `x = bedLeft + (margin + bx)·scale`，`y = bedTop + (displayH − margin − by)·scale`
- canvas → bed: 逆变换

3D 对齐：

- 平台以世界原点为中心（含边距），打印区角 = 世界 (−w/2, −h/2)
- 模型加载时 `mesh.position.set(−w/2, −h/2, 0)` —— 模型 bed 原点角压在 3D 轴角上
- 垂直层序：平台顶面 z=0 > 网格 0.01 > 轴 0.02 > 模型从 0 向上
- 默认视角：3/4 透视（俯角 ~40°，相机在 −Y 侧 `(0, −1.15w, 1.2w)`），轴原点落在窗口左下区域

## Bed 对象（OO 设计）

```javascript
Bed { id, w, h, label, margin }            // 打印盘: 打印区尺寸 + 显示边距
  .displayW() / .displayH()                // 显示尺寸 = 打印区 + margin×2
  .fits(w, h)                              // 能否容纳

BED_CATALOG                                // 床目录 (A1M/A1/P1S/X1C/custom255/custom300)

Scene (视口单例)                           // 持有当前 Bed + 坐标换算 + 2D 床面渲染
  .bed         当前 Bed 实例
  .getBedById(id) / .findSmallestBed(w,h) / .setBed(bed)   // setBed: 下拉框+重建+3D平台同步
  .canvasToBed(cx, cy) / .bedToCanvas(bx, by)
  .rebuild()   床面变化后统一重建: 图形(Renderer) + 草图(Sketch) + 顶点覆盖层(Overlay)
```

消费方全部读 `Scene.bed`：2D 网格/轴、`generateSCAD()` 的 `square([w,h])`、3D 平台/网格/轴、草图自动换床——同一数据源保证三视图一致。

## Model 数据结构

```javascript
shape = {
  id: "shape_1",
  type: "polygon" | "rect" | "circle",
  points: [{x,y}...],       // bed mm
  toolType: "pen" | "rect" | "circle" | "polygon",
  visible: true,            // 隐藏: 不渲染/不可命中/不参与深度/不导出
  wall: 2,                  // 每图形壁厚 (墙模式偏置距离, 初始值 = Model.defaults.wall)
  height: 43.2,             // 每图形拉伸高度 (任意模式, 初始值 = Model.defaults.height)
  rect?: {x, y, w, h, angle, radius},   // 矩形独立属性 (中心/宽高/圆角)
  poly?: {x, y, radius, sides, angle}   // 正多边形独立属性 (被顶点编辑后降级删除)
}
model = { shapes: [], selectedId: null, editId: null }
```

包含深度：`containmentDepth`（偶数=实体，奇数=孔）；隐藏图形不参与计算。

## 模块结构

```text
examples/BoxMaker/
├── index.html           入口: WASM 模块 + 工具条 + 浮动栏 + 对象列表区
├── css/editor.css
├── js/
│   ├── model.js         纯数据模型 + 几何计算 (射线法/包含深度/最近边顶点)
│   ├── scene.js         Bed 类 + BED_CATALOG + Scene 视口 (坐标换算/床面渲染)
│   ├── sketch.js        照片草图: 导入/4点透视矫正/双标定/warp/草图层控制
│   ├── renderer.js      Model → Fabric 对象 (全量重建)
│   ├── overlay.js       SVG 覆盖层 (顶点编辑控制圆)
│   ├── controller.js    交互: 鼠标/键盘/钢笔/多选/平移缩放 (分发至 Sketch→Overlay)
│   ├── preview.js       Three.js 3D 预览 (OrbitControls) + STL 解析
│   ├── codeview.js      SCAD 代码窗口 (CodeMirror 只读 + 左侧拉手调宽 + 折叠/复制)
│   └── app.js           入口 + 属性面板 + 对象列表 + SCAD 生成 + WASM 渲染 + 用户图形库
├── lib/
│   ├── fabric.min.js    Fabric 5.3
│   ├── three.min.js     Three r15x
│   ├── OrbitControls.js 官方 OrbitControls r157 (unpkg 下载, ESM→全局转换)
│   └── codemirror/      CodeMirror 5.65.18 (cdnjs 下载: css/js/clike mode/material-darker 主题)
└── docs/
    ├── README.md       项目说明 (功能/运行/架构/库/测试/限制)
    ├── design.md       本文档
    ├── test-sketch-math.js     单应矩阵数学单测 (node, 11 项)
    ├── test-sketch-warp.js     warp 坐标换算集成测试 (node, canvas stub, 11 项)
    ├── test-model-outline.js   Model 轮廓展开/命中/包含深度 (node, 13 项)
    └── test-scad-expr.js       SCAD 表达式辅助函数回归 (node, 8 项)
```

## 照片草图 (sketch.js)

流程：`📷 导入草图` → 照片铺到主画布（fit 70%，进入矫正模式）→ 拖 4 角点对齐已知矩形 → 应用 → warp 后草图落位 bed。

- **矫正 UI**：主画布内联，SVG 覆盖层 4 角点圆 + 虚线四边形 + 可选参考线；复用滚轮缩放/中键平移；矫正期间禁用画图形/编辑
- **标定（双方式）**：
  - 矫正框物理尺寸：预设 A4 210×297 / A5 / 银行卡 / 自定义 W×H —— 矫正+标定一步完成，mm/px = physH/dstH
  - 参考线 + 输入长度：尺寸未知时，参考线经单应变换后在输出图中的长度反推 mm/px
  - 都没有 → 任意比例（mm/px=1），可用"重新矫正"补救
- **算法**：4 点对应 DLT 解 8×8 线性方程组（高斯-约当，近共线报错）→ 反向映射 + 双线性采样 warp（源图长边 >2400px 先降采样，**采样坐标须乘降采样系数**）
- **自动换床**：`!Scene.bed.fits(w,h)` 时 `setBed(findSmallestBed(...))`
- **草图层状态**：`{img, bedX, bedY, bedWmm, bedHmm, locked, original}`；`reposition()` 按 bed 坐标重放（床平移/缩放/换床后跟随）
- **草图栏**：锁定（默认锁，解锁后 evented 可拖动，拖完回写 bedX/bedY）、X/Y/W/H 可编辑（mm）、透明度、显示、重新矫正、删除
- 草图是**参考层**：不进对象列表、不进 Model、不导出、不持久化

## 对象列表 (app.js)

右侧面板"全局参数"下方，只列图形（Model 顺序 = 层叠顺序）：

- 行点击 → 画布选中（隐藏图形仅高亮行）；画布选中 → 行高亮同步
- 显隐 checkbox → `shape.visible`（隐藏图形不参与导出/深度/命中）
- 删除按钮；空列表显示"暂无图形"

## 代码视图 (codeview.js)

- **布局**：右侧浮动列（`#right-float-col`，上 8/右 8/下 8px 边距）——3D 预览窗在上，SCAD 代码窗口在下，高度 flex 占剩余空间；列容器 `pointer-events:none`、子窗口 auto（缝隙穿透到 2D 画布）
- 编辑器：CodeMirror 5 只读，`text/x-csrc` C-like 高亮，material-darker 主题（与 ServerClient 同款配置）
- **左侧拉手**（`#cw-resizer`）拖拽调整整列宽度（200~560px，预览窗同步），拖动中实时 `Preview3D.fitCanvas()` + `cm.refresh()`
- **标题栏**：折叠按钮（折叠后只显示标题栏，`flex:0 0 auto`）+ 复制按钮（navigator.clipboard，旧浏览器 execCommand 回退）
- 内容 = `generateSCAD()` 输出，同步时机：
  - 渲染成功（导出/自动预览）→ 立即 `refresh()`
  - 图形/参数高频变更（rebuildAll/rebuildOne/全局参数滑条）→ 200ms 防抖 `scheduleCodeRefresh()`
- 预览窗折叠/展开 → `Preview3D.fitCanvas()` 同步渲染尺寸

## 3D 预览 (preview.js)

- **交互**：官方 `THREE.OrbitControls`（Z 天顶 `camera.up=(0,0,1)`，极角钳位 [0.02, π−0.02]，左/右键旋转、中键平移、滚轮缩放，距离限制 [30, 6w]）
- 平台：圆角 r=margin 的挤出板（Shape + ExtrudeGeometry），网格/轴只在打印区
- 3D 轴：红 +X、绿 +Y，位于打印区左下角，方向与 2D 一致
- 加载模型后：orbit 目标 = 模型包围盒中心，相机按默认视角方向复位
- 视图交换（pw-swap）：DOM 对称换位——3D canvas 移入主区铺满（预览窗保持右上角悬浮，不遮挡轨道交互），Fabric 容器移入预览窗作 2D mini 并按窗尺寸 `Scene.rebuild()` 重建；恢复时各自移回并重建。场景数据不变

## 应用设置 (settings.js)

- 入口：工具条最右 `⚙ 设置`，点击弹出 `#settings-pop`（fixed 右上，点击外部/Esc 关闭）；localStorage `boxmaker_settings` 持久化，重置按钮同步复位
- 配置项：
  - **轮廓模式**（`S.outlineMode`）：
    - `original` 原始轮廓模式（默认）：depth 0 挤出实体、depth 1 为孔（嵌套语义）
    - `wall` 墙模式：每个轮廓按偏置方向生成墙（`offset(r=0)` 即原始轮廓；图形过小时内偏置空集退化为实心）
  - **墙模式 · 轮廓偏置方向**（`S.offsetDir`，默认 `inner` 内偏置）：
    - `inner`：原始 − 内偏置(壁厚)（外边界 = 用户轮廓）；`outer`：外偏置(壁厚) − 原始；`both`：各偏壁厚/2（轮廓为中心线，墙总厚 = 壁厚）
  - **默认壁厚**（`S.defaultWall`，默认 2mm）：墙模式图形的偏置距离**初始值**
  - **默认拉伸高度**（`S.defaultHeight`，默认 43.2mm）：每个图形拉伸高度**初始值**（任意轮廓模式）
  - **底板类型**（`S.floorType`，默认 `none`）：`none` 无 / `outline` 轮廓（各图形有效外轮廓单独成板）/ `bbox` 边界框 / `hull` 凸包（`hull()` 所有有效外轮廓）——**导出模型不生成床轮廓的外壳（shell），底板完全由此类型决定**
  - **底板厚度**：= `S.bottom`（与全局参数·底板厚滑条双向同步，不持久化）
  - **底板外边距**（`S.floorMargin`，默认 0mm）：底板轮廓的外偏置量，三种底板类型均生效
  - 图形"有效外轮廓"= 墙模式外/两侧偏置时外扩图形壁厚，内偏置与原始模式即图形本身
  - 图形底部高度 `baseH`：有底板时立于底板上（= S.bottom），无底板时落到 z=0
- 每图形属性：`shape.wall` / `shape.height` 在 `Model.addShape` 时用 `Model.defaults` 初始化；右侧属性面板可单独编辑（壁厚字段仅墙模式显示）；图形库保存/加载携带这两项（旧数据回退默认值）
- SCAD 挤出高度：两种模式均用图形自身 `height`（回退 dh = (S.h−S.bottom)×divRatio）
- 切换任一设置 → 持久化 + `CodeView.refresh()` + autoPreview → `schedulePreview()`（3D 重渲）+ 属性面板字段显隐刷新

## 导出管线

```scad
// 输出结构 (模块化: 顶部定义, 底部调用):
module plate(){
  linear_extrude(2)offset(r=0)hull(){translate([50,60])circle(r=10);translate([100,50])rotate([0,0,0])square([40,20],center=true);polygon(points=[...]);};
}
module walls(){
  translate([0,0,2])linear_extrude(43.2)difference(){offset(r=0)polygon(points=[...]);offset(r=-2)polygon(points=[...]);}
}
plate();
walls();
```

```text
generateSCAD(): module plate(底板: 轮廓/边界框/凸包 + 外边距) + module walls(图形挤出: 原始嵌套/墙偏置) —— 无外壳
  → FS.writeFile(/in*.scad)
  → callMain(["--export-format","binstl","-o",fout,fin])
  → FS.readFile → S.stlData (下载) + parseSTL → Three.js (预览)
```

WASM 加载：ES module + top-level await，`locateFile` 映射 `../../build-web/openscad.wasm`，`openscad-ready` 事件通知经典脚本。

## 已知限制

1. 工具栏 3MF 选项未接管线（下载固定 STL）
2. 嵌套第 3 层（孔中岛, depth≥2）不导出
3. 草图不持久化；镜头桶形畸变不矫正（建议 2× 变焦拍摄）
4. 2D 中键平移 bed 后 Scene.rebuild 会重新居中（平移未真正生效）
5. 交换视图的 2D mini 模式下顶点编辑覆盖层（SVG 固定在主区）会错位，不建议 mini 态做顶点编辑
6. 全局参数·壁厚滑条（S.wall）原用于外壳，外壳移除后暂无用途（保留待重新定义）

## 测试

**自动化（node，无 DOM）**：

- `node docs/test-sketch-math.js` — 单应矩阵：角点精确映射、H·H⁻¹=I、往返误差、参考线标定反推 A4 尺寸、共线退化、恒等缩放（11 项）
- `node docs/test-sketch-warp.js` — warpPerspective：降采样坐标换算（含"不是旧值"回归断言）、子区域框选边界、超界透明（11 项）
- `node docs/test-model-outline.js` — Model 轮廓展开：rect 角点/旋转 90°、circle 32 边形、rect/circle 命中与包含深度（13 项）
- `node docs/test-scad-expr.js` — SCAD 表达式回归：offsetExpr 负偏置必须包装（内偏置丢弃 bug）、shapeOutset 三种偏置方向（8 项）
- 全部 JS 文件 `node --check` 语法检查

**手动清单**（HTTP 服务根目录，`http://localhost:PORT/examples/BoxMaker/index.html`）：

1. 图形绘制/选中/顶点编辑/多选/钢笔闭合 —— 不回归
2. 床切换 → 2D 网格/轴 + 3D 平台同步；窗口拖动 → 图形/草图跟随
3. 草图：斜拍 A4 照片矫正 → 网格数格验证 210×297；参考线标定；自动换床；锁定/解锁拖动；X/Y/W/H 编辑
4. 对象列表：双向选择同步、显隐（隐藏孔导出无洞）、删除
5. 3D：默认 3/4 视角轴角在左下；旋转/平移/缩放流畅；导出后模型与 2D 轮廓重合
6. 交换视图、预览窗折叠、自动预览防抖、用户图形库存取
7. 代码视图：SCAD 随图形/参数变化同步（防抖）；左侧拉手调宽（预览窗同步）；折叠后只显示标题栏、展开恢复；复制到剪贴板
