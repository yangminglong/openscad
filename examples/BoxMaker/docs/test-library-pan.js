// BoxMaker 图库模板平移与持久床面平移的纯逻辑回归测试。
const fs = require("fs");
const path = require("path");

const appSrc = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");
const sceneSrc = fs.readFileSync(path.join(__dirname, "../js/scene.js"), "utf8");

function extractFn(source, name) {
  const m = source.match(new RegExp("function " + name + "\\([^)]*\\) \\{[\\s\\S]*?\\n\\}"));
  if (!m) throw new Error("未找到函数: " + name);
  return m[0];
}

let pass = 0, fail = 0;
function assert(condition, message) {
  if (condition) { pass++; console.log("  ✓ " + message); }
  else { fail++; console.log("  ✗ FAIL: " + message); }
}

console.log("== 图库模板放置 ==");
eval(extractFn(appSrc, "cloneLibraryValue"));
eval(extractFn(appSrc, "templateCenter"));
const rounded = {
  type: "rect",
  points: [{x: 0, y: 0}, {x: 40, y: 30}],
  rect: {x: 20, y: 15, w: 40, h: 30, angle: 30, radius: 5},
  wall: 2.5,
  height: 42
};
const copy = cloneLibraryValue(rounded);
const center = templateCenter(copy);
assert(center.x === 20 && center.y === 15, "矩形模板中心取 rect 元数据");
copy.points[0].x = 999;
assert(rounded.points[0].x === 0, "模板深拷贝不会修改原图形");

console.log("== 持久床面平移 ==");
const scene = {};
const objectLiteral = sceneSrc.match(/var Scene = \{([\s\S]*?)\n\};/);
assert(!!objectLiteral, "找到 Scene 单例");
assert(/panX:\s*0/.test(objectLiteral[0]) && /panY:\s*0/.test(objectLiteral[0]), "Scene 保存 panX/panY");
assert(/\+ this\.panX/.test(sceneSrc) && /\+ this\.panY/.test(sceneSrc), "Scene.rebuild 将持久偏移加到居中位置");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
