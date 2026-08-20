// ============================================================
// settings.js — 应用设置弹窗 (标题栏 ⚙设置)
// 配置项:
//   - 轮廓模式: 原始轮廓 / 墙
//   - 墙模式 · 轮廓偏置方向: 内偏置 / 外偏置 / 两侧偏置
//   - 默认壁厚 (墙模式图形的偏置距离初始值)
//   - 默认拉伸高度 (每个图形的拉伸高度初始值, 任意轮廓模式)
// 持久化: localStorage "boxmaker_settings"
// ============================================================

var SETTINGS_KEY = "boxmaker_settings";

var Settings = {
  pop: null,

  init: function() {
    this.pop = document.getElementById("settings-pop");
    if (!this.pop) return;
    this.bindToggle();
    this.bindMode();
    this.bindOffsetDir();
    this.bindDefaults();
    this.bindFloor();
    this.syncUI();
  },

  // 弹窗开关: ⚙设置切换; 点击外部/Esc 关闭
  bindToggle: function() {
    var self = this;
    document.getElementById("btn-settings").addEventListener("click", function(e) {
      e.stopPropagation();
      var show = self.pop.style.display !== "block";
      self.pop.style.display = show ? "block" : "none";
      if (show) self.syncUI();
    });
    document.addEventListener("click", function(e) {
      if (!self.pop.contains(e.target)) self.pop.style.display = "none";
    });
    document.addEventListener("keydown", function(e) {
      if (e.key === "Escape") self.pop.style.display = "none";
    });
  },

  // 轮廓模式 radio: 更新状态 + 持久化 + 代码/预览同步 + 属性面板字段刷新
  bindMode: function() {
    var self = this;
    this.pop.querySelectorAll('input[name="outline-mode"]').forEach(function(r) {
      r.addEventListener("change", function() {
        if (!this.checked) return;
        S.outlineMode = this.value;
        self.save();
        if (typeof CodeView !== "undefined") CodeView.refresh();
        if (S.autoPreview) schedulePreview();
        if (typeof showProps === "function") showProps(Model.selectedId); // 壁厚字段显隐
        var el = document.getElementById("status-text");
        if (el) el.textContent = (this.value === "wall") ? "墙模式: 图形生成偏置墙轮廓 (默认壁厚 " + S.defaultWall + "mm)" : "原始轮廓模式: 图形直接转轮廓";
      });
    });
  },

  // 轮廓偏置方向 radio (墙模式生效)
  bindOffsetDir: function() {
    var self = this;
    this.pop.querySelectorAll('input[name="offset-dir"]').forEach(function(r) {
      r.addEventListener("change", function() {
        if (!this.checked) return;
        S.offsetDir = this.value;
        self.save();
        if (typeof CodeView !== "undefined") CodeView.refresh();
        if (S.autoPreview) schedulePreview();
      });
    });
  },

  // 默认壁厚 / 默认拉伸高度: 更新状态 + Model.defaults (新建图形生效)
  bindDefaults: function() {
    var self = this;
    document.getElementById("sp-wall").addEventListener("input", function() {
      var v = parseFloat(this.value);
      if (isNaN(v) || v <= 0) return;
      S.defaultWall = v;
      Model.defaults.wall = v;
      self.save();
    });
    document.getElementById("sp-height").addEventListener("input", function() {
      var v = parseFloat(this.value);
      if (isNaN(v) || v <= 0) return;
      S.defaultHeight = v;
      Model.defaults.height = v;
      self.save();
    });
  },

  // 底板: 类型 / 厚度(S.bottom 与全局滑条同步) / 外边距
  bindFloor: function() {
    var self = this;
    this.pop.querySelectorAll('input[name="floor-type"]').forEach(function(r) {
      r.addEventListener("change", function() {
        if (!this.checked) return;
        S.floorType = this.value;
        self.save();
        if (typeof CodeView !== "undefined") CodeView.refresh();
        if (S.autoPreview) schedulePreview();
      });
    });
    document.getElementById("sp-floor-thick").addEventListener("input", function() {
      var v = parseFloat(this.value);
      if (isNaN(v) || v <= 0) return;
      S.bottom = v;
      var el = document.getElementById("p-bottom");
      if (el) el.value = v;
      var lb = document.getElementById("v-bottom");
      if (lb) lb.textContent = v.toFixed(1);
      if (typeof CodeView !== "undefined") CodeView.scheduleCodeRefresh();
      if (S.autoPreview) schedulePreview();
    });
    document.getElementById("sp-floor-margin").addEventListener("input", function() {
      var v = parseFloat(this.value);
      if (isNaN(v) || v < 0) return;
      S.floorMargin = v;
      self.save();
      if (typeof CodeView !== "undefined") CodeView.refresh();
      if (S.autoPreview) schedulePreview();
    });
  },

  // 弹窗控件与 S 状态对齐
  syncUI: function() {
    this.pop.querySelectorAll('input[name="outline-mode"]').forEach(function(r) {
      r.checked = (r.value === (S.outlineMode || "original"));
    });
    this.pop.querySelectorAll('input[name="offset-dir"]').forEach(function(r) {
      r.checked = (r.value === (S.offsetDir || "inner"));
    });
    this.pop.querySelectorAll('input[name="floor-type"]').forEach(function(r) {
      r.checked = (r.value === (S.floorType || "none"));
    });
    document.getElementById("sp-wall").value = S.defaultWall;
    document.getElementById("sp-height").value = S.defaultHeight;
    document.getElementById("sp-floor-thick").value = S.bottom;
    document.getElementById("sp-floor-margin").value = S.floorMargin;
  },

  save: function() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        outlineMode: S.outlineMode,
        offsetDir: S.offsetDir,
        defaultWall: S.defaultWall,
        defaultHeight: S.defaultHeight,
        floorType: S.floorType,
        floorMargin: S.floorMargin
      }));
    } catch (e) {}
  },

  // 返回完整配置对象 (非法值回退默认)
  load: function() {
    var cfg = {outlineMode: "original", offsetDir: "inner", defaultWall: 2, defaultHeight: 43.2,
               floorType: "none", floorMargin: 0};
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        var s = JSON.parse(raw);
        if (s.outlineMode === "wall" || s.outlineMode === "original") cfg.outlineMode = s.outlineMode;
        if (s.offsetDir === "inner" || s.offsetDir === "outer" || s.offsetDir === "both") cfg.offsetDir = s.offsetDir;
        if (typeof s.defaultWall === "number" && s.defaultWall > 0) cfg.defaultWall = s.defaultWall;
        if (typeof s.defaultHeight === "number" && s.defaultHeight > 0) cfg.defaultHeight = s.defaultHeight;
        if (s.floorType === "none" || s.floorType === "outline" || s.floorType === "bbox" || s.floorType === "hull") cfg.floorType = s.floorType;
        if (typeof s.floorMargin === "number" && s.floorMargin >= 0) cfg.floorMargin = s.floorMargin;
      }
    } catch (e) {}
    return cfg;
  }
};
