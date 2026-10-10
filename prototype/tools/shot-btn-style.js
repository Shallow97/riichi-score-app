/**
 * shot-btn-style.js — 真 Chrome(CDP) 截图：按钮样式改动复核
 *
 * 覆盖 2026-09-28 按钮 4 项改动：
 *   1. --accent-soft / --danger-dark token 化（颜色值不变，视觉应零差异）
 *   2. .btn 按压色反馈（primary→accent-dark、danger→danger-dark、次按钮微暗、ghost 微绿）
 *   4. .btn.ghost 底边 4px→2px
 *   5. flex/grid 容器内 .btn 统一 margin-top:0（修 dice-actions「摇一摇」被顶下 10px 的隐性 bug）
 *
 * 用法：
 *   1) chrome --headless=new --remote-debugging-port=9333 --user-data-dir=D:/_cdp_x
 *      --window-size=393,852 "file:///<本仓库>/prototype/index.html"
 *   2) node prototype/tools/shot-btn-style.js   → 图输出到 .workbuddy/tmp/
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, '..', '..', '.workbuddy', 'tmp');
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

(async () => {
  const targets = await getJson('http://127.0.0.1:9333/json');
  const page = targets.find((t) => t.type === 'page' && t.url.indexOf('index.html') >= 0)
    || targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没有 page 调试目标');
  console.log('target:', page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 连接失败')); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const call = (method, params) => new Promise((res) => {
    const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  });

  await call('Runtime.enable', {});
  await call('Page.enable', {});
  await call('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 2, mobile: true });

  async function ev(expr) {
    const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  async function shot(name) {
    const r = await call('Page.captureScreenshot', { format: 'png' });
    const b64 = r.result && r.result.data;
    if (!b64) throw new Error('截图失败: ' + JSON.stringify(r).slice(0, 300));
    const f = path.join(OUT, name);
    fs.writeFileSync(f, Buffer.from(b64, 'base64'));
    console.log('saved', f, fs.statSync(f).size, 'bytes');
  }
  // 取元素中心（相对视口），供 CDP 鼠标按压用
  async function center(sel) {
    return ev(`(function(){var b=document.querySelector('${sel}').getBoundingClientRect();
      return {x:b.left+b.width/2, y:b.top+b.height/2};})()`);
  }
  // 真实按压 :active —— mousePressed 按住不放再截图
  async function pressShot(sel, name) {
    const c = await center(sel);
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 });
    await sleep(120);
    const diag = await ev(`(function(){var el=document.querySelector('${sel}');
      var hit=document.elementFromPoint(${c.x},${c.y});
      return {active: el.matches(':active'),
        hit: hit ? (hit.id || hit.className || hit.tagName) : null,
        bg: getComputedStyle(el).backgroundColor};})()`);
    console.log('press diag', sel, JSON.stringify(diag));
    await shot(name);
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 });
  }

  for (let i = 0; i < 60; i++) {
    if (await ev("!!document.getElementById('btn-create-game')")) break;
    await sleep(250);
  }

  // 清掉遗留 storage（chrome profile 持久化上次的进行中对局会让页面状态不同），reload 到干净初始态
  await ev("localStorage.clear(); location.reload(); 'ok'");
  await sleep(800);
  for (let i = 0; i < 60; i++) {
    if (await ev("!!document.getElementById('btn-create-game')")) break;
    await sleep(250);
  }

  // --- 页1：模式选择（primary + 次按钮 + net-joinroom-row 行内两钮） ---
  await sleep(300);
  await shot('btn-01-mode.png');
  console.log('[同高断言] 加入/扫码:',
    await ev(`(function(){var a=document.getElementById('btn-join-room').getBoundingClientRect(),
      b=document.getElementById('btn-scan-qr').getBoundingClientRect();
      return 'h='+a.height.toFixed(1)+'/'+b.height.toFixed(1)+' top差='+(b.top-a.top).toFixed(1);})()`));

  // --- 按压态：primary ---
  await pressShot('#btn-next-setup', 'btn-02-primary-press.png');

  // --- 进对局主界面：action-grid + dice-btn 四角 ---
  await ev(`
    document.getElementById('mode-4').click();
    document.getElementById('btn-next-setup').click();
    Array.from(document.querySelectorAll('.setup-name')).forEach(function(inp,i){ inp.value = '玩家'+(i+1); });
    document.getElementById('btn-create-game').click();
    'ok';`);
  await sleep(600);
  await shot('btn-04-main.png');

  // --- 按压态：次按钮（主界面宫格里的默认款 .btn） ---
  await pressShot('#btn-flow', 'btn-03-secondary-press.png');
  await ev("document.querySelector('#modal-flow .close-x').click(); 'ok'");
  await sleep(200);

  // --- 骰子弹窗：dice-actions 两按钮同高（本次修复的隐性 bug） ---
  await ev("document.getElementById('btn-dice').click(); 'ok'");
  await sleep(400);
  await shot('btn-05-dice-modal.png');
  console.log('[同高断言] 关闭/摇一摇:',
    await ev(`(function(){var a=document.getElementById('btn-dice-close').getBoundingClientRect(),
      b=document.getElementById('btn-dice-shake').getBoundingClientRect();
      return 'h='+a.height.toFixed(1)+'/'+b.height.toFixed(1)+' top差='+(b.top-a.top).toFixed(1);})()`));
  await ev("document.getElementById('btn-dice-close').click(); 'ok'");

  // --- 结算填分弹窗：ghost 底边应为 2px ---
  await ev(`
    document.getElementById('btn-tsumo-ron').click();
    document.getElementById('btn-settle-ron').click();
    document.querySelectorAll('#pay-pick .p')[1].click();
    document.querySelectorAll('#recv-pick .p')[0].click();
    'ok';`);
  await sleep(400);
  await shot('btn-06-ghost-btn.png');
  console.log('[ghost断言] border-bottom-width =',
    await ev("getComputedStyle(document.getElementById('btn-settle-calc')).borderBottomWidth"));
  console.log('[danger断言] --danger-dark =',
    await ev("getComputedStyle(document.documentElement).getPropertyValue('--danger-dark')"));
  console.log('[soft断言] --accent-soft =',
    await ev("getComputedStyle(document.documentElement).getPropertyValue('--accent-soft')"));

  ws.close();
  console.log('done');
  setTimeout(() => process.exit(0), 200);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
