/**
 * OpenSCAD 服务端渲染 Demo — 客户端应用
 *
 * 核心架构：
 *   浏览器端绝不执行 SCAD 脚本。
 *   SCAD 源码通过 HTTP POST 发送到服务端 → 服务端调用 openscad CLI 渲染 →
 *   返回 STL 网格 / PNG 图片 → 浏览器端 Three.js 纯显示。
 *
 * 参考：examples/web/index.html (WASM 零拷贝方案)
 * 本方案改为 HTTP + STL 传输，更适合服务端渲染场景。
 */

import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ── API 地址 ────────────────────────────────────────────────────────────
const API = '/api';

// ── 默认 SCAD 源码 ──────────────────────────────────────────────────────
const DEFAULT_SCAD = `// 带安装孔的圆角盒体
// 服务端执行此脚本，浏览器仅负责显示结果
$fn = 60;

difference() {
  cube([30, 20, 15], center = true);
  translate([0, 0, 2])
    cube([26, 16, 15], center = true);
  translate([10, 6, 0])
    cylinder(h = 20, d = 3.5, center = true);
  translate([-10, 6, 0])
    cylinder(h = 20, d = 3.5, center = true);
  translate([10, -6, 0])
    cylinder(h = 20, d = 3.5, center = true);
  translate([-10, -6, 0])
    cylinder(h = 20, d = 3.5, center = true);
}`;

// ── CodeMirror 编辑器 ────────────────────────────────────────────────────
const editor = CodeMirror(document.getElementById('editor-container'), {
  mode: 'text/x-csrc',
  theme: 'material-darker',
  lineNumbers: true,
  tabSize: 2,
  indentUnit: 2,
  indentWithTabs: false,
  matchBrackets: true,
  autoCloseBrackets: true,
  extraKeys: { 'Ctrl-Enter': () => render3D() },
  value: DEFAULT_SCAD,
});

// ── DOM 引用 ─────────────────────────────────────────────────────────────
const viewerEl    = document.getElementById('viewer-container');
const placeholder = document.getElementById('viewer-placeholder');
const loadingEl   = document.getElementById('loading');
const legendEl    = document.getElementById('legend');
const infoEl      = document.getElementById('info');
const statusEl    = document.getElementById('status');

// ── Three.js 场景（参考 examples/web 的配置）──────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x313244);

// 相机
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
camera.position.set(10, 12, 15);
camera.up.set(0, 0, 1);
camera.lookAt(0, 0, 0);

// 渲染器
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
viewerEl.appendChild(renderer.domElement);

// 轨道控制
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.update();

// 光照
scene.add(new THREE.AmbientLight(0xffffff, 0.4));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(1, 1, 0.8);
scene.add(dirLight);
const dirLight2 = new THREE.DirectionalLight(0x8080ff, 0.3);
dirLight2.position.set(-0.5, -1, -0.5);
scene.add(dirLight2);

// 网格参考面 (XY 平面，与 OpenSCAD 坐标系一致)
const grid = new THREE.GridHelper(60, 20, 0x585b70, 0x45475a);
grid.rotation.x = Math.PI / 2;  // 平放在 XY 平面
scene.add(grid);

// 模型容器
let modelGroup = new THREE.Group();
scene.add(modelGroup);

// ── 自适应尺寸 ───────────────────────────────────────────────────────────
function resize() {
  const w = viewerEl.clientWidth;
  const h = viewerEl.clientHeight;
  if (w <= 0 || h <= 0) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener('resize', resize);
new ResizeObserver(resize).observe(viewerEl);
setTimeout(resize, 50);

// 渲染循环
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

// ── 构建 STL 模型 ────────────────────────────────────────────────────────
function loadSTL(buffer) {
  // 清理旧模型
  modelGroup.traverse(c => {
    if (c.geometry) c.geometry.dispose();
    if (c.material) {
      if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
      else c.material.dispose();
    }
  });
  scene.remove(modelGroup);
  modelGroup = new THREE.Group();
  scene.add(modelGroup);

  infoEl.textContent = '';
  legendEl.innerHTML = '';
  legendEl.style.display = 'none';

  const loader = new STLLoader();
  const geometry = loader.parse(buffer);

  if (!geometry || geometry.getAttribute('position').count === 0) {
    infoEl.textContent = '模型为空';
    return;
  }

  geometry.computeVertexNormals();
  geometry.center();

  const numVertices = geometry.getAttribute('position').count;
  const numFaces = geometry.index
    ? geometry.index.count / 3
    : numVertices / 3;

  // 材质（STL 不含颜色信息，使用统一材质）
  const material = new THREE.MeshPhongMaterial({
    color: new THREE.Color(0xf9d72c),
    specular: 0x111111,
    shininess: 30,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  modelGroup.add(mesh);

  // 适配相机
  const box = new THREE.Box3().setFromObject(modelGroup);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length();
  controls.target.copy(center);
  camera.position.set(
    center.x + size * 0.7,
    center.y - size * 0.5,
    center.z + size * 0.8
  );
  controls.update();

  // 隐藏占位符
  placeholder.style.display = 'none';

  // 显示统计信息
  infoEl.textContent = `顶点 ${numVertices}  ·  三角面 ${Math.round(numFaces)}  ·  STL`;
}

// ── 服务端通信 ───────────────────────────────────────────────────────────
function setStatus(cls, msg) {
  statusEl.className = cls;
  statusEl.textContent = msg;
}

async function checkHealth() {
  try {
    const res = await fetch(`${API}/health`);
    const data = await res.json();
    if (data.status === 'ok') {
      document.getElementById('concurrency').textContent =
        `⚡ ${data.concurrency?.running || 0}/${data.concurrency?.max || '?'}`;
    }
  } catch {
    document.getElementById('concurrency').textContent = '⚠ 未连接';
  }
}

/**
 * 发送 SCAD 到服务端
 * @param {'render'|'preview'|'export'} endpoint
 * @param {string} [format]
 * @returns {Promise<ArrayBuffer>}
 */
async function sendToServer(endpoint, format = null) {
  const scadSource = editor.getValue().trim();
  if (!scadSource) {
    showError('编辑器为空，请先编写 SCAD 代码');
    throw new Error('空源码');
  }

  clearError();
  setStatus('status-working', '⏳ 渲染中...');
  loadingEl.classList.add('show');

  const btnPreview = document.getElementById('btn-preview');
  const btnPng = document.getElementById('btn-png');
  const btnExport = document.getElementById('btn-export');
  btnPreview.disabled = true;
  btnPng.disabled = true;
  btnExport.disabled = true;

  let url = `${API}/${endpoint}`;
  if (endpoint === 'export' && format) url += `?format=${format}`;
  if (endpoint === 'preview') url += '?mode=render';

  console.log(`%c📤 POST %c${url}%c  (%{(scadSource.length / 1024).toFixed(1)} KB SCAD)`,
    'color:#f9e2af', 'color:#89b4fa', 'color:inherit');

  try {
    const t0 = performance.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: scadSource,
    });

    if (!res.ok) {
      const text = await res.text();
      let msg = text;
      try { msg = JSON.parse(text).error || text; } catch {}
      throw new Error(msg);
    }

    const data = await res.arrayBuffer();
    const elapsed = (performance.now() - t0).toFixed(0);
    console.log(`%c📥 响应 %c${res.status}%c  (${(data.byteLength / 1024).toFixed(1)} KB, ${elapsed}ms)`,
      'color:#a6e3a1', 'color:#89b4fa', 'color:inherit');
    setStatus('status-idle', '● 就绪');
    checkHealth();
    return data;
  } catch (err) {
    setStatus('status-error', `✕ ${err.message.slice(0, 50)}`);
    showError(err.message);
    throw err;
  } finally {
    loadingEl.classList.remove('show');
    btnPreview.disabled = false;
    btnPng.disabled = false;
    btnExport.disabled = false;
  }
}

// ── 3D 预览 ──────────────────────────────────────────────────────────────
async function render3D() {
  try {
    const data = await sendToServer('render');
    loadSTL(data);
  } catch { /* 错误已显示 */ }
}

// ── PNG 渲染 ─────────────────────────────────────────────────────────────
async function renderPNG() {
  try {
    const data = await sendToServer('preview');
    const blob = new Blob([data], { type: 'image/png' });
    const url = URL.createObjectURL(blob);

    const overlay = document.getElementById('png-overlay');
    const img = document.getElementById('png-result');

    if (img.dataset.blobUrl) URL.revokeObjectURL(img.dataset.blobUrl);
    img.src = url;
    img.dataset.blobUrl = url;
    overlay.classList.add('show');
  } catch { /* 错误已显示 */ }
}

// ── 导出下载 ─────────────────────────────────────────────────────────────
async function exportFile() {
  const format = document.getElementById('export-format').value;
  try {
    const data = await sendToServer('export', format);

    const exts = {
      stl: 'stl', '3mf': '3mf', off: 'off', amf: 'amf',
      svg: 'svg', dxf: 'dxf', png: 'png', csg: 'csg', ast: 'ast'
    };
    const mimes = {
      stl: 'model/stl',
      '3mf': 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
      png: 'image/png',
      svg: 'image/svg+xml'
    };

    const blob = new Blob([data], { type: mimes[format] || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `model.${exts[format] || format}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch { /* 错误已显示 */ }
}

// ── 错误显示 ─────────────────────────────────────────────────────────────
function showError(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function clearError() {
  const el = document.getElementById('error-msg');
  el.textContent = '';
  el.classList.add('hidden');
}

// ── 示例 SCAD ────────────────────────────────────────────────────────────
const examples = {
  basic: `// 带安装孔的圆角盒体
// 服务端执行此脚本，浏览器仅负责显示结果
$fn = 60;

difference() {
  cube([30, 20, 15], center = true);
  translate([0, 0, 2])
    cube([26, 16, 15], center = true);
  translate([10, 6, 0])
    cylinder(h = 20, d = 3.5, center = true);
  translate([-10, 6, 0])
    cylinder(h = 20, d = 3.5, center = true);
  translate([10, -6, 0])
    cylinder(h = 20, d = 3.5, center = true);
  translate([-10, -6, 0])
    cylinder(h = 20, d = 3.5, center = true);
}`,

  gear: `// 参数化齿轮
$fn = 60;

module gear(teeth = 12, radius = 20, height = 6, hole = 5) {
  difference() {
    union() {
      cylinder(r = radius, h = height, center = true);
      for (i = [0:teeth-1]) {
        rotate([0, 0, i * 360 / teeth])
          translate([radius * 0.85, 0, 0])
            cube([radius * 0.3, radius * 0.2, height],
                 center = true);
      }
    }
    cylinder(r = hole, h = height + 1, center = true);
  }
}

gear(teeth = 12, radius = 20, height = 6, hole = 4);`,

  text: `// 3D 文字
$fn = 40;

linear_extrude(height = 6) {
  text("OpenSCAD", size = 12,
       font = "Liberation Sans:style=Bold",
       halign = "center",
       valign = "center");
}

translate([0, 0, -2])
  cube([100, 20, 4], center = true);`,

  csg: `// 复杂 CSG 布尔运算
$fn = 80;

difference() {
  union() {
    sphere(r = 20);
    for (a = [0:90:270]) {
      rotate([0, 0, a])
        translate([18, 0, 0])
          cylinder(h = 8, r = 6, center = true);
    }
  }
  sphere(r = 15);
  rotate([90, 0, 0])
    cylinder(h = 50, r = 4, center = true);
  rotate([0, 90, 0])
    cylinder(h = 50, r = 4, center = true);
}`,
};

// ── 事件绑定 ─────────────────────────────────────────────────────────────
document.getElementById('btn-preview').addEventListener('click', render3D);
document.getElementById('btn-png').addEventListener('click', renderPNG);
document.getElementById('btn-export').addEventListener('click', exportFile);

document.getElementById('btn-close-png').addEventListener('click', () => {
  document.getElementById('png-overlay').classList.remove('show');
});

Object.entries(examples).forEach(([name, code]) => {
  const idMap = { basic: 'basic', gear: 'gear', text: 'text', csg: 'csg' };
  document.getElementById(`btn-example-${idMap[name]}`)?.addEventListener('click', () => {
    editor.setValue(code);
    clearError();
  });
});

// Ctrl+Enter 快捷键
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    render3D();
  }
});

// ── 初始化 ────────────────────────────────────────────────────────────────
checkHealth();
setInterval(checkHealth, 10000);

console.log('%c🔷 OpenSCAD 服务端渲染 Demo %c就绪',
  'font-size:1.1em;font-weight:bold;color:#cba6f7', 'color:#a6e3a1');
console.log('  Ctrl+Enter → 发送到服务端渲染 3D 预览');
console.log('  服务端:', API);
