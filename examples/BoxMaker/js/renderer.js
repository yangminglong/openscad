// ============================================================
// renderer.js — Model 数据 → Fabric.js 对象
// 核心: 每次修改后完整重建, 避免 Fabric 内部状态 bug
// ============================================================

var Renderer = {
  canvas: null,
  fabricShapes: {},   // shapeId → fabric 对象

  init: function(canvas) {
    this.canvas = canvas;
  },

  // 打印板坐标 → 画布坐标
  toCanvas: function(bx, by) {
    return Scene.bedToCanvas(bx, by);
  },

  // 完整重建所有图形
  rebuildAll: function() {
    // 移除旧对象
    var self = this;
    Object.keys(this.fabricShapes).forEach(function(id) {
      var obj = self.fabricShapes[id];
      if (obj) self.canvas.remove(obj);
    });
    this.fabricShapes = {};

    // 重建
    Model.shapes.forEach(function(shape) {
      self.rebuildOne(shape);
    });

    // 同步对象列表 + 代码视图 + 自动预览。模型改变会覆盖未预览的手写代码。
    if (typeof renderObjectList === "function") renderObjectList();
    if (typeof CodeView !== "undefined") CodeView.scheduleCodeRefresh();
    if (typeof S !== "undefined" && S.autoPreview && typeof schedulePreview === "function") schedulePreview();
    this.canvas.renderAll();
  },

  // 重建单个图形
  rebuildOne: function(shape) {
    // 保存选中状态 (remove 会触发 selection:cleared 清空 Model.selectedId)
    var wasSelected = (Model.selectedId === shape.id);
    var wasEditing = (Model.editId === shape.id);

    // 移除旧对象，并保留它的画布层级，避免编辑低层图形后被追加到顶层。
    var oldIndex = -1;
    if (this.fabricShapes[shape.id]) {
      oldIndex = this.canvas.getObjects().indexOf(this.fabricShapes[shape.id]);
      this.canvas.remove(this.fabricShapes[shape.id]);
      delete this.fabricShapes[shape.id];
    }

    var obj = this.createFabric(shape);
    if (!obj) return null;

    obj._shapeId = shape.id;
    this.fabricShapes[shape.id] = obj;
    if (oldIndex >= 0 && typeof this.canvas.insertAt === "function") this.canvas.insertAt(obj, oldIndex, false);
    else this.canvas.add(obj);
    obj.setCoords();

    // 恢复选中状态 (隐藏图形不可激活)
    if (wasSelected) {
      Model.selectedId = shape.id;
      if (shape.visible !== false) this.canvas.setActiveObject(obj);
    }
    if (wasEditing) Model.editId = shape.id;

    // 顶点拖拽等高频编辑 → 代码视图防抖刷新
    if (typeof CodeView !== "undefined") CodeView.scheduleCodeRefresh();
    this.canvas.renderAll();
    return obj;
  },

  // 从 model 数据创建 Fabric 对象
  // 关键: Fabric Polygon 用 pathOffset 自动居中, 必须传相对 left/top 的局部坐标
  createFabric: function(shape) {
    var style = {
      fill: "rgba(74,144,217,0.12)",
      stroke: "#4A90D9",
      strokeWidth: 2,
      toolType: "pen",
      name: shape.id,
      objectCaching: false,
      visible: shape.visible !== false
    };

    if (shape.type === "circle") {
      // 圆: points 存储 [圆心, 边上一点]
      var center = Scene.bedToCanvas(shape.points[0].x, shape.points[0].y);
      var edge = Scene.bedToCanvas(shape.points[1].x, shape.points[1].y);
      var radius = Math.hypot(edge.x - center.x, edge.y - center.y);
      var circle = new fabric.Circle(Object.assign({
        left: center.x, top: center.y, radius: radius,
        originX: "center", originY: "center"
      }, style));
      // 圆形: 只保留四角缩放, 隐藏旋转/水平/垂直控制点
      circle.setControlsVisibility({ml: false, mr: false, mt: false, mb: false, mtr: false});
      return circle;
    }

    if (shape.type === "rect") {
      // 矩形: 使用 rect 属性 (x/y/w/h/angle/radius)
      var r = shape.rect;
      var c = Scene.bedToCanvas(r.x, r.y);
      var w = r.w * Scene.scale, h = r.h * Scene.scale;
      return new fabric.Rect(Object.assign({
        left: c.x, top: c.y,
        width: w, height: h,
        rx: r.radius * Scene.scale, ry: r.radius * Scene.scale,
        angle: r.angle || 0,
        originX: "center", originY: "center"
      }, style));
    }

    // 正多边形: 从 poly 属性动态生成顶点
    if (shape.poly) {
      var poly = shape.poly;
      var verts = [];
      for (var vi = 0; vi < poly.sides; vi++) {
        var va = poly.angle * Math.PI / 180 + Math.PI / 2 + 2 * Math.PI / poly.sides * vi;
        verts.push({x: poly.x + poly.radius * Math.cos(va), y: poly.y + poly.radius * Math.sin(va)});
      }
      shape.points = verts;
    }

    // 多边形: fabric.Path (SVG 路径), center 原点, left/top = 点集视觉中心
    var canvasPts = shape.points.map(function(p) {
      var c = Scene.bedToCanvas(p.x, p.y);
      return {x: c.x, y: c.y};
    });
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    canvasPts.forEach(function(c) {
      minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x); maxY = Math.max(maxY, c.y);
    });
    var d = "";
    canvasPts.forEach(function(c, i) {
      d += (i === 0 ? "M " : "L ") + (c.x - minX).toFixed(2) + " " + (c.y - minY).toFixed(2) + " ";
    });
    d += "Z";
    var path = new fabric.Path(d, Object.assign({
      left: (minX + maxX) / 2, top: (minY + maxY) / 2,
      originX: "center", originY: "center"
    }, style));
    // 正多边形: 隐藏水平/垂直控制点 (保留四角 + 旋转)
    if (shape.poly) {
      path.setControlsVisibility({ml: false, mr: false, mt: false, mb: false});
    }
    return path;
  },

  // 将图形提升到所有图形对象的最顶层，不影响床面、草图和临时 UI 图层。
  moveShapeToTop: function(shapeId) {
    var obj = this.fabricShapes[shapeId];
    if (!obj || !this.canvas || typeof this.canvas.moveTo !== "function") return false;
    var objects = this.canvas.getObjects();
    var shapeObjects = Object.keys(this.fabricShapes).map(function(id) {
      return Renderer.fabricShapes[id];
    }).filter(function(shape) { return shape; });
    var topIndex = -1;
    shapeObjects.forEach(function(shape) {
      topIndex = Math.max(topIndex, objects.indexOf(shape));
    });
    if (topIndex < 0 || objects.indexOf(obj) === topIndex) return false;
    this.canvas.moveTo(obj, topIndex);
    obj.setCoords();
    this.canvas.requestRenderAll();
    return true;
  },

  // 获取选中图形的 Fabric 对象
  getFabric: function(shapeId) {
    return this.fabricShapes[shapeId] || null;
  }
};
