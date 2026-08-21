// Controller 输入行为回归测试 (node，无 Fabric/DOM)
// 覆盖: SCAD 编辑焦点的快捷键保护、非选择工具 Ctrl 临时选择、
// 重叠创建，以及选择模式的命中堆栈循环。
// 运行: node docs/test-controller-input.js
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "../js/controller.js"), "utf8");
eval(src); // 定义 Controller

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ FAIL: " + msg); }
}

console.log("== 可编辑文本焦点 ==");
var CodeView = {cm: {hasFocus: function() { return true; }}};
assert(Controller.isTextEditing({target: {tagName: "DIV"}}), "CodeMirror 聚焦时阻断全局快捷键");
CodeView.cm.hasFocus = function() { return false; };
assert(Controller.isTextEditing({target: {tagName: "TEXTAREA"}}), "textarea 阻断全局快捷键");
assert(Controller.isTextEditing({target: {tagName: "INPUT"}}), "input 阻断全局快捷键");
assert(Controller.isTextEditing({target: {tagName: "DIV", isContentEditable: true}}), "contenteditable 阻断全局快捷键");
assert(!Controller.isTextEditing({target: {tagName: "CANVAS"}}), "canvas 不阻断全局快捷键");

console.log("== 非选择工具点击分流 ==");
var calls = [];
var upperCanvas = {focus: function() { calls.push("focus"); }};
var activeObject = null;
Controller.canvas = {
  upperCanvasEl: upperCanvas,
  getPointer: function() { return {x: 15, y: 25}; },
  discardActiveObject: function() { calls.push("discard"); activeObject = null; },
  setActiveObject: function(obj) { calls.push("activate:" + obj.id); activeObject = obj; },
  getActiveObject: function() { return activeObject; },
  requestRenderAll: function() { calls.push("render"); }
};
var Scene = {canvasToBed: function(x, y) { return {x: x, y: y}; }};
var Sketch = {rectify: null, sketch: null};
var Model = {
  editId: null,
  selectedId: null,
  getEditing: function() { return null; },
  getShape: function(id) { return this.shapes.find(function(shape) { return shape.id === id; }) || null; },
  shapes: [{id: "existing", visible: true}],
  bringToFront: function(id) {
    var index = this.shapes.findIndex(function(shape) { return shape.id === id; });
    if (index < 0 || index === this.shapes.length - 1) return false;
    this.shapes.push(this.shapes.splice(index, 1)[0]);
    return true;
  },
  hitTest: function() { return this.hitTestAll()[0] || null; },
  hitTestAll: function() { return this.shapes.filter(function(shape) { return shape.visible !== false; }).slice().reverse(); }
};
var Renderer = {
  getFabric: function(id) { return {id: "fabric-" + id}; },
  moveShapeToTop: function(id) { calls.push("promote:" + id); }
};
var document = {activeElement: upperCanvas, querySelector: function() { return null; }};
function showProps(id) { calls.push("props:" + id); }
function renderObjectList() { calls.push("list"); }
function placeLibraryShape(template, x, y) { calls.push("library:" + template.name + ":" + x + ":" + y); }

Controller.activeTool = "rect";
Controller.createShape = function(type, x, y) { calls.push("create:" + type + ":" + x + ":" + y); };
Controller.onDown({e: {button: 0, ctrlKey: false}, target: {_shapeId: "existing"}});
assert(calls.indexOf("create:rect:15:25") !== -1, "矩形工具点击已有对象仍创建矩形");
assert(Controller.activeTool === "rect", "普通创建后保持矩形工具");

calls = [];
Controller.activeTool = "circle";
Controller.onDown({e: {button: 0, ctrlKey: true}, target: {_shapeId: "existing"}});
assert(Model.selectedId === "existing" && calls.indexOf("activate:fabric-existing") !== -1, "Ctrl 点击已有对象临时选择");
assert(calls.every(function(c) { return c.indexOf("create:") !== 0; }), "Ctrl 点击不创建图形");
assert(Controller.activeTool === "circle", "Ctrl 选择后保持原工具");

calls = [];
Controller.activeTool = "library";
Controller.activeLibraryTemplate = {name: "template"};
Controller.onDown({e: {button: 0, ctrlKey: false}, target: {_shapeId: "existing"}});
assert(calls.indexOf("library:template:15:25") !== -1, "图库工具点击已有对象仍放置模板");

console.log("== 选择命中堆栈 / Tab 循环 ==");
Model.shapes = [{id: "bottom", visible: true}, {id: "top", visible: true}];
Model.selectedId = "top";
Controller.activeTool = "select";
Controller.clearHitStack();
Controller.onDown({e: {button: 0, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false}, target: {id: "fabric-top"}});
assert(Controller.hitStackIds.join(",") === "top,bottom", "选择点击记录顶层到低层的全部命中");
assert(calls.indexOf("focus") !== -1, "记录命中后聚焦 Canvas 以接收 Tab");
assert(Controller.cycleHitStack(false) && Model.selectedId === "bottom", "Tab 正向选择下一低层图形");
assert(Controller.cycleHitStack(false) && Model.selectedId === "top", "Tab 到底后循环回顶层");
assert(Controller.cycleHitStack(true) && Model.selectedId === "bottom", "Shift+Tab 反向循环");
assert(Controller.cycleHitStack(false) && Model.selectedId === "top", "提升改变实时层级后仍按首次命中顺序循环");
Model.shapes[0].visible = false;
assert(!Controller.cycleHitStack(false) && Controller.hitStackIds.length === 0, "隐藏/变化后的命中堆栈失效");

console.log("== 单选层级提升 ==");
Model.shapes = [{id: "bottom", visible: true}, {id: "top", visible: true}];
calls = [];
assert(Controller.selectShapeById("bottom", false), "可显式选择下层图形");
assert(Model.shapes[Model.shapes.length - 1].id === "bottom", "显式选择会提升模型层级");
assert(calls.indexOf("promote:bottom") !== -1, "显式选择会提升 Fabric 图形层级");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
