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

// ── 参数状态 ──────────────────────────────────────────────────────────────
let currentParams = null;   // { title, parameters: [...] }
let paramValues = {};       // { paramName: currentValue }
let paramDetectTimer = null;

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

// ── 模型容器管理 ──────────────────────────────────────────────────────────
function resetModelGroup() {
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
  placeholder.style.display = 'none';
}

// ── binmesh 解析（与 examples/web 相同的布局，见 src/wasm/binary_mesh_export.cc）──
//
// u32×4 头 {nv, nf, nc, ni} | pos f32×nv×3 | idx u32×ni | 面色 i32×nf | 调色板 f32×nc×4
// 直接在 fetch 返回的 ArrayBuffer 上建 typed array 视图，零解析开销。
function parseBinaryMesh(buf) {
  if (buf.byteLength < 16) return null;
  const v = new DataView(buf, 0, 16);
  const nv = v.getUint32(0, true), nf = v.getUint32(4, true),
        nc = v.getUint32(8, true), ni = v.getUint32(12, true);
  const expected = 16 + nv * 12 + ni * 4 + nf * 4 + nc * 16;
  if (expected > buf.byteLength) return null;  // 结构不合法 → 视为非 binmesh
  let off = 16;
  const pos = new Float32Array(buf, off, nv * 3); off += nv * 12;
  const idx = new Uint32Array(buf, off, ni); off += ni * 4;
  const ci = new Int32Array(buf, off, nf); off += nf * 4;
  const pal = new Float32Array(buf, off, nc * 4);
  return { nv, nf, nc, pos, idx, ci, pal };
}

// ── 构建 binmesh 模型（单色零拷贝 / 多色按面色分组）────────────────────────
// 返回 false 表示数据不是合法 binmesh（调用方回退 STL）
function loadBinaryMesh(buffer) {
  const data = parseBinaryMesh(buffer);
  if (!data) return false;

  resetModelGroup();
  const { nf, nc, pos, idx, ci, pal } = data;
  if (nf === 0) {
    infoEl.textContent = '模型为空';
    return true;
  }

  // 材质：平滑着色（与 STL 路径一致）。flatShading 会让曲面呈逐面色块，
  // 默认颜色视觉上会"变深/花掉"，故保留平滑法线
  const defaultColor = new THREE.Color(0xf9d72c);
  const makeMaterial = (r, g, b) => new THREE.MeshPhongMaterial({
    color: new THREE.Color(r, g, b), specular: 0x111111, shininess: 30,
    side: THREE.DoubleSide,
  });

  // 按面色分组：ci[fi] → 面列表
  const groups = new Map();
  for (let fi = 0; fi < nf; fi++) {
    const c = ci[fi];
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(fi);
  }

  let totalTris = 0;
  previewColorMeshes = [];
  for (const [colorIdx, faces] of groups) {
    let geo;
    if (groups.size === 1 && faces.length === nf) {
      // 单色快路径：position/index 直接零拷贝视图，无顶点重映射
      geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeVertexNormals();
    } else {
      // 多色：索引重映射到分组局部顶点（O(n) 拷贝，与 examples/web 一致）
      geo = new THREE.BufferGeometry();
      const verts = [], indices = [], idxMap = new Map();
      let vi = 0;
      for (const fi of faces) {
        for (let k = 0; k < 3; k++) {
          const oi = idx[fi * 3 + k];
          if (!idxMap.has(oi)) { idxMap.set(oi, vi); verts.push(pos[oi * 3], pos[oi * 3 + 1], pos[oi * 3 + 2]); vi++; }
          indices.push(idxMap.get(oi));
        }
      }
      geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();
    }

    let r = defaultColor.r, g = defaultColor.g, b = defaultColor.b;
    if (colorIdx >= 0 && colorIdx < nc) { r = pal[colorIdx * 4]; g = pal[colorIdx * 4 + 1]; b = pal[colorIdx * 4 + 2]; }
    const mesh = new THREE.Mesh(geo, makeMaterial(r, g, b));
    modelGroup.add(mesh);
    previewColorMeshes.push({ mesh, paletteIdx: colorIdx });
    totalTris += faces.length;
  }

  fitCameraToModel();
  infoEl.textContent = `顶点 ${pos.length / 3}  ·  三角面 ${totalTris}  ·  颜色 ${nc}  ·  binmesh`;

  // 保存调色板，供 3MF 耗材配置与导出使用
  lastPalette = pal;
  document.getElementById('btn-filament').classList.toggle('hidden', nc === 0);

  // 已保存的耗材配置回馈预览着色，并重建图例
  applyFilamentColorsToPreview();
  return true;
}

// 将耗材配置应用到当前预览网格（保存/重置/渲染后调用）：
// 未配置时显示模型调色板本色；配置后按耗材对话框的颜色显示，
// 并同步图例——所见即 3MF 导出所用颜色。
function applyFilamentColorsToPreview() {
  let lhtml = '';
  for (const { mesh, paletteIdx } of previewColorMeshes) {
    const cfg = filamentConfig && filamentConfig[paletteIdx];
    const hex = cfg ? cfg.color : paletteHex(paletteIdx);
    mesh.material.color.set(hex);
    lhtml += `<div class="item"><span class="swatch" style="background:${hex}"></span><span class="hex">${hex}</span></div>`;
  }
  legendEl.innerHTML = lhtml;
  legendEl.style.display = lhtml ? 'block' : 'none';
}

// ── 构建 STL 模型（回退路径）──────────────────────────────────────────────
function loadSTL(buffer) {
  resetModelGroup();

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

  fitCameraToModel();

  // 显示统计信息
  infoEl.textContent = `顶点 ${numVertices}  ·  三角面 ${Math.round(numFaces)}  ·  STL`;
}

// ── 相机适配 ──────────────────────────────────────────────────────────────
function fitCameraToModel() {
  const box = new THREE.Box3().setFromObject(modelGroup);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length();
  controls.target.copy(center);
  camera.position.set(
    center.x + size * 0.7,
    center.y - size * 0.5,
    center.z + size * 0.8
  );
  controls.update();
}

// ── 3MF 耗材配置（MMU 颜色分割）─────────────────────────────────────────────
// filamentConfig[i] = { name, type: 'solid'|'gradient'|'glow', color: '#RRGGBB' }
// 序号与模型调色板索引一一对应（挤出机 i ← 模型第 i 种颜色）。
// 服务端按顺序拼成 -O export-3mf/filament-colors=Name|serialize 传给 CLI。
let lastPalette = null;       // binmesh 调色板 Float32Array（渲染后有效）
let filamentConfig = null;    // null = 未配置（导出时走 CLI 自动检测）
let previewColorMeshes = [];  // [{ mesh, paletteIdx }] — 供耗材配置回馈预览着色

function paletteHex(i) {
  const r = Math.round(lastPalette[i * 4] * 255).toString(16).padStart(2, '0').toUpperCase();
  const g = Math.round(lastPalette[i * 4 + 1] * 255).toString(16).padStart(2, '0').toUpperCase();
  const b = Math.round(lastPalette[i * 4 + 2] * 255).toString(16).padStart(2, '0').toUpperCase();
  return '#' + r + g + b;
}

function defaultConfig() {
  if (!lastPalette) return [];
  const nc = lastPalette.length / 4;
  return Array.from({ length: nc }, (_, i) => ({
    name: `PLA ${i + 1}`,
    type: 'solid',
    color: paletteHex(i),
  }));
}

function serializeFilament(cfg) {
  const hex = (cfg.color || '#FF0000') + 'FF';
  if (cfg.type === 'gradient') return `gradient:${hex},#FFFFFFFF;angle:0`;
  if (cfg.type === 'glow')     return `glow:${hex},#0000FFFF`;
  return hex;
}

function openFilamentDialog() {
  if (!lastPalette) return;
  const overlay = document.getElementById('filament-modal-overlay');
  const rowsEl = document.getElementById('filament-rows');
  const draft = JSON.parse(JSON.stringify(filamentConfig || defaultConfig()));

  const render = () => {
    rowsEl.innerHTML = '';
    draft.forEach((cfg, i) => {
      const row = document.createElement('div');
      row.className = 'filament-row';
      row.innerHTML = `
        <span class="swatch" style="background:${paletteHex(i)}"></span>
        <span class="extruder-tag">挤出机 ${i + 1}</span>
        <input class="fname" value="${escapeHTML(cfg.name)}" data-i="${i}">
        <input type="color" value="${cfg.color}" data-i="${i}">
        <select data-i="${i}">
          <option value="solid" ${cfg.type === 'solid' ? 'selected' : ''}>纯色</option>
          <option value="gradient" ${cfg.type === 'gradient' ? 'selected' : ''}>渐变（→白）</option>
          <option value="glow" ${cfg.type === 'glow' ? 'selected' : ''}>夜光（→亮蓝）</option>
        </select>
        <button class="btn-sm" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn-sm" data-down="${i}" ${i === draft.length - 1 ? 'disabled' : ''}>↓</button>`;
      rowsEl.appendChild(row);
    });

    rowsEl.querySelectorAll('.fname').forEach(inp => {
      inp.onchange = () => { draft[+inp.dataset.i].name = inp.value.trim() || `PLA ${+inp.dataset.i + 1}`; };
    });
    rowsEl.querySelectorAll('input[type="color"]').forEach(inp => {
      inp.oninput = () => { draft[+inp.dataset.i].color = inp.value; };
    });
    rowsEl.querySelectorAll('select').forEach(sel => {
      sel.onchange = () => { draft[+sel.dataset.i].type = sel.value; };
    });
    rowsEl.querySelectorAll('[data-up]').forEach(btn => {
      btn.onclick = () => {
        const i = +btn.dataset.up;
        [draft[i - 1], draft[i]] = [draft[i], draft[i - 1]];
        render();
      };
    });
    rowsEl.querySelectorAll('[data-down]').forEach(btn => {
      btn.onclick = () => {
        const i = +btn.dataset.down;
        [draft[i], draft[i + 1]] = [draft[i + 1], draft[i]];
        render();
      };
    });
  };
  render();
  overlay.classList.add('show');

  document.getElementById('btn-filament-save').onclick = () => {
    filamentConfig = draft;
    applyFilamentColorsToPreview();  // 立即回馈预览着色
    overlay.classList.remove('show');
    document.getElementById('status').textContent =
      `耗材配置已保存 (${filamentConfig.length} 个挤出机) · 预览与 3MF 导出生效`;
  };
  document.getElementById('btn-filament-cancel').onclick = () => {
    overlay.classList.remove('show');  // 放弃草稿，保留已保存配置
  };
  document.getElementById('btn-filament-reset').onclick = () => {
    filamentConfig = null;  // 恢复 CLI 自动检测
    applyFilamentColorsToPreview();  // 预览恢复模型本色
    overlay.classList.remove('show');
    document.getElementById('status').textContent = '耗材配置已重置 · 预览恢复模型本色，3MF 导出使用自动检测';
  };
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
// ── 参数检测 ─────────────────────────────────────────────────────────────

async function detectParams() {
  const scadSource = editor.getValue().trim();
  if (!scadSource) return;

  try {
    const res = await fetch(`${API}/params`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: scadSource,
    });
    if (!res.ok) { hideParamPanel(); return; }
    const data = await res.json();
    if (!data.parameters || data.parameters.length === 0) { hideParamPanel(); return; }

    // Preserve existing values for params that still exist
    const newValues = {};
    for (const p of data.parameters) {
      if (paramValues[p.name] !== undefined) {
        newValues[p.name] = paramValues[p.name];
      } else {
        newValues[p.name] = p.initial;
      }
    }
    paramValues = newValues;
    currentParams = data;
    renderParamPanel(data);
  } catch {
    // silently ignore detection errors
  }
}

function hideParamPanel() {
  document.getElementById('param-panel').classList.add('hidden');
  currentParams = null;
}

function triggerParamDetection() {
  if (paramDetectTimer) clearTimeout(paramDetectTimer);
  paramDetectTimer = setTimeout(detectParams, 600);
}

// Listen for editor changes
editor.on('change', triggerParamDetection);

// ── 参数面板渲染 ─────────────────────────────────────────────────────────

function renderParamPanel(data) {
  const panel = document.getElementById('param-panel');
  const list = document.getElementById('param-list');
  panel.classList.remove('hidden');

  // Group params
  const groups = {};
  for (const p of data.parameters) {
    const g = p.group || 'Parameters';
    if (!groups[g]) groups[g] = [];
    groups[g].push(p);
  }

  list.innerHTML = '';
  for (const [groupName, params] of Object.entries(groups)) {
    const groupDiv = document.createElement('div');
    groupDiv.className = 'param-group';

    const header = document.createElement('div');
    header.className = 'param-group-header';
    header.innerHTML = `<span class="arrow">▼</span> ${escapeHTML(groupName)}`;
    header.onclick = () => groupDiv.classList.toggle('collapsed');
    groupDiv.appendChild(header);

    for (const p of params) {
      groupDiv.appendChild(createParamRow(p));
    }
    list.appendChild(groupDiv);
  }
}

function setParamValue(name, value) {
  paramValues[name] = value;
  updateParamRowUI(name, value);
}

function updateParamRowUI(name, value) {
  const row = document.getElementById(`param-row-${name}`);
  if (!row) return;
  const param = currentParams?.parameters?.find(p => p.name === name);
  if (!param) return;

  // Update modified state
  const isModified = JSON.stringify(value) !== JSON.stringify(param.initial);
  row.classList.toggle('modified', isModified);

  // Update value display
  const display = row.querySelector('.param-value-display');
  if (display) {
    if (Array.isArray(value)) display.textContent = `[${value.map(v => parseFloat(v.toFixed(4))).join(', ')}]`;
    else if (typeof value === 'number') display.textContent = parseFloat(value.toFixed(4));
    else display.textContent = String(value);
  }

  // Update controls
  const checkbox = row.querySelector('input[type="checkbox"]');
  if (checkbox) checkbox.checked = value;

  const numberInput = row.querySelector('input[type="number"]');
  if (numberInput && !Array.isArray(value)) numberInput.value = value;

  const rangeInput = row.querySelector('input[type="range"]');
  if (rangeInput && !Array.isArray(value)) rangeInput.value = value;

  const textInput = row.querySelector('input[type="text"]');
  if (textInput) textInput.value = value;

  const select = row.querySelector('select');
  if (select) select.value = String(value);

  // Vector sub-inputs
  if (Array.isArray(value)) {
    const vecInputs = row.querySelectorAll('.param-vector input');
    vecInputs.forEach((inp, i) => { if (i < value.length) inp.value = value[i]; });
  }
}

function createParamRow(param) {
  const row = document.createElement('div');
  row.className = 'param-row';
  row.id = `param-row-${param.name}`;

  const currentVal = paramValues[param.name] ?? param.initial;

  // Label
  const label = document.createElement('label');
  label.textContent = param.name;
  label.title = param.name;
  row.appendChild(label);

  // Description
  if (param.caption) {
    const desc = document.createElement('span');
    desc.className = 'param-desc';
    desc.textContent = param.caption;
    desc.title = param.caption;
    row.appendChild(desc);
  }

  // Input by type
  if (param.type === 'boolean') {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = currentVal;
    cb.onchange = () => setParamValue(param.name, cb.checked);
    row.appendChild(cb);
  } else if ('options' in param && param.options) {
    // Enum → dropdown
    const sel = document.createElement('select');
    for (const opt of param.options) {
      const o = document.createElement('option');
      o.value = String(opt.value);
      o.textContent = opt.name;
      if (String(opt.value) === String(currentVal)) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => setParamValue(param.name, isNaN(Number(sel.value)) ? sel.value : Number(sel.value));
    row.appendChild(sel);
  } else if (Array.isArray(param.initial)) {
    // Vector
    const container = document.createElement('span');
    container.className = 'param-vector';
    for (let i = 0; i < param.initial.length; i++) {
      const inp = document.createElement('input');
      inp.type = 'number';
      if (param.min !== undefined) { inp.min = param.min; inp.max = param.max; }
      if (param.step !== undefined) inp.step = param.step;
      inp.value = currentVal[i] ?? param.initial[i];
      inp.onchange = () => {
        const vals = [...(paramValues[param.name] || param.initial)];
        vals[i] = Number(inp.value);
        setParamValue(param.name, vals);
      };
      container.appendChild(inp);
    }
    row.appendChild(container);
  } else if (param.type === 'number') {
    // Number → range + number input
    const rng = document.createElement('input');
    rng.type = 'range';
    if (param.min !== undefined) rng.min = param.min;
    if (param.max !== undefined) rng.max = param.max;
    if (param.step !== undefined) { rng.step = param.step; } else { rng.step = (param.max - param.min) / 100 || 1; }
    rng.value = currentVal;
    rng.oninput = () => {
      setParamValue(param.name, Number(rng.value));
    };
    row.appendChild(rng);

    const num = document.createElement('input');
    num.type = 'number';
    if (param.min !== undefined) num.min = param.min;
    if (param.max !== undefined) num.max = param.max;
    if (param.step !== undefined) num.step = param.step;
    num.value = currentVal;
    num.onchange = () => {
      setParamValue(param.name, Number(num.value));
    };
    row.appendChild(num);
  } else if (param.type === 'string') {
    const txt = document.createElement('input');
    txt.type = 'text';
    txt.value = currentVal;
    txt.onchange = () => setParamValue(param.name, txt.value);
    row.appendChild(txt);
  }

  // Value display
  const valDisplay = document.createElement('span');
  valDisplay.className = 'param-value-display';
  if (Array.isArray(currentVal)) {
    valDisplay.textContent = `[${currentVal.map(v => parseFloat(v.toFixed(4))).join(', ')}]`;
  } else if (typeof currentVal === 'number') {
    valDisplay.textContent = parseFloat(currentVal.toFixed(4));
  } else {
    valDisplay.textContent = currentVal;
  }
  row.appendChild(valDisplay);

  // Reset button
  const resetBtn = document.createElement('button');
  resetBtn.className = 'btn-reset-param';
  resetBtn.textContent = '↺';
  resetBtn.title = '重置为默认值';
  resetBtn.onclick = (e) => { e.stopPropagation(); setParamValue(param.name, param.initial); };
  row.appendChild(resetBtn);

  return row;
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── 服务端通信 ────────────────────────────────────────────────────────────

async function sendToServer(endpoint, format = null, extraParams = null) {
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

  // Build URL with -D parameters
  const urlParams = new URLSearchParams();
  if ((endpoint === 'export' || endpoint === 'render') && format) urlParams.set('format', format);
  if (endpoint === 'preview') urlParams.set('mode', 'render');
  if (extraParams) for (const [k, v] of extraParams) urlParams.append(k, v);

  // Append modified parameter values as -D flags
  if (currentParams && paramValues) {
    for (const param of currentParams.parameters) {
      const val = paramValues[param.name];
      if (val === undefined || JSON.stringify(val) === JSON.stringify(param.initial)) continue;
      // Format value for SCAD
      let formatted;
      if (typeof val === 'string') formatted = `${param.name}="${val}"`;
      else if (Array.isArray(val)) formatted = `${param.name}=[${val.join(', ')}]`;
      else formatted = `${param.name}=${val}`;
      urlParams.append('D', formatted);
    }
  }

  let url = `${API}/${endpoint}`;
  const qs = urlParams.toString();
  if (qs) url += `?${qs}`;

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
// 首选 binmesh（体积小/零解析/含每面颜色），失败自动回退 STL
async function render3D() {
  try {
    try {
      const data = await sendToServer('render', 'binmesh');
      if (loadBinaryMesh(data)) return;
    } catch { /* binmesh 不可用（老服务端/格式异常），回退 STL */ }

    const stlData = await sendToServer('render', 'stl');
    loadSTL(stlData);
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
    // 3MF 导出携带耗材配置（?F=Name|serialize，服务端转 -O export-3mf/filament-colors）
    let extra = null;
    if (format === '3mf' && filamentConfig && filamentConfig.length) {
      extra = filamentConfig.map(cfg => ['F', `${cfg.name}|${serializeFilament(cfg)}`]);
    }
    const data = await sendToServer('export', format, extra);

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

  customizer: `// 参数化示例 — 支持 Customizer 参数面板
/* [尺寸] */
// 盒体宽度
box_width = 30;   // [20:5:60]
// 盒体深度
box_depth = 20;   // [15:5:40]
// 盒体高度
box_height = 15;  // [10:5:40]
// 壁厚
wall = 2;         // [1:0.5:5]

/* [孔洞] */
// 螺丝孔径
hole_d = 3.5;     // [2, 2.5, 3, 3.5, 4, 5]
// 显示孔洞
show_holes = true;

/* [材质] */
// 材质类型
material = "PLA"; // ["PLA", "ABS", "PETG", "TPU"]

/* [Hidden] */
$fn = 60;

module rounded_box(w, d, h, r) {
  hull() {
    for (x = [-1, 1], y = [-1, 1])
      translate([x * (w/2 - r), y * (d/2 - r), 0])
        cylinder(h = h, r = r);
  }
}

difference() {
  rounded_box(box_width, box_depth, box_height, wall);
  translate([0, 0, wall])
    rounded_box(box_width - 2*wall, box_depth - 2*wall,
                box_height - wall + 1, wall/2);
  if (show_holes) {
    translate([box_width/2 - 3*wall, box_depth/2 - 3*wall, 0])
      cylinder(h = box_height, d = hole_d);
    translate([-box_width/2 + 3*wall, box_depth/2 - 3*wall, 0])
      cylinder(h = box_height, d = hole_d);
    translate([box_width/2 - 3*wall, -box_depth/2 + 3*wall, 0])
      cylinder(h = box_height, d = hole_d);
    translate([-box_width/2 + 3*wall, -box_depth/2 + 3*wall, 0])
      cylinder(h = box_height, d = hole_d);
  }
}`,

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
document.getElementById('btn-filament').addEventListener('click', openFilamentDialog);
document.getElementById('btn-reset-params').addEventListener('click', () => {
  if (!currentParams) return;
  for (const p of currentParams.parameters) {
    paramValues[p.name] = p.initial;
    updateParamRowUI(p.name, p.initial);
  }
});

document.getElementById('btn-close-png').addEventListener('click', () => {
  document.getElementById('png-overlay').classList.remove('show');
});

Object.entries(examples).forEach(([name, code]) => {
  const idMap = { basic: 'basic', gear: 'gear', text: 'text', csg: 'csg', customizer: 'customizer' };
  document.getElementById(`btn-example-${idMap[name]}`)?.addEventListener('click', () => {
    editor.setValue(code);
    clearError();
  });
});

// 花瓶示例：从服务端加载 demo-vase.scad（含 BOSL2，22 个参数）
document.getElementById('btn-example-vase')?.addEventListener('click', async () => {
  try {
    const res = await fetch('/demo-vase.scad');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const code = await res.text();
    editor.setValue(code);
    clearError();
    // editor.setValue 已触发 change 事件，参数检测由监听器自动执行
  } catch (err) {
    showError(`加载 demo-vase.scad 失败: ${err.message}`);
  }
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
