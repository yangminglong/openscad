// 单应矩阵数学单测 (node, 无 DOM — sketch.js 顶层无 DOM 依赖)
// 运行: node tmp/test-sketch-math.js
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "../js/sketch.js"), "utf8");
eval(src); // 定义 solveLinear8 / invert3x3 / computeHomography / applyH

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ FAIL: " + msg); }
}
function approx(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-6); }

console.log("== 1. 梯形源角点 → 目标矩形: 角点精确映射 ==");
// 模拟斜拍照片中的纸张四边形 (原图像素, TL,TR,BR,BL)
const srcPts = [
  {x: 100, y: 80},
  {x: 1500, y: 120},
  {x: 1480, y: 1000},
  {x: 80, y: 980}
];
// 目标: A4 比例矩形 (210:297), 高 1600
const dstW = Math.round(1600 * 210 / 297); // 1131
const dstPts = [{x: 0, y: 0}, {x: dstW, y: 0}, {x: dstW, y: 1600}, {x: 0, y: 1600}];

const H = computeHomography(srcPts, dstPts);
assert(H !== null, "H 可解");
for (let i = 0; i < 4; i++) {
  const p = applyH(H, srcPts[i]);
  assert(approx(p.x, dstPts[i].x, 1e-6) && approx(p.y, dstPts[i].y, 1e-6),
    `角点 ${i}: (${p.x.toFixed(4)}, ${p.y.toFixed(4)}) → (${dstPts[i].x}, ${dstPts[i].y})`);
}

console.log("== 2. 逆矩阵: H · H⁻¹ = I ==");
const inv = invert3x3(H);
assert(inv !== null, "可逆");
const I = [0,0,0, 0,0,0, 0,0,0];
for (let i = 0; i < 3; i++)
  for (let j = 0; j < 3; j++)
    for (let k = 0; k < 3; k++)
      I[i*3+j] += H[i*3+k] * inv[k*3+j];
let idOk = true;
for (let i = 0; i < 9; i++) {
  const expect = (i % 4 === 0) ? 1 : 0;
  if (!approx(I[i], expect, 1e-9)) idOk = false;
}
assert(idOk, "H·H⁻¹ ≈ I");

console.log("== 3. 反向映射往返: 输出像素 → 源 → 输出 ==");
const mid = {x: dstW * 0.5, y: 1600 * 0.5};
const back = applyH(inv, mid); // 输出 → 源
const again = applyH(H, back); // 源 → 输出
assert(approx(again.x, mid.x, 1e-6) && approx(again.y, mid.y, 1e-6),
  `输出中点往返误差 ${Math.abs(again.x - mid.x).toExponential(2)}px`);

console.log("== 4. 参考线标定模拟 (A4 纸张上 210mm 纸宽特征) ==");
// 纸中高处的水平参考线: 左边缘→右边缘, 源图几何上恰为纸宽 1400px = 210mm
// (左边缘 TL(100,80)→BL(80,980) 在中高 540 处 x≈90; 右边缘同理 x≈1490)
const p1 = {x: 90, y: 540}, p2 = {x: 1490, y: 540};
const t1 = applyH(H, p1), t2 = applyH(H, p2);
const pxLen = Math.hypot(t2.x - t1.x, t2.y - t1.y);
const mmPerPx = 210 / pxLen; // 输入真实长度 210mm
const physW = dstW * mmPerPx, physH = 1600 * mmPerPx;
console.log(`  输出参考线长 ${pxLen.toFixed(1)}px → mm/px=${mmPerPx.toFixed(4)} → 反推物理尺寸 ${physW.toFixed(1)}×${physH.toFixed(1)}mm`);
assert(approx(physW, 210, 0.5) && approx(physH, 297, 0.5),
  "参考线反推物理尺寸 ≈ A4 210×297mm (误差 <0.5mm)");

console.log("== 5. 退化输入: 4 点共线 → 返回 null ==");
const collinear = [
  {x: 0, y: 0}, {x: 100, y: 100}, {x: 200, y: 200}, {x: 300, y: 300}
];
assert(computeHomography(collinear, dstPts) === null, "共线角点返回 null");

console.log("== 6. 正方形矫正 (非透视, 应近似恒等缩放) ==");
const square = [{x: 0, y: 0}, {x: 1000, y: 0}, {x: 1000, y: 1000}, {x: 0, y: 1000}];
const sqDst = [{x: 0, y: 0}, {x: 1000, y: 0}, {x: 1000, y: 1000}, {x: 0, y: 1000}];
const Hs = computeHomography(square, sqDst);
const pc = applyH(Hs, {x: 250, y: 750});
assert(approx(pc.x, 250, 1e-6) && approx(pc.y, 750, 1e-6), "正方形映射保持坐标不变");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
