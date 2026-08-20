// SCAD 表达式辅助函数回归测试 (node)
// 从 app.js 提取 offsetExpr/shapeOutset 实际源码执行, 防回归:
//   - 负偏置必须包装 offset(r=-x) (内偏置被静默丢弃的 bug)
//   - 0 不包装; 正偏置包装; both 外扩 = 壁厚/2
// 运行: node tmp/test-scad-expr.js
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");

function extractFn(name) {
  const m = src.match(new RegExp("function " + name + "\\([^)]*\\) \\{[\\s\\S]*?\\n\\}"));
  if (!m) throw new Error("未找到函数: " + name);
  return m[0];
}

// 构造最小环境
var S = {outlineMode: "wall", offsetDir: "inner", defaultWall: 2};
eval(extractFn("offsetExpr"));
eval(extractFn("shapeOutset"));

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ FAIL: " + msg); }
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
