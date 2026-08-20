// ============================================================
// sketch.js — 照片草图导入 + 4 点透视矫正 + 比例标定
// 矫正中的照片活在画布坐标 (缩放/平移自然作用),
// 应用后的草图存打印板坐标 (bed mm), 由 reposition() 重放。
// 草图是参考层: 不进 Model, 不导出, 不持久化。
// ============================================================

// 矫正框物理尺寸预设 (mm)
var SKETCH_PRESETS = {
  a4:   {w: 210,  h: 297},
  a5:   {w: 148,  h: 210},
  card: {w: 85.6, h: 54}
};

function sketchSetStatus(msg) {
  var el = document.getElementById("status-text");
  if (el) el.textContent = msg;
}

// ---- 线性代数工具 (纯函数, 无依赖) ----

// 高斯-约当消元解 8×8 线性方程组, 奇异时返回 null
function solveLinear8(A, b) {
  var n = 8;
  var M = new Float64Array(n * (n + 1));
  for (var i = 0; i < n; i++) {
    for (var j = 0; j < n; j++) M[i * (n + 1) + j] = A[i * n + j];
    M[i * (n + 1) + n] = b[i];
  }
  for (var col = 0; col < n; col++) {
    // 部分主元
    var piv = col, max = Math.abs(M[col * (n + 1) + col]);
    for (var r = col + 1; r < n; r++) {
      var v = Math.abs(M[r * (n + 1) + col]);
      if (v > max) { max = v; piv = r; }
    }
    if (max < 1e-12) return null; // 奇异 (角点近共线)
    if (piv !== col) {
      for (var j = 0; j <= n; j++) {
        var t = M[col * (n + 1) + j];
        M[col * (n + 1) + j] = M[piv * (n + 1) + j];
        M[piv * (n + 1) + j] = t;
      }
    }
    var d = M[col * (n + 1) + col];
    for (var j2 = col; j2 <= n; j2++) M[col * (n + 1) + j2] /= d;
    for (var r2 = 0; r2 < n; r2++) {
      if (r2 === col) continue;
      var f = M[r2 * (n + 1) + col];
      if (f === 0) continue;
      for (var j3 = col; j3 <= n; j3++) M[r2 * (n + 1) + j3] -= f * M[col * (n + 1) + j3];
    }
  }
  var x = new Float64Array(n);
  for (var k = 0; k < n; k++) x[k] = M[k * (n + 1) + n];
  return x;
}

// 3×3 矩阵求逆 (伴随矩阵法), 奇异时返回 null
function invert3x3(m) {
  var a = m[0], b = m[1], c = m[2],
      d = m[3], e = m[4], f = m[5],
      g = m[6], h = m[7], i = m[8];
  var A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  var det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  det = 1 / det;
  return [
    A * det, (c * h - b * i) * det, (b * f - c * e) * det,
    B * det, (a * i - c * g) * det, (c * d - a * f) * det,
    C * det, -(a * h - b * g) * det, (a * e - b * d) * det
  ];
}

// 对 4 组对应点解单应矩阵 (DLT, h33=1), dst = H · src
// src/dst: [{x,y}×4], 顺序 TL,TR,BR,BL。奇异时返回 null
function computeHomography(src, dst) {
  var A = new Float64Array(64), b = new Float64Array(8);
  for (var i = 0; i < 4; i++) {
    var x = src[i].x, y = src[i].y, u = dst[i].x, v = dst[i].y;
    var r1 = i * 16, r2 = r1 + 8;
    A[r1] = x;     A[r1 + 1] = y;     A[r1 + 2] = 1;
    A[r1 + 6] = -u * x; A[r1 + 7] = -u * y;
    A[r2 + 3] = x; A[r2 + 4] = y;     A[r2 + 5] = 1;
    A[r2 + 6] = -v * x; A[r2 + 7] = -v * y;
    b[i * 2] = u; b[i * 2 + 1] = v;
  }
  var h = solveLinear8(A, b);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

// H 作用于点
function applyH(H, p) {
  var w = H[6] * p.x + H[7] * p.y + H[8];
  return {x: (H[0] * p.x + H[1] * p.y + H[2]) / w,
          y: (H[3] * p.x + H[4] * p.y + H[5]) / w};
}

// 透视重投影: 源图经 H 变换到 dstW×dstH (反向映射 + 双线性采样)
// 源超长边 2400px 时先降采样; 目标区域外为透明
function warpPerspective(imgEl, H, dstW, dstH) {
  var sw = imgEl.naturalWidth || imgEl.width;
  var sh = imgEl.naturalHeight || imgEl.height;
  var maxDim = Math.max(sw, sh);
  var down = maxDim > 2400 ? 2400 / maxDim : 1;
  var ws = Math.max(1, Math.round(sw * down)), hs = Math.max(1, Math.round(sh * down));

  var tmp = document.createElement("canvas");
  tmp.width = ws; tmp.height = hs;
  var tctx = tmp.getContext("2d");
  tctx.drawImage(imgEl, 0, 0, ws, hs);
  var sData = tctx.getImageData(0, 0, ws, hs);
  var srcPx = sData.data;

  var invH = invert3x3(H);
  if (!invH) return null;

  var out = document.createElement("canvas");
  out.width = dstW; out.height = dstH;
  var octx = out.getContext("2d");
  var oData = octx.createImageData(dstW, dstH);
  var outPx = oData.data;

  for (var y = 0; y < dstH; y++) {
    for (var x = 0; x < dstW; x++) {
      var w = invH[6] * x + invH[7] * y + invH[8];
      // H 的源坐标系是原图像素; 采样缓冲区已降采样 down 倍, 需换算到缓冲坐标
      var sx = (invH[0] * x + invH[1] * y + invH[2]) / w * down;
      var sy = (invH[3] * x + invH[4] * y + invH[5]) / w * down;
      var o = (y * dstW + x) * 4;
      if (sx < 0 || sy < 0 || sx >= ws - 1 || sy >= hs - 1) {
        outPx[o + 3] = 0; // 目标区域外: 透明
        continue;
      }
      var x0 = Math.floor(sx), y0 = Math.floor(sy);
      var fx = sx - x0, fy = sy - y0;
      var i00 = (y0 * ws + x0) * 4, i10 = i00 + 4, i01 = i00 + ws * 4, i11 = i01 + 4;
      for (var c = 0; c < 4; c++) {
        outPx[o + c] = srcPx[i00 + c] * (1 - fx) * (1 - fy) +
                       srcPx[i10 + c] * fx * (1 - fy) +
                       srcPx[i01 + c] * (1 - fx) * fy +
                       srcPx[i11 + c] * fx * fy;
      }
    }
  }
  octx.putImageData(oData, 0, 0);
  return out;
}

// ============================================================
// Sketch 模块
// ============================================================

var Sketch = {
  canvas: null,
  svg: null,
  rectify: null,    // 矫正模式: {img, imgEl, corners(原图像素 TL,TR,BR,BL), physW, physH, refLine, dragMode, dragLast, savedSelection}
  sketch: null,     // 已应用草图: {img, bedX, bedY, bedWmm, bedHmm, locked, original}
  sketchDrag: null, // 草图拖拽中: {x, y} (client 坐标)

  init: function(canvas) {
    this.canvas = canvas;

    // SVG 覆盖层 (角点/参考线控制, 与 Overlay 同模式)
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svg.id = "sketch-overlay";
    this.svg.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:6;overflow:visible";
    document.getElementById("canvas-area").appendChild(this.svg);

    // 顶栏: 导入 / 标定纸
    document.getElementById("btn-import-photo").addEventListener("click", function() {
      document.getElementById("file-photo").click();
    });
    document.getElementById("file-photo").addEventListener("change", function() {
      if (this.files && this.files[0]) Sketch.importPhoto(this.files[0]);
      this.value = ""; // 允许重复选择同一文件
    });
    document.getElementById("btn-calib-sheet").addEventListener("click", function() {
      Sketch.downloadCalibSheet();
    });

    // 矫正栏
    var self = this;
    document.getElementById("rect-preset").addEventListener("change", function() {
      var r = Sketch.rectify; if (!r) return;
      var v = this.value;
      document.getElementById("rect-custom").style.display = (v === "custom") ? "" : "none";
      if (v === "custom") {
        r.physW = parseFloat(document.getElementById("rect-w").value) || 100;
        r.physH = parseFloat(document.getElementById("rect-h").value) || 100;
      } else if (v === "none") {
        r.physW = null; r.physH = null;
      } else {
        r.physW = SKETCH_PRESETS[v].w; r.physH = SKETCH_PRESETS[v].h;
      }
      Sketch.updateHint();
    });
    ["rect-w", "rect-h"].forEach(function(id) {
      document.getElementById(id).addEventListener("input", function() {
        var r = Sketch.rectify; if (!r) return;
        var w = parseFloat(document.getElementById("rect-w").value);
        var h = parseFloat(document.getElementById("rect-h").value);
        if (w > 0) r.physW = w;
        if (h > 0) r.physH = h;
      });
    });
    document.getElementById("rect-ref-on").addEventListener("change", function() {
      var r = Sketch.rectify; if (!r) return;
      document.getElementById("rect-ref-len").style.display = this.checked ? "" : "none";
      document.getElementById("rect-ref-unit").style.display = this.checked ? "" : "none";
      if (this.checked) {
        // 默认: 上下边中点连线 (垂直贯穿四边形)
        var c = r.corners;
        r.refLine = {
          p1: {x: (c[0].x + c[1].x) / 2, y: (c[0].y + c[1].y) / 2},
          p2: {x: (c[3].x + c[2].x) / 2, y: (c[3].y + c[2].y) / 2},
          lenMm: parseFloat(document.getElementById("rect-ref-len").value) || 100
        };
      } else {
        r.refLine = null;
      }
      Sketch.renderOverlay();
      Sketch.updateHint();
    });
    document.getElementById("rect-ref-len").addEventListener("input", function() {
      var r = Sketch.rectify;
      if (r && r.refLine) r.refLine.lenMm = parseFloat(this.value) || 0;
    });
    document.getElementById("rect-apply").addEventListener("click", function() {
      Sketch.applyRectify();
    });
    document.getElementById("rect-cancel").addEventListener("click", function() {
      Sketch.cancelRectify();
    });

    // 草图控制栏
    document.getElementById("sketch-lock").addEventListener("change", function() {
      Sketch.setLocked(this.checked);
    });
    [["sketch-x", "x"], ["sketch-y", "y"], ["sketch-w", "w"], ["sketch-h", "h"]].forEach(function(pair) {
      document.getElementById(pair[0]).addEventListener("input", function() {
        var s = Sketch.sketch;
        if (!s) return;
        var v = parseFloat(this.value);
        if (isNaN(v)) return;
        if (pair[1] === "x") s.bedX = v;
        else if (pair[1] === "y") s.bedY = v;
        else if (pair[1] === "w" && v > 0) s.bedWmm = v;
        else if (pair[1] === "h" && v > 0) s.bedHmm = v;
        else return;
        Sketch.reposition();
      });
    });
    document.getElementById("sketch-opacity").addEventListener("input", function() {
      Sketch.setOpacity(parseFloat(this.value));
    });
    document.getElementById("sketch-visible").addEventListener("change", function() {
      Sketch.toggleVisible(this.checked);
    });
    document.getElementById("sketch-rectify").addEventListener("click", function() {
      Sketch.reRectify();
    });
    document.getElementById("sketch-delete").addEventListener("click", function() {
      Sketch.remove();
    });
  },

  // ---- 导入 ----

  importPhoto: function(file) {
    if (!file || !/^image\//.test(file.type)) {
      sketchSetStatus("错误: 请选择图片文件");
      return;
    }
    var url = URL.createObjectURL(file);
    var img = new Image();
    var self = this;
    img.onload = function() {
      URL.revokeObjectURL(url); // 元素已持有解码数据
      self.enterRectify(img);
    };
    img.onerror = function() {
      URL.revokeObjectURL(url);
      sketchSetStatus("错误: 图片加载失败");
    };
    img.src = url;
  },

  // ---- 矫正模式 ----

  enterRectify: function(imgEl) {
    if (this.rectify) this.finishRectify(false);

    var cw = this.canvas.getWidth(), ch = this.canvas.getHeight();
    var w = imgEl.naturalWidth || imgEl.width, h = imgEl.naturalHeight || imgEl.height;
    var scale = Math.max(0.05, Math.min(cw * 0.7 / w, ch * 0.7 / h));

    var img = new fabric.Image(imgEl, {
      left: (cw - w * scale) / 2, top: (ch - h * scale) / 2,
      scaleX: scale, scaleY: scale,
      selectable: false, evented: true,
      hoverCursor: "move",
      objectCaching: true
    });
    this.canvas.add(img);
    this.restack(img);

    this.rectify = {
      img: img, imgEl: imgEl,
      corners: [{x: 0, y: 0}, {x: w, y: 0}, {x: w, y: h}, {x: 0, y: h}], // 原图像素, TL,TR,BR,BL
      physW: SKETCH_PRESETS.a4.w, physH: SKETCH_PRESETS.a4.h,
      refLine: null,
      dragMode: null, dragLast: null,
      savedSelection: this.canvas.selection
    };
    // 矫正期间禁用框选/创建图形 (Controller.onDown 也会拦截)
    this.canvas.selection = false;
    this.canvas.discardActiveObject();

    this.syncBar();
    document.getElementById("rectify-bar").style.display = "flex";
    document.getElementById("sketch-bar").style.display = "none";
    this.renderOverlay();
    this.canvas.renderAll();
    sketchSetStatus("矫正模式: 拖动 4 个角点对齐已知矩形 (纸张/卡片四角)");
  },

  // 结束矫正模式 (应用/取消共用): 移除照片、恢复选择、清覆盖层
  finishRectify: function() {
    var r = this.rectify;
    if (!r) return;
    this.canvas.remove(r.img);
    this.rectify = null;
    this.canvas.selection = r.savedSelection;
    this.svg.innerHTML = "";
    document.getElementById("rectify-bar").style.display = "none";
    this.canvas.renderAll();
  },

  cancelRectify: function() {
    if (!this.rectify) return;
    this.finishRectify();
    if (this.sketch) {
      this.sketch.img.visible = true;
      this.reposition();
      this.syncBarValues();
      document.getElementById("sketch-bar").style.display = "flex";
    }
    sketchSetStatus("就绪");
  },

  // ---- 矫正栏同步 ----

  syncBar: function() {
    var r = this.rectify;
    if (!r) return;
    var sel = document.getElementById("rect-preset");
    if (r.physW === null || r.physH === null) {
      sel.value = "none";
    } else if (Math.abs(r.physW - 210) < 0.01 && Math.abs(r.physH - 297) < 0.01) sel.value = "a4";
    else if (Math.abs(r.physW - 148) < 0.01 && Math.abs(r.physH - 210) < 0.01) sel.value = "a5";
    else if (Math.abs(r.physW - 85.6) < 0.01 && Math.abs(r.physH - 54) < 0.01) sel.value = "card";
    else {
      sel.value = "custom";
      document.getElementById("rect-w").value = r.physW;
      document.getElementById("rect-h").value = r.physH;
    }
    document.getElementById("rect-custom").style.display = (sel.value === "custom") ? "" : "none";
    var refOn = !!r.refLine;
    document.getElementById("rect-ref-on").checked = refOn;
    document.getElementById("rect-ref-len").style.display = refOn ? "" : "none";
    document.getElementById("rect-ref-unit").style.display = refOn ? "" : "none";
    if (refOn) document.getElementById("rect-ref-len").value = r.refLine.lenMm;
    this.updateHint();
  },

  updateHint: function() {
    var r = this.rectify;
    var el = document.getElementById("rect-hint");
    if (!el || !r) return;
    var unknown = (r.physW === null || r.physH === null);
    if (unknown && r.refLine) el.textContent = "角点矫正透视 → 参考线标定尺寸 (建议 2× 变焦拍摄)";
    else if (unknown) el.textContent = "角点矫正透视 (尺寸未标定, 之后可用重新矫正补救)";
    else el.textContent = "把角点对齐纸张/卡片四角 (建议 2× 变焦拍摄)";
  },

  // ---- SVG 覆盖层 ----

  // 画布坐标 → 屏幕坐标 (应用 viewportTransform)
  toScreen: function(cx, cy) {
    var vpt = this.canvas.viewportTransform;
    return {x: vpt[0] * cx + vpt[2] * cy + vpt[4],
            y: vpt[1] * cx + vpt[3] * cy + vpt[5]};
  },

  // 角点 (原图像素) → 画布坐标
  cornerToCanvas: function(i) {
    var r = this.rectify;
    return {x: r.img.left + r.corners[i].x * r.img.scaleX,
            y: r.img.top + r.corners[i].y * r.img.scaleY};
  },

  renderOverlay: function() {
    if (!this.rectify) { this.svg.innerHTML = ""; return; }
    var container = this.svg.parentElement;
    this.svg.setAttribute("width", container.clientWidth);
    this.svg.setAttribute("height", container.clientHeight);
    this.svg.setAttribute("viewBox", "0 0 " + container.clientWidth + " " + container.clientHeight);

    this.svg.innerHTML = "";
    var ns = "http://www.w3.org/2000/svg";
    var self = this;

    // 四边形轮廓 (虚线)
    var pts = "";
    for (var i = 0; i < 4; i++) {
      var ccv = this.cornerToCanvas(i);
      var c = this.toScreen(ccv.x, ccv.y);
      pts += c.x + "," + c.y + " ";
    }
    var quad = document.createElementNS(ns, "polygon");
    quad.setAttribute("points", pts);
    quad.setAttribute("fill", "rgba(74,144,217,0.05)");
    quad.setAttribute("stroke", "#f39c12");
    quad.setAttribute("stroke-width", "1.5");
    quad.setAttribute("stroke-dasharray", "6 4");
    quad.style.pointerEvents = "none";
    this.svg.appendChild(quad);

    // 4 个角点控制圆
    for (var j = 0; j < 4; j++) {
      var ccv2 = this.cornerToCanvas(j);
      var cc = this.toScreen(ccv2.x, ccv2.y);
      var circle = document.createElementNS(ns, "circle");
      circle.setAttribute("cx", cc.x);
      circle.setAttribute("cy", cc.y);
      circle.setAttribute("r", 8);
      circle.setAttribute("fill", "#fff");
      circle.setAttribute("stroke", "#f39c12");
      circle.setAttribute("stroke-width", "2");
      circle.style.pointerEvents = "all";
      circle.style.cursor = "move";
      (function(idx) {
        circle.addEventListener("mousedown", function(e) {
          self.rectify.dragMode = "corner" + idx;
          e.stopPropagation();
          e.preventDefault();
        });
      })(j);
      this.svg.appendChild(circle);
    }

    // 参考线 (可选)
    if (this.rectify.refLine) {
      var rl = this.rectify.refLine;
      var toC = function(p) {
        return {x: self.rectify.img.left + p.x * self.rectify.img.scaleX,
                y: self.rectify.img.top + p.y * self.rectify.img.scaleY};
      };
      var s1 = this.toScreen(toC(rl.p1).x, toC(rl.p1).y);
      var s2 = this.toScreen(toC(rl.p2).x, toC(rl.p2).y);
      var line = document.createElementNS(ns, "line");
      line.setAttribute("x1", s1.x); line.setAttribute("y1", s1.y);
      line.setAttribute("x2", s2.x); line.setAttribute("y2", s2.y);
      line.setAttribute("stroke", "#f39c12");
      line.setAttribute("stroke-width", "2");
      line.setAttribute("stroke-dasharray", "2 3");
      line.style.pointerEvents = "none";
      this.svg.appendChild(line);
      [rl.p1, rl.p2].forEach(function(p, k) {
        var sc = self.toScreen(toC(p).x, toC(p).y);
        var rc = document.createElementNS(ns, "circle");
        rc.setAttribute("cx", sc.x);
        rc.setAttribute("cy", sc.y);
        rc.setAttribute("r", 6);
        rc.setAttribute("fill", "#fff");
        rc.setAttribute("stroke", "#f39c12");
        rc.setAttribute("stroke-width", "2");
        rc.style.pointerEvents = "all";
        rc.style.cursor = "move";
        rc.addEventListener("mousedown", function(e) {
          self.rectify.dragMode = "ref" + (k + 1);
          e.stopPropagation();
          e.preventDefault();
        });
        self.svg.appendChild(rc);
      });
    }
  },

  // ---- 拖拽 (由 Controller 全局 mousemove/mouseup 分发) ----

  startImageDrag: function(e) {
    if (!this.rectify) return;
    this.rectify.dragMode = "image";
    this.rectify.dragLast = {x: e.clientX, y: e.clientY};
  },

  // 草图拖拽起点 (由 Controller.onDown 分发, 仅未锁定时)
  startSketchDrag: function(e) {
    if (!this.sketch || this.sketch.locked) return;
    this.sketchDrag = {x: e.clientX, y: e.clientY};
  },

  onMouseMove: function(e) {
    var r = this.rectify;
    if (!r || !r.dragMode) {
      // 草图拖拽 (未锁定)
      if (this.sketchDrag) {
        var dx = e.clientX - this.sketchDrag.x;
        var dy = e.clientY - this.sketchDrag.y;
        this.sketchDrag = {x: e.clientX, y: e.clientY};
        var si = this.sketch.img;
        si.left += dx;
        si.top += dy;
        si.setCoords();
        // 实时同步坐标输入框
        var bp = Scene.canvasToBed(si.left, si.top);
        var ex = document.getElementById("sketch-x"), ey = document.getElementById("sketch-y");
        if (ex) ex.value = bp.x.toFixed(1);
        if (ey) ey.value = bp.y.toFixed(1);
        this.canvas.requestRenderAll();
        return true;
      }
      return false;
    }
    var pointer = this.canvas.getPointer(e);

    if (r.dragMode === "image") {
      // 整体移动照片 (画布坐标平移)
      var dx = e.clientX - r.dragLast.x;
      var dy = e.clientY - r.dragLast.y;
      r.dragLast = {x: e.clientX, y: e.clientY};
      r.img.left += dx;
      r.img.top += dy;
      r.img.setCoords();
      this.canvas.requestRenderAll();
    } else if (r.dragMode.indexOf("corner") === 0) {
      // 拖角点: 画布 → 原图像素坐标
      var idx = parseInt(r.dragMode.slice(6), 10);
      r.corners[idx] = {
        x: (pointer.x - r.img.left) / r.img.scaleX,
        y: (pointer.y - r.img.top) / r.img.scaleY
      };
    } else if (r.dragMode === "ref1" || r.dragMode === "ref2") {
      // 拖参考线端点
      var p = (r.dragMode === "ref1") ? r.refLine.p1 : r.refLine.p2;
      p.x = (pointer.x - r.img.left) / r.img.scaleX;
      p.y = (pointer.y - r.img.top) / r.img.scaleY;
    }
    this.renderOverlay();
    return true;
  },

  onMouseUp: function() {
    if (this.sketchDrag) {
      this.sketchDrag = null;
      var s = this.sketch;
      if (s) {
        // 拖拽结束: 画布坐标回写 bed 坐标, 与数值输入框保持一致
        var bp = Scene.canvasToBed(s.img.left, s.img.top);
        s.bedX = bp.x; s.bedY = bp.y;
        this.reposition();
        var ex = document.getElementById("sketch-x"), ey = document.getElementById("sketch-y");
        if (ex) ex.value = s.bedX.toFixed(1);
        if (ey) ey.value = s.bedY.toFixed(1);
      }
      return true;
    }
    if (!this.rectify || !this.rectify.dragMode) return false;
    this.rectify.dragMode = null;
    return true;
  },

  // ---- 应用矫正 ----

  // 四边形宽高比估算 (原图像素, 尺寸未知时用)
  quadAspect: function(c) {
    var wAvg = (Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y) +
                Math.hypot(c[2].x - c[3].x, c[2].y - c[3].y)) / 2;
    var hAvg = (Math.hypot(c[3].x - c[0].x, c[3].y - c[0].y) +
                Math.hypot(c[2].x - c[1].x, c[2].y - c[1].y)) / 2;
    return hAvg > 0 ? wAvg / hAvg : 1;
  },

  applyRectify: function() {
    var r = this.rectify;
    if (!r) return;

    if (r.refLine && !(r.refLine.lenMm > 0)) {
      sketchSetStatus("错误: 请输入参考线长度");
      return;
    }
    var physKnown = (r.physW > 0 && r.physH > 0);

    // 输出分辨率
    var aspect = physKnown ? r.physW / r.physH : this.quadAspect(r.corners);
    if (!(aspect > 0.01 && aspect < 100)) {
      sketchSetStatus("错误: 角点位置异常");
      return;
    }
    var srcMax = Math.max(r.imgEl.naturalWidth || r.imgEl.width, r.imgEl.naturalHeight || r.imgEl.height);
    var dstH = Math.min(1600, srcMax);
    var dstW = Math.round(dstH * aspect);
    if (dstW > 4096) { dstH = Math.round(dstH * 4096 / dstW); dstW = 4096; }
    dstH = Math.max(64, dstH); dstW = Math.max(64, dstW);

    // 单应矩阵: 原图像素角点 → 输出矩形
    var H = computeHomography(
      r.corners,
      [{x: 0, y: 0}, {x: dstW, y: 0}, {x: dstW, y: dstH}, {x: 0, y: dstH}]
    );
    if (!H) {
      sketchSetStatus("矫正失败: 角点过于接近共线");
      return;
    }

    sketchSetStatus("矫正中...");
    var self = this;
    setTimeout(function() { // 让状态栏先刷新再进入阻塞的 warp
      self.finishApplyRectify(r, H, dstW, dstH, physKnown);
    }, 30);
  },

  finishApplyRectify: function(r, H, dstW, dstH, physKnown) {
    var prevLocked = this.sketch ? this.sketch.locked : true;
    var warp = warpPerspective(r.imgEl, H, dstW, dstH);
    if (!warp) {
      sketchSetStatus("矫正失败: 变换矩阵奇异");
      return;
    }

    // mm/px: 物理尺寸 > 参考线 > 任意比例
    var mmPerPx;
    if (physKnown) {
      mmPerPx = r.physH / dstH;
    } else if (r.refLine && r.refLine.lenMm > 0) {
      var t1 = applyH(H, r.refLine.p1), t2 = applyH(H, r.refLine.p2);
      var pxLen = Math.hypot(t2.x - t1.x, t2.y - t1.y);
      if (pxLen < 1) {
        sketchSetStatus("矫正失败: 参考线过短");
        return;
      }
      mmPerPx = r.refLine.lenMm / pxLen;
    } else {
      mmPerPx = 1;
    }
    var physWmm = dstW * mmPerPx, physHmm = dstH * mmPerPx;

    // 床坐标落位: 角点画布坐标 → bed (minX = 左, maxY = 上)
    var bedX = Infinity, bedY = -Infinity;
    for (var i = 0; i < 4; i++) {
      var cc = this.cornerToCanvas(i);
      var bp = Scene.canvasToBed(cc.x, cc.y);
      bedX = Math.min(bedX, bp.x);
      bedY = Math.max(bedY, bp.y);
    }

    // 自动换床: 选能容纳草图的最小床
    var bedMsg = "";
    if (!Scene.bed.fits(physWmm, physHmm)) {
      var fit = Scene.findSmallestBed(physWmm, physHmm);
      if (fit) {
        Scene.setBed(fit);
        bedMsg = "已切换床面 " + fit.label;
      } else {
        Scene.setBed(Scene.getBedById("custom300"));
        bedMsg = "超过最大床面 300×300";
      }
    }

    // 替换旧草图 (重新矫正场景)
    if (this.sketch && this.sketch.img) this.canvas.remove(this.sketch.img);

    var img = new fabric.Image(warp, {
      opacity: 0.6, selectable: false, evented: false,
      objectCaching: true
    });
    this.canvas.add(img);
    this.sketch = {
      img: img,
      bedX: bedX, bedY: bedY,
      bedWmm: physWmm, bedHmm: physHmm,
      locked: prevLocked,
      original: {
        imgEl: r.imgEl,
        corners: r.corners.map(function(p) { return {x: p.x, y: p.y}; }),
        physW: r.physW, physH: r.physH,
        refLine: r.refLine ? {p1: {x: r.refLine.p1.x, y: r.refLine.p1.y},
                              p2: {x: r.refLine.p2.x, y: r.refLine.p2.y},
                              lenMm: r.refLine.lenMm} : null
      }
    };

    this.finishRectify();
    this.reposition();
    this.applyLockState();
    this.syncBarValues();
    document.getElementById("sketch-bar").style.display = "flex";
    sketchSetStatus("草图已导入 " + physWmm.toFixed(1) + "×" + physHmm.toFixed(1) + "mm" +
                    (bedMsg ? " (" + bedMsg + ")" : "") + ", 解锁后可拖动");
  },

  // ---- 草图层控制 ----

  // 锁定/解锁: 锁定时草图不响应拖动
  setLocked: function(v) {
    var s = this.sketch;
    if (!s) return;
    s.locked = v;
    this.applyLockState();
    this.canvas.renderAll();
    sketchSetStatus(v ? "草图已锁定" : "草图已解锁, 可直接拖动 (描线前建议重新锁定)");
  },

  // 把锁定状态应用到 Fabric 对象 (未锁定 → evented 可接收拖拽事件)
  applyLockState: function() {
    var s = this.sketch;
    if (!s) return;
    s.img.evented = !s.locked;
    s.img.selectable = false;
    s.img.hoverCursor = s.locked ? "default" : "move";
  },

  // 控制栏数值回填 (X/Y/W/H/锁定/透明度/显隐)
  syncBarValues: function() {
    var s = this.sketch;
    if (!s) return;
    var set = function(id, v) { var el = document.getElementById(id); if (el) el.value = v; };
    set("sketch-x", s.bedX.toFixed(1));
    set("sketch-y", s.bedY.toFixed(1));
    set("sketch-w", s.bedWmm.toFixed(1));
    set("sketch-h", s.bedHmm.toFixed(1));
    var lk = document.getElementById("sketch-lock");
    if (lk) lk.checked = s.locked;
    var op = document.getElementById("sketch-opacity");
    if (op) op.value = s.img.opacity;
    var vs = document.getElementById("sketch-visible");
    if (vs) vs.checked = s.img.visible;
  },

  // 床坐标 → 画布放置 (床平移/缩放/换床后重放)
  reposition: function() {
    if (!this.sketch || !this.sketch.img) return;
    var s = this.sketch;
    var c = Scene.bedToCanvas(s.bedX, s.bedY);
    s.img.set({
      left: c.x, top: c.y,
      scaleX: s.bedWmm * Scene.scale / s.img.width,
      scaleY: s.bedHmm * Scene.scale / s.img.height
    });
    s.img.setCoords();
    this.canvas.renderAll();
  },

  // 保持图形层序: 照片/草图贴床面之上、图形之下
  restack: function(img) {
    if (!img || !Scene.bedGroup) return;
    var idx = this.canvas._objects.indexOf(Scene.bedGroup);
    this.canvas.moveTo(img, idx >= 0 ? idx + 1 : 1);
  },

  // Scene.rebuild 钩子 (床平移/换床/窗口缩放)
  onSceneRebuild: function() {
    if (this.rectify && this.rectify.img) this.restack(this.rectify.img);
    if (this.sketch) {
      this.reposition();
      this.restack(this.sketch.img);
    }
  },

  setOpacity: function(v) {
    if (!this.sketch) return;
    this.sketch.img.opacity = v;
    this.canvas.renderAll();
  },

  toggleVisible: function(v) {
    if (!this.sketch) return;
    this.sketch.img.visible = v;
    this.canvas.renderAll();
  },

  remove: function() {
    if (!this.sketch) return;
    this.canvas.remove(this.sketch.img);
    this.sketch = null;
    this.sketchDrag = null;
    document.getElementById("sketch-bar").style.display = "none";
    this.canvas.renderAll();
    sketchSetStatus("草图已删除");
  },

  // 回到矫正模式 (保留原照片与角点)
  reRectify: function() {
    var s = this.sketch;
    if (!s || !s.original) return;
    s.img.visible = false; // 矫正期间隐藏, 取消时恢复
    this.canvas.renderAll();
    var o = s.original;
    this.enterRectify(o.imgEl);
    this.rectify.corners = o.corners.map(function(p) { return {x: p.x, y: p.y}; });
    this.rectify.physW = o.physW;
    this.rectify.physH = o.physH;
    this.rectify.refLine = o.refLine ? {
      p1: {x: o.refLine.p1.x, y: o.refLine.p1.y},
      p2: {x: o.refLine.p2.x, y: o.refLine.p2.y},
      lenMm: o.refLine.lenMm
    } : null;
    this.syncBar();
    this.renderOverlay();
    sketchSetStatus("重新矫正: 调整角点后点应用");
  },

  // ---- 标定纸 (A4 300dpi PNG, 10mm 网格) ----

  downloadCalibSheet: function() {
    var mm2px = 300 / 25.4;
    var w = Math.round(210 * mm2px), h = Math.round(297 * mm2px); // 2480×3508
    var c = document.createElement("canvas");
    c.width = w; c.height = h;
    var ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);

    // 网格: 10mm 细线, 50mm 粗线
    for (var x = 0; x <= 210; x += 10) {
      var px = Math.round(x * mm2px);
      ctx.strokeStyle = (x % 50 === 0) ? "#444" : "#ddd";
      ctx.lineWidth = (x % 50 === 0) ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
    }
    for (var y = 0; y <= 297; y += 10) {
      var py = Math.round(y * mm2px);
      ctx.strokeStyle = (y % 50 === 0) ? "#444" : "#ddd";
      ctx.lineWidth = (y % 50 === 0) ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(w, py); ctx.stroke();
    }
    // mm 刻度 (每 50mm)
    ctx.fillStyle = "#333";
    ctx.font = "36px sans-serif";
    for (var x2 = 50; x2 <= 210; x2 += 50) ctx.fillText(String(x2), x2 * mm2px + 8, 48);
    for (var y2 = 50; y2 <= 297; y2 += 50) ctx.fillText(String(y2), 10, y2 * mm2px + 48);
    // 四角标记 + 中心十字
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 4;
    [[0, 0], [w, 0], [0, h], [w, h]].forEach(function(p) {
      var sx = p[0] === 0 ? 1 : -1, sy = p[1] === 0 ? 1 : -1;
      var len = 30 * mm2px;
      ctx.beginPath();
      ctx.moveTo(p[0] + sx * len, p[1]); ctx.lineTo(p[0], p[1]); ctx.lineTo(p[0], p[1] + sy * len);
      ctx.stroke();
    });
    ctx.beginPath();
    ctx.moveTo(w / 2 - 40, h / 2); ctx.lineTo(w / 2 + 40, h / 2);
    ctx.moveTo(w / 2, h / 2 - 40); ctx.lineTo(w / 2, h / 2 + 40);
    ctx.stroke();

    c.toBlob(function(blob) {
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "boxmaker-calib-a4.png";
      a.click();
      setTimeout(function() { URL.revokeObjectURL(a.href); }, 1000);
      sketchSetStatus("标定纸已生成 (A4 300dpi, 打印后把物体放上去拍照)");
    }, "image/png");
  }
};
