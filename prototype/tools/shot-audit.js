/**
 * shot-audit.js — 外观审查用：截取 模式选择页 / 对局主界面 / 历史页 真图
 * 复用 shot-settle-calc.js 骨架，前置 chrome --headless=new --remote-debugging-port=9333
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
    if (!b64) throw new Error('截图失败');
    const f = path.join(OUT, name);
    fs.writeFileSync(f, Buffer.from(b64, 'base64'));
    console.log('saved', f, fs.statSync(f).size, 'bytes');
  }

  for (let i = 0; i < 60; i++) {
    if (await ev("!!document.getElementById('btn-create-game')")) break;
    await sleep(250);
  }

  // 1. 模式选择页（净版：隐藏联网卡片）
  await ev(`localStorage.clear(); location.reload(); 'ok'`);
  await sleep(800);
  await ev(`var nc=document.getElementById('net-card'); if(nc) nc.style.display='none'; 'ok'`);
  await sleep(200);
  await shot('audit-1-mode.png');

  // 2. 建局 → 对局主界面
  await ev(`
    document.getElementById('mode-4').click();
    document.getElementById('btn-next-setup').click();
    Array.from(document.querySelectorAll('.setup-name')).forEach(function(inp,i){ inp.value = '玩家'+(i+1); });
    document.getElementById('btn-create-game').click();
    'ok';`);
  await sleep(600);
  await shot('audit-2-main.png');

  // 3. 主界面：展开逐局记录（若有）+ 打开一个典型弹窗（立直选人）
  await ev(`document.getElementById('btn-riichi').click(); 'ok'`);
  await sleep(400);
  await shot('audit-3-modal.png');
  await ev(`var c=document.querySelector('#modal-riichi .modal-close, #modal-riichi .close-x'); if(c) c.click(); 'ok'`);

  // 4. 历史页（净版）
  await ev(`history.back(); 'ok'`);
  await sleep(300);
  await ev(`
    try { document.getElementById('btn-end-game').click(); } catch(e){}
    'ok';`);
  await sleep(300);
  await ev(`
    try { var cf=document.querySelector('#modal-confirm .btn.danger, #btn-confirm-yes'); if(cf) cf.click(); } catch(e){}
    'ok';`);
  await sleep(400);
  await ev(`showMode && showMode(); document.getElementById('btn-goto-history').click(); 'ok'`);
  await sleep(400);
  await shot('audit-4-history.png');

  ws.close();
  console.log('done');
  setTimeout(() => process.exit(0), 200);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
