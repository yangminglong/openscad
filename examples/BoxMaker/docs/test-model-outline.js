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

console.log("== 6. 正多边形参数与顶点同步 ==");
const hex = {
  id: "p1", type: "polygon",
  points: [
    {x: 50, y: 60}, {x: 41.34, y: 55}, {x: 41.34, y: 45},
    {x: 50, y: 40}, {x: 58.66, y: 45}, {x: 58.66, y: 55}
  ],
  poly: {x: 0, y: 0, radius: 0, sides: 6, angle: 0}
};
Model.syncRegularPolyMetadata(hex);
assert(approx(hex.poly.x, 50, 0.01) && approx(hex.poly.y, 50, 0.01), "正多边形同步中心");
assert(approx(hex.poly.radius, 10, 0.01), "正多边形同步半径");
assert(approx(hex.poly.angle, 0, 0.01), "首顶点在 +Y 时同步 angle=0");
hex.points = hex.points.map(function(p) { return {x: 100 - (p.y - 50), y: 200 + (p.x - 50)}; });
Model.syncRegularPolyMetadata(hex);
assert(approx(hex.poly.x, 100, 0.01) && approx(hex.poly.y, 200, 0.01), "旋转/平移后同步中心");
assert(approx(hex.poly.radius, 10, 0.01), "旋转后保持半径");
assert(approx(hex.poly.angle, 90, 0.01), "首顶点旋至 -X 时同步 angle=90");

console.log("== 7. 多层命中顺序 ==");
const overlapBottom = {id: "bottom", type: "rect", visible: true, rect: {x: 50, y: 50, w: 80, h: 80, angle: 0, radius: 0}, points: []};
const overlapHidden = {id: "hidden", type: "circle", visible: false, points: [{x: 50, y: 50}, {x: 70, y: 50}]};
const overlapTop = {id: "top", type: "polygon", visible: true, points: [{x: 30, y: 30}, {x: 70, y: 30}, {x: 50, y: 70}]};
Model.shapes = [overlapBottom, overlapHidden, overlapTop];
const hitIds = Model.hitTestAll(50, 50).map(function(s) { return s.id; });
assert(hitIds.join(",") === "top,bottom", "多层命中按顶层到低层返回，跳过隐藏图形");
assert(Model.hitTest(50, 50).id === "top", "hitTest 保持返回最上层图形");
assert(Model.hitTestAll(200, 200).length === 0, "空白点返回空命中列表");

console.log("== 8. 图层提升 ==");
const originalTopPoints = JSON.stringify(overlapTop.points);
assert(Model.bringToFront("bottom") === true, "可将下层图形提升到顶层");
assert(Model.shapes.map(function(s) { return s.id; }).join(",") === "hidden,top,bottom", "模型顺序更新为底层到顶层");
assert(Model.hitTestAll(50, 50)[0].id === "bottom", "提升后命中最上层为被选图形");
assert(JSON.stringify(overlapTop.points) === originalTopPoints, "提升不改变其他图形几何数据");
assert(Model.bringToFront("bottom") === false && Model.bringToFront("missing") === false, "顶层或不存在的图形不改变顺序");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
