// BoxMaker 用户图形库管理回归测试 (node，无 Fabric/浏览器)。
// 运行: node docs/test-library-management.js
const fs = require("fs");
const path = require("path");

const appSrc = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");

function extractFn(source, name) {
  const start = source.indexOf("function " + name + "(");
  if (start < 0) throw new Error("未找到函数: " + name);
  const brace = source.indexOf("{", start);
  let depth = 0, quote = null;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "{") depth++;
    if (ch === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error("函数未闭合: " + name);
}

let pass = 0, fail = 0;
function assert(condition, message) {
  if (condition) { pass++; console.log("  ✓ " + message); }
  else { fail++; console.log("  ✗ FAIL: " + message); }
}

function classList() {
  const names = new Set();
  return {
    toggle: function(name, enabled) { if (enabled) names.add(name); else names.delete(name); },
    contains: function(name) { return names.has(name); }
  };
}

function element(tagName) {
  let html = "";
  return {
    tagName: (tagName || "div").toUpperCase(),
    children: [],
    classList: classList(),
    attributes: {},
    textContent: "",
    title: "",
    className: "",
    type: "",
    onclick: null,
    appendChild: function(child) { this.children.push(child); return child; },
    setAttribute: function(name, value) { this.attributes[name] = String(value); },
    getAttribute: function(name) { return this.attributes[name]; },
    set innerHTML(value) { html = value; this.children = []; },
    get innerHTML() { return html; }
  };
}

const nodes = {
  "lib-items": element("div"),
  "btn-lib-manage": element("button"),
  "status-text": element("span")
};
var document = {
  getElementById: function(id) { return nodes[id] || null; },
  createElement: function(tagName) { return element(tagName); }
};
function $(id) { return document.getElementById(id); }

let storage = "[]";
let failWrite = false;
let failRead = false;
var localStorage = {
  getItem: function() {
    if (failRead) throw new Error("read blocked");
    return storage;
  },
  setItem: function(key, value) {
    if (failWrite) throw new Error("write blocked");
    storage = value;
  },
  removeItem: function() { storage = null; }
};

var S = {libraryManageMode: false};
var Controller = {
  activeTool: "select",
  activeLibraryTemplate: null,
  setToolCalls: [],
  libraryCalls: [],
  setTool: function(tool) {
    this.activeTool = tool;
    this.activeLibraryTemplate = null;
    this.setToolCalls.push(tool);
  },
  setLibraryTool: function(template, button) {
    this.activeTool = "library";
    this.activeLibraryTemplate = template;
    this.libraryCalls.push({template: template, button: button});
  }
};

eval(extractFn(appSrc, "setLibraryStatus"));
eval(extractFn(appSrc, "getUserLibrary"));
eval(extractFn(appSrc, "writeUserLibrary"));
eval(extractFn(appSrc, "renderLib"));
eval(extractFn(appSrc, "setLibraryManageMode"));
eval(extractFn(appSrc, "deleteFromLib"));

function reset(items) {
  storage = JSON.stringify(items || []);
  failWrite = false;
  failRead = false;
  S.libraryManageMode = false;
  Controller.activeTool = "select";
  Controller.activeLibraryTemplate = null;
  Controller.setToolCalls = [];
  Controller.libraryCalls = [];
  nodes["status-text"].textContent = "";
  renderLib();
}

const items = [
  {name: "rect", type: "rect", points: [{x: 0, y: 0}]},
  {name: "circle", type: "circle", points: [{x: 1, y: 1}]}
];

console.log("== 管理模式渲染 ==");
reset(items);
assert(nodes["lib-items"].children.length === 2, "普通模式按模板渲染两个放置按钮");
assert(nodes["lib-items"].children.every(function(node) { return node.tagName === "BUTTON"; }), "普通模式不渲染行包装或删除按钮");
assert(nodes["btn-lib-manage"].textContent === "管理" && nodes["btn-lib-manage"].getAttribute("aria-pressed") === "false", "普通模式同步管理按钮无障碍状态");

setLibraryManageMode(true);
const rows = nodes["lib-items"].children;
assert(rows.length === 2 && rows.every(function(row) { return row.className === "lib-row" && row.children.length === 2; }), "管理模式每个模板有一行和一个删除标志");
assert(rows.every(function(row) { return row.children[0].tagName === "BUTTON" && row.children[0].className === "lib-item" && row.children[1].tagName === "BUTTON" && row.children[1].className === "lib-delete"; }), "放置和删除控件为同级按钮，不嵌套交互元素");
assert(nodes["btn-lib-manage"].textContent === "完成" && nodes["btn-lib-manage"].getAttribute("aria-pressed") === "true", "管理模式同步完成文案和无障碍状态");

console.log("== 删除与活动工具失效 ==");
rows[0].children[0].onclick();
assert(Controller.activeTool === "library", "管理模式中模板按钮仍可进入图库放置工具");
let prevented = false, stopped = false;
rows[0].children[1].onclick({preventDefault: function() { prevented = true; }, stopPropagation: function() { stopped = true; }});
const saved = JSON.parse(storage);
assert(prevented && stopped, "删除点击阻止默认行为和传播");
assert(saved.length === 1 && saved[0].name === "circle", "删除只持久化移除对应模板并保留其他条目");
assert(Controller.activeTool === "select" && Controller.setToolCalls.includes("select"), "删除活动模板后清除图库工具，不能继续放置旧模板");
assert(nodes["lib-items"].children.length === 1 && nodes["status-text"].textContent === "已从用户图形库删除", "删除成功后刷新列表并显示状态");

setLibraryManageMode(false);
assert(nodes["lib-items"].children.length === 1 && nodes["lib-items"].children[0].tagName === "BUTTON", "退出管理模式后删除标志消失并恢复普通按钮");

console.log("== 存储失败 ==");
reset(items);
setLibraryManageMode(true);
const before = nodes["lib-items"].children;
Controller.activeTool = "library";
failWrite = true;
assert(deleteFromLib(0) === false, "存储写入失败时删除操作返回失败");
assert(JSON.parse(storage).length === 2, "写入失败不丢失已存模板");
assert(nodes["lib-items"].children === before && Controller.activeTool === "library", "写入失败不刷新界面或改变当前图库工具");
assert(nodes["status-text"].textContent === "无法保存用户图形库", "写入失败显示状态提示");

console.log("== 受限或损坏存储 ==");
failWrite = false;
failRead = true;
assert(getUserLibrary().length === 0 && nodes["status-text"].textContent === "无法读取用户图形库", "读取受限时安全返回空图库并显示提示");
failRead = false;
storage = "{";
assert(getUserLibrary().length === 0 && storage === null && nodes["status-text"].textContent === "用户图形库数据损坏，已重置", "损坏数据会安全重置图库");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
