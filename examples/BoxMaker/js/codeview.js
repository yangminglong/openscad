// ============================================================
// codeview.js — 可编辑 SCAD 代码窗口 (CodeMirror 5)
// 图形/设置变更时重新生成代码并丢弃手写草稿；手写代码可显式预览/导出。
// ============================================================

var CodeView = {
  cm: null,
  _timer: null,
  _writingGenerated: false,
  _dirty: false,

  init: function() {
    var ta = document.getElementById("scad-editor");
    if (!ta || typeof CodeMirror === "undefined") return;
    this.cm = CodeMirror.fromTextArea(ta, {
      mode: "text/x-csrc",
      theme: "material-darker",
      lineNumbers: true,
      matchBrackets: true,
      tabSize: 2,
      indentUnit: 2,
      extraKeys: {
        "Ctrl-Enter": function() { CodeView.preview(); },
        "Cmd-Enter": function() { CodeView.preview(); }
      }
    });
    this.cm.on("change", function() {
      if (CodeView._writingGenerated) return;
      CodeView._dirty = true;
      CodeView.updateState();
    });
    this.bindResizer();
    this.bindCollapse();
    document.getElementById("cw-copy").addEventListener("click", function() {
      CodeView.copyToClipboard();
    });
    document.getElementById("cw-preview").addEventListener("click", function() {
      CodeView.preview();
    });
    this.setGeneratedSource(generateSCAD(), false);
  },

  getSource: function() {
    return this.cm ? this.cm.getValue() : "";
  },

  isDirty: function() {
    return this._dirty;
  },

  updateState: function() {
    var state = document.getElementById("cw-state");
    if (state) state.textContent = this._dirty ? "手写草稿" : "图形代码";
  },

  setGeneratedSource: function(scad, discardedDraft) {
    if (!this.cm) return;
    this._writingGenerated = true;
    if (this.cm.getValue() !== scad) this.cm.setValue(scad);
    this._writingGenerated = false;
    this._dirty = false;
    this.updateState();
    if (discardedDraft) {
      var status = document.getElementById("status-text");
      if (status) status.textContent = "图形已修改，已丢弃手写 SCAD 草稿";
    }
  },

  // 图形或设置改变时调用。只在确实存在手写草稿时提示覆盖。
  refresh: function() {
    if (!this.cm || typeof generateSCAD !== "function") return;
    this.setGeneratedSource(generateSCAD(), this._dirty);
  },

  scheduleCodeRefresh: function() {
    var self = this;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(function() { self.refresh(); }, 200);
  },

  preview: function() {
    if (typeof renderSTL !== "function") return;
    renderSTL(this.getSource(), {manual: true});
  },

  copyToClipboard: function() {
    if (!this.cm) return;
    var text = this.cm.getValue();
    var done = function() {
      var el = document.getElementById("status-text");
      if (el) el.textContent = "SCAD 已复制到剪贴板";
    };
    var failed = function() {
      var el = document.getElementById("status-text");
      if (el) el.textContent = "复制 SCAD 失败";
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, failed);
    } else {
      this.cm.focus();
      this.cm.execCommand("selectAll");
      if (document.execCommand("copy")) done(); else failed();
    }
  },

  bindCollapse: function() {
    var win = document.getElementById("code-window");
    var btn = document.getElementById("cw-collapse");
    if (!win || !btn) return;
    btn.addEventListener("click", function() {
      var collapsed = win.classList.toggle("collapsed");
      btn.textContent = collapsed ? "▼" : "▲";
    });
  },

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
        var w = Math.max(260, Math.min(620, startW + (startX - ev.clientX)));
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
