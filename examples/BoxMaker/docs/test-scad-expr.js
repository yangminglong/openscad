// SCAD 表达式辅助函数回归测试 (node)
// 从 app.js 提取 SCAD 表达式辅助函数实际源码执行, 防回归:
//   - 负偏置必须包装 offset(r=-x) (内偏置被静默丢弃的 bug)
//   - BOSL2 include 必须位于生成 SCAD 首行
//   - 矩形/正多边形必须保留参数化 zrot 表达式
//   - 普通多边形必须使用最终绝对坐标, 不得重复 XY 平移
// 运行: node docs/test-scad-expr.js
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");

function extractFn(name) {
  const m = src.match(new RegExp("function " + name + "\\([^)]*\\) \\{[\\s\\S]*?\\n\\}"));
  if (!m) throw new Error("未找到函数: " + name);
  return m[0];
}

// 构造最小环境
var S = {outlineMode: "wall", offsetDir: "inner", defaultWall: 2, h: 50, bottom: 2, divRatio: 0.9, floorType: "none"};
var Model = {
  shapes: [],
  getBounds: function(s) {
    var xs = s.points.map(function(p) { return p.x; }), ys = s.points.map(function(p) { return p.y; });
    return {minX: Math.min.apply(null, xs), minY: Math.min.apply(null, ys), maxX: Math.max.apply(null, xs), maxY: Math.max.apply(null, ys)};
  },
  containmentDepth: function() { return 0; },
  polygonContains: function() { return false; },
  getOutlinePoints: function(s) { return s.points; }
};
eval(extractFn("shapeCenter"));
eval(extractFn("shapeExpr"));
eval(extractFn("extrudeExpr"));
eval(extractFn("offsetExpr"));
eval(extractFn("shapeOutset"));
eval(extractFn("exportShapes"));
eval(extractFn("generateWallsBody"));
eval(extractFn("generatePlateBody"));
eval(extractFn("generateSCAD"));

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ FAIL: " + msg); }
}
function count(text, fragment) {
  return text.split(fragment).length - 1;
}

console.log("== offsetExpr ==");
assert(offsetExpr("X", -2) === "offset(r=-2.0)X", `负偏置包装: ${offsetExpr("X", -2)}`);
assert(offsetExpr("X", -1) === "offset(r=-1.0)X", "内偏置 -1 包装 (两侧偏置的 -t/2)");
assert(offsetExpr("X", 0) === "X", "0 不包装");
assert(offsetExpr("X", 1) === "offset(r=1.0)X", "正偏置包装");

console.log("== shapeOutset (墙模式有效外轮廓外扩) ==");
S.offsetDir = "outer";
assert(shapeOutset({wall: 3}) === 3, "outer → 壁厚 3");
S.offsetDir = "both";
assert(shapeOutset({wall: 3}) === 1.5, "both → 壁厚/2 = 1.5");
S.offsetDir = "inner";
assert(shapeOutset({wall: 3}) === 0, "inner → 0");
S.outlineMode = "original";
assert(shapeOutset({wall: 3}) === 0, "原始模式 → 0");

console.log("== 参数化图形 SCAD 表达式 ==");
var roundedRect = {type: "rect", rect: {x: 20, y: 15, w: 40, h: 30, radius: 5, angle: 30}, points: []};
var squareRect = {type: "rect", rect: {x: 20, y: 15, w: 40, h: 30, radius: 0, angle: 0}, points: []};
var roundedExpr = shapeExpr(roundedRect);
assert(roundedExpr === "translate([20.0, 15.0])zrot(30.0)rect([40.0, 30.0], rounding=5.0)", "圆角矩形使用 translate + BOSL2 zrot + rect");
assert(shapeExpr(squareRect) === "translate([20.0, 15.0])zrot(0.0)rect([40.0, 30.0])", "直角矩形使用 centered BOSL2 rect");
assert(roundedExpr.indexOf("rotate([0,0,") === -1 && roundedExpr.indexOf("offset(") === -1 && roundedExpr.indexOf("square(") === -1, "矩形不再用原生 rotate 或 offset+square");

var regularPoly = {type: "polygon", points: [], poly: {x: 20, y: 15, radius: 10, sides: 6, angle: 30}};
assert(shapeCenter(regularPoly).x === 20 && shapeCenter(regularPoly).y === 15, "正多边形中心使用参数中心而非顶点包围盒");
assert(shapeExpr(regularPoly) === "translate([20.0, 15.0])zrot(120.0)circle(d=20.0, $fn=6)", "正多边形使用 circle($fn) 和 Canvas +90° 顶点相位");
regularPoly.poly.angle = 0;
assert(shapeExpr(regularPoly).indexOf("zrot(90.0)circle(d=20.0, $fn=6)") !== -1, "angle=0 时首顶点保持 Canvas 的 +Y 方向");

var freehand = {type: "polygon", points: [{x: 1, y: 2}, {x: 11, y: 2}, {x: 1, y: 12}]};
var freehandExpr = shapeExpr(freehand);
assert(freehandExpr === "polygon(points=[[1.0, 2.0],[11.0, 2.0],[1.0, 12.0]])", "普通多边形直接使用最终绝对坐标");
assert(freehandExpr.indexOf("translate(") === -1 && freehandExpr.indexOf("zrot(") === -1, "普通多边形不附加 XY translate/zrot");

console.log("== 挤出位置 / SCAD preamble ==");
S.outlineMode = "wall";
S.offsetDir = "inner";
var wallExpr = generateWallsBody([freehand], 2, 10);
assert(wallExpr.indexOf("translate([0,0,2.0]) linear_extrude(10.0)") !== -1, "墙模式仅为挤出添加 Z 平移");
assert(wallExpr.indexOf("translate([1.0, 2.0,") === -1 && count(wallExpr, "translate([") === 1, "普通多边形在墙模式没有重复 XY 平移");
assert(wallExpr.indexOf(freehandExpr) !== -1, "墙模式保留普通多边形绝对坐标");

S.outlineMode = "original";
var originalExpr = generateWallsBody([freehand], 2, 10);
assert(originalExpr.indexOf("translate([0,0,2.0]) linear_extrude(10.0) " + freehandExpr) !== -1, "原始模式仅在 Z 轴定位普通多边形");

var previousShapes = Model.shapes;
S.outlineMode = "wall";
Model.shapes = [Object.assign({visible: true}, roundedRect)];
assert(generateSCAD().indexOf("include <BOSL2/std.scad>\n") === 0, "生成 SCAD 首行包含 BOSL2 std");
Model.shapes = previousShapes;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
