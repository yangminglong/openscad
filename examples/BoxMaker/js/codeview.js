// ============================================================
// codeview.js — SCAD 代码窗口 (CodeMirror 5, 只读, 随模型生成)
// 浮动于预览窗下方 (同一右侧浮动列), 高度占剩余空间;
// 左侧拉手拖拽调整整列宽度 (预览窗同步), 折叠后只显示标题栏
// ============================================================

var CodeView = {
  cm: null,
  _timer: null,

  init: function() {
    var ta = document.getElementById("scad-editor");
    if (!ta || typeof CodeMirror === "undefined") return;
    this.cm = CodeMirror.fromTextArea(ta, {
      mode: "text/x-csrc",   // SCAD 语法近似 C (与 ServerClient 一致)
      theme: "material-darker",
      lineNumbers: true,
      matchBrackets: true,
      readOnly: true,
      tabSize: 2,
      indentUnit: 2
    });
    this.bindResizer();
    this.bindCollapse();
    document.getElementById("cw-copy").addEventListener("click", function() {
      CodeView.copyToClipboard();
    });
    this.refresh();
  },

  // 生成最新 SCAD 并刷新 (内容变化时才 setValue, 避免丢失滚动位置)
  refresh: function() {
    if (!this.cm || typeof generateSCAD !== "function") return;
    var scad = generateSCAD();
    if (this.cm.getValue() !== scad) this.cm.setValue(scad);
  },

  // 防抖刷新 (图形/参数高频变更时)
  scheduleCodeRefresh: function() {
    var self = this;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(function() { self.refresh(); }, 200);
  },

  copyToClipboard: function() {
    if (!this.cm) return;
    var text = this.cm.getValue();
    var done = function() {
      var el = document.getElementById("status-text");
      if (el) el.textContent = "SCAD 已复制到剪贴板";
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
    } else {
      // 旧浏览器回退
      this.cm.focus();
      this.cm.execCommand("selectAll");
      document.execCommand("copy");
      done();
    }
  },

  // 折叠/展开: 折叠后只显示标题栏
  bindCollapse: function() {
    var win = document.getElementById("code-window");
    var btn = document.getElementById("cw-collapse");
    if (!win || !btn) return;
    btn.addEventListener("click", function() {
      var collapsed = win.classList.toggle("collapsed");
      btn.textContent = collapsed ? "▼" : "▲";
    });
  },

  // 左侧拉手: 调整右侧浮动列宽度 (预览窗同步, 拖左变宽/拖右变窄)
  bindResizer: function() {
    var rz = document.getElementById("cw-resizer");
    var col = document.getElementById("right-float-col");
    if (!rz || !col) return;
    var self = this;
    rz.addEventListener("mousedown", function(e) {
      e.preventDefault();
      e.stopPropagation();
      var startX = e.clientX, startW = col.offsetWidth;
      function onMove(ev) {
        var w = Math.max(200, Math.min(560, startW + (startX - ev.clientX)));
        col.style.width = w + "px";
        if (window.Preview3D && Preview3D.inited) Preview3D.fitCanvas();
        self.cm.refresh();
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }
};
