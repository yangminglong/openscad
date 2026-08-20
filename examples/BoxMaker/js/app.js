// ============================================================
// app.js — 入口 + 全局状态 + SCAD 导出
// 架构: Model(数据) → Renderer(Fabric渲染) + Overlay(SVG编辑)
// ============================================================

var S = {activeTool: "select", wall: 2, bottom: 2, h: 50, divRatio: 0.9,
         wasmReady: false, stlData: null, autoPreview: true,
         outlineMode: "original",       // "original" 原始轮廓 | "wall" 墙
         offsetDir: "inner",            // 墙模式偏置方向: "inner" 内 | "outer" 外 | "both" 两侧
         defaultWall: 2,                // 墙模式图形壁厚初始值 (mm)
         defaultHeight: 43.2,           // 图形拉伸高度初始值 (mm)
         floorType: "none",             // 底板类型: "none" 无 | "outline" 轮廓 | "bbox" 边界框 | "hull" 凸包
         floorMargin: 0};               // 底板外边距 (mm, 外偏置)
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

  if (window.OpenSCADModule) onWasmReady();
  document.addEventListener("openscad-ready", onWasmReady);
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
  $("btn-export").addEventListener("click", function() { renderSTL().then(downloadSTL); });
  $("btn-reset").addEventListener("click", resetAll);
  $("chk-autopreview").addEventListener("change", function() {
    S.autoPreview = this.checked;
    // 勾选时立即渲染一次 (预览同步当前模型, 不用等下次编辑)
    if (this.checked) renderSTL();
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
  previewTimer = setTimeout(function() { renderSTL(); }, 500);
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

function onWasmReady() {
  S.wasmReady = true;
  $("status-wasm").textContent = "WASM OK";
  $("status-wasm").style.color = "#4caf50";
  $("btn-export").disabled = false;
  // 自动预览默认开启: WASM 就绪后渲染初始模型 (此前 renderSTL 会被就绪守卫静默丢弃)
  if (S.autoPreview) renderSTL();
}

function resetAll() {
  Model.clearAll();
  Renderer.rebuildAll();
  Overlay.hide();
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
  $("status-text").textContent = "Ready";
}

// ---- SCAD 生成 ----
// 导出模型 = 底板(按底板类型, 可无) + 图形挤出(原始嵌套 / 墙偏置); 不生成床轮廓的外壳
// 图形类型: polygon / rect(含圆角/旋转) / circle(SCAD 圆原语)

// 图形中心 (局部坐标原点; polygon 取包围盒中心)
function shapeCenter(s) {
  if (s.type === "circle") return {x: s.points[0].x, y: s.points[0].y};
  if (s.type === "rect") return {x: s.rect.x, y: s.rect.y};
  var b = Model.getBounds(s);
  return {x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2};
}

// 图形局部 2D 表达式 (原点 = 图形中心, 无 translate)
function shapeLocalExpr(s) {
  if (s.type === "circle") {
    var rad = Math.hypot(s.points[1].x - s.points[0].x, s.points[1].y - s.points[0].y);
    return "circle(r=" + rad.toFixed(1) + ")";
  }
  if (s.type === "rect") {
    var r = s.rect;
    var expr = "rotate([0,0," + ((r.angle || 0).toFixed(1)) + "])square([" + r.w.toFixed(1) + ", " + r.h.toFixed(1) + "], center=true)";
    var rad = r.radius || 0;
    return rad > 0 ? "offset(r=" + rad.toFixed(1) + ")" + expr : expr;
  }
  var c = shapeCenter(s);
  var pts = s.points.map(function(p) { return "[" + (p.x - c.x).toFixed(1) + ", " + (p.y - c.y).toFixed(1) + "]"; }).join(",");
  return "polygon(points=[" + pts + "])";
}

// 定位后的 2D 表达式 (translate 到图形中心, 2D 无 z)
function shapeExpr(s) {
  var c = shapeCenter(s);
  return "translate([" + c.x.toFixed(1) + ", " + c.y.toFixed(1) + "])" + shapeLocalExpr(s);
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
  var scad = "";

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
    // 风格: translate([x, y, z]) linear_extrude(h) difference(){ offset(r=a)局部; offset(r=b)局部; };
    polys.forEach(function(s) {
      var t = (typeof s.wall === "number" && s.wall > 0) ? s.wall : S.defaultWall;
      var h = (typeof s.height === "number" && s.height > 0) ? s.height : dh;
      var a = 0, b = 0;
      if (S.offsetDir === "inner") b = -t;
      else if (S.offsetDir === "outer") a = t;
      else { a = t / 2; b = -t / 2; }
      var c = shapeCenter(s);
      var local = shapeLocalExpr(s);
      out += "  translate([" + c.x.toFixed(1) + ", " + c.y.toFixed(1) + ", " + baseH + "]) linear_extrude(" + h.toFixed(1) + ") difference(){\n";
      out += "    " + offsetExpr(local, a) + ";\n";
      out += "    " + offsetExpr(local, b) + ";\n";
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
    var oc = shapeCenter(outer);
    if (holes.length > 0) {
      out += "  difference(){\n";
      out += "    translate([" + oc.x.toFixed(1) + ", " + oc.y.toFixed(1) + ", " + baseH + "]) linear_extrude(" + oh.toFixed(1) + ") " + shapeLocalExpr(outer) + ";\n";
      holes.forEach(function(h) {
        var hh = (typeof h.height === "number" && h.height > 0) ? h.height : oh;
        var hc = shapeCenter(h);
        out += "    translate([" + hc.x.toFixed(1) + ", " + hc.y.toFixed(1) + ", " + (baseH - 0.5) + "]) linear_extrude(" + (hh + 1).toFixed(1) + ") " + shapeLocalExpr(h) + ";\n";
      });
      out += "  };\n";
    } else {
      out += "  translate([" + oc.x.toFixed(1) + ", " + oc.y.toFixed(1) + ", " + baseH + "]) linear_extrude(" + oh.toFixed(1) + ") " + shapeLocalExpr(outer) + ";\n";
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

// ---- WASM 渲染 ----
async function renderSTL() {
  if (!S.wasmReady || !window.OpenSCADModule) return;
  $("status-text").textContent = "Rendering...";
  var scad = generateSCAD();
  var ts = Date.now(), fin = "/in" + ts + ".scad", fout = "/out" + ts + ".stl";
  try {
    var FS = window.OpenSCADModule.FS;
    try { FS.unlink(fin); } catch (e) {}
    try { FS.unlink(fout); } catch (e) {}
    FS.writeFile(fin, scad);
    window.OpenSCADModule.callMain(["--export-format", "binstl", "-o", fout, fin]);
    var data = FS.readFile(fout, {encoding: "binary"});
    S.stlData = new Uint8Array(data.length);
    S.stlData.set(data);
    var faces = S.stlData.length > 84 ? Math.round((S.stlData.length - 84) / 50) : 0;
    $("status-text").textContent = "Done: " + faces + " faces";
    Preview3D.loadSTL(S.stlData.buffer.slice(S.stlData.byteOffset, S.stlData.byteOffset + S.stlData.byteLength));
    CodeView.refresh();
    try { FS.unlink(fin); FS.unlink(fout); } catch (e) {}
  } catch (err) {
    console.error("renderSTL error:", err);
    $("status-text").textContent = "Error: " + (err && err.message ? err.message : err);
  }
}

function downloadSTL() {
  if (!S.stlData) return;
  var blob = new Blob([S.stlData], {type: "application/octet-stream"});
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url; a.download = "boxmaker.stl"; a.click();
  URL.revokeObjectURL(url);
}

// ---- 右键菜单 ----
function showContextMenu(x, y, shapeId) {
  var old = document.querySelector(".ctx-menu");
  if (old) old.remove();
  var menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.cssText = "position:fixed;left:" + x + "px;top:" + y + "px;background:#1a1a1a;border:1px solid #3a3a3a;border-radius:4px;padding:4px 0;z-index:100;box-shadow:0 4px 8px rgba(0,0,0,.5)";
  var add = function(text, fn) {
    var d = document.createElement("div");
    d.textContent = text;
    d.style.cssText = "padding:6px 12px;font-size:12px;color:#ccc;cursor:pointer";
    d.onmouseenter = function() { d.style.background = "#333"; };
    d.onmouseleave = function() { d.style.background = "transparent"; };
    d.onclick = function() { fn(); menu.remove(); };
    menu.appendChild(d);
  };
  add("保存到图形库", function() { saveToLib(shapeId); });
  add("删除", function() { Model.removeShape(shapeId); Renderer.rebuildAll(); });
  document.body.appendChild(menu);
  document.addEventListener("click", function() { menu.remove(); }, {once: true});
}

// ---- 用户图形库 ----
function saveToLib(shapeId) {
  var shape = Model.getShape(shapeId);
  if (!shape) return;
  var lib = JSON.parse(localStorage.getItem("boxmaker_lib") || "[]");
  if (lib.length >= 20) lib.shift();
  lib.push({name: shape.id, type: shape.type, points: shape.points, toolType: shape.toolType,
            wall: shape.wall, height: shape.height});
  localStorage.setItem("boxmaker_lib", JSON.stringify(lib));
  renderLib();
}

function renderLib() {
  var lib = JSON.parse(localStorage.getItem("boxmaker_lib") || "[]");
  var el = $("lib-items");
  if (!el) return;
  el.innerHTML = "";
  lib.forEach(function(item, i) {
    var btn = document.createElement("div");
    btn.className = "lib-item";
    btn.textContent = item.name ? item.name.substring(0, 4) : i;
    btn.title = item.name;
    btn.onclick = function() { loadFromLib(i); };
    el.appendChild(btn);
  });
}

function loadFromLib(i) {
  var lib = JSON.parse(localStorage.getItem("boxmaker_lib") || "[]");
  if (!lib[i]) return;
  var s = Model.addShape(lib[i].type, lib[i].points, lib[i].toolType || "pen");
  // 恢复保存时的导出属性 (旧数据无此字段 → 保持默认值)
  if (typeof lib[i].wall === "number" && lib[i].wall > 0) s.wall = lib[i].wall;
  if (typeof lib[i].height === "number" && lib[i].height > 0) s.height = lib[i].height;
  Renderer.rebuildAll();
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
  Model.selectedId = id;
  if (Model.editId) { Model.editId = null; Overlay.hide(); }
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
