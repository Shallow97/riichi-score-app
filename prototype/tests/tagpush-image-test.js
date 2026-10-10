/**
 * tagpush-image-test.js — 场风盘画面处理链单测（无浏览器、无蓝牙）
 *
 * 校验 prototype/js/tagpush.js 的 processCanvasImage：
 *   对比度 1.2 → Floyd-Steinberg 抖动（强度 1.0）→ 三色双平面量化
 * 参数口径按用户定稿：4.2寸 400×300 三色、Floyd-Steinberg、强度 1.0（档位 10）、对比度 1.2。
 *
 * 跑法：cd prototype/tests && node tagpush-image-test.js
 */
const path = require('path');
const assert = require('assert');

// tagpush.js 是浏览器脚本：造最小 window/navigator 便于 require
global.window = {};
global.navigator = {};
global.location = { protocol: 'http:', host: '127.0.0.1:8765' };
global.document = { hidden: false, addEventListener() {} };
require(path.join(__dirname, '..', 'js', 'tagpush.js'));

const TagPush = global.window.TagPush;
const W = 400, H = 300;

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

/** 造一张 400×300 假画布数据：白底 + 黑块 + 红块 + 50% 灰块 */
function makeImage() {
  const data = new Uint8ClampedArray(W * H * 4);
  const fill = (x0, y0, x1, y1, r, g, b) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  };
  fill(0, 0, W, H, 255, 255, 255);       // 白底
  fill(20, 20, 120, 120, 0, 0, 0);        // 黑块
  fill(160, 20, 260, 120, 255, 0, 0);     // 红块
  fill(20, 180, 380, 260, 128, 128, 128); // 50% 灰块（抖动用）
  return { width: W, height: H, data: data };
}

/** 取 1bpp 平面某像素的位（1 = 该平面置位） */
function bitAt(plane, x, y) {
  const byteWidth = Math.ceil(W / 8);
  return (plane[y * byteWidth + Math.floor(x / 8)] >> (7 - (x % 8))) & 1;
}

console.log('画面参数:', JSON.stringify(TagPush.params));
console.log('tagpush-image-test:');

const planes = TagPush.processCanvasImage(makeImage());
const byteWidth = Math.ceil(W / 8);
const expectLen = H * byteWidth;

ok('黑白面长度 = ' + expectLen, planes.bw.length === expectLen);
ok('红面长度 = ' + expectLen, planes.red.length === expectLen);

// 白底：黑白面 1（白）、红面 1（非红）
ok('白底 → 黑白面=1', bitAt(planes.bw, 300, 150) === 1);
ok('白底 → 红面=1', bitAt(planes.red, 300, 150) === 1);

// 黑块：黑白面 0（黑）、红面 1（非红）
ok('黑块 → 黑白面=0', bitAt(planes.bw, 70, 70) === 0);
ok('黑块 → 红面=1', bitAt(planes.red, 70, 70) === 1);

// 红块：黑白面 0（红按灰度落黑）、红面 0（红）
ok('红块 → 黑白面=0', bitAt(planes.bw, 210, 70) === 0);
ok('红块 → 红面=0', bitAt(planes.red, 210, 70) === 0);

// 灰块：抖动后必须有黑有白（纯阈值量化会全落同一色）
let ones = 0, zeros = 0;
for (let y = 185; y < 255; y++) for (let x = 25; x < 375; x++) {
  if (bitAt(planes.bw, x, y)) ones++; else zeros++;
}
ok('50% 灰块被抖动成黑白混合（黑像素 ' + zeros + ' / 白像素 ' + ones + '）', ones > 0 && zeros > 0);
ok('灰块黑白比例接近 1:1', Math.abs(ones - zeros) / (ones + zeros) < 0.15);

// 对比度 1.2 会把 128 灰拉到 128（中点不动）；170 灰应被拉白
const d = new Uint8ClampedArray([170, 170, 170, 255, 128, 128, 128, 255, 80, 80, 80, 255]);
TagPush.applyContrast(d, 1.2);
ok('对比度 1.2：170 → 178', d[0] === 178);
ok('对比度 1.2：128 保持中点', d[4] === 128);
ok('对比度 1.2：80 → 70', d[8] === 70);

console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
