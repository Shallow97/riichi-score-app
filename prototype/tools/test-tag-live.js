/**
 * test-tag-live.js — 场风盘无硬件全链路联动测试
 *
 * 验证：真实服务器(serve.js:8765) → tag.html 真 WS 接入 → state 广播 → 渲染更新
 * 不含 BLE（那一步需要墨水屏实机）。
 *
 * 前置：
 *   1) 后台起服务器：  cd prototype && node serve.js
 *   2) 后台起 Chrome： chrome --headless=new --disable-gpu --no-proxy-server
 *        --remote-debugging-port=9333 --user-data-dir=D:/_cdp_tag
 *        "http://127.0.0.1:8765/tag.html"        ← 注意走服务器，不能 file://
 *   3) node prototype/tools/test-tag-live.js
 *
 * 输出：.workbuddy/tmp/11-tag-live-A.png（开局）→ 12-tag-live-B.png（结算后）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const OUT = 'D:/日麻计分APP/.workbuddy/tmp';
fs.mkdirSync(OUT, { recursive: true });

function getJson(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => {
      let s = '';
      r.on('data', (d) => { s += d; });
      r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 两个时点的伪 state（协议 = storage 序列化的 game 对象） ---------- */

function mkGame(round, honba, kyotaku, winds, points, bars) {
  const seats = ['东', '南', '西', '北'];
  return {
    mode: 4,
    players: seats.map((seat, i) => ({
      seat, wind: winds[i], name: 'P' + seat,
      points: points[i], riichi: bars[i] > 0, riichiBars: bars[i],
    })),
    opts: { westRule: false, multiRon: false, dealerName: 'P东' },
    dealerIndex: winds.indexOf('东'),
    round,
    honba, kyotaku,
    gameWind: '东',
    over: false, endReason: '', history: [],
  };
}

// A：东1局开局（东在下边，红东在下）
const STATE_A = mkGame({ wind: '东', num: 1 }, 0, 0,
  ['东', '南', '西', '北'], [25000, 25000, 25000, 25000], [0, 0, 0, 0]);

// B：打完一局（闲家和牌庄家轮转 → 东2局：红东移到右边；两家立直、供托 1000）
const STATE_B = mkGame({ wind: '东', num: 2 }, 1, 1000,
  ['北', '东', '南', '西'], [26200, 33400, 31300, 9100], [1, 3, 0, 2]);

/* ---------------- 主流程 ---------------- */

(async () => {
  // 1. 找到 Chrome 里的 tag 页
  const targets = await getJson('http://127.0.0.1:9333/json');
  const page = targets.find((t) => t.type === 'page' && t.url.indexOf('tag.html') >= 0);
  if (!page) throw new Error('Chrome 里没有 tag.html 页面（必须走 http://127.0.0.1:8765/tag.html 打开）');
  console.log('target:', page.url);

  // CDP 连接
  const cdp = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { cdp.onopen = res; cdp.onerror = () => rej(new Error('CDP 连接失败')); });
  let id = 0;
  const pending = new Map();
  cdp.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const call = (method, params) => new Promise((res) => {
    const i = ++id; pending.set(i, res); cdp.send(JSON.stringify({ id: i, method, params }));
  });
  async function ev(expr) {
    const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  await call('Runtime.enable', {});
  await call('Page.enable', {});
  // 先重载：保证拿到磁盘上最新的 tagpush.js
  await call('Page.reload', {});
  await sleep(1500);
  async function saveCanvas(name) {
    const dataUrl = await ev("document.getElementById('board').toDataURL('image/png')");
    const f = path.join(OUT, name);
    fs.writeFileSync(f, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('saved', f);
  }

  // 2. 等 tag 页连上服务器 WS
  let logTxt = '';
  for (let i = 0; i < 20; i++) {
    logTxt = await ev("document.getElementById('log').textContent");
    if (logTxt.indexOf('已连接对局服务器') >= 0) break;
    await sleep(250);
  }
  console.log('tag页日志:', JSON.stringify(logTxt.trim()));
  if (logTxt.indexOf('已连接对局服务器') < 0) throw new Error('tag 页没连上 WS（服务器没起？）');

  // 3. 伪装房主：连接须带 ?host=1（serve.js 只认它认定的房主/操作权者发的 host-state）
  const fake = new WebSocket('ws://127.0.0.1:8765/ws?host=1');
  await new Promise((res, rej) => { fake.onopen = res; fake.onerror = () => rej(new Error('伪装房主 WS 连接失败')); });
  fake.send(JSON.stringify({ type: 'set-name', name: '测试房主' }));
  await sleep(300);

  fake.send(JSON.stringify({ type: 'host-state', state: JSON.stringify(STATE_A) }));
  await sleep(800);
  await saveCanvas('11-tag-live-A.png');

  fake.send(JSON.stringify({ type: 'host-state', state: JSON.stringify(STATE_B) }));
  await sleep(800);
  await saveCanvas('12-tag-live-B.png');

  console.log('页面错误检查:', await ev("window.__err || 'none'"));
  fake.close();
  cdp.close();
  console.log('done');
  setTimeout(() => process.exit(0), 200);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
