// ============================================================
// app.js — 入口 + 全局状态 + SCAD 导出
// 架构: Model(数据) → Renderer(Fabric渲染) + Overlay(SVG编辑)
// ============================================================

var S = {activeTool: "select", wall: 2, bottom: 2, h: 50, divRatio: 0.9,
         serverReady: false, autoPreview: true, renderSeq: 0, renderAbort: null,
         outlineMode: "original",       // "original" 原始轮廓 | "wall" 墙
         offsetDir: "inner",            // 墙模式偏置方向: "inner" 内 | "outer" 外 | "both" 两侧
         defaultWall: 2,                // 墙模式图形壁厚初始值 (mm)
         defaultHeight: 43.2,           // 图形拉伸高度初始值 (mm)
         floorType: "none",             // 底板类型: "none" 无 | "outline" 轮廓 | "bbox" 边界框 | "hull" 凸包
         floorMargin: 0,                // 底板外边距 (mm, 外偏置)
         libraryManageMode: false};     // 用户图形管理模式 (仅当前页面会话)
var canvas;

function $(id) { return document.getElementById(id); }

// ---- 初始化 ----
function init() {
  canvas = new fabric.Canvas("editor-canvas", {
    selection: true, backgroundColor: "#474747",
    preserveObjectStacking: true, stopContextMenu: true, fireRightClick: true
  });

  Scene.canvas = canvas;
  Scene.initDropdown();
  Renderer.init(canvas);
  Overlay.init();
  Sketch.init(canvas);
  Controller.init(canvas);

  window.addEventListener("resize", resize);
  resize();

  // 中键平移打印板
  var upperEl = null;
  canvas.on("after:render", function() {
    if (!upperEl) {
      upperEl = canvas.getElement().querySelector(".upper-canvas");
      if (!upperEl) return;
      upperEl.addEventListener("mousedown", function(e) {
        if (e.button !== 1) return;
        Controller.bedPanning = true;
        Controller.bedPanLast = {x: e.clientX, y: e.clientY};
        e.preventDefault(); e.stopPropagation();
      }, true);
    }
  });

  bindUI();
  renderObjectList();
  var cfg = Settings.load();
  S.outlineMode = cfg.outlineMode;
  S.offsetDir = cfg.offsetDir;
  S.defaultWall = cfg.defaultWall;
  S.defaultHeight = cfg.defaultHeight;
  S.floorType = cfg.floorType;
  S.floorMargin = cfg.floorMargin;
  Model.defaults.wall = S.defaultWall;
  Model.defaults.height = S.defaultHeight;
  Preview3D.init();
  CodeView.init();
  Settings.init();

  checkServerHealth();
}

function resize() {
  var area = document.getElementById("canvas-area");
  canvas.setWidth(area.clientWidth);
  canvas.setHeight(area.clientHeight);
  Scene.rebuild(); // 图形/草图/覆盖层同步已由 Scene.rebuild 内部处理
  Overlay.resize(area.clientWidth, area.clientHeight);
}

// ---- UI ----
function bindUI() {
  document.querySelectorAll(".tbtn[data-tool]").forEach(function(b) {
    b.addEventListener("click", function() { Controller.setTool(b.dataset.tool); });
  });
  $("btn-export").addEventListener("click", exportCurrentSource);
  $("btn-reset").addEventListener("click", resetAll);
  $("btn-lib-manage").addEventListener("click", function() {
    setLibraryManageMode(!S.libraryManageMode);
  });
  $("chk-autopreview").addEventListener("change", function() {
    S.autoPreview = this.checked;
    // 勾选时立即渲染一次 (预览同步当前模型, 不用等下次编辑)
    if (this.checked) renderSTL(generateSCAD(), {generated: true});
  });

  bindProps();
  ["p-wall", "p-bottom", "p-h", "p-dr"].forEach(function(id) {
    $(id).addEventListener("input", function() {
      var v = parseFloat(this.value);
      if (id === "p-wall") S.wall = v;
      else if (id === "p-bottom") S.bottom = v;
      else if (id === "p-h") S.h = Math.round(v);
      else if (id === "p-dr") S.divRatio = v;
      var vid = "v-" + id.substring(2);
      if ($(vid)) $(vid).textContent = v;
      CodeView.scheduleCodeRefresh();
      if (S.autoPreview) schedulePreview();
    });
  });
  renderLib();
}

var previewTimer = null;
function schedulePreview() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(function() {
    // 模型改变后 CodeView 会覆盖草稿；自动预览始终使用最新图形生成的源码。
    renderSTL(generateSCAD(), {generated: true});
  }, 500);
}

// ---- 属性面板 ----
function showProps(shapeId) {
  var shape = shapeId ? Model.getShape(shapeId) : null;
  if (!shape) {
    $("prop-empty").style.display = "block";
    $("prop-content").style.display = "none";
    return;
  }
  $("prop-empty").style.display = "none";
  $("prop-content").style.display = "block";

  // 通用属性: 位置
  var cx = 0, cy = 0;
  if (shape.rect) { cx = shape.rect.x; cy = shape.rect.y; }
  else if (shape.poly) { cx = shape.poly.x; cy = shape.poly.y; }
  else if (shape.points.length >= 2) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    shape.points.forEach(function(p) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    });
    cx = (minX + maxX) / 2; cy = (minY + maxY) / 2;
  }
  $("prop-x").value = cx.toFixed(1);
  $("prop-y").value = cy.toFixed(1);

  // 矩形: 宽/高/圆角/角度
  var isRect = !!shape.rect, isPoly = !!shape.poly, isCircle = (shape.type === "circle");
  var isPenPoly = (shape.type === "polygon" && !shape.poly);
  // 可导出图形类型 (polygon/rect/circle)
  var isExportable = (shape.type === "polygon" || shape.type === "rect" || shape.type === "circle");
  $("prop-w-label").style.display = isRect ? "block" : "none";
  $("prop-h-label").style.display = isRect ? "block" : "none";
  $("prop-corner-label").style.display = isRect ? "block" : "none";
  $("prop-dia-label").style.display = (isCircle || isPoly) ? "block" : "none";
  $("prop-sides-label").style.display = isPoly ? "block" : "none";
  $("prop-angle-label").style.display = (isRect || isPoly) ? "block" : "none";
  $("prop-verts-label").style.display = isPenPoly ? "block" : "none";
  // 拉伸高度 (任意模式) / 壁厚 (仅墙模式) — 导出属性
  $("prop-height-label").style.display = isExportable ? "block" : "none";
  $("prop-wall-label").style.display = (isExportable && S.outlineMode === "wall") ? "block" : "none";
  if (isExportable) {
    $("prop-height").value = (typeof shape.height === "number" ? shape.height : S.defaultHeight).toFixed(1);
    $("prop-wall").value = (typeof shape.wall === "number" ? shape.wall : S.defaultWall).toFixed(1);
  }

  if (isRect) {
    $("prop-w").value = shape.rect.w.toFixed(1);
    $("prop-h").value = shape.rect.h.toFixed(1);
    $("prop-corner").value = (shape.rect.radius || 0).toFixed(1);
    $("prop-angle").value = (shape.rect.angle || 0).toFixed(0);
  }
  if (isCircle) {
    // 直径 = 两点距离 (圆心到边上一点 × 2)
    var rad = Math.hypot(shape.points[1].x - shape.points[0].x, shape.points[1].y - shape.points[0].y);
    $("prop-dia").value = (rad * 2).toFixed(1);
  }
  if (isPoly) {
    $("prop-dia").value = (shape.poly.radius * 2).toFixed(1);
    $("prop-sides").value = shape.poly.sides;
    $("prop-angle").value = (shape.poly.angle || 0).toFixed(0);
  }
  if (isPenPoly) {
    renderVertList(shape);
  }
}

// 任意多边形顶点列表
function renderVertList(shape) {
  var el = $("prop-verts");
  if (!el) return;
  el.innerHTML = "";
  shape.points.forEach(function(p, idx) {
    var row = document.createElement("div");
    row.className = "vert-row";
    row.innerHTML =
      '<span class="vert-idx">#' + idx + '</span>' +
      '<input class="vert-x" type="number" step="0.1" value="' + p.x.toFixed(1) + '">' +
      '<input class="vert-y" type="number" step="0.1" value="' + p.y.toFixed(1) + '">' +
      '<button class="vert-del" title="删除顶点">×</button>';
    el.appendChild(row);

    // X/Y 编辑
    row.querySelector(".vert-x").addEventListener("input", function() {
      var v = parseFloat(this.value);
      if (!isNaN(v)) { shape.points[idx].x = v; Renderer.rebuildOne(shape); if (Model.editId === shape.id) Overlay.render(); if (S.autoPreview) schedulePreview(); }
    });
    row.querySelector(".vert-y").addEventListener("input", function() {
      var v = parseFloat(this.value);
      if (!isNaN(v)) { shape.points[idx].y = v; Renderer.rebuildOne(shape); if (Model.editId === shape.id) Overlay.render(); if (S.autoPreview) schedulePreview(); }
    });
    // 删除顶点
    row.querySelector(".vert-del").addEventListener("click", function() {
      if (shape.points.length <= 3) return;
      shape.points.splice(idx, 1);
      Renderer.rebuildOne(shape);
      if (Model.editId === shape.id) Overlay.render();
      renderVertList(shape);
      if (S.autoPreview) schedulePreview();
    });
  });
}

function bindProps() {
  // X/Y 位置
  ["prop-x", "prop-y"].forEach(function(id) {
    $(id).addEventListener("input", function() {
      var shape = Model.getSelected();
      if (!shape) return;
      var nx = parseFloat($("prop-x").value);
      var ny = parseFloat($("prop-y").value);
      if (isNaN(nx) || isNaN(ny)) return;
      if (shape.rect) {
        shape.rect.x = nx; shape.rect.y = ny;
        shape.points = [{x: nx - shape.rect.w/2, y: ny - shape.rect.h/2}, {x: nx + shape.rect.w/2, y: ny + shape.rect.h/2}];
      } else if (shape.poly) {
        shape.poly.x = nx; shape.poly.y = ny;
      } else {
        var dx = nx - (shape._propCx || nx);
        var dy = ny - (shape._propCy || ny);
        shape.points.forEach(function(p) { p.x += dx; p.y += dy; });
      }
      shape._propCx = nx; shape._propCy = ny;
      Renderer.rebuildOne(shape);
      if (S.autoPreview) schedulePreview();
    });
  });

  // 矩形宽/高/圆角/角度
  ["prop-w", "prop-h", "prop-corner", "prop-angle"].forEach(function(id) {
    $(id).addEventListener("input", function() {
      var shape = Model.getSelected();
      if (!shape || !shape.rect) return;
      var w = parseFloat($("prop-w").value);
      var h = parseFloat($("prop-h").value);
      var cr = parseFloat($("prop-corner").value);
      var a = parseFloat($("prop-angle").value);
      if (!isNaN(w) && w > 0) shape.rect.w = w;
      if (!isNaN(h) && h > 0) shape.rect.h = h;
      if (!isNaN(cr) && cr >= 0) shape.rect.radius = Math.min(cr, Math.min(shape.rect.w, shape.rect.h) / 2);
      if (!isNaN(a)) shape.rect.angle = a;
      Renderer.rebuildOne(shape);
      if (S.autoPreview) schedulePreview();
    });
  });

  // 正多边形边数/角度
  ["prop-sides", "prop-angle"].forEach(function(id) {
    $(id).addEventListener("input", function() {
      var shape = Model.getSelected();
      if (!shape || !shape.poly) return;
      var s = parseInt($("prop-sides").value);
      var a = parseFloat($("prop-angle").value);
      if (!isNaN(s) && s >= 3 && s <= 12) shape.poly.sides = s;
      if (!isNaN(a)) shape.poly.angle = a;
      Renderer.rebuildOne(shape);
      if (S.autoPreview) schedulePreview();
    });
  });

  // 拉伸高度 / 壁厚 (polygon 图形导出属性)
  [["prop-height", "height"], ["prop-wall", "wall"]].forEach(function(pair) {
    $(pair[0]).addEventListener("input", function() {
      var shape = Model.getSelected();
      if (!shape) return;
      var v = parseFloat(this.value);
      if (isNaN(v) || v <= 0) return;
      shape[pair[1]] = v;
      CodeView.scheduleCodeRefresh();
      if (S.autoPreview) schedulePreview();
    });
  });

  // 直径 (圆形 + 正多边形共用)
  $("prop-dia").addEventListener("input", function() {
    var shape = Model.getSelected();
    if (!shape) return;
    var d = parseFloat(this.value);
    if (isNaN(d) || d <= 0) return;
    if (shape.type === "circle") {
      var rad = d / 2;
      var cx = shape.points[0].x, cy = shape.points[0].y;
      shape.points[1] = {x: cx + rad, y: cy};
    } else if (shape.poly) {
      shape.poly.radius = d / 2;
    } else return;
    Renderer.rebuildOne(shape);
    if (S.autoPreview) schedulePreview();
  });
}

async function checkServerHealth() {
  var label = $("status-wasm");
  try {
    var response = await fetch("api/health", {cache: "no-store"});
    var data = await response.json();
    if (!response.ok || data.status !== "ok") throw new Error(data.message || "服务不可用");
    S.serverReady = true;
    var supports3mf = !data.formats || data.formats["3mf"] !== false;
    $("sel-format").querySelector('option[value="3mf"]').disabled = !supports3mf;
    if (!supports3mf && $("sel-format").value === "3mf") $("sel-format").value = "stl";
    label.textContent = supports3mf ? "服务 OK · STL/3MF" : "服务 OK · 仅 STL";
    label.style.color = supports3mf ? "#4caf50" : "#f39c12";
    $("btn-export").disabled = false;
    if (S.autoPreview) renderSTL(generateSCAD(), {generated: true});
  } catch (err) {
    S.serverReady = false;
    label.textContent = "服务未连接";
    label.style.color = "#e74c3c";
    $("btn-export").disabled = true;
    $("status-text").textContent = "无法连接 BoxMaker 服务：运行 node examples/BoxMaker/server.js";
  }
}

function resetAll() {
  Model.clearAll();
  Scene.panX = 0; Scene.panY = 0;
  Scene.rebuild();
  Overlay.hide();
  if (Controller) Controller.setTool("select");
  S.wall = 2; S.bottom = 2; S.h = 50; S.divRatio = 0.9;
  $("p-wall").value = 2; $("v-wall").textContent = "2.0";
  $("p-bottom").value = 2; $("v-bottom").textContent = "2.0";
  $("p-h").value = 50; $("v-h").textContent = "50";
  $("p-dr").value = 0.9; $("v-dr").textContent = "0.9";
  // 应用设置
  S.outlineMode = "original";
  S.offsetDir = "inner";
  S.defaultWall = 2; Model.defaults.wall = 2;
  S.defaultHeight = 43.2; Model.defaults.height = 43.2;
  S.floorType = "none";
  S.floorMargin = 0;
  Settings.save();
  Settings.syncUI();
  CodeView.refresh();
  if (S.autoPreview) schedulePreview(); // 重置后渲染空模型
  $("status-text").textContent = "已重置";
}

// ---- SCAD 生成 ----
// 导出模型 = 底板(按底板类型, 可无) + 图形挤出(原始嵌套 / 墙偏置); 不生成床轮廓的外壳
// 图形类型: polygon / rect(含圆角/旋转) / circle(SCAD 圆原语)

// 图形中心 (正多边形/矩形的参数中心; 普通 polygon 取包围盒中心)
function shapeCenter(s) {
  if (s.type === "circle") return {x: s.points[0].x, y: s.points[0].y};
  if (s.type === "rect") return {x: s.rect.x, y: s.rect.y};
  if (s.poly) return {x: s.poly.x, y: s.poly.y};
  var b = Model.getBounds(s);
  return {x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2};
}

// 最终定位后的 2D 表达式 (坐标已是打印板 XY 坐标, 无 z)
function shapeExpr(s) {
  if (s.type === "circle") {
    var c = s.points[0];
    var circleRadius = Math.hypot(s.points[1].x - c.x, s.points[1].y - c.y);
    return "translate([" + c.x.toFixed(1) + ", " + c.y.toFixed(1) + "])circle(r=" + circleRadius.toFixed(1) + ")";
  }
  if (s.type === "rect") {
    var r = s.rect;
    var cornerRadius = r.radius || 0;
    var rect = "rect([" + r.w.toFixed(1) + ", " + r.h.toFixed(1) + "]" +
      (cornerRadius > 0 ? ", rounding=" + cornerRadius.toFixed(1) : "") + ")";
    // BOSL2 rect 默认 anchor=CENTER，与 BoxMaker 的局部中心坐标保持一致。
    return "translate([" + r.x.toFixed(1) + ", " + r.y.toFixed(1) + "])zrot(" + ((r.angle || 0).toFixed(1)) + ")" + rect;
  }
  if (s.poly) {
    var poly = s.poly;
    // Canvas 中 angle=0 的首个顶点在 +Y；OpenSCAD circle($fn=...) 的首个顶点在 +X。
    var scadAngle = (poly.angle || 0) + 90;
    return "translate([" + poly.x.toFixed(1) + ", " + poly.y.toFixed(1) + "])zrot(" + scadAngle.toFixed(1) + ")circle(d=" + (poly.radius * 2).toFixed(1) + ", $fn=" + poly.sides + ")";
  }
  // 普通多边形的 points 已是最终 bed 坐标；不得再平移或旋转。
  var pts = s.points.map(function(p) { return "[" + p.x.toFixed(1) + ", " + p.y.toFixed(1) + "]"; }).join(",");
  return "polygon(points=[" + pts + "])";
}

// 将最终 XY 2D 表达式挤出到指定 z；调用方不得再添加 XY 平移。
function extrudeExpr(expr, height, z) {
  return "translate([0,0," + z.toFixed(1) + "]) linear_extrude(" + height.toFixed(1) + ") " + expr;
}

// 偏置包装 (d=0 时不包裹; 正=外偏置, 负=内偏置)
function offsetExpr(expr, d) {
  return d !== 0 ? "offset(r=" + d.toFixed(1) + ")" + expr : expr;
}

// 图形有效外轮廓的外扩量 (墙模式: outer 外偏置→壁厚, both 两侧→壁厚/2, 其余 0)
function shapeOutset(s) {
  if (S.outlineMode !== "wall") return 0;
  var t = (typeof s.wall === "number" && s.wall > 0) ? s.wall : S.defaultWall;
  if (S.offsetDir === "outer") return t;
  if (S.offsetDir === "both") return t / 2;
  return 0;
}

// 可导出图形 (visible; polygon 需 >=3 点)
function exportShapes() {
  return Model.shapes.filter(function(s) {
    if (s.visible === false) return false;
    if (s.type === "polygon") return s.points.length >= 3;
    return s.type === "rect" || s.type === "circle";
  });
}

function generateSCAD() {
  var scad = "include <BOSL2/std.scad>\n";

  var dh = (S.h - S.bottom) * S.divRatio;
  var polys = exportShapes();
  // 图形底部高度: 有底板时立于底板上 (S.bottom), 无底板时落到 z=0
  var baseH = (S.floorType === "none") ? 0 : S.bottom;

  // 模块化结构: 顶部定义 plate/walls, 底部调用
  var plateBody = generatePlateBody(polys);
  if (plateBody !== null) {
    scad += "module plate(){\n" + plateBody + "}\n";
  }
  scad += "module walls(){\n" + generateWallsBody(polys, baseH, dh) + "}\n";
  if (plateBody !== null) scad += "plate();\n";
  scad += "walls();\n";
  return scad;
}

// ---- walls 模块内容 (图形挤出: 原始嵌套 / 墙偏置) ----
function generateWallsBody(polys, baseH, dh) {
  var out = "";

  if (S.outlineMode === "wall") {
    // 墙模式: 每个轮廓按"偏置方向"生成墙:
    //   inner: 原始 − 内偏置(壁厚);  outer: 外偏置(壁厚) − 原始;  both: 各偏壁厚/2 (轮廓为中心线)
    // 图形表达式已包含最终 XY 位置；挤出时仅增加 Z 平移。
    polys.forEach(function(s) {
      var t = (typeof s.wall === "number" && s.wall > 0) ? s.wall : S.defaultWall;
      var h = (typeof s.height === "number" && s.height > 0) ? s.height : dh;
      var a = 0, b = 0;
      if (S.offsetDir === "inner") b = -t;
      else if (S.offsetDir === "outer") a = t;
      else { a = t / 2; b = -t / 2; }
      var expr = shapeExpr(s);
      out += "  translate([0,0," + baseH.toFixed(1) + "]) linear_extrude(" + h.toFixed(1) + ") difference(){\n";
      out += "    " + offsetExpr(expr, a) + ";\n";
      out += "    " + offsetExpr(expr, b) + ";\n";
      out += "  };\n";
    });
    return out;
  }

  // 原始轮廓模式: 计算包含深度 (0=外轮廓, 1=孔, 2=孔中岛...); 隐藏图形不参与
  polys.forEach(function(s) { s._depth = Model.containmentDepth(s); });

  // 对每个外轮廓 (depth=0), 收集其直接包含的孔 (depth=1)
  polys.forEach(function(outer) {
    if (outer._depth !== 0) return;
    var holes = polys.filter(function(h) {
      return h._depth === 1 && Model.polygonContains(outer, h);
    });
    var oh = (typeof outer.height === "number" && outer.height > 0) ? outer.height : dh;
    if (holes.length > 0) {
      out += "  difference(){\n";
      out += "    " + extrudeExpr(shapeExpr(outer), oh, baseH) + ";\n";
      holes.forEach(function(h) {
        var hh = (typeof h.height === "number" && h.height > 0) ? h.height : oh;
        out += "    " + extrudeExpr(shapeExpr(h), hh + 1, baseH - 0.5) + ";\n";
      });
      out += "  };\n";
    } else {
      out += "  " + extrudeExpr(shapeExpr(outer), oh, baseH) + ";\n";
    }
  });
  return out;
}

// ---- plate 模块内容 (底板类型: 无→null / 轮廓 / 边界框 / 凸包; 外边距外偏置) ----
function generatePlateBody(polys) {
  if (S.floorType === "none" || !polys.length) return null;
  var m = S.floorMargin || 0;
  var out = "";
  if (S.floorType === "outline") {
    // 各图形有效外轮廓单独构成底板 (外扩 shapeOutset + 外边距)
    polys.forEach(function(s) {
      out += "  linear_extrude(" + S.bottom + ") " + offsetExpr(shapeExpr(s), shapeOutset(s) + m) + ";\n";
    });
  } else if (S.floorType === "bbox") {
    // 所有有效外轮廓的包围盒
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    polys.forEach(function(s) {
      var t = shapeOutset(s);
      Model.getOutlinePoints(s).forEach(function(pt) {
        minX = Math.min(minX, pt.x - t); minY = Math.min(minY, pt.y - t);
        maxX = Math.max(maxX, pt.x + t); maxY = Math.max(maxY, pt.y + t);
      });
    });
    out += "  linear_extrude(" + S.bottom + ") " + offsetExpr("polygon(points=[[" + minX.toFixed(1) + ", " + minY.toFixed(1) + "], [" + maxX.toFixed(1) + ", " + minY.toFixed(1) + "], [" + maxX.toFixed(1) + ", " + maxY.toFixed(1) + "], [" + minX.toFixed(1) + ", " + maxY.toFixed(1) + "]])", m) + ";\n";
  } else {
    // 凸包: hull() 所有有效外轮廓 (子项以分号分隔)
    var hull = polys.map(function(s) {
      return "    " + offsetExpr(shapeExpr(s), shapeOutset(s)) + ";\n";
    }).join("");
    out += "  linear_extrude(" + S.bottom + ") " + offsetExpr("hull(){\n" + hull + "  }", m) + ";\n";
  }
  return out;
}

// ---- 服务端渲染 / 导出 ----
function serverError(response, fallback) {
  return response.text().then(function(text) {
    try { return JSON.parse(text).error || fallback; }
    catch (e) { return text || fallback; }
  });
}

async function renderSTL(source, options) {
  options = options || {};
  if (!S.serverReady) {
    $("status-text").textContent = "服务未连接，无法预览";
    return false;
  }
  source = source || generateSCAD();
  if (!source.trim()) {
    $("status-text").textContent = "SCAD 代码为空";
    return false;
  }

  var seq = ++S.renderSeq;
  if (S.renderAbort) S.renderAbort.abort();
  var abort = new AbortController();
  S.renderAbort = abort;
  $("status-text").textContent = options.manual ? "正在预览手写 SCAD..." : "正在生成 3D 预览...";
  var previewButton = $("cw-preview");
  if (previewButton) previewButton.disabled = true;

  try {
    var response = await fetch("api/render?format=stl", {
      method: "POST",
      headers: {"Content-Type": "text/plain; charset=utf-8"},
      body: source,
      signal: abort.signal
    });
    if (!response.ok) throw new Error(await serverError(response, "服务端渲染失败"));
    var buffer = await response.arrayBuffer();
    if (seq !== S.renderSeq) return false;
    var faces = buffer.byteLength >= 84 ? Math.floor((buffer.byteLength - 84) / 50) : 0;
    Preview3D.loadSTL(buffer);
    $("status-text").textContent = "预览完成：" + faces + " 个三角面";
    return true;
  } catch (err) {
    if (err.name === "AbortError") return false;
    if (seq === S.renderSeq) {
      console.error("BoxMaker render error:", err);
      $("status-text").textContent = "预览失败：" + (err.message || err);
    }
    return false;
  } finally {
    if (seq === S.renderSeq) S.renderAbort = null;
    if (previewButton) previewButton.disabled = !S.serverReady;
  }
}

async function exportCurrentSource() {
  if (!S.serverReady) {
    $("status-text").textContent = "服务未连接，无法导出";
    return;
  }
  var format = $("sel-format").value;
  var source = (CodeView && CodeView.getSource) ? CodeView.getSource() : generateSCAD();
  if (!source.trim()) {
    $("status-text").textContent = "SCAD 代码为空";
    return;
  }
  var button = $("btn-export");
  button.disabled = true;
  $("status-text").textContent = "正在导出 " + format.toUpperCase() + "...";
  try {
    var response = await fetch("api/export?format=" + encodeURIComponent(format), {
      method: "POST",
      headers: {"Content-Type": "text/plain; charset=utf-8"},
      body: source
    });
    if (!response.ok) throw new Error(await serverError(response, "服务端导出失败"));
    var data = await response.arrayBuffer();
    var mime = format === "3mf" ? "application/vnd.ms-package.3dmanufacturing-3dmodel+xml" : "model/stl";
    var url = URL.createObjectURL(new Blob([data], {type: mime}));
    var a = document.createElement("a");
    a.href = url;
    a.download = "boxmaker." + format;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
    $("status-text").textContent = format.toUpperCase() + " 已导出";
  } catch (err) {
    console.error("BoxMaker export error:", err);
    $("status-text").textContent = "导出失败：" + (err.message || err);
  } finally {
    button.disabled = !S.serverReady;
  }
}

// ---- 右键菜单 ----
function showContextMenu(x, y, hits) {
  if (!hits || !hits.length) return;
  var old = document.querySelector(".ctx-menu");
  if (old) old.remove();

  var menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  menu.addEventListener("mousedown", function(e) { e.stopPropagation(); });
  menu.addEventListener("click", function(e) { e.stopPropagation(); });

  var add = function(text, fn, className) {
    var item = document.createElement("button");
    item.type = "button";
    item.className = className || "ctx-item";
    item.textContent = text;
    item.onclick = function() { fn(); menu.remove(); };
    menu.appendChild(item);
  };
  var addDivider = function() {
    var divider = document.createElement("div");
    divider.className = "ctx-divider";
    menu.appendChild(divider);
  };
  var iconFor = function(shape) {
    return shape.type === "rect" ? "⬜" : shape.type === "circle" ? "⭕" : (shape.poly ? "⬡" : "✏");
  };

  var title = document.createElement("div");
  title.className = "ctx-title";
  title.textContent = "点击位置的图形";
  menu.appendChild(title);
  hits.forEach(function(shape, depth) {
    var depthLabel = depth === 0 ? "顶层" : "下层 " + depth;
    add(iconFor(shape) + " " + shape.id + " · " + depthLabel, function() {
      Controller.selectShapeById(shape.id, false);
    }, "ctx-item ctx-depth-item");
  });

  var topShapeId = hits[0].id;
  addDivider();
  add("保存顶层图形到图形库", function() { saveToLib(topShapeId); });
  add("删除顶层图形", function() {
    if (Controller) Controller.clearHitStack();
    Model.removeShape(topShapeId);
    Renderer.rebuildAll();
  }, "ctx-item ctx-danger");
  document.body.appendChild(menu);

  var rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)) + "px";
  menu.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)) + "px";
  document.addEventListener("click", function() { menu.remove(); }, {once: true});
}

// ---- 用户图形库 ----
function cloneLibraryValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function setLibraryStatus(message) {
  var status = $("status-text");
  if (status) status.textContent = message;
}

function getUserLibrary() {
  var raw;
  try {
    raw = localStorage.getItem("boxmaker_lib");
  } catch (e) {
    setLibraryStatus("无法读取用户图形库");
    return [];
  }
  try {
    var lib = JSON.parse(raw || "[]");
    return Array.isArray(lib) ? lib : [];
  } catch (e) {
    try {
      localStorage.removeItem("boxmaker_lib");
      setLibraryStatus("用户图形库数据损坏，已重置");
    } catch (removeError) {
      setLibraryStatus("用户图形库数据损坏，且无法重置");
    }
    return [];
  }
}

function writeUserLibrary(lib) {
  try {
    localStorage.setItem("boxmaker_lib", JSON.stringify(lib));
    return true;
  } catch (e) {
    setLibraryStatus("无法保存用户图形库");
    return false;
  }
}

function setLibraryManageMode(managing) {
  S.libraryManageMode = !!managing;
  if (S.libraryManageMode && Controller.activeTool === "library") Controller.setTool("select");
  renderLib();
}

function deleteFromLib(index) {
  var lib = getUserLibrary();
  if (index < 0 || index >= lib.length) return false;
  var next = lib.slice();
  next.splice(index, 1);
  if (!writeUserLibrary(next)) return false;
  if (Controller.activeTool === "library") Controller.setTool("select");
  renderLib();
  setLibraryStatus("已从用户图形库删除");
  return true;
}

function isExportableShape(shape) {
  return shape && (shape.type === "rect" || shape.type === "circle" ||
    (shape.type === "polygon" && shape.points && shape.points.length >= 3));
}

function saveToLib(shapeId) {
  var shape = Model.getShape(shapeId);
  if (!isExportableShape(shape)) return;
  var lib = getUserLibrary();
  if (lib.length >= 20) lib.shift();
  var item = {
    schema: 2,
    name: shape.id,
    type: shape.type,
    toolType: shape.toolType,
    points: cloneLibraryValue(shape.points),
    wall: shape.wall,
    height: shape.height
  };
  if (shape.rect) item.rect = cloneLibraryValue(shape.rect);
  if (shape.poly) item.poly = cloneLibraryValue(shape.poly);
  lib.push(item);
  if (!writeUserLibrary(lib)) return;
  renderLib();
  setLibraryStatus("已保存到用户图形库");
}

function templateCenter(item) {
  if (item.rect) return {x: item.rect.x, y: item.rect.y};
  if (item.poly) return {x: item.poly.x, y: item.poly.y};
  if (item.type === "circle" && item.points && item.points[0]) return item.points[0];
  var points = item.points || [];
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  points.forEach(function(p) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  });
  return points.length ? {x: (minX + maxX) / 2, y: (minY + maxY) / 2} : {x: 0, y: 0};
}

function placeLibraryShape(template, x, y) {
  if (!template || !template.points) return null;
  var item = cloneLibraryValue(template);
  var sourceCenter = templateCenter(item);
  var dx = x - sourceCenter.x, dy = y - sourceCenter.y;
  item.points.forEach(function(p) { p.x += dx; p.y += dy; });
  var shape = Model.addShape(item.type, item.points, item.toolType || "pen");
  if (item.rect) {
    shape.rect = item.rect;
    shape.rect.x += dx; shape.rect.y += dy;
    shape.points = [
      {x: shape.rect.x - shape.rect.w / 2, y: shape.rect.y - shape.rect.h / 2},
      {x: shape.rect.x + shape.rect.w / 2, y: shape.rect.y + shape.rect.h / 2}
    ];
  }
  if (item.poly) {
    shape.poly = item.poly;
    shape.poly.x += dx; shape.poly.y += dy;
  }
  if (typeof item.wall === "number" && item.wall > 0) shape.wall = item.wall;
  if (typeof item.height === "number" && item.height > 0) shape.height = item.height;
  Renderer.rebuildAll();
  showProps(shape.id);
  return shape;
}

function renderLib() {
  var lib = getUserLibrary();
  var el = $("lib-items");
  var manageBtn = $("btn-lib-manage");
  if (manageBtn) {
    manageBtn.classList.toggle("active", S.libraryManageMode);
    manageBtn.setAttribute("aria-pressed", String(S.libraryManageMode));
    manageBtn.textContent = S.libraryManageMode ? "完成" : "管理";
    manageBtn.title = S.libraryManageMode ? "退出用户图形管理" : "管理用户图形";
  }
  if (!el) return;
  el.innerHTML = "";
  lib.forEach(function(item, i) {
    if (!item || typeof item !== "object") return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "lib-item";
    var label = item.type === "rect" ? "矩形模板" : item.type === "circle" ? "圆形模板" : item.poly ? "多边形模板" : "钢笔模板";
    btn.textContent = label;
    btn.title = (item.name || label) + "：选中后可重复点击放置";
    btn.onclick = function() { Controller.setLibraryTool(lib[i], btn); };

    if (!S.libraryManageMode) {
      el.appendChild(btn);
      return;
    }

    var row = document.createElement("div");
    row.className = "lib-row";
    row.appendChild(btn);
    var del = document.createElement("button");
    del.type = "button";
    del.className = "lib-delete";
    del.textContent = "×";
    del.title = "删除 " + (item.name || label);
    del.setAttribute("aria-label", del.title);
    del.onclick = function(e) {
      e.preventDefault();
      e.stopPropagation();
      deleteFromLib(i);
    };
    row.appendChild(del);
    el.appendChild(row);
  });
}

// 兼容旧调用：图库点击改为进入重复放置模式，而非立即创建一个形状。
function loadFromLib(i) {
  var lib = getUserLibrary();
  if (lib[i]) Controller.setLibraryTool(lib[i], null);
}

// ---- 对象列表 (草图 + 所有图形) ----

function renderObjectList() {
  var el = $("obj-list");
  if (!el) return;
  el.innerHTML = "";
  var count = 0;

  // 图形 (Model 顺序 = 层叠顺序); 草图是参考层, 不在列表中, 由底部草图栏管理
  Model.shapes.forEach(function(shape) {
    var row = document.createElement("div");
    row.className = "obj-row" + (Model.selectedId === shape.id ? " selected" : "");
    row.dataset.shapeId = shape.id;
    var icon = shape.type === "rect" ? "⬜" : shape.type === "circle" ? "⭕" : (shape.poly ? "⬡" : "✏");
    var visible = shape.visible !== false;
    row.innerHTML =
      '<span class="obj-icon">' + icon + "</span>" +
      '<span class="obj-name" title="' + shape.id + " " + shape.toolType + '">' + shape.id + "</span>" +
      '<input type="checkbox" class="obj-vis" ' + (visible ? "checked" : "") + ' title="显示/隐藏">' +
      '<button class="obj-del" title="删除">×</button>';
    row.addEventListener("click", function(e) {
      if (e.target.classList.contains("obj-vis") || e.target.classList.contains("obj-del")) return;
      selectShapeFromList(shape.id);
    });
    row.querySelector(".obj-vis").addEventListener("change", function() {
      shape.visible = this.checked;
      // 隐藏正在顶点编辑的图形 → 退出编辑模式
      if (!this.checked && Model.editId === shape.id) {
        Model.editId = null;
        Overlay.hide();
      }
      Renderer.rebuildOne(shape);
      if (S.autoPreview) schedulePreview();
    });
    row.querySelector(".obj-del").addEventListener("click", function() {
      Model.removeShape(shape.id);
      Renderer.rebuildAll();
    });
    el.appendChild(row);
    count++;
  });

  if (count === 0) {
    el.innerHTML = '<div id="obj-list-empty">暂无图形</div>';
  }
}

// 列表点击 → 选中画布上的图形
function selectShapeFromList(id) {
  if (Model.editId) { Model.editId = null; Overlay.hide(); }
  if (Controller && Controller.selectShapeById && Controller.selectShapeById(id, false)) return;
  Model.selectedId = id;
  canvas.discardActiveObject();
  var obj = Renderer.getFabric(id);
  // 隐藏图形仅高亮列表行, 不激活画布选中框
  if (obj && obj.visible !== false) canvas.setActiveObject(obj);
  canvas.renderAll();
  showProps(id);
  renderObjectList();
}

// ---- 启动 ----
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
