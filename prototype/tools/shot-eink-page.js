/* 场风盘控制页截图：file:// 打开 index.html（WS 连不上自动降级单机，不碰 8765）
 * 用法：先起无头 Chrome --remote-debugging-port=9333 --user-data-dir=D:/_cdp_eink
 *       打开 file:///D:/日麻计分APP/prototype/index.html
 * 然后运行本脚本 → 输出 .workbuddy/tmp/03-eink-page.png
 */
const fs = require('fs');
const http = require('http');

function getJson(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => { let s = ''; r.on('data', d => s += d); r.on('end', () => res(JSON.parse(s))); }).on('error', rej);
  });
}

(async () => {
  const targets = await getJson('http://127.0.0.1:9333/json');
  const page = targets.find(t => t.type === 'page' && t.url.includes('index.html'));
  if (!page) throw new Error('Chrome 里没有 index.html');
  const cdp = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { cdp.onopen = res; cdp.onerror = rej; });
  let id = 0; const pend = new Map();
  cdp.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const call = (method, params) => new Promise(res => { const i = ++id; pend.set(i, res); cdp.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : undefined; };

  await call('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 2, mobile: true });
  await call('Page.enable', {});
  // 跳到场风盘控制页
  await ev("typeof showPage === 'function' && showPage('page-eink')");
  await new Promise(r => setTimeout(r, 300));
  let shot = await call('Page.captureScreenshot', { format: 'png' });
  if (shot && shot.result && shot.result.data) {
    fs.writeFileSync('D:/日麻计分APP/.workbuddy/tmp/03-eink-page.png', Buffer.from(shot.result.data, 'base64'));
    console.log('saved 03-eink-page.png');
  } else { console.log('shot1 failed:', JSON.stringify(shot).slice(0, 200)); }
  // 顺便回主页截一张（含新按钮）
  await ev("typeof showPage === 'function' && showPage('page-mode')");
  await new Promise(r => setTimeout(r, 300));
  shot = await call('Page.captureScreenshot', { format: 'png' });
  if (shot && shot.result && shot.result.data) {
    fs.writeFileSync('D:/日麻计分APP/.workbuddy/tmp/04-mode-page.png', Buffer.from(shot.result.data, 'base64'));
    console.log('saved 04-mode-page.png');
  } else { console.log('shot2 failed:', JSON.stringify(shot).slice(0, 200)); }
  cdp.close(); setTimeout(() => process.exit(0), 200);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
