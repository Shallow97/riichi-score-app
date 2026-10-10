/**
 * check-tag-edge-layout.js — 场风盘「四边版式」像素级复核（真 Chrome / CDP）
 *
 * 【为什么需要它】
 *   EinkTagRenderer.drawEdge() 是 tag.html drawEdge() 的 Java 移植版。移植时把
 *   `Math.abs(angle) > 2` 原样抄了过来 —— 但 tag.html 里 angle 是【弧度】，
 *   ±π/2≈1.57 判不出长边（所以那边是对的）；Java 侧传的是【角度】，
 *   `Math.abs(-90) > 2` 恒真 ⇒ 左右两条 120×140 短边被当成"长边"横排、L/H 取反
 *   ⇒ **风位与分数重叠**（用户 2026-10-04 反馈的正是这个）。
 *   这类"单位口径"bug 在 jsdom 里测不出来（渲染在 Java 侧、且不抛异常），
 *   只能在真画布引擎上按几何口径复核。
 *
 * 【做法】
 *   把 Java 的 drawEdge 逐行照抄成 JS（角度口径），用三套判据渲染同一份数据：
 *     ref  = tag.html 口径（弧度 + `> 2`）—— 正确参照
 *     old  = Java 旧判据（角度 + `> 2`）—— 复现 bug
 *     new  = Java 新判据（角度 % 180 === 0）—— 修复后
 *   1) 与 tag.html 自己 render() 的画布逐像素比对（数据严格同源）；
 *   2) 三套判据互比 + 求「风位 / 分数」文字包围盒的重叠面积。
 *
 * 【前置】无 —— 脚本自行拉起 headless Chrome（file:///…/tag.html?demo=1）
 * 【运行】cd prototype && NODE_PATH=<workspace>/node_modules node tools/check-tag-edge-layout.js
 * 【输出】.workbuddy/tmp/tag-edge-{ref,before,after,compare}.png
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const OUT = path.resolve(__dirname, '..', '..', '.workbuddy', 'tmp');
fs.mkdirSync(OUT, { recursive: true });
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
// 跨平台拼 file:// URL（Windows 盘符需转成正斜杠并加前导斜杠，否则 file:///D:/… 之外的路径不认）
const TAG_URL = require('url').pathToFileURL(
  path.resolve(__dirname, '..', 'tag.html')).href + '?demo=1';

function getJson(url) {
  return new Promise((res, rej) => {
    const r = http.get(url, (resp) => {
      let s = '';
      resp.on('data', (d) => { s += d; });
      resp.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } });
    });
    r.on('error', rej);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 与 tag.html DEMO_GAME() 逐字段一致（必须同源，才能拿 tag.html 画布当参照） */
const DEMO = {
  mode: 4,
  players: [
    { seat: '东', wind: '北', points: 25100, riichi: false },
    { seat: '南', wind: '东', points: 32400, riichi: true },
    { seat: '西', wind: '南', points: 34300, riichi: false },
    { seat: '北', wind: '西', points: 7200, riichi: true },
  ],
};
/** 额外场景：负分（红字、位数更多，最容易挤）与三人局（西边落到左边） */
const SCENARIOS = [
  { name: '四人·含负分', data: { mode: 4, players: [
      { seat: '东', wind: '东', points: -3300, riichi: true },
      { seat: '南', wind: '南', points: 120900, riichi: false },
      { seat: '西', wind: '西', points: 25100, riichi: false },
      { seat: '北', wind: '北', points: 7200, riichi: true },
    ] } },
  { name: '三人局', data: { mode: 3, players: [
      { seat: '东', wind: '东', points: 45000, riichi: false },
      { seat: '南', wind: '南', points: 35000, riichi: true },
      { seat: '西', wind: '西', points: 25000, riichi: false },
    ] } },
];

/** 在页面上下文执行的复核代码（字符串，避免闭包捕获） */
const RUN = (demo, scenarios) => `(function(){
  var EDGE_4 = {
    '东': [0, 220, 400, 80, 0],
    '南': [280, 80, 120, 140, -90],
    '北': [0, 80, 120, 140, 90],
    '西': [0, 0, 400, 80, 180]
  };
  var EDGE_3 = {
    '东': [0, 220, 400, 80, 0],
    '南': [280, 80, 120, 140, -90],
    '西': [0, 80, 120, 140, 90]
  };
  var BLACK = '#000', WHITE = '#fff', RED = '#f00';
  function fmt(n){ return n.toLocaleString('en-US'); }
  function radii(c, x, y, w, h, r){
    c.beginPath();
    c.arc(x+r, y+r, r, Math.PI, Math.PI*1.5);
    c.arc(x+w-r, y+r, r, Math.PI*1.5, 0);
    c.arc(x+w-r, y+h-r, r, 0, Math.PI*0.5);
    c.arc(x+r, y+h-r, r, Math.PI*0.5, Math.PI);
    c.closePath();
  }
  /* ---- 以下 drawEdge 逐行照抄 EinkTagRenderer.drawEdge()（角度口径） ---- */
  function drawEdge(c, p, rect, angleDeg, rule, kind){
    kind = kind || 'both';   // 'both' | 'wind' | 'score'
    var rw = rect[2], rh = rect[3];
    var wide;
    if (rule === 'ref'){
      // tag.html 口径：angle 是弧度，阈值 2 在弧度下才有意义
      var rad = angleDeg * Math.PI / 180;
      wide = (rad === 0 || Math.abs(rad) > 2);
    } else if (rule === 'old'){
      wide = (angleDeg === 0 || Math.abs(angleDeg) > 2);   // 旧：照抄弧度阈值 ⇒ 单位错配
    } else {
      wide = (angleDeg % 180 === 0);                        // 新：阅读方向水平 ⇔ 180° 整数倍
    }
    var L = wide ? rw : rh, Hh = wide ? rh : rw;
    c.save();
    c.translate(rect[0] + rw/2, rect[1] + rh/2);
    c.rotate(angleDeg * Math.PI / 180);
    c.textBaseline = 'alphabetic';
    c.textAlign = 'left';
    var windSize = 46, scoreSize = 34;
    var dealer = (p.wind === '东');
    function wind(x, y){
      c.font = 'bold ' + windSize + 'px sans-serif';
      c.fillStyle = dealer ? RED : BLACK;
      c.fillText(p.wind, x, y);
    }
    if (wide){
      if (kind !== 'score') wind(-L/2 + 12, -Hh/2 + windSize + 8);
      c.fillStyle = (p.points < 0) ? RED : BLACK;
      c.font = 'bold ' + scoreSize + 'px sans-serif';
      if (c.measureText(fmt(p.points)).width > L - 24) c.font = 'bold 28px sans-serif';
      c.textAlign = 'right';
      if (kind !== 'wind') c.fillText(fmt(p.points), L/2 - 12, -Hh/2 + scoreSize + 12);
      c.textAlign = 'left';
    } else {
      c.textAlign = 'center';
      if (kind !== 'score') wind(0, -Hh/2 + windSize + 8);
      c.fillStyle = (p.points < 0) ? RED : BLACK;
      c.font = 'bold ' + scoreSize + 'px sans-serif';
      if (c.measureText(fmt(p.points)).width > L - 12) c.font = 'bold 28px sans-serif';
      if (kind !== 'wind') c.fillText(fmt(p.points), 0, Hh/2 - 26);
      c.textAlign = 'left';
    }
    if (p.riichi && kind === 'both'){
      var sw = 56, sh = 14, cy = Hh/2 - (wide ? 20 : 8), sx = -sw/2;
      c.fillStyle = WHITE; radii(c, sx, cy - sh/2, sw, sh, sh/2); c.fill();
      c.lineWidth = 2; c.strokeStyle = BLACK; c.stroke();
      c.fillStyle = RED; c.beginPath(); c.arc(sx + sw/2, cy, 4.5, 0, Math.PI*2); c.fill();
    }
    c.restore();
  }
  function layoutOf(g){ return g.mode === 3 ? EDGE_3 : EDGE_4; }
  function playerOf(g, seat){
    for (var i = 0; i < g.players.length; i++) if (g.players[i].seat === seat) return g.players[i];
    return null;
  }
  function renderEdges(c, g, rule, kind){
    var lay = layoutOf(g);
    for (var s in lay){
      var p = playerOf(g, s);
      if (p) drawEdge(c, p, lay[s], lay[s][4], rule, kind);
    }
  }
  function mk(){
    var cv = document.createElement('canvas'); cv.width = 400; cv.height = 300;
    var c = cv.getContext('2d'); c.fillStyle = WHITE; c.fillRect(0,0,400,300); return cv;
  }
  function dataOf(cv){ return cv.toDataURL('image/png'); }
  function inEdges(g, x, y){
    var lay = layoutOf(g);
    for (var s in lay){
      var r = lay[s];
      if (x >= r[0] && x < r[0]+r[2] && y >= r[1] && y < r[1]+r[3]) return true;
    }
    return false;
  }
  function diff(a, b, g){
    var da = a.getContext('2d').getImageData(0,0,400,300).data;
    var db = b.getContext('2d').getImageData(0,0,400,300).data;
    var n = 0, first = null;
    for (var y = 0; y < 300; y++) for (var x = 0; x < 400; x++){
      if (!inEdges(g, x, y)) continue;
      var i = (y*400 + x) * 4;
      if (Math.abs(da[i]-db[i]) > 40 || Math.abs(da[i+1]-db[i+1]) > 40 || Math.abs(da[i+2]-db[i+2]) > 40){
        n++; if (!first) first = [x, y];
      }
    }
    return { diff: n, first: first };
  }
  function bbox(cv){
    var d = cv.getContext('2d').getImageData(0,0,400,300).data;
    var x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (var y = 0; y < 300; y++) for (var x = 0; x < 400; x++){
      var i = (y*400+x)*4;
      if (d[i] < 200 || d[i+1] < 200 || d[i+2] < 200){
        if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
      }
    }
    return x1 < 0 ? null : [x0, y0, x1, y1];
  }
  function overlap(a, b){
    if (!a || !b) return 0;
    var ix = Math.min(a[2], b[2]) - Math.max(a[0], b[0]) + 1;
    var iy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]) + 1;
    return (ix > 0 && iy > 0) ? ix * iy : 0;
  }
  function boxes(g, rule){
    var lay = layoutOf(g), out = {};
    for (var s in lay){
      var p = playerOf(g, s); if (!p) continue;
      var p2 = { seat: p.seat, wind: p.wind, points: p.points, riichi: false };
      var cvW = mk(); drawEdge(cvW.getContext('2d'), p2, lay[s], lay[s][4], rule, 'wind');
      var cvS = mk(); drawEdge(cvS.getContext('2d'), p2, lay[s], lay[s][4], rule, 'score');
      var w = bbox(cvW), sc = bbox(cvS), r = lay[s];
      out[s] = { rect: r, angle: r[4], wind: w, score: sc, overlapPx: overlap(w, sc) };
    }
    return out;
  }
  function runOne(g){
    var refCv = mk(); renderEdges(refCv.getContext('2d'), g, 'ref');
    var oldCv = mk(); renderEdges(oldCv.getContext('2d'), g, 'old');
    var newCv = mk(); renderEdges(newCv.getContext('2d'), g, 'new');
    return {
      dRefNew: diff(refCv, newCv, g),
      dRefOld: diff(refCv, oldCv, g),
      boxesOld: boxes(g, 'old'),
      boxesNew: boxes(g, 'new'),
      png: { ref: dataOf(refCv), old: dataOf(oldCv), neo: dataOf(newCv) }
    };
  }
  // ① 与 tag.html 真实画布比对（数据同源）
  var live = mk(); live.getContext('2d').drawImage(document.getElementById('board'), 0, 0);
  var demoRef = mk(); renderEdges(demoRef.getContext('2d'), ${JSON.stringify(demo)}, 'ref');
  var demoNew = mk(); renderEdges(demoNew.getContext('2d'), ${JSON.stringify(demo)}, 'new');
  var demoOld = mk(); renderEdges(demoOld.getContext('2d'), ${JSON.stringify(demo)}, 'old');
  var out = {
    liveVsRef: diff(live, demoRef, ${JSON.stringify(demo)}),
    liveVsNew: diff(live, demoNew, ${JSON.stringify(demo)}),
    liveVsOld: diff(live, demoOld, ${JSON.stringify(demo)}),
    demoBoxesOld: boxes(${JSON.stringify(demo)}, 'old'),
    demoBoxesNew: boxes(${JSON.stringify(demo)}, 'new'),
    png: { ref: dataOf(demoRef), old: dataOf(demoOld), neo: dataOf(demoNew) },
    scenarios: []
  };
  ${JSON.stringify(scenarios)}.forEach(function(s){
    var r = runOne(s.data); r.name = s.name; out.scenarios.push(r);
  });
  return out;
})()`;

(async () => {
  if (!fs.existsSync(CHROME)) throw new Error('找不到 Chrome: ' + CHROME);
  const child = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-proxy-server',
    '--remote-debugging-port=' + PORT, '--user-data-dir=D:/_cdp_tag',
    '--window-size=640,900', TAG_URL,
  ], { stdio: 'ignore', detached: false });

  let targets = null;
  for (let i = 0; i < 40; i++) {
    try { targets = await getJson('http://127.0.0.1:' + PORT + '/json'); if (targets && targets.length) break; }
    catch (e) { /* 还没起来 */ }
    await sleep(300);
  }
  const page = (targets || []).find((t) => t.type === 'page' && t.url.indexOf('tag.html') >= 0)
    || (targets || []).find((t) => t.type === 'page');
  if (!page) { child.kill(); throw new Error('没有 page 调试目标'); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 连接失败')); });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const call = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await call('Runtime.enable', {});
  await call('Page.enable', {});

  const ev = async (expr) => {
    const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 900));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  for (let i = 0; i < 40; i++) {
    if (await ev("!!(document.getElementById('board') && document.getElementById('board').__rendered)")) break;
    await sleep(250);
  }
  console.log('页面错误:', await ev("window.__err || 'none'"));

  const out = await ev('(' + RUN(DEMO, SCENARIOS) + ')');
  const save = (name, dataUrl) => {
    const f = path.join(OUT, name);
    fs.writeFileSync(f, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('saved', f);
  };
  save('tag-edge-ref.png', out.png.ref);
  save('tag-edge-before.png', out.png.old);
  save('tag-edge-after.png', out.png.neo);

  // 三图并排 + 标注，便于目视
  const cmp = await ev(`(function(){
    return new Promise(function(res){
      var imgs = [['参照：tag.html 口径（弧度 ±π/2 ⇒ 正确）', ${JSON.stringify(out.png.ref)}],
                  ['修复前：Java 旧判据 |角度|>2 ⇒ 左右边重叠', ${JSON.stringify(out.png.old)}],
                  ['修复后：Java 新判据 角度%180==0', ${JSON.stringify(out.png.neo)}]];
      var S = 2, H1 = 300 + 34, cv = document.createElement('canvas');
      cv.width = 400*S; cv.height = H1*imgs.length*S;
      var c = cv.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0,0,cv.width,cv.height);
      var loaded = 0;
      imgs.forEach(function(it, i){
        var im = new Image();
        im.onload = function(){
          c.fillStyle = '#111'; c.font = 'bold 19px sans-serif';
          c.fillText(it[0], 14, (i*H1+24)*S);
          c.drawImage(im, 0, (i*H1+34)*S, 400*S, 300*S);
          c.strokeStyle = '#bbb'; c.lineWidth = 1; c.strokeRect(0, (i*H1+34)*S, 400*S, 300*S);
          if (++loaded === imgs.length) res(cv.toDataURL('image/png'));
        };
        im.src = it[1];
      });
    });
  })()`);
  save('tag-edge-compare.png', cmp);

  // ---- 判定 ----
  const P = (t) => t ? ('[' + t.join(',') + ']') : 'null';
  const dump = (title, boxes) => {
    console.log('\n-- ' + title);
    for (const s in boxes) {
      const b = boxes[s];
      console.log('   ' + s + " rect=" + P(b.rect) + " 角" + b.angle
        + " 风位" + P(b.wind) + " 分数" + P(b.score) + " → 重叠 " + b.overlapPx + "px²");
    }
  };
  console.log('\n=== ① 与 tag.html 真实画布逐像素比对（仅四边区域）===');
  console.log('  tag.html 画布 vs 参照口径 :', out.liveVsRef.diff, 'px');
  console.log('  tag.html 画布 vs 修复后  :', out.liveVsNew.diff, 'px');
  console.log('  tag.html 画布 vs 修复前  :', out.liveVsOld.diff, 'px');
  dump('四人局·修复前（用户看到的 bug）', out.demoBoxesOld);
  dump('四人局·修复后', out.demoBoxesNew);

  const fail = [];
  if (out.liveVsRef.diff !== 0) fail.push('参照口径与 tag.html 画布不一致（复核脚本本身有问题）');
  if (out.liveVsNew.diff !== 0) fail.push('修复后与 tag.html 画布仍有 ' + out.liveVsNew.diff + 'px 差异');
  if (out.liveVsOld.diff === 0) fail.push('旧判据竟然零差异（用例没覆盖到 bug）');
  let oldOverlap = 0;
  for (const s in out.demoBoxesOld) oldOverlap += out.demoBoxesOld[s].overlapPx;
  if (oldOverlap === 0) fail.push('旧判据未复现重叠');
  console.log('\n=== ② 追加场景（负分 / 三人局）===');
  for (const s of out.scenarios) {
    console.log('\n-- ' + s.name + '：参照 vs 修复后 ' + s.dRefNew.diff + 'px，参照 vs 修复前 ' + s.dRefOld.diff + 'px');
    dump(s.name + '·修复后', s.boxesNew);
    if (s.dRefNew.diff !== 0) fail.push(s.name + '：修复后与参照仍有 ' + s.dRefNew.diff + 'px 差异');
    for (const k in s.boxesNew) {
      if (s.boxesNew[k].overlapPx > 0) fail.push(s.name + ' ' + k + ' 边风位/分数重叠 ' + s.boxesNew[k].overlapPx + 'px²');
    }
    for (const k in s.boxesNew) {
      // 越界检查：文字包围盒必须落在该边矩形内
      const b = s.boxesNew[k], r = b.rect;
      if (b.wind && (b.wind[0] < r[0] || b.wind[1] < r[1] || b.wind[2] >= r[0]+r[2] || b.wind[3] >= r[1]+r[3]))
        fail.push(s.name + ' ' + k + ' 边风位越界 ' + P(b.wind));
      if (b.score && (b.score[0] < r[0] || b.score[1] < r[1] || b.score[2] >= r[0]+r[2] || b.score[3] >= r[1]+r[3]))
        fail.push(s.name + ' ' + k + ' 边分数越界 ' + P(b.score));
    }
  }

  ws.close();
  child.kill();
  console.log('\n' + (fail.length
    ? '✗ ' + fail.length + ' 项未通过:\n   - ' + fail.join('\n   - ')
    : '✓ 全部通过：左右两边（及三人局西边）风位与分数不再重叠，且与 tag.html 参照版式零差异'));
  setTimeout(() => process.exit(fail.length ? 1 : 0), 200);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
