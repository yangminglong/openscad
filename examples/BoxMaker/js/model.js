// ============================================================
// model.js — 纯数据模型
// 所有坐标存储为打印板坐标系 (mm, 原点左下, Y向上)
// ============================================================

var Model = {
  shapes: [],        // [{id, type, points:[{x,y}...], toolType}]
  selectedId: null,  // 当前选中图形
  editId: null,      // 当前顶点编辑的图形
  _idCounter: 0,
  defaults: {wall: 2, height: 43.2}, // 新图形属性初始值 (由 Settings 更新)

  // ---- CRUD ----
  nextId: function() {
    return "shape_" + (++this._idCounter);
  },

  addShape: function(type, points, toolType) {
    var shape = {
      id: this.nextId(), type: type, points: points, toolType: toolType || "pen", visible: true,
      wall: this.defaults.wall,      // 每图形壁厚 (墙模式偏置距离)
      height: this.defaults.height   // 每图形拉伸高度 (任意轮廓模式)
    };
    if (type === "rect") {
      // 矩形: 独立属性 (位置/宽高/角度/圆角)
      // points 为两对角点, 中心即位置
      var c = {
        x: (points[0].x + points[1].x) / 2,
        y: (points[0].y + points[1].y) / 2
      };
      shape.rect = {
        x: c.x, y: c.y,
        w: Math.abs(points[1].x - points[0].x),
        h: Math.abs(points[1].y - points[0].y),
        angle: 0,
        radius: 0
      };
    }
    if (type === "polygon" && toolType === "polygon") {
      // 正多边形: 独立属性 (中心/半径/边数/角度)
      var cx = 0, cy = 0;
      points.forEach(function(p) { cx += p.x; cy += p.y; });
      cx /= points.length; cy /= points.length;
      var maxR = 0;
      points.forEach(function(p) {
        maxR = Math.max(maxR, Math.hypot(p.x - cx, p.y - cy));
      });
      shape.poly = {
        x: cx, y: cy,
        radius: maxR,
        sides: points.length,
        angle: 0
      };
    }
    this.shapes.push(shape);
    this.selectedId = shape.id;
    return shape;
  },

  removeShape: function(id) {
    this.shapes = this.shapes.filter(function(s) { return s.id !== id; });
    if (this.selectedId === id) this.selectedId = null;
    if (this.editId === id) this.editId = null;
  },

  getShape: function(id) {
    for (var i = 0; i < this.shapes.length; i++) {
      if (this.shapes[i].id === id) return this.shapes[i];
    }
    return null;
  },

  getSelected: function() {
    return this.getShape(this.selectedId);
  },

  getEditing: function() {
    return this.getShape(this.editId);
  },

  // 将图形提升到模型层的最顶层 (shapes 尾部)。
  bringToFront: function(id) {
    var index = -1;
    for (var i = 0; i < this.shapes.length; i++) {
      if (this.shapes[i].id === id) { index = i; break; }
    }
    if (index < 0 || index === this.shapes.length - 1) return false;
    this.shapes.push(this.shapes.splice(index, 1)[0]);
    return true;
  },

  clearAll: function() {
    this.shapes = [];
    this.selectedId = null;
    this.editId = null;
  },

  // 正多边形降级为普通多边形 (顶点被手动编辑后)
  degradePoly: function(shape) {
    if (!shape.poly) return;
    delete shape.poly;
    shape.toolType = "pen";
  },

  // 从最终 bed 顶点同步正多边形参数。Canvas 与 SCAD 都约定首个顶点方向为 angle + 90°。
  syncRegularPolyMetadata: function(shape) {
    if (!shape || !shape.poly || !shape.points || !shape.points.length) return;
    var poly = shape.poly, cx = 0, cy = 0;
    shape.points.forEach(function(p) { cx += p.x; cy += p.y; });
    cx /= shape.points.length;
    cy /= shape.points.length;
    poly.x = cx;
    poly.y = cy;

    var radius = 0;
    shape.points.forEach(function(p) {
      radius = Math.max(radius, Math.hypot(p.x - cx, p.y - cy));
    });
    poly.radius = radius;

    if (radius > 0) {
      var first = shape.points[0];
      var angle = Math.atan2(first.y - cy, first.x - cx) * 180 / Math.PI - 90;
      poly.angle = ((angle % 360) + 360) % 360;
      if (poly.angle > 359.999999) poly.angle = 0;
    }
  },

  // ---- 几何计算 (bed mm 坐标) ----

  // 图形的轮廓点 (rect 展开 4 角点含旋转; circle 展开 32 边形; polygon 原样)
  // 供命中测试/包含深度/SCAD 导出使用 (rect/circle 的 points 仅存 2 个控制点)
  getOutlinePoints: function(shape) {
    if (shape.type === "circle") {
      var c = shape.points[0];
      var rad = Math.hypot(shape.points[1].x - c.x, shape.points[1].y - c.y);
      var pts = [];
      for (var i = 0; i < 32; i++) {
        var a = 2 * Math.PI * i / 32;
        pts.push({x: c.x + rad * Math.cos(a), y: c.y + rad * Math.sin(a)});
      }
      return pts;
    }
    if (shape.type === "rect") {
      var r = shape.rect;
      var cosA = Math.cos((r.angle || 0) * Math.PI / 180), sinA = Math.sin((r.angle || 0) * Math.PI / 180);
      var hw = r.w / 2, hh = r.h / 2;
      var raw = [{x: -hw, y: -hh}, {x: hw, y: -hh}, {x: hw, y: hh}, {x: -hw, y: hh}];
      return raw.map(function(p) {
        return {x: r.x + p.x * cosA - p.y * sinA, y: r.y + p.x * sinA + p.y * cosA};
      });
    }
    return shape.points;
  },

  getBounds: function(shape) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    shape.points.forEach(function(p) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    });
    return {minX: minX, minY: minY, maxX: maxX, maxY: maxY, w: maxX - minX, h: maxY - minY};
  },

  // 点到线段距离
  pointToSegmentDist: function(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    var len2 = dx * dx + dy * dy;
    var t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
    var cx = x1 + t * dx, cy = y1 + t * dy;
    return {dist: Math.hypot(px - cx, py - cy), t: t, idx: null};
  },

  // 找最近边 (返回插入索引)
  findClosestEdge: function(shape, px, py) {
    var pts = shape.points, bestIdx = 0, bestDist = Infinity;
    for (var i = 0; i < pts.length; i++) {
      var j = (i + 1) % pts.length;
      var r = this.pointToSegmentDist(px, py, pts[i].x, pts[i].y, pts[j].x, pts[j].y);
      if (r.dist < bestDist) { bestDist = r.dist; bestIdx = j; }
    }
    return bestIdx;
  },

  // 判断点是否在多边形内 (射线法; rect/circle 用展开轮廓点)
  pointInPolygon: function(shape, px, py) {
    var pts = this.getOutlinePoints(shape), inside = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      if (((yi > py) !== (yj > py)) &&
          (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  },

  // inner 是否完全被 outer 包含 (所有顶点都在 outer 内)
  polygonContains: function(outer, inner) {
    for (var i = 0; i < inner.points.length; i++) {
      if (!this.pointInPolygon(outer, inner.points[i].x, inner.points[i].y)) {
        return false;
      }
    }
    return true;
  },

  // 计算包含深度: 被多少个可导出轮廓包含 (0 = 顶层外轮廓); 隐藏图形不参与
  containmentDepth: function(shape) {
    var depth = 0;
    for (var i = 0; i < this.shapes.length; i++) {
      var other = this.shapes[i];
      if (other.id === shape.id || other.visible === false) continue;
      var exportable = (other.type === "polygon" || other.type === "rect" || other.type === "circle");
      if (exportable && this.polygonContains(other, shape)) {
        depth++;
      }
    }
    return depth;
  },

  // 找包含点的所有图形 (从上到下); 隐藏图形不可命中
  hitTestAll: function(px, py) {
    var hits = [];
    for (var i = this.shapes.length - 1; i >= 0; i--) {
      var s = this.shapes[i];
      if (s.visible === false) continue;
      if (this.pointInPolygon(s, px, py)) hits.push(s);
    }
    return hits;
  },

  // 找包含点的最上层图形 (兼容原有单命中调用)
  hitTest: function(px, py) {
    return this.hitTestAll(px, py)[0] || null;
  },

  // 找距离点最近的顶点 (在阈值内)
  hitVertex: function(shape, px, py, threshold) {
    var best = null, bestDist = threshold || 0.8; // mm
    shape.points.forEach(function(p, idx) {
      var d = Math.hypot(px - p.x, py - p.y);
      if (d <= bestDist) { bestDist = d; best = idx; }
    });
    return best;
  }
};
