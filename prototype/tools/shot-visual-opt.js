/**
 * shot-visual-opt.js — 视觉优化 A~G 落地后的真 Chrome(CDP) 复核截图
 *
 * 覆盖：历史空态（立直棒引导）→ 主界面（四角 SVG 图标 / 按钮主次 / 顶栏热区）→ 逐局空态
 * 前置：chrome --headless=new --remote-debugging-port=9333 --user-data-dir=D:/_cdp_x
 *       开 file:///D:/日麻计分APP/prototype/index.html（单机模式，勿起 serve.js）
 * 输出：.workbuddy/tmp/30-visual-*.png + 控制台断言结果
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
  async function shot(name, beyond) {
    const r = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!beyond });
    const b64 = r.result && r.result.data;
    if (!b64) throw new Error('截图失败: ' + JSON.stringify(r).slice(0, 300));
    const f = path.join(OUT, name);
    fs.writeFileSync(f, Buffer.from(b64, 'base64'));
    console.log('saved', f, fs.statSync(f).size, 'bytes');
  }
  const results = [];
  const check = (name, cond, detail) => {
    results.push((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' → ' + detail : ''));
  };

  for (let i = 0; i < 60; i++) {
    if (await ev("!!document.getElementById('btn-create-game')")) break;
    await sleep(250);
  }

  // ---- F：历史空态 ----
  await ev("document.getElementById('btn-goto-history').click(); 'ok'");
  await sleep(400);
  check('历史空态有立直棒图形', await ev("!!document.querySelector('#history-list .empty-riichi .er-bar')"));
  check('历史空态文案含引导', await ev("document.getElementById('history-list').textContent.includes('开一局试试')"));
  await shot('30-visual-history-empty.png');

  // ---- 回模式页 → 建局 ----
  await ev("document.getElementById('btn-new-game-history').click(); 'ok'");
  await sleep(300);
  await ev(`
    document.getElementById('mode-4').click();
    document.getElementById('btn-next-setup').click();
    Array.from(document.querySelectorAll('.setup-name')).forEach(function(inp,i){ inp.value = '玩家'+(i+1); });
    document.getElementById('btn-create-game').click();
    'ok';`);
  await sleep(500);

  // ---- B：四角按钮图标 ----
  check('骰子按钮为 SVG 图标', await ev("!!document.querySelector('#btn-dice svg')"));
  check('计算器按钮为 SVG 图标', await ev("!!document.querySelector('#btn-calc svg')"));
  check('帮助按钮仍为「？」字形', await ev("document.getElementById('btn-help').textContent.trim() === '？'"));

  // ---- C：顶栏热区 ----
  const backH = await ev("document.getElementById('btn-back-main').getBoundingClientRect().height");
  const newH = await ev("document.getElementById('btn-new-game').getBoundingClientRect().height");
  check('返回热区 ≥44px', backH >= 44, backH + 'px');
  check('新对局热区 ≥44px', newH >= 44, newH + 'px');

  // ---- E：按钮主次 ----
  const ronBg = await ev("getComputedStyle(document.getElementById('btn-tsumo-ron')).backgroundColor");
  const endColor = await ev("getComputedStyle(document.getElementById('btn-end')).color");
  check('和牌结算=主按钮绿', ronBg === 'rgb(30, 122, 78)', ronBg);
  check('结束对局=深红描边字', endColor === 'rgb(193, 62, 46)', endColor);

  // ---- A：0 分色（读样式表规则） ----
  const neg2 = await ev(`
    (function(){
      var out = null;
      Array.from(document.styleSheets).forEach(function(ss){
        try { Array.from(ss.cssRules).forEach(function(r){
          if (r.selectorText && r.selectorText.indexOf('.pts.neg2') >= 0) out = r.style.color;
        }); } catch(e){}
      });
      return out;
    })()`);
  check('0分色已换 --gold(#8F6B12)', neg2 === 'rgb(143, 107, 18)', String(neg2));

  // ---- G：小字 ----
  const youFs = await ev("getComputedStyle(document.querySelector('.seat .you-mark') || document.body).fontSize");
  check('「你」角标 11px', youFs === '11px', youFs);

  await shot('31-visual-main.png');

  // 逐局空态（半庄分数记录，页面底部，全页截图）
  check('逐局空态有立直棒图形', await ev("!!document.querySelector('#round-log-body .empty-riichi .er-bar')"));
  check('逐局空态文案保留断言子串', await ev("document.getElementById('round-log-body').textContent.includes('尚无已结算的对局')"));
  await shot('32-visual-main-full.png', true);

  console.log(results.join('\n'));
  const fails = results.filter((s) => s.startsWith('FAIL')).length;
  console.log(fails === 0 ? 'ALL CHECKS PASS' : fails + ' CHECK(S) FAILED');
  ws.close();
  setTimeout(() => process.exit(fails === 0 ? 0 : 2), 200);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
