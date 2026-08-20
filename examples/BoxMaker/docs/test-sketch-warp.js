// warpPerspective 集成测试 (node, canvas stub)
// 验证: H 源坐标(原图像素) → 降采样缓冲坐标 的换算正确性
// 运行: node tmp/test-sketch-warp.js
const fs = require("fs");
const path = require("path");

// ---- canvas 2D stub ----
function installCanvasStub() {
  global.document = {
    createElement: function(tag) {
      if (tag !== "canvas") throw new Error("unexpected tag " + tag);
      const c = { width: 0, height: 0 };
      c.getContext = function() {
        return {
          // 源图数据由 getImageData 合成 (R=x 梯度, G=y 梯度)
          drawImage: function() {}, // 源内容由 getImageData 决定
          getImageData: function(x, y, w, h) {
            const data = new Uint8ClampedArray(w * h * 4);
            for (let i = 0; i < w * h; i++) {
              const bx = i % w, by = Math.floor(i / w);
              data[i * 4]     = Math.round(bx / w * 255); // R: 水平梯度
              data[i * 4 + 1] = Math.round(by / h * 255); // G: 垂直梯度
              data[i * 4 + 3] = 255;
            }
            return { data, width: w, height: h };
          },
          createImageData: function(w, h) {
            return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
          },
          putImageData: function(imgData) {
            c._out = imgData; // 记录输出
          }
        };
      };
      return c;
    }
  };
}

installCanvasStub();
const src = fs.readFileSync(path.join(__dirname, "../js/sketch.js"), "utf8");
eval(src); // 定义 computeHomography / warpPerspective

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ FAIL: " + msg); }
}
// putImageData 记录在 canvas._out
function px(out, x, y, w) { return out._out.data[(y * w + x) * 4]; }

console.log("== 1. 大图 (4000×3000, 降采样 0.6) 全图矫正: 采样坐标一致 ==");
// H: 原图 (0,0)-(4000,3000) → 输出 (0,0)-(400,300), 即 0.1 缩放
const H1 = computeHomography(
  [{x: 0, y: 0}, {x: 4000, y: 0}, {x: 4000, y: 3000}, {x: 0, y: 3000}],
  [{x: 0, y: 0}, {x: 400, y: 0}, {x: 400, y: 300}, {x: 0, y: 300}]
);
assert(H1 !== null, "H 可解");
const imgEl = {naturalWidth: 4000, naturalHeight: 3000};
const out1 = warpPerspective(imgEl, H1, 400, 300);
assert(out1 !== null, "warp 成功");

// 输出(100,50) → 原图(1000,500) → 缓冲(600,300) → R=63.75 G=42.5
assert(Math.abs(px(out1, 100, 50, 400) - 63.75) <= 1, `输出(100,50) R=${px(out1, 100, 50, 400)} ≈ 63.75 (缓冲 600/2400)`);
assert(Math.abs(px(out1, 100, 50, 400) - 106.25) > 5, "确认不是未换算的旧值 106.25 (直接以原图坐标索引缓冲)");
// 输出(0,0) → 缓冲(0,0) → R=0
assert(px(out1, 0, 0, 400) === 0, `输出(0,0) R=0`);
// 输出(399,299) → 原图(3990,2990) → 缓冲(2394,1794) → R≈254.4
assert(Math.abs(px(out1, 399, 299, 400) - 254.4) <= 1, `输出(399,299) R=${px(out1, 399, 299, 400)} ≈ 254.4`);

console.log("== 2. 框选子区域 (200,100)-(3800,2900): 输出边界即框选边界 ==");
// 用户框选纸张区域, 输出应只含该区域: 输出左上角 = 原图(200,100)
const H2 = computeHomography(
  [{x: 200, y: 100}, {x: 3800, y: 100}, {x: 3800, y: 2900}, {x: 200, y: 2900}],
  [{x: 0, y: 0}, {x: 400, y: 0}, {x: 400, y: 280}, {x: 0, y: 280}]
);
assert(H2 !== null, "H2 可解");
const out2 = warpPerspective(imgEl, H2, 400, 280);
// 输出(0,0) → 原图(200,100) → 缓冲(120,60) → R=120/2400*255=12.75, G=60/1800*255=8.5
assert(Math.abs(px(out2, 0, 0, 400) - 12.75) <= 1, `子区域输出(0,0) R=${px(out2, 0, 0, 400)} ≈ 12.75 (缓冲 120/2400)`);
assert(Math.abs(px(out2, 0, 0, 400) - 21.25) > 5, "确认不是未换算的旧值 21.25 (原图坐标直接索引)");

console.log("== 3. 目标区域超出原图 → 透明 ==");
// H 把输出映射到原图 (0,0)-(5000,3000): x 超出 4000 的部分应透明
const H3 = computeHomography(
  [{x: 0, y: 0}, {x: 5000, y: 0}, {x: 5000, y: 3000}, {x: 0, y: 3000}],
  [{x: 0, y: 0}, {x: 400, y: 0}, {x: 400, y: 300}, {x: 0, y: 300}]
);
const out3 = warpPerspective(imgEl, H3, 400, 300);
assert(out3._out.data[(150 * 400 + 399) * 4 + 3] === 0, "输出(399,150) 透明 (原图 x>4000)");
assert(out3._out.data[(150 * 400 + 200) * 4 + 3] === 255, "输出(200,150) 不透明 (原图 x=2500 在图内)");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
