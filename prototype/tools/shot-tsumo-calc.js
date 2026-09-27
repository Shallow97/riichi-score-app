/**
 * shot-tsumo-calc.js — 真 Chrome(CDP) 渲染截图：自摸填额 ⇄ 番符表联动
 *
 * 用途：自摸走的是 #modal-tsumo-amounts（不是荣和的 #modal-settle-amount），
 *       且要往两个分类输入框回填，jsdom 测不出层叠与置灰，用本脚本出真图复核。
 * 覆盖：自摸填额弹窗（含「点数计算」按钮）→ 番符表叠层 + 座位锁定
 *       → 关闭后按「闲家应付 / 庄家应付」分类回填（闲家自摸 / 庄家自摸两种形态）。
 *
 * 关键前置（与 shot-settle-calc.js 相同，踩过坑）：
 *   1. **不要同时起 serve.js** —— 页面会连上 ws://127.0.0.1:8765/ws 被当成"成员"，
 *      `btn-create-game` 变异步（toast「对局由房主建立，请等待房主操作」），步骤脚本全乱。
 *      直接 file:// 打开即为单机模式。
 *   2. chrome 用 `--headless=new --remote-debugging-port=9333 --user-data-dir=D:/_cdp_x`；
 *      window-size 无头下最小 512px，准图靠 `Emulation.setDeviceMetricsOverride(393x852, dsf2)`。
 *
 * 用法：
 *   1) chrome --headless=new --disable-gpu --no-proxy-server --remote-debugging-port=9333 \
 *        --user-data-dir=D:/_cdp_x --window-size=393,852 "file:///D:/日麻计分APP/prototype/index.html"
 *   2) node prototype/tools/shot-tsumo-calc.js      → 图输出到 .workbuddy/tmp/
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

(async () => {
  const targets = await getJson('http://127.0.0.1:9333/json');
  const page = targets.find((t) => t.type === 'page' && t.url.indexOf('index.html') >= 0)
    || targets.find((t) => t.type === 'page' && t.url.indexOf('8765') >= 0)
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

  for (let i = 0; i < 60; i++) {
    if (await ev("!!document.getElementById('btn-create-game')")) break;
    await sleep(250);
  }

  await ev(`
    document.getElementById('mode-4').click();
    document.getElementById('btn-next-setup').click();
    Array.from(document.querySelectorAll('.setup-name')).forEach(function(inp,i){ inp.value = '玩家'+(i+1); });
    document.getElementById('btn-create-game').click();
    'ok';`);
  await sleep(500);

  // ---------- 形态一：闲家自摸（两个输入框 + 座位锁 ko） ----------
  await ev(`
    (function(){
      document.getElementById('btn-tsumo-ron').click();
      document.getElementById('btn-settle-tsumo').click();
      var picks = Array.from(document.querySelectorAll('#tsumo-pick .p'));
      var ko = picks.filter(function(p){ return p.querySelector('.wind').textContent !== '东'; })[0];
      window.__koWind = ko.querySelector('.wind').textContent;
      ko.click();
    })();
    'ok';`);
  await sleep(400);
  await shot('05-tsumo-amounts.png');
  console.log('自摸填额弹窗 show =', await ev("document.getElementById('modal-tsumo-amounts').classList.contains('show')"),
    '/ 自摸者方位 =', await ev("window.__koWind"),
    '/ shared数 =', await ev("document.querySelectorAll('#tsumo-amount-list .tsumo-shared').length"),
    '/ koha数 =', await ev("document.querySelectorAll('#tsumo-amount-list .tsumo-koha').length"),
    '/ oya数 =', await ev("document.querySelectorAll('#tsumo-amount-list .tsumo-oya').length"));

  await ev("document.getElementById('btn-tsumo-calc').click(); 'ok'");
  await sleep(400);
  await shot('06-tsumo-calc-locked.png');
  console.log('番符表 show =', await ev("document.getElementById('modal-calc').classList.contains('show')"),
    '/ 填额弹窗仍 show =', await ev("document.getElementById('modal-tsumo-amounts').classList.contains('show')"),
    '/ ko active =', await ev("document.getElementById('calc-seat-ko').classList.contains('active')"),
    '/ oya locked =', await ev("document.getElementById('calc-seat-oya').classList.contains('locked')"),
    '/ hint =', await ev("document.getElementById('calc-link-hint').textContent"));

  await ev(`
    var h = document.getElementById('calc-han'); h.value = '3';
    h.dispatchEvent(new Event('change', { bubbles: true }));
    var f = document.getElementById('calc-fu'); f.value = '30';
    f.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('btn-calc-close').click();
    'ok';`);
  await sleep(400);
  await shot('07-tsumo-filled-ko.png');
  console.log('闲家应付 =', await ev("document.querySelector('#tsumo-amount-list .tsumo-koha').value"),
    '/ 庄家应付 =', await ev("document.querySelector('#tsumo-amount-list .tsumo-oya').value"),
    '/ 荣和填分框未被串写 =', await ev("document.getElementById('settle-amount').value"));

  // ---------- 形态二：庄家自摸（单输入框 + 座位锁 oya） ----------
  await ev("document.querySelector('#modal-tsumo-amounts .close-x').click(); 'ok'");
  await sleep(200);
  await ev(`
    (function(){
      document.getElementById('btn-tsumo-ron').click();
      document.getElementById('btn-settle-tsumo').click();
      var picks = Array.from(document.querySelectorAll('#tsumo-pick .p'));
      picks.filter(function(p){ return p.querySelector('.wind').textContent === '东'; })[0].click();
    })();
    'ok';`);
  await sleep(400);
  await ev("document.getElementById('btn-tsumo-calc').click(); 'ok'");
  await sleep(400);
  await shot('08-tsumo-oya-calc.png');
  console.log('oya active =', await ev("document.getElementById('calc-seat-oya').classList.contains('active')"),
    '/ ko locked =', await ev("document.getElementById('calc-seat-ko').classList.contains('locked')"));

  await ev("document.getElementById('btn-calc-close').click(); 'ok'");
  await sleep(400);
  await shot('09-tsumo-filled-oya.png');
  console.log('庄自摸 每位闲家应付 =', await ev("document.querySelector('#tsumo-amount-list .tsumo-shared').value"));

  ws.close();
  console.log('done');
  setTimeout(() => process.exit(0), 200);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
