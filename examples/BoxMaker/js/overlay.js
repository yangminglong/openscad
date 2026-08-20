// ============================================================
// overlay.js — SVG 覆盖层 (顶点编辑控制)
// SVG 位于 Fabric canvas 上方, 精确渲染顶点控制圆
// ============================================================

var Overlay = {
  svg: null,
  container: null,
  activeShapeId: null,
  dragVertexIdx: -1,
  dragShapeId: null,
  dragLast: null,

  init: function() {
    // 创建 SVG 覆盖层
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svg.id = "edit-overlay";
    this.svg.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:5;overflow:visible";
    document.getElementById("canvas-area").appendChild(this.svg);
    this.container = document.getElementById("canvas-area");
  },

  resize: function(w, h) {
    this.svg.setAttribute("width", w);
    this.svg.setAttribute("height", h);
    this.svg.setAttribute("viewBox", "0 0 " + w + " " + h);
  },

  // 显示顶点编辑覆盖层
  show: function(shapeId) {
    this.activeShapeId = shapeId;
    this.render();
  },

  hide: function() {
    this.activeShapeId = null;
    this.dragVertexIdx = -1;
    this.svg.innerHTML = "";
  },

  // canvas 坐标 → 屏幕坐标 (应用 viewportTransform, 使 SVG 与 Fabric 渲染对齐)
  toScreen: function(cx, cy) {
    var vpt = Renderer.canvas.viewportTransform;
    return {
      x: vpt[0] * cx + vpt[2] * cy + vpt[4],
      y: vpt[1] * cx + vpt[3] * cy + vpt[5]
    };
  },

  render: function() {
    if (!this.activeShapeId) return;
    var shape = Model.getShape(this.activeShapeId);
    if (!shape) { this.hide(); return; }

    // 每次渲染前同步 SVG 尺寸 (窗口调整后覆盖层坐标系才能与画布对齐)
    var container = this.svg.parentElement;
    if (container) {
      this.svg.setAttribute("width", container.clientWidth);
      this.svg.setAttribute("height", container.clientHeight);
      this.svg.setAttribute("viewBox", "0 0 " + container.clientWidth + " " + container.clientHeight);
    }

    this.svg.innerHTML = "";
    var ns = "http://www.w3.org/2000/svg";
    var self = this;

    // 顶点控制圆 (应用 viewport 变换)
    shape.points.forEach(function(p, idx) {
      var c = Scene.bedToCanvas(p.x, p.y);
      var s = self.toScreen(c.x, c.y);
      var circle = document.createElementNS(ns, "circle");
      circle.setAttribute("cx", s.x);
      circle.setAttribute("cy", s.y);
      circle.setAttribute("r", 7);
      circle.setAttribute("fill", "#fff");
      circle.setAttribute("stroke", "#4A90D9");
      circle.setAttribute("stroke-width", "2");
      circle.style.pointerEvents = "all";
      circle.style.cursor = "move";

      circle.addEventListener("mousedown", function(e) {
        // 正多边形顶点被编辑 → 降级为普通多边形
        if (shape.poly) Model.degradePoly(shape);
        self.dragVertexIdx = idx;
        self.dragLast = {x: e.clientX, y: e.clientY};
        e.stopPropagation();
        e.preventDefault();
      });

      self.svg.appendChild(circle);
    });

    // 高亮边 (虚线, 应用 viewport 变换)
    shape.points.forEach(function(p, idx) {
      var j = (idx + 1) % shape.points.length;
      var c1 = self.toScreen(Scene.bedToCanvas(p.x, p.y).x, Scene.bedToCanvas(p.x, p.y).y);
      var c2 = self.toScreen(Scene.bedToCanvas(shape.points[j].x, shape.points[j].y).x, Scene.bedToCanvas(shape.points[j].x, shape.points[j].y).y);
      var line = document.createElementNS(ns, "line");
      line.setAttribute("x1", c1.x); line.setAttribute("y1", c1.y);
      line.setAttribute("x2", c2.x); line.setAttribute("y2", c2.y);
      line.setAttribute("stroke", "rgba(74,144,217,0.4)");
      line.setAttribute("stroke-width", "1");
      line.setAttribute("stroke-dasharray", "4 3");
      line.style.pointerEvents = "none";
      self.svg.appendChild(line);
    });
  },

  // 全局鼠标移动 — 由 controller 调用
  onMouseMove: function(e) {
    if (this.dragVertexIdx < 0 || !this.activeShapeId) return false;
    var shape = Model.getShape(this.activeShapeId);
    if (!shape) return false;

    // 屏幕 → 画布坐标
    var canvasEl = document.querySelector("#canvas-area canvas");
    if (!canvasEl) return false;
    var rect = canvasEl.getBoundingClientRect();
    var canvas = Renderer.canvas;
    var pointer = canvas.getPointer(e);

    // 画布 → bed 坐标
    var bed = Scene.canvasToBed(pointer.x, pointer.y);

    // 更新 model
    shape.points[this.dragVertexIdx] = {x: bed.x, y: bed.y};

    // 重建 Fabric 对象
    Renderer.rebuildOne(shape);

    // 顶点拖拽连续编辑 → 防抖自动预览 (拖拽暂停 500ms 后渲染)
    if (typeof S !== "undefined" && S.autoPreview && typeof schedulePreview === "function") schedulePreview();

    // 重新渲染 SVG
    this.render();

    return true;
  },

  // 全局鼠标释放 — 由 controller 调用
  onMouseUp: function() {
    if (this.dragVertexIdx < 0) return false;
    this.dragVertexIdx = -1;
    return true;
  }
};
