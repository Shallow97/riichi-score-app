/**
 * tag-edge-geometry-test.js — 场风盘四边版式的「角度制一致性」守卫
 *
 * 背景（2026-10-04 真实事故）：
 *   tag.html 的 drawEdge 用【弧度】判长边 —— `angle === 0 || Math.abs(angle) > 2`
 *   （±π/2≈1.57 判不出 ⇒ 左右为短边，正确）。
 *   EinkTagRenderer.drawEdge 是它的 Java 移植，但那边传的是【角度】（0/±90/180），
 *   照抄这个阈值后 `Math.abs(-90) > 2` 恒真 ⇒ 左右两条 120×140 短边被当成"长边"横排
 *   且 L/H 取反 ⇒ 风位与分数重叠。
 *
 * 本测试不复制任何逻辑，而是**解析两侧源码里的判据表达式**，按各自的角度制在
 * {0°, ±90°, 180°} 上求值，断言两者的「长边/短边」分类完全一致且符合版式规范。
 * 这样一旦有人把角度制改成弧度制（或反之）却没同步阈值，测试立刻红。
 *
 * 运行：NODE_PATH=<workspace>/node_modules node tag-edge-geometry-test.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const HTML = path.join(ROOT, 'prototype', 'tag.html');
const JAVA = path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'riichi', 'score', 'EinkTagRenderer.java');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

const html = fs.readFileSync(HTML, 'utf8');
const java = fs.readFileSync(JAVA, 'utf8');

console.log('\n=== 1. 抽出两侧的“长边/短边”判据表达式 ===');
const mJs = html.match(/var wide = \((.+?)\);/);
const mJava = java.match(/boolean wide = (.+?);/);
ok(!!mJs, 'tag.html 里找到 `var wide = (...)`');
ok(!!mJava, 'EinkTagRenderer.java 里找到 `boolean wide = ...`');
if (!mJs || !mJava) { console.log('\n' + pass + ' 通过, ' + fail + ' 失败'); process.exit(1); }
// Java 的 float 字面量在 JS 里不合法，去掉后缀即可（180f → 180）
const exprJs = mJs[1];
const exprJava = mJava[1].replace(/(\d)f\b/g, '$1');
console.log('  tag.html 判据 : ' + exprJs);
console.log('  Java   判据   : ' + exprJava);

console.log('\n=== 2. 两侧确实使用了不同的角度制（这是本测试存在的前提）===');
// tag.html：EDGE_4/EDGE_3 的 angle 用 Math.PI
const htmlAngles = [...html.matchAll(/angle:\s*([^}]+?)\s*\}/g)].map((x) => x[1].trim());
ok(htmlAngles.some((a) => /Math\.PI/.test(a)), 'tag.html 的 angle 用 Math.PI（弧度）');
// Java：edgeFor 返回 0 / -90 / 90 / 180，且 rotate 直接吃 angleDeg
const javaAngles = [...java.matchAll(/new float\[\]\{\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*(-?\d+)\s*\}/g)]
  .map((x) => parseInt(x[5], 10));
ok(javaAngles.length >= 4, 'EinkTagRenderer.edgeFor 抽到 ' + javaAngles.length + ' 条边位（' + javaAngles.join('/') + '）');
ok(javaAngles.every((a) => [0, 90, -90, 180].includes(a)), 'Java 的角度取值只在 {0, ±90, 180} 内（角度制）');
ok(/ctx\.rotate\(angleDeg\)/.test(java), 'Canvas.rotate(angleDeg) 直接传角度（Canvas 收的就是角度）');
ok(/ctx\.rotate\(angle\)/.test(html), 'tag.html ctx.rotate(angle) 传的是弧度值');

console.log('\n=== 3. 两侧判据在同一组朝向下必须给出一致分类 ===');
const fnOf = (expr, varName) => new Function(varName, 'return (' + expr + ');');
const wideJs = fnOf(exprJs, 'angle');
const wideJava = fnOf(exprJava, 'angleDeg');

// 朝向 → 该边矩形尺寸（与两侧 edgeFor / EDGE_* 一致）
const CASES = [
  { seat: '东', deg: 0,      rad: 0,              rect: [400, 80],  expect: 'wide' },
  { seat: '西', deg: 180,    rad: Math.PI,        rect: [400, 80],  expect: 'wide' },
  { seat: '南', deg: -90,    rad: -Math.PI / 2,   rect: [120, 140], expect: 'narrow' },
  { seat: '北', deg: 90,     rad: Math.PI / 2,    rect: [120, 140], expect: 'narrow' },
];
for (const c of CASES) {
  const a = !!wideJs(c.rad), b = !!wideJava(c.deg);
  ok(a === b, c.seat + ' 边：tag.html(' + (a ? '长' : '短') + ') 与 Java(' + (b ? '长' : '短') + ') 分类一致');
  ok((c.expect === 'wide') === b, c.seat + ' 边判为' + (c.expect === 'wide' ? '长边' : '短边') + '（版式规范）');
  // 阅读方向长度 L：长边取 rw，短边取 rh
  const [rw, rh] = c.rect;
  const L = b ? rw : rh;
  const expectL = c.expect === 'wide' ? 400 : 140;
  ok(L === expectL, c.seat + ' 边阅读方向长 L=' + L + '（矩形 ' + rw + '×' + rh + '，期望 ' + expectL + '）');
}

console.log('\n=== 4. 回归：旧判据（角度制照抄弧度阈值）必须被判为错误 ===');
const oldJava = fnOf('angleDeg === 0 || Math.abs(angleDeg) > 2', 'angleDeg');
const wrong = CASES.filter((c) => !!oldJava(c.deg) !== (c.expect === 'wide'));
ok(wrong.length === 2, '旧判据在 ' + wrong.map((c) => c.seat).join('/') + ' 两条边上判错（这正是本次 bug 的成因）');
ok(wrong.map((c) => c.seat).sort().join(',') === '北,南', '判错的恰是左右两条边（南/北）——与“左右风位与分数重合”的现象吻合');

console.log('\n' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
