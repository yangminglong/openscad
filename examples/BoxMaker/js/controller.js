// ============================================================
// controller.js — 交互逻辑
// 处理所有 mouse/key 事件, 修改 Model, 触发 Renderer 重建
// ============================================================

var Controller = {
  canvas: null,
  activeTool: "select",
  activeLibraryTemplate: null,
  polySides: 6,
  // 钢笔状态
  penPts: [],        // bed mm 坐标
  penLines: [],      // Fabric 临时线
  penPreview: null,
  penStart: null,
  penActive: false,
  // 打印板平移
  bedPanning: false,
  bedPanLast: null,
  // 双击检测
  lastClickTime: 0,
  lastClickPos: null,
  // 选择模式中点击位置的命中堆栈 (顶层 → 底层)
  hitStackIds: [],
  hitStackBed: null,
  applyingHitStackSelection: false,

  init: function(canvas) {
    this.canvas = canvas;
    if (canvas.upperCanvasEl) canvas.upperCanvasEl.tabIndex = 0;
    var self = this;

    canvas.on("mouse:down", this.onDown.bind(this));
    canvas.on("mouse:move", this.onMove.bind(this));
    canvas.on("mouse:up", this.onUp.bind(this));
    canvas.on("mouse:dblclick", this.onDblClick.bind(this));
    canvas.on("object:modified", this.onModified.bind(this));
    canvas.on("object:moving", this.onMoving.bind(this));
    canvas.on("selection:created", this.onSelected.bind(this));
    canvas.on("selection:updated", this.onSelected.bind(this));
    canvas.on("selection:cleared", function() {
      if (self.applyingHitStackSelection) return;
      Model.selectedId = null;
      self.clearHitStack();
      if (typeof showProps === "function") showProps(null);
      if (typeof renderObjectList === "function") renderObjectList();
    });

    // 滚轮缩放
    var self = this;
    canvas.on("mouse:wheel", function(o) {
      var z = canvas.getZoom() * Math.pow(0.999, o.e.deltaY);
      z = Math.max(0.2, Math.min(8, z));
      canvas.zoomToPoint({x: o.e.offsetX, y: o.e.offsetY}, z);
      if (Model.editId) Overlay.render();
      if (Sketch.rectify) Sketch.renderOverlay();
      o.e.preventDefault();
      o.e.stopPropagation();
    });

    // 全局鼠标事件 (SVG 覆盖层拖拽; 草图矫正优先于顶点编辑)
    document.addEventListener("mousemove", function(e) {
      if (Sketch.onMouseMove(e)) { e.preventDefault(); return; }
      if (Overlay.onMouseMove(e)) { e.preventDefault(); return; }
      self.onGlobalMove(e);
    });
    document.addEventListener("mouseup", function(e) {
      if (Sketch.onMouseUp()) return;
      if (Overlay.onMouseUp()) return;
      self.onGlobalUp(e);
    });

    // 键盘
    document.addEventListener("keydown", this.onKey.bind(this));
  },

  setTool: function(t) {
    this.activeTool = t;
    this.activeLibraryTemplate = null;
    this.clearHitStack();
    document.querySelectorAll(".tbtn[data-tool]").forEach(function(b) {
      b.classList.toggle("active", b.dataset.tool === t);
    });
    document.querySelectorAll(".lib-item").forEach(function(b) { b.classList.remove("active"); });
    if (this.penActive) this.cancelPen();
    var selecting = (t === "select");
    this.canvas.selection = selecting;
    this.canvas.skipTargetFind = !selecting;
    this.canvas.defaultCursor = (t === "pen") ? "crosshair" : "default";
  },

  setLibraryTool: function(template, button) {
    if (!template) return;
    this.activeTool = "library";
    this.activeLibraryTemplate = template;
    if (this.penActive) this.cancelPen();
    this.canvas.selection = false;
    this.canvas.skipTargetFind = true;
    this.canvas.defaultCursor = "copy";
    document.querySelectorAll(".tbtn[data-tool]").forEach(function(b) { b.classList.remove("active"); });
    document.querySelectorAll(".lib-item").forEach(function(b) { b.classList.toggle("active", b === button); });
    var status = document.getElementById("status-text");
    if (status) status.textContent = "图库工具已选中：点击打印板可重复放置；按住 Ctrl 点击可选择图形";
  },

  isTextEditing: function(e) {
    if (typeof CodeView !== "undefined" && CodeView.cm && CodeView.cm.hasFocus()) return true;
    var target = e.target;
    if (!target) return false;
    if (target.isContentEditable) return true;
    var tag = (target.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || tag === "button";
  },

  clearHitStack: function() {
    this.hitStackIds = [];
    this.hitStackBed = null;
  },

  captureHitStack: function(bed) {
    var hits = Model.hitTestAll(bed.x, bed.y);
    this.hitStackIds = hits.map(function(shape) { return shape.id; });
    this.hitStackBed = hits.length ? {x: bed.x, y: bed.y} : null;
    return hits;
  },

  getValidHitStack: function() {
    if (!this.hitStackBed || this.hitStackIds.length < 2) return null;
    var ids = Model.hitTestAll(this.hitStackBed.x, this.hitStackBed.y).map(function(shape) { return shape.id; });
    var expected = this.hitStackIds.slice().sort();
    var actual = ids.slice().sort();
    if (actual.length !== expected.length || actual.some(function(id, index) {
      return id !== expected[index];
    })) {
      this.clearHitStack();
      return null;
    }
    // 层级提升会改变实时命中顺序；循环顺序保持首次点击时的快照。
    return this.hitStackIds;
  },

  promoteSelectedShape: function(id) {
    var changed = Model.bringToFront(id);
    if (changed && typeof Renderer.moveShapeToTop === "function") Renderer.moveShapeToTop(id);
    return changed;
  },

  selectShapeById: function(id, keepHitStack) {
    var shape = Model.getShape(id);
    if (!shape || shape.visible === false) return false;
    this.promoteSelectedShape(id);
    this.applyingHitStackSelection = true;
    this.canvas.discardActiveObject();
    Model.selectedId = id;
    var obj = Renderer.getFabric(id);
    if (obj) this.canvas.setActiveObject(obj);
    this.applyingHitStackSelection = false;
    if (!keepHitStack) this.clearHitStack();
    if (typeof showProps === "function") showProps(id);
    if (typeof renderObjectList === "function") renderObjectList();
    this.canvas.requestRenderAll();
    return true;
  },

  selectShapeAt: function(bed) {
    var hit = Model.hitTest(bed.x, bed.y);
    if (hit) return this.selectShapeById(hit.id, false) ? hit : null;
    this.applyingHitStackSelection = true;
    this.canvas.discardActiveObject();
    this.applyingHitStackSelection = false;
    Model.selectedId = null;
    this.clearHitStack();
    if (typeof showProps === "function") showProps(null);
    if (typeof renderObjectList === "function") renderObjectList();
    this.canvas.requestRenderAll();
    return null;
  },

  cycleHitStack: function(reverse) {
    var ids = this.getValidHitStack();
    if (!ids) return false;
    var current = ids.indexOf(Model.selectedId);
    var next = current < 0 ? 0 : (current + (reverse ? -1 : 1) + ids.length) % ids.length;
    return this.selectShapeById(ids[next], true);
  },

  // ---- 鼠标事件 ----

  onDown: function(o) {
    var e = o.e;

    // 照片矫正模式: 仅允许拖照片整体移动, 阻断其他交互
    if (Sketch.rectify) {
      if (e.button === 0 && o.target && o.target === Sketch.rectify.img) Sketch.startImageDrag(e);
      return;
    }

    // 未锁定的草图: 直接拖拽移动
    if (Sketch.sketch && !Sketch.sketch.locked &&
        e.button === 0 && o.target && o.target === Sketch.sketch.img) {
      Sketch.startSketchDrag(e);
      return;
    }

    var pointer = this.canvas.getPointer(e);
    var bed = Scene.canvasToBed(pointer.x, pointer.y);

    if (e.button === 2) { this.onRightClick(e, bed); return; }

    // 顶点编辑模式: 点击空白退出
    if (Model.editId) {
      var editShape = Model.getEditing();
      if (editShape && o.target && o.target._shapeId === editShape.id) {
        // 点击正在编辑的多边形 → 拖拽移动整个图形
        this.startShapeDrag(e);
        return;
      }
      if (!o.target || (o.target._shapeId !== Model.editId)) {
        Model.editId = null;
        Overlay.hide();
      }
      return;
    }

    // 选择模式普通单击保存此处的所有命中，Fabric 仍负责实际点击/拖拽/框选。
    if (this.activeTool === "select") {
      if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) this.clearHitStack();
      else {
        this.captureHitStack(bed);
        if (this.canvas.upperCanvasEl && this.hitStackIds.length) this.canvas.upperCanvasEl.focus();
      }
      return;
    }

    // 非选择工具中，Ctrl 点击临时按选择模式处理，保留当前工具供下一次创建使用。
    if (e.ctrlKey) {
      this.selectShapeAt(bed);
      return;
    }

    // 图库工具：普通点击始终重复放置模板（包括已有图形上方）。
    if (this.activeTool === "library" && this.activeLibraryTemplate) {
      if (typeof placeLibraryShape === "function") placeLibraryShape(this.activeLibraryTemplate, bed.x, bed.y);
      return;
    }

    // 钢笔工具
    if (this.activeTool === "pen") {
      if (e.altKey) return;
      if (!this.penActive) {
        this.penActive = true;
        this.penPts = [{x: bed.x, y: bed.y}];
        this.penLines = [];
        // 起始标记
        var c = Scene.bedToCanvas(bed.x, bed.y);
        this.penStart = new fabric.Circle({left: c.x - 5, top: c.y - 5, radius: 5, fill: "#4A90D9", stroke: "#fff", strokeWidth: 2, selectable: false, evented: false});
        this.canvas.add(this.penStart);
        this.canvas.renderAll();
      } else {
        // 检查是否闭合
        var d = Math.hypot(bed.x - this.penPts[0].x, bed.y - this.penPts[0].y);
        if (d < 2 && this.penPts.length >= 3) { // 2mm 阈值
          this.finishPen();
          return;
        }
        // 添加顶点 + 画实线
        var last = this.penPts[this.penPts.length - 1];
        var c1 = Scene.bedToCanvas(last.x, last.y);
        var c2 = Scene.bedToCanvas(bed.x, bed.y);
        var line = new fabric.Line([c1.x, c1.y, c2.x, c2.y], {stroke: "#4A90D9", strokeWidth: 1.5, selectable: false, evented: false});
        this.canvas.add(line);
        this.penLines.push(line);
        this.penPts.push({x: bed.x, y: bed.y});
        var marker = new fabric.Circle({left: c2.x - 3.5, top: c2.y - 3.5, radius: 3.5, fill: "#fff", stroke: "#4A90D9", strokeWidth: 1.5, selectable: false, evented: false});
        this.canvas.add(marker);
        this.canvas.renderAll();
      }
      return;
    }

    // 形状工具：普通点击始终创建，允许与已有图形重叠。
    if (this.activeTool === "rect" || this.activeTool === "circle" || this.activeTool === "polygon") {
      this.createShape(this.activeTool, bed.x, bed.y);
    }
  },

  onMove: function(o) {
    // 打印板平移 (中键)
    if (this.bedPanning) return;

    // 拖拽移动图形
    if (this.dragShapeId) {
      var dx = o.e.clientX - this.dragLast.x;
      var dy = o.e.clientY - this.dragLast.y;
      this.dragLast = {x: o.e.clientX, y: o.e.clientY};
      // 平移 shape 的所有点
      var shape = Model.getShape(this.dragShapeId);
      if (shape) {
        var scale = Scene.scale;
        var bx = dx / scale, by = -dy / scale; // Y 轴翻转
        shape.points.forEach(function(p) { p.x += bx; p.y += by; });
        Renderer.rebuildOne(shape);
        if (Model.editId === shape.id) Overlay.render();
      }
      return;
    }

    // 钢笔预览线
    if (this.penActive && this.penPts.length) {
      var pointer = this.canvas.getPointer(o.e);
      if (this.penPreview) this.canvas.remove(this.penPreview);
      var last = this.penPts[this.penPts.length - 1];
      var c1 = Scene.bedToCanvas(last.x, last.y);
      this.penPreview = new fabric.Line([c1.x, c1.y, pointer.x, pointer.y], {stroke: "#4A90D9", strokeWidth: 1.5, strokeDashArray: [4, 4], selectable: false, evented: false});
      this.canvas.add(this.penPreview);
      // 接近起点提示
      var bed = Scene.canvasToBed(pointer.x, pointer.y);
      var d = Math.hypot(bed.x - this.penPts[0].x, bed.y - this.penPts[0].y);
      if (this.penStart) this.penStart.set({radius: (d < 2 && this.penPts.length >= 2) ? 7 : 5, fill: (d < 2 && this.penPts.length >= 2) ? "#f39c12" : "#4A90D9"});
      this.canvas.renderAll();
    }
  },

  onUp: function() {
    if (this.dragShapeId) {
      this.dragShapeId = null;
      if (S && S.autoPreview) schedulePreview();
    }
  },

  onDblClick: function(o) {
    if (Sketch.rectify) return;
    // 双击未锁定草图: 仅拖拽, 不触发下方图形的编辑
    if (Sketch.sketch && !Sketch.sketch.locked && o.target === Sketch.sketch.img) return;
    var e = o.e;
    var pointer = this.canvas.getPointer(e);
    var bed = Scene.canvasToBed(pointer.x, pointer.y);

    // 已在编辑模式
    if (Model.editId) {
      var editShape = Model.getEditing();
      if (!editShape) { Model.editId = null; Overlay.hide(); return; }

      // 双击顶点 → 删除
      var vIdx = Model.hitVertex(editShape, bed.x, bed.y, 1.5);
      if (vIdx !== null) {
        if (editShape.points.length > 3) {
          Model.degradePoly(editShape);
          editShape.points.splice(vIdx, 1);
          Renderer.rebuildOne(editShape);
          Overlay.render();
        }
        return;
      }

      // 双击边 → 新增顶点
      Model.degradePoly(editShape);
      var insertIdx = Model.findClosestEdge(editShape, bed.x, bed.y);
      editShape.points.splice(insertIdx, 0, {x: bed.x, y: bed.y});
      Renderer.rebuildOne(editShape);
      Overlay.render();
      return;
    }

    // 双击多边形 → 进入编辑模式
    var hit = Model.hitTest(bed.x, bed.y);
    if (hit && hit.type === "polygon") {
      this.selectShapeById(hit.id, false);
      Model.editId = hit.id;
      this.canvas.discardActiveObject();
      this.canvas.renderAll();
      Overlay.show(hit.id);
    }
  },

  // 图形拖拽
  startShapeDrag: function(e) {
    var shape = Model.getEditing();
    if (!shape) return;
    this.dragShapeId = shape.id;
    this.dragLast = {x: e.clientX, y: e.clientY};
  },

  onGlobalMove: function(e) {
    if (this.bedPanning) {
      var dx = e.clientX - this.bedPanLast.x;
      var dy = e.clientY - this.bedPanLast.y;
      this.bedPanLast = {x: e.clientX, y: e.clientY};
      Scene.panX += dx;
      Scene.panY += dy;
      Scene.rebuild(); // 内部会按持久 pan 重建图形 + 同步覆盖层
    }
  },

  onGlobalUp: function() {
    this.bedPanning = false;
  },

  onRightClick: function(e, bed) {
    var old = document.querySelector(".ctx-menu");
    if (old) old.remove();
    if (this.activeTool !== "select") return;
    var hits = Model.hitTestAll(bed.x, bed.y);
    if (!hits.length) return;
    showContextMenu(e.clientX, e.clientY, hits);
  },

  // ---- 对象事件 ----

  onModified: function(o) {
    this.clearHitStack();
    var obj = o.target;
    if (!obj) return;

    // 多选 (ActiveSelection): 子对象属性不含 selection 变换, 需叠加 selMatrix
    if (obj.type === "activeSelection") {
      var selMatrix = obj.calcTransformMatrix();
      var self = this;
      var subShapes = [];
      obj.getObjects().forEach(function(sub) {
        if (sub._shapeId) {
          self.writeBackWithMatrix(sub, selMatrix);
          subShapes.push(sub._shapeId);
        }
      });
      // 全部重建完成后恢复多选
      setTimeout(function() {
        self.restoreMultiSelection(subShapes);
      }, 0);
      return;
    }

    this.writeBack(obj);
  },

  // 恢复多选状态
  restoreMultiSelection: function(shapeIds) {
    var objs = shapeIds.map(function(id) {
      return Renderer.fabricShapes[id];
    }).filter(function(o) { return o; });
    if (objs.length < 2) return;
    var sel = new fabric.ActiveSelection(objs, {canvas: this.canvas});
    this.canvas.setActiveObject(sel);
    this.canvas.requestRenderAll();
  },

  // 回写时叠加外部变换矩阵 (用于多选)
  writeBackWithMatrix: function(obj, selMatrix) {
    if (!obj || !obj._shapeId) return;
    var shape = Model.getShape(obj._shapeId);
    if (!shape) return;

    if (shape.type === "polygon") {
      var po = obj.pathOffset || {x: 0, y: 0};
      var localPts = [];
      obj.path.forEach(function(cmd) {
        if (cmd[0] === "M" || cmd[0] === "L") {
          localPts.push({x: cmd[1], y: cmd[2]});
        }
      });
      shape.points = localPts.map(function(p) {
        // 子对象局部点(减pathOffset乘scale) → 相对sel中心 → selMatrix → 世界
        var selLocal = {
          x: obj.left + (p.x - po.x) * obj.scaleX,
          y: obj.top + (p.y - po.y) * obj.scaleY
        };
        var w = fabric.util.transformPoint(selLocal, selMatrix);
        return Scene.canvasToBed(w.x, w.y);
      });
      if (shape.poly) Model.syncRegularPolyMetadata(shape);
    } else if (shape.type === "circle") {
      var cw = fabric.util.transformPoint({x: obj.left, y: obj.top}, selMatrix);
      var ew = fabric.util.transformPoint({x: obj.left + obj.radius * obj.scaleX, y: obj.top}, selMatrix);
      shape.points = [Scene.canvasToBed(cw.x, cw.y), Scene.canvasToBed(ew.x, ew.y)];
    } else if (shape.type === "rect") {
      var tlW = fabric.util.transformPoint({x: obj.left - obj.width * obj.scaleX / 2, y: obj.top - obj.height * obj.scaleY / 2}, selMatrix);
      var brW = fabric.util.transformPoint({x: obj.left + obj.width * obj.scaleX / 2, y: obj.top + obj.height * obj.scaleY / 2}, selMatrix);
      var tlB = Scene.canvasToBed(tlW.x, tlW.y);
      var brB = Scene.canvasToBed(brW.x, brW.y);
      var rr = shape.rect;
      rr.x = (tlB.x + brB.x) / 2;
      rr.y = (tlB.y + brB.y) / 2;
      rr.w = Math.abs(brB.x - tlB.x);
      rr.h = Math.abs(brB.y - tlB.y);
      shape.points = [tlB, brB];
    }

    // 多选回写: 重建时不激活单个对象 (由 restoreMultiSelection 统一恢复)
    Model.selectedId = null;
    var shapeRef = shape;
    setTimeout(function() {
      Renderer.rebuildOne(shapeRef);
    }, 0);
    if (S && S.autoPreview) schedulePreview();
  },

  // 回写单个对象到 model
  writeBack: function(obj) {
    if (!obj || !obj._shapeId) return;
    var shape = Model.getShape(obj._shapeId);
    if (!shape) return;

    // center 原点: left/top 即视觉中心
    // worldPt = center + R(localPt - pathOffset)
    var po = obj.pathOffset || {x: 0, y: 0};
    var cos = Math.cos(obj.angle * Math.PI / 180);
    var sin = Math.sin(obj.angle * Math.PI / 180);
    var cx = obj.left, cy = obj.top;
    var localToWorld = function(lx, ly) {
      var rx = (lx - po.x) * obj.scaleX;
      var ry = (ly - po.y) * obj.scaleY;
      return {
        x: cx + rx * cos - ry * sin,
        y: cy + rx * sin + ry * cos
      };
    };

    if (shape.type === "polygon") {
      var localPts = [];
      obj.path.forEach(function(cmd) {
        if (cmd[0] === "M" || cmd[0] === "L") {
          localPts.push({x: cmd[1], y: cmd[2]});
        }
      });
      shape.points = localPts.map(function(p) {
        var w = localToWorld(p.x, p.y);
        return Scene.canvasToBed(w.x, w.y);
      });
      // 正多边形: 从最终 bed 顶点同步中心、半径和角度，避免重复应用 Fabric 的屏幕角度。
      if (shape.poly) Model.syncRegularPolyMetadata(shape);
    } else if (shape.type === "circle") {
      // 圆形是 center 原点: left/top 即圆心, 旋转绕圆心自身
      var cc = Scene.canvasToBed(obj.left, obj.top);
      var ee = Scene.canvasToBed(obj.left + obj.radius * obj.scaleX * cos, obj.top + obj.radius * obj.scaleX * sin);
      shape.points = [{x: cc.x, y: cc.y}, {x: ee.x, y: ee.y}];
    } else if (shape.type === "rect") {
      // 回写矩形属性: 位置/宽高/角度/圆角
      var r = shape.rect;
      var newCenter = Scene.canvasToBed(obj.left, obj.top);
      r.x = newCenter.x;
      r.y = newCenter.y;
      r.w = obj.width * obj.scaleX / Scene.scale;
      r.h = obj.height * obj.scaleY / Scene.scale;
      r.angle = obj.angle || 0;
      r.radius = ((obj.rx || 0) / Scene.scale);
      // 同步 points (用于 hitTest 等)
      shape.points = [
        {x: r.x - r.w / 2, y: r.y - r.h / 2},
        {x: r.x + r.w / 2, y: r.y + r.h / 2}
      ];
    }

    // 延迟重建, 避免在 object:modified 事件内部移除当前对象
    var shapeRef = shape;
    setTimeout(function() {
      Renderer.rebuildOne(shapeRef);
    }, 0);
    if (S && S.autoPreview) schedulePreview();
  },

  onMoving: function(o) {
    // 移动会使点击位置的命中堆栈失效。
    this.clearHitStack();
    // 移动时实时更新 model (用于 SVG 覆盖层同步)
    var obj = o.target;
    if (!obj) return;

    // 多选: 分别处理
    if (obj.type === "activeSelection") {
      var self = this;
      obj.getObjects().forEach(function(sub) {
        self.syncMoving(sub);
      });
      return;
    }
    this.syncMoving(obj);
  },

  syncMoving: function(obj) {
    if (!obj || !obj._shapeId) return;
    var shape = Model.getShape(obj._shapeId);
    if (!shape || Model.editId === shape.id) return;

    if (shape.type === "polygon") {
      // center 原点: worldPt = center + R(p - pathOffset)
      var po2 = obj.pathOffset || {x: 0, y: 0};
      var cos2 = Math.cos(obj.angle * Math.PI / 180);
      var sin2 = Math.sin(obj.angle * Math.PI / 180);
      var localPts = [];
      obj.path.forEach(function(cmd) {
        if (cmd[0] === "M" || cmd[0] === "L") {
          localPts.push({x: cmd[1], y: cmd[2]});
        }
      });
      shape.points = localPts.map(function(p) {
        var rx = (p.x - po2.x) * obj.scaleX;
        var ry = (p.y - po2.y) * obj.scaleY;
        return Scene.canvasToBed(
          obj.left + rx * cos2 - ry * sin2,
          obj.top + rx * sin2 + ry * cos2
        );
      });
      if (shape.poly) Model.syncRegularPolyMetadata(shape);
    }
  },

  onSelected: function(o) {
    if (this.applyingHitStackSelection) return;
    if (this.canvas.getActiveObject() && this.canvas.getActiveObject().type === "activeSelection") {
      Model.selectedId = null;
      this.clearHitStack();
      return;
    }
    if (o.selected && o.selected[0] && o.selected[0]._shapeId) {
      var id = o.selected[0]._shapeId;
      this.promoteSelectedShape(id);
      Model.selectedId = id;
      if (typeof showProps === "function") showProps(Model.selectedId);
      if (typeof renderObjectList === "function") renderObjectList();
    }
  },

  // ---- 钢笔 ----

  finishPen: function() {
    if (this.penPts.length < 3) { this.cancelPen(); return; }
    this.clearPenUI();
    var shape = Model.addShape("polygon", this.penPts, "pen");
    this.penActive = false;
    this.setTool("select");
    Renderer.rebuildAll();
    if (S && S.autoPreview) schedulePreview();
  },

  cancelPen: function() {
    this.clearPenUI();
    this.penActive = false;
    this.penPts = [];
  },

  clearPenUI: function() {
    if (this.penPreview) { this.canvas.remove(this.penPreview); this.penPreview = null; }
    this.penLines.forEach(function(l) { this.canvas.remove(l); }, this);
    this.penLines = [];
    if (this.penStart) { this.canvas.remove(this.penStart); this.penStart = null; }
    this.canvas.getObjects().forEach(function(o) {
      if (o.type === "circle" && o.radius <= 5 && !o.selectable) this.canvas.remove(o);
    }, this);
    this.canvas.renderAll();
  },

  // ---- 形状创建 ----

  createShape: function(type, bx, by) {
    this.clearHitStack();
    var points;
    if (type === "rect") {
      points = [
        {x: bx - 10, y: by - 8},
        {x: bx + 10, y: by + 8}
      ];
    } else if (type === "circle") {
      points = [
        {x: bx, y: by},
        {x: bx + 10, y: by}
      ];
    } else if (type === "polygon") {
      points = [];
      var R = 10;
      for (var i = 0; i < this.polySides; i++) {
        var a = Math.PI / 2 + 2 * Math.PI / this.polySides * i;
        points.push({x: bx + R * Math.cos(a), y: by + R * Math.sin(a)});
      }
    }
    Model.addShape(type, points, type);
    Renderer.rebuildAll();
  },

  // ---- 键盘 ----

  onKey: function(e) {
    if (this.isTextEditing(e)) return;
    if (e.key === "Tab") {
      var canvasFocused = this.canvas.upperCanvasEl && document.activeElement === this.canvas.upperCanvasEl;
      var multiSelecting = this.canvas.getActiveObject() && this.canvas.getActiveObject().type === "activeSelection";
      if (this.activeTool === "select" && !Model.editId && !Sketch.rectify && canvasFocused && !multiSelecting && this.cycleHitStack(e.shiftKey)) {
        e.preventDefault();
      }
      return;
    }
    if (e.key === "s" || e.key === "S") this.setTool("select");
    else if (e.key === "p" || e.key === "P") { this.setTool("pen"); e.preventDefault(); }
    else if (e.key === "Delete" || e.key === "Backspace") {
      if (Model.editId) { e.preventDefault(); return; }
      if (Model.selectedId) {
        Model.removeShape(Model.selectedId);
        Renderer.rebuildAll();
        e.preventDefault();
      }
    }
    else if (e.key === "Escape") {
      if (this.penActive) { this.cancelPen(); this.setTool("select"); }
      else if (Model.editId) { Model.editId = null; Overlay.hide(); }
      else if (Sketch.rectify) { Sketch.cancelRectify(); }
    }
  }
};
