// ============================================================
// preview.js — Three.js 3D 预览悬浮窗
// ============================================================

var Preview3D = {
  scene: null, camera: null, renderer: null,
  modelGroup: null, bedGroup: null,
  canvas: null, inited: false,

  init: function() {
    if (this.inited) return;
    var p = this;
    p.canvas = document.getElementById("preview-canvas");
    var pwBody = document.querySelector(".pw-body");
    if (!p.canvas || !pwBody) return;
    var w = pwBody.clientWidth, h = pwBody.clientHeight || 220;

    p.scene = new THREE.Scene();
    p.scene.background = new THREE.Color(0x2d2d2d);
    p.camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 5000);
    p.camera.up.set(0, 0, 1); // 世界 Z 为天顶 (OrbitControls 以其为轨道极轴)
    // 世界坐标: 平台在 XY 平面, +Z 为高度 —— 与 SCAD 的 (x,y)+extrude z 一一对应
    // 默认视角: 3/4 透视 (俯角 ~40°), 相机在 -X/-Y 侧 —— 平台立体感明显,
    // 且轴原点(打印区左下角)落在窗口左下区域 (|f_x| < |f_y| 的左偏条件)
    var bed0 = Scene.bed;
    p.camera.position.set(0, -1.15 * bed0.w, 1.2 * bed0.w);
    // 官方 OrbitControls (lib/OrbitControls.js, r157): 轨道旋转/平移/缩放
    p.controls = new THREE.OrbitControls(p.camera, p.canvas);
    p.controls.target.set(0, 0, 0);
    p.controls.enableDamping = false;
    p.controls.screenSpacePanning = true;
    p.controls.minPolarAngle = 0.02;        // 防天顶退化
    p.controls.maxPolarAngle = Math.PI - 0.02;
    p.controls.minDistance = 30;
    p.controls.maxDistance = 6 * bed0.w;
    // 左/右键旋转, 中键平移, 滚轮缩放
    p.controls.mouseButtons = {LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE};
    p.controls.update();
    p.renderer = new THREE.WebGLRenderer({canvas: p.canvas, antialias: true});
    p.renderer.setSize(w, h, false);
    p.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // 灯光
    p.scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    var dl = new THREE.DirectionalLight(0xffffff, 0.8);
    dl.position.set(1, 1, 0.8); p.scene.add(dl);
    var dl2 = new THREE.DirectionalLight(0x8080ff, 0.3);
    dl2.position.set(-0.5, -1, -0.5); p.scene.add(dl2);

    p.modelGroup = new THREE.Group(); p.scene.add(p.modelGroup);
    p.bedGroup = new THREE.Group(); p.scene.add(p.bedGroup);

    // 鼠标交互 (旋转/平移/缩放) 由 OrbitControls 处理, 无需手写

    // 折叠按钮 (折叠/展开后预览画布尺寸同步)
    var collapsed = false;
    document.getElementById("pw-collapse").addEventListener("click", function() {
      collapsed = !collapsed;
      document.getElementById("preview-window").classList.toggle("collapsed", collapsed);
      document.getElementById("pw-collapse").textContent = collapsed ? "▼" : "▲";
      p.fitCanvas();
    });

    // 交换按钮: 交换 2D/3D 内容
    // 交换后: 3D canvas 移到主区铺满 (预览窗继续悬浮右上角, 不拦截事件),
    //          Fabric 容器移入预览窗作 2D mini; 恢复时对称移回并各自重建尺寸
    var swapped = false;
    var fabWrap = null;
    document.getElementById("pw-swap").addEventListener("click", function() {
      var pw = document.getElementById("preview-window");
      var pwBody = pw.querySelector(".pw-body");
      var area = document.getElementById("canvas-area");

      if (!swapped) {
        // 3D canvas → 主区首位, 铺满
        fabWrap = document.querySelector("#canvas-area .canvas-container");
        area.insertBefore(p.canvas, area.firstChild);
        var aw = area.clientWidth, ah = area.clientHeight;
        if (aw > 0) { p.renderer.setSize(aw, ah, false); p.camera.aspect = aw / ah; p.camera.updateProjectionMatrix(); }
        // Fabric 容器 → 预览窗, 按预览窗尺寸重建 2D 场景 (床面比例重算)
        pwBody.appendChild(fabWrap);
        var mw = pwBody.clientWidth, mh = pwBody.clientHeight;
        if (canvas && mw > 0) {
          canvas.setWidth(mw);
          canvas.setHeight(mh);
          canvas.calcOffset();
          Scene.rebuild();
          Overlay.resize(mw, mh);
        }
        document.getElementById("pw-title-text").textContent = "2D 编辑";
        swapped = true;
      } else {
        // 恢复: 3D canvas 移回预览窗, Fabric 移回主区, 各自按容器尺寸重建
        pwBody.appendChild(p.canvas);
        var w3 = pwBody.clientWidth, h3 = pwBody.clientHeight;
        if (w3 > 0) { p.renderer.setSize(w3, h3, false); p.camera.aspect = w3 / h3; p.camera.updateProjectionMatrix(); }
        area.appendChild(fabWrap);
        if (canvas) resize();
        document.getElementById("pw-title-text").textContent = "3D 预览";
        swapped = false;
      }
    });

    p.inited = true;
    this.rebuildBed();
    this.animate();
  },

  // 预览画布尺寸跟随 pw-body 容器 (列宽调整/折叠展开后调用)
  fitCanvas: function() {
    var pwBody = document.querySelector(".pw-body");
    if (!this.inited || !pwBody) return;
    var w = pwBody.clientWidth, h = pwBody.clientHeight;
    if (w > 0) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  },

  rebuildBed: function() {
    if (!this.inited) return;
    var p = this;
    while (p.bedGroup.children.length) p.bedGroup.remove(p.bedGroup.children[0]);
    var bed = Scene.bed;
    var bw = bed.displayW(), bh = bed.displayH();
    // 平台 (圆角 r = margin): 圆角矩形在 XY 平面, 沿 +Z 挤出后平移使顶面 z=0
    var r = bed.margin, x0 = -bw / 2, y0 = -bh / 2, x1 = bw / 2, y1 = bh / 2;
    var shp = new THREE.Shape();
    shp.moveTo(x0 + r, y0);
    shp.lineTo(x1 - r, y0);
    shp.quadraticCurveTo(x1, y0, x1, y0 + r);
    shp.lineTo(x1, y1 - r);
    shp.quadraticCurveTo(x1, y1, x1 - r, y1);
    shp.lineTo(x0 + r, y1);
    shp.quadraticCurveTo(x0, y1, x0, y1 - r);
    shp.lineTo(x0, y0 + r);
    shp.quadraticCurveTo(x0, y0, x0 + r, y0);
    var geo = new THREE.ExtrudeGeometry(shp, {depth: 1, bevelEnabled: false});
    geo.translate(0, 0, -1); // 厚度向下 (z∈[-1,0]), 顶面 z=0
    var mat = new THREE.MeshPhongMaterial({color: 0x252525, specular: 0x050505, shininess: 5});
    var platform = new THREE.Mesh(geo, mat);
    p.bedGroup.add(platform);
    // 网格 (仅打印区, XY 平面 z=0.01)
    var gridMat = new THREE.LineBasicMaterial({color: 0x3a3a3a});
    for (var x = 0; x <= bed.w; x += 10) {
      var pts = [new THREE.Vector3(x - bed.w / 2, -bed.h / 2, 0.01), new THREE.Vector3(x - bed.w / 2, bed.h / 2, 0.01)];
      p.bedGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), gridMat));
    }
    for (var y = 0; y <= bed.h; y += 10) {
      var pts2 = [new THREE.Vector3(-bed.w / 2, y - bed.h / 2, 0.01), new THREE.Vector3(bed.w / 2, y - bed.h / 2, 0.01)];
      p.bedGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts2), gridMat));
    }
    // 坐标轴 (打印区左下角 z=0.02, 红 +X, 绿 +Y — 与 2D 视图方向一致)
    var alen = 30;
    var ax0x = -bed.w / 2, ax0y = -bed.h / 2;
    var xPts = [new THREE.Vector3(ax0x, ax0y, 0.02), new THREE.Vector3(ax0x + alen, ax0y, 0.02)];
    p.bedGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(xPts), new THREE.LineBasicMaterial({color: 0xe74c3c})));
    var yPts = [new THREE.Vector3(ax0x, ax0y, 0.02), new THREE.Vector3(ax0x, ax0y + alen, 0.02)];
    p.bedGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(yPts), new THREE.LineBasicMaterial({color: 0x27ae60})));
    // 已有模型重新对齐 (模型原点 = 打印区左下角 → 世界 (-w/2, -h/2))
    p.modelGroup.children.forEach(function(m) { m.position.set(-bed.w / 2, -bed.h / 2, 0); });
  },

  loadSTL: function(buffer) {
    if (!this.inited) return;
    var p = this;
    while (p.modelGroup.children.length) p.modelGroup.remove(p.modelGroup.children[0]);
    try {
      var geo = parseSTL(buffer);
      var mat = new THREE.MeshPhongMaterial({color: 0xf9d72c, specular: 0x111111, shininess: 30, side: THREE.DoubleSide});
      var mesh = new THREE.Mesh(geo, mat);
      // SCAD 坐标 (x,y)+z 与世界坐标一一对应; 模型原点(打印区左下角)平移到世界 (-w/2, -h/2)
      var bed = Scene.bed;
      mesh.position.set(-bed.w / 2, -bed.h / 2, 0);
      p.modelGroup.add(mesh);
      var box = new THREE.Box3().setFromObject(mesh);
      var center = box.getCenter(new THREE.Vector3());
      var size = box.getSize(new THREE.Vector3()).length();
      // 默认视角复位 (3/4 透视, 与初始视角同方向: (-0.8,-1.15,1.2) 归一化)
      var r = size * 1.2;
      p.controls.target.copy(center);
      p.camera.position.set(center.x - r * 0.434, center.y - r * 0.623, center.z + r * 0.651);
      p.controls.update();
      var ph = document.getElementById("pw-placeholder");
      if (ph) ph.style.display = "none";
    } catch (e) { console.error("STL parse error:", e); }
  },

  animate: function() {
    var p = this;
    requestAnimationFrame(function() { p.animate(); });
    if (this.inited) this.renderer.render(this.scene, this.camera);
  }
};

// 二进制 STL 解析
function parseSTL(buffer) {
  var dv = new DataView(buffer);
  var count = dv.getUint32(80, true);
  var vertices = [], normals = [];
  for (var i = 0; i < count; i++) {
    var off = 84 + i * 50;
    normals.push(dv.getFloat32(off, true), dv.getFloat32(off + 4, true), dv.getFloat32(off + 8, true));
    for (var j = 0; j < 3; j++) {
      var vo = off + 12 + j * 12;
      vertices.push(dv.getFloat32(vo, true), dv.getFloat32(vo + 4, true), dv.getFloat32(vo + 8, true));
    }
  }
  var geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geo.computeVertexNormals();
  return geo;
}
