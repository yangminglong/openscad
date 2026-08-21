// ============================================================
// scene.js — 打印盘对象 + 视口 + 网格/坐标轴渲染
// ============================================================

// ============================================================
// Bed — 打印盘对象
// 属性: 打印区尺寸 (w/h, mm) + 显示边距 (margin, mm)
// 床坐标系: 原点在打印区左下角, X 向右, Y 向上, 范围 [0,w]×[0,h]
// ============================================================
var Bed = function(config) {
  this.id = config.id;
  this.w = config.w;                  // 打印区宽 (mm)
  this.h = config.h;                  // 打印区高 (mm)
  this.label = config.label;
  this.margin = config.margin || 5;   // 显示边距 (仅视觉边框, 不参与坐标计算)
};

Bed.prototype = {
  // 显示尺寸 = 打印区 + 边距×2
  displayW: function() { return this.w + this.margin * 2; },
  displayH: function() { return this.h + this.margin * 2; },

  // 给定尺寸是否能放上打印区
  fits: function(w, h) { return w <= this.w && h <= this.h; }
};

// 床目录 (下拉框选项)
var BED_CATALOG = [
  new Bed({id: "A1M", w: 180, h: 180, label: "A1 Mini 180×180"}),
  new Bed({id: "A1", w: 256, h: 256, label: "A1 256×256"}),
  new Bed({id: "P1S", w: 256, h: 256, label: "P1S 256×256"}),
  new Bed({id: "X1C", w: 256, h: 256, label: "X1C 256×256"}),
  new Bed({id: "custom255", w: 255, h: 255, label: "自定义 255×255"}),
  new Bed({id: "custom300", w: 300, h: 300, label: "自定义 300×300"})
];

var BED_COLOR = "#252525";
var GRID_COLOR = "rgba(255,255,255,0.06)";

// ============================================================
// Scene — 打印盘视口 (单例)
// 职责: 持有当前 Bed, 画布↔床坐标换算, 床面/网格/坐标轴渲染
// ============================================================
var Scene = {
  canvas: null,
  bed: BED_CATALOG[0], // 当前打印盘 (Bed 实例)
  bedGroup: null,
  axesGroup: null,
  sizeSelect: null,
  // 视口状态 (画布 px)
  scale: 1,
  bedLeft: 0,
  bedTop: 0,
  // 中键拖拽形成的持久视图平移 (canvas px)。缩放/重建不会清除它。
  panX: 0,
  panY: 0,

  // 按 id 查床
  getBedById: function(id) {
    for (var i = 0; i < BED_CATALOG.length; i++) {
      if (BED_CATALOG[i].id === id) return BED_CATALOG[i];
    }
    return BED_CATALOG[0];
  },

  // 找能容纳给定尺寸的最小床 (没有则 null)
  findSmallestBed: function(w, h) {
    for (var i = 0; i < BED_CATALOG.length; i++) {
      if (BED_CATALOG[i].fits(w, h)) return BED_CATALOG[i];
    }
    return null;
  },

  // 切换当前床: 更新下拉框 + 重建 + 3D 平台同步
  setBed: function(bed) {
    this.bed = bed;
    if (this.sizeSelect) this.sizeSelect.value = bed.id;
    this.rebuild();
    if (window.Preview3D && Preview3D.inited) Preview3D.rebuildBed();
  },

  initDropdown: function() {
    if (this.sizeSelect) return;
    var sel = document.createElement("select");
    sel.id = "bed-size-select";
    sel.style.cssText = "position:absolute;top:8px;left:8px;z-index:20;padding:3px 6px;background:#1a1a1a;border:1px solid #3a3a3a;border-radius:3px;color:#ccc;font-size:11px";
    BED_CATALOG.forEach(function(b) {
      var opt = document.createElement("option");
      opt.value = b.id; opt.textContent = b.label;
      sel.appendChild(opt);
    });
    document.getElementById("canvas-area").appendChild(sel);
    this.sizeSelect = sel;
    var self = this;
    sel.addEventListener("change", function() { self.setBed(self.getBedById(this.value)); });
  },

  // 画布坐标 → 打印板坐标 (mm)
  // 原点 = 打印区左下角 (显示区含边距, 打印区占据 bed 坐标 [0,w]×[0,h])
  canvasToBed: function(cx, cy) {
    var bed = this.bed;
    var scale = this.scale || 1;
    return {
      x: (cx - this.bedLeft) / scale - bed.margin,
      y: bed.displayH() - bed.margin - (cy - this.bedTop) / scale
    };
  },

  // 打印板坐标 → 画布坐标
  bedToCanvas: function(bx, by) {
    var bed = this.bed;
    var scale = this.scale || 1;
    return {
      x: this.bedLeft + (bed.margin + bx) * scale,
      y: this.bedTop + (bed.displayH() - bed.margin - by) * scale
    };
  },

  rebuild: function() {
    if (!this.canvas) return;
    if (this.bedGroup) this.canvas.remove(this.bedGroup);
    if (this.axesGroup) this.canvas.remove(this.axesGroup);

    var bed = this.bed;
    var dw = bed.displayW(), dh = bed.displayH();
    var cw = this.canvas.getWidth(), ch = this.canvas.getHeight();
    var scale = Math.min(cw / dw, ch / dh);
    this.scale = scale;
    this.bedLeft = (cw - dw * scale) / 2 + this.panX;
    this.bedTop = (ch - dh * scale) / 2 + this.panY;

    var items = [];
    // 床背景 (显示区 = 打印区 + 边距, 边距作为边框; 圆角 r = margin)
    items.push(new fabric.Rect({
      left: this.bedLeft, top: this.bedTop,
      width: dw * scale, height: dh * scale,
      rx: bed.margin * scale, ry: bed.margin * scale,
      fill: BED_COLOR, stroke: "#3a3a3a", strokeWidth: 1,
      selectable: false, evented: false
    }));
    // 10mm 网格 (仅打印区)
    for (var x = 0; x <= bed.w; x += 10) {
      var px = this.bedLeft + (bed.margin + x) * scale;
      items.push(new fabric.Line([px, this.bedTop + bed.margin * scale, px, this.bedTop + (bed.margin + bed.h) * scale], {
        stroke: GRID_COLOR, strokeWidth: 0.5, selectable: false, evented: false
      }));
    }
    for (var y = 0; y <= bed.h; y += 10) {
      var py = this.bedTop + (bed.margin + y) * scale;
      items.push(new fabric.Line([this.bedLeft + bed.margin * scale, py, this.bedLeft + (bed.margin + bed.w) * scale, py], {
        stroke: GRID_COLOR, strokeWidth: 0.5, selectable: false, evented: false
      }));
    }

    this.bedGroup = new fabric.Group(items, {selectable: false, evented: false, excludeFromExport: true});
    this.canvas.add(this.bedGroup);
    this.bedGroup.sendToBack();

    // 坐标轴 (打印区左下角原点)
    var o0 = this.bedToCanvas(0, 0);
    var ox = o0.x, oy = o0.y;
    var len = 20 * scale, arrow = 5 * scale;
    var axItems = [];
    axItems.push(new fabric.Line([ox, oy, ox + len, oy], {stroke: "#e74c3c", strokeWidth: 2, selectable: false, evented: false}));
    axItems.push(new fabric.Polygon([
      {x: ox + len, y: oy - arrow / 2},
      {x: ox + len + arrow, y: oy},
      {x: ox + len, y: oy + arrow / 2}
    ], {fill: "#e74c3c", selectable: false, evented: false}));
    axItems.push(new fabric.Line([ox, oy, ox, oy - len], {stroke: "#27ae60", strokeWidth: 2, selectable: false, evented: false}));
    axItems.push(new fabric.Polygon([
      {x: ox - arrow / 2, y: oy - len},
      {x: ox, y: oy - len - arrow},
      {x: ox + arrow / 2, y: oy - len}
    ], {fill: "#27ae60", selectable: false, evented: false}));
    axItems.push(new fabric.Circle({left: ox - 3, top: oy - 3, radius: 3, fill: "#fff", selectable: false, evented: false}));

    this.axesGroup = new fabric.Group(axItems, {selectable: false, evented: false, excludeFromExport: true});
    this.canvas.add(this.axesGroup);

    // 床面变化 (缩放/换床/窗口调整) 后, 依赖 scale/bedLeft 的对象全部重建:
    // 图形按新 scale 重建, 草图重放, 顶点编辑覆盖层同步
    if (window.Renderer) Renderer.rebuildAll();
    if (window.Sketch) Sketch.onSceneRebuild();
    if (window.Overlay && Model.editId) Overlay.render();

    this.canvas.renderAll();
  }
};
