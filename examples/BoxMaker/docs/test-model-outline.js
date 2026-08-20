// Model.getOutlinePoints / pointInPolygon 单测 (node, 无 DOM)
// 运行: node tmp/test-model-outline.js
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "../js/model.js"), "utf8");
eval(src); // 定义 Model

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ FAIL: " + msg); }
}
function approx(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-9); }

console.log("== 1. rect 展开 4 角点 (无旋转) ==");
Model.shapes = [{id: "r1", type: "rect", rect: {x: 100, y: 50, w: 40, h: 20, angle: 0, radius: 0}, points: []}];
const r0 = Model.getOutlinePoints(Model.shapes[0]);
assert(r0.length === 4, "4 个角点");
assert(approx(r0[0].x, 80) && approx(r0[0].y, 40), `角点0 (80,40) 实际 (${r0[0].x},${r0[0].y})`);
assert(approx(r0[2].x, 120) && approx(r0[2].y, 60), `角点2 (120,60) 实际 (${r0[2].x},${r0[2].y})`);

console.log("== 2. rect 旋转 90° ==");
Model.shapes[0].rect.angle = 90;
const r90 = Model.getOutlinePoints(Model.shapes[0]);
// (x,y) 绕 (100,50) 转 90°: (dx,dy)→(-dy,dx); 角点0 局部(-20,-10) → (10,-20) → (110,30)
assert(approx(r90[0].x, 110) && approx(r90[0].y, 30), `角点0 (110,30) 实际 (${r90[0].x.toFixed(2)},${r90[0].y.toFixed(2)})`);
assert(approx(r90[2].x, 90) && approx(r90[2].y, 70), `角点2 (90,70) 实际 (${r90[2].x.toFixed(2)},${r90[2].y.toFixed(2)})`);

console.log("== 3. circle 展开 32 边形 ==");
Model.shapes = [{id: "c1", type: "circle", points: [{x: 50, y: 60}, {x: 60, y: 60}]}]; // r=10
const cpts = Model.getOutlinePoints(Model.shapes[0]);
assert(cpts.length === 32, "32 个点");
assert(cpts.every(p => approx(Math.hypot(p.x - 50, p.y - 60), 10, 1e-6)), "所有点距圆心 = 半径 10");

console.log("== 4. pointInPolygon 支持 rect/circle ==");
Model.shapes[0].rect = {x: 100, y: 50, w: 40, h: 20, angle: 0, radius: 0}; // 重置 rect
const rectS = {id: "r2", type: "rect", rect: {x: 100, y: 50, w: 40, h: 20, angle: 0, radius: 0}, points: []};
const cirS = {id: "c2", type: "circle", points: [{x: 50, y: 60}, {x: 60, y: 60}]};
assert(Model.pointInPolygon(rectS, 100, 50) === true, "rect 中心在内");
assert(Model.pointInPolygon(rectS, 150, 50) === false, "rect 外点不在内");
assert(Model.pointInPolygon(cirS, 50, 60) === true, "circle 圆心在内");
assert(Model.pointInPolygon(cirS, 70, 60) === false, "circle 外点不在内");

console.log("== 5. containmentDepth 支持 rect 包含 circle ==");
Model.shapes = [
  {id: "out", type: "rect", rect: {x: 50, y: 50, w: 100, h: 100, angle: 0, radius: 0}, points: []},
  {id: "in", type: "circle", points: [{x: 50, y: 50}, {x: 60, y: 50}]}
];
assert(Model.containmentDepth(Model.shapes[1]) === 1, "圆在矩形内 → depth 1 (孔)");
assert(Model.polygonContains(Model.shapes[0], Model.shapes[1]) === true, "polygonContains(rect, circle) = true");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
