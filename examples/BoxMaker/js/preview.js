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
    p.camera.up.set(0, 0, 1);
    var bed0 = Scene.bed;
    p.camera.position.set(0, -1.15 * bed0.w, 1.2 * bed0.w);
    p.controls = new THREE.OrbitControls(p.camera, p.canvas);
    p.controls.target.set(0, 0, 0);
    p.controls.enableDamping = true;
    p.controls.dampingFactor = 0.08;
    p.controls.screenSpacePanning = true;
    p.controls.minPolarAngle = 0.02;
    p.controls.maxPolarAngle = Math.PI - 0.02;
    p.controls.minDistance = 30;
    p.controls.maxDistance = 6 * bed0.w;
    p.controls.mouseButtons = {LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE};
    p.controls.update();

    p.renderer = new THREE.WebGLRenderer({canvas: p.canvas, antialias: true});
    p.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    p.renderer.setSize(w, h, false);
    p.renderer.shadowMap.enabled = true;
    p.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if ("outputColorSpace" in p.renderer && THREE.SRGBColorSpace) p.renderer.outputColorSpace = THREE.SRGBColorSpace;
    else if ("outputEncoding" in p.renderer && THREE.sRGBEncoding) p.renderer.outputEncoding = THREE.sRGBEncoding;
    if (THREE.ACESFilmicToneMapping) {
      p.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      p.renderer.toneMappingExposure = 1.05;
    }

    p.scene.add(new THREE.HemisphereLight(0xdbeeff, 0x17202a, 1.6));
    var key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-0.6 * bed0.w, -0.8 * bed0.w, 1.5 * bed0.w);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    p.scene.add(key);
    var fill = new THREE.DirectionalLight(0x8fb8ff, 0.8);
    fill.position.set(0.8 * bed0.w, 0.5 * bed0.w, 0.7 * bed0.w);
    p.scene.add(fill);
    var rim = new THREE.DirectionalLight(0xffd6a1, 0.55);
    rim.position.set(0, 1.1 * bed0.w, 0.9 * bed0.w);
    p.scene.add(rim);

    p.modelGroup = new THREE.Group(); p.scene.add(p.modelGroup);
    p.bedGroup = new THREE.Group(); p.scene.add(p.bedGroup);

    var collapsed = false;
    document.getElementById("pw-collapse").addEventListener("click", function() {
      collapsed = !collapsed;
      document.getElementById("preview-window").classList.toggle("collapsed", collapsed);
      document.getElementById("pw-collapse").textContent = collapsed ? "▼" : "▲";
      p.fitCanvas();
    });

    var swapped = false;
    var fabWrap = null;
    document.getElementById("pw-swap").addEventListener("click", function() {
      var pw = document.getElementById("preview-window");
      var pwBody = pw.querySelector(".pw-body");
      var area = document.getElementById("canvas-area");
      if (!swapped) {
        fabWrap = document.querySelector("#canvas-area .canvas-container");
        area.insertBefore(p.canvas, area.firstChild);
        var aw = area.clientWidth, ah = area.clientHeight;
        if (aw > 0 && ah > 0) p.setSize(aw, ah);
        pwBody.appendChild(fabWrap);
        var mw = pwBody.clientWidth, mh = pwBody.clientHeight;
        if (canvas && mw > 0 && mh > 0) {
          canvas.setWidth(mw); canvas.setHeight(mh); canvas.calcOffset();
          Scene.rebuild(); Overlay.resize(mw, mh);
        }
        document.getElementById("pw-title-text").textContent = "2D 编辑";
        swapped = true;
      } else {
        pwBody.appendChild(p.canvas);
        var w3 = pwBody.clientWidth, h3 = pwBody.clientHeight;
        if (w3 > 0 && h3 > 0) p.setSize(w3, h3);
        area.appendChild(fabWrap);
        if (canvas) resize();
        document.getElementById("pw-title-text").textContent = "3D 预览";
        swapped = false;
      }
    });

    p.inited = true;
    p.rebuildBed();
    p.animate();
  },

  setSize: function(w, h) {
    if (!this.renderer || !(w > 0 && h > 0)) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  },

  fitCanvas: function() {
    if (!this.inited) return;
    var parent = this.canvas && this.canvas.parentElement;
    if (!parent) return;
    this.setSize(parent.clientWidth, parent.clientHeight);
  },

  disposeObject: function(object) {
    object.traverse(function(child) {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach(function(m) { m.dispose(); });
        else child.material.dispose();
      }
    });
  },

  clearGroup: function(group) {
    while (group.children.length) {
      var child = group.children.pop();
      this.disposeObject(child);
    }
  },

  rebuildBed: function() {
    if (!this.inited) return;
    var p = this;
    p.clearGroup(p.bedGroup);
    var bed = Scene.bed;
    p.controls.maxDistance = 6 * Math.max(bed.w, bed.h);
    var bw = bed.displayW(), bh = bed.displayH();
    var r = bed.margin, x0 = -bw / 2, y0 = -bh / 2, x1 = bw / 2, y1 = bh / 2;
    var shp = new THREE.Shape();
    shp.moveTo(x0 + r, y0);
    shp.lineTo(x1 - r, y0); shp.quadraticCurveTo(x1, y0, x1, y0 + r);
    shp.lineTo(x1, y1 - r); shp.quadraticCurveTo(x1, y1, x1 - r, y1);
    shp.lineTo(x0 + r, y1); shp.quadraticCurveTo(x0, y1, x0, y1 - r);
    shp.lineTo(x0, y0 + r); shp.quadraticCurveTo(x0, y0, x0 + r, y0);
    var geo = new THREE.ExtrudeGeometry(shp, {depth: 1, bevelEnabled: false});
    geo.translate(0, 0, -1);
    var platform = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({color: 0x252a31, roughness: 0.78, metalness: 0.08}));
    platform.receiveShadow = true;
    p.bedGroup.add(platform);

    var gridMat = new THREE.LineBasicMaterial({color: 0x46515e, transparent: true, opacity: 0.68});
    for (var x = 0; x <= bed.w; x += 10) {
      p.bedGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x - bed.w / 2, -bed.h / 2, 0.012),
        new THREE.Vector3(x - bed.w / 2, bed.h / 2, 0.012)
      ]), gridMat));
    }
    for (var y = 0; y <= bed.h; y += 10) {
      p.bedGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-bed.w / 2, y - bed.h / 2, 0.012),
        new THREE.Vector3(bed.w / 2, y - bed.h / 2, 0.012)
      ]), gridMat));
    }
    var ax0x = -bed.w / 2, ax0y = -bed.h / 2, alen = 30;
    p.bedGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(ax0x, ax0y, 0.02), new THREE.Vector3(ax0x + alen, ax0y, 0.02)
    ]), new THREE.LineBasicMaterial({color: 0xe74c3c})));
    p.bedGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(ax0x, ax0y, 0.02), new THREE.Vector3(ax0x, ax0y + alen, 0.02)
    ]), new THREE.LineBasicMaterial({color: 0x27ae60})));
    p.modelGroup.children.forEach(function(m) { m.position.set(-bed.w / 2, -bed.h / 2, 0); });
  },

  loadSTL: function(buffer) {
    if (!this.inited) return;
    try {
      var geo = parseSTL(buffer);
      if (!geo.getAttribute("position") || geo.getAttribute("position").count === 0) throw new Error("STL 不含三角面");
      this.clearGroup(this.modelGroup);
      var mat = new THREE.MeshStandardMaterial({
        color: 0xf5bd3b, roughness: 0.36, metalness: 0.12, side: THREE.DoubleSide
      });
      var mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      var bed = Scene.bed;
      mesh.position.set(-bed.w / 2, -bed.h / 2, 0);
      this.modelGroup.add(mesh);
      var box = new THREE.Box3().setFromObject(mesh);
      var center = box.getCenter(new THREE.Vector3());
      var size = Math.max(box.getSize(new THREE.Vector3()).length(), 1);
      var distance = size * 1.35;
      this.controls.target.copy(center);
      this.camera.position.set(center.x - distance * 0.434, center.y - distance * 0.623, center.z + distance * 0.651);
      this.controls.update();
      var ph = document.getElementById("pw-placeholder");
      if (ph) ph.style.display = "none";
    } catch (err) {
      console.error("STL parse error:", err);
      var status = document.getElementById("status-text");
      if (status) status.textContent = "STL 预览失败：" + (err.message || err);
    }
  },

  animate: function() {
    var p = this;
    requestAnimationFrame(function() { p.animate(); });
    if (p.inited) {
      p.controls.update();
      p.renderer.render(p.scene, p.camera);
    }
  }
};

// 二进制 STL 解析与基础长度验证。
function parseSTL(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 84) throw new Error("二进制 STL 文件过短");
  var dv = new DataView(buffer);
  var count = dv.getUint32(80, true);
  var expected = 84 + count * 50;
  if (!Number.isSafeInteger(expected) || expected > buffer.byteLength) throw new Error("二进制 STL 面数或长度无效");
  var vertices = new Float32Array(count * 9);
  var offset = 0;
  for (var i = 0; i < count; i++) {
    var face = 84 + i * 50;
    for (var j = 0; j < 3; j++) {
      var source = face + 12 + j * 12;
      var x = dv.getFloat32(source, true), y = dv.getFloat32(source + 4, true), z = dv.getFloat32(source + 8, true);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new Error("STL 含无效顶点");
      vertices[offset++] = x; vertices[offset++] = y; vertices[offset++] = z;
    }
  }
  var geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  return geo;
}
