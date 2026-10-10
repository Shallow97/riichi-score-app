/**
 * shot-net-banner.js — 掉线锁定横幅（#net-banner）的真 Chrome(CDP) 视觉复核
 *
 * 前置：chrome --headless=new --remote-debugging-port=9333 --user-data-dir=D:/_cdp_x
 *       开 file:///<本仓库>/prototype/index.html（单机模式，勿起 serve.js）
 * 输出：.workbuddy/tmp/40-net-banner-*.png + 控制台断言
 *
 * 说明：单机模式下不会真的掉线，所以这里直接切换 hidden 属性来复核 CSS 渲染
 *       （位置/配色/层级/是否压过弹窗）。掉线时的行为断言在
 *       tests/net-reconnect-lock-test.js 里用真实 ws 服务端覆盖。
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

  // 先重载页面：脚本可能被重复运行，页面里会残留上一轮改动过的横幅文案/配色，
  // 导致断言测的不是 index.html 里的真实标记。
  await call('Page.reload', { ignoreCache: true });
  await sleep(600);

  async function ev(expr) {
    const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
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
  const results = [];
  const check = (name, cond, detail) => results.push((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' → ' + detail : ''));

  for (let i = 0; i < 60; i++) {
    if (await ev("!!document.getElementById('btn-create-game')")) break;
    await sleep(250);
  }

  // 建一局，进入对局主界面
  await ev("document.getElementById('mode-4').click()");
  await ev("document.getElementById('btn-next-setup').click()");
  await ev("Array.from(document.querySelectorAll('.setup-name')).forEach((el,i)=>{el.value='玩家'+(i+1);});");
  await ev("document.getElementById('btn-create-game').click()");
  await sleep(300);
  check('已进入对局主界面', await ev("document.getElementById('page-main').classList.contains('active')"));

  // 基线：横幅隐藏
  check('单机模式横幅默认隐藏', (await ev("document.getElementById('net-banner').hidden")) === true);
  await shot('40-net-banner-off.png');

  // 显示横幅 → 复核 CSS
  await ev("document.getElementById('net-banner').hidden = false");
  await sleep(120);
  const st = await ev(`(function(){
    const el = document.getElementById('net-banner');
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { display: cs.display, position: cs.position, top: cs.top, zIndex: cs.zIndex,
             bg: cs.backgroundColor, color: cs.color, fontWeight: cs.fontWeight,
             left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height),
             text: el.textContent.trim(), dot: !!el.querySelector('.net-banner-dot') };
  })()`);
  check('横幅 display:flex（hidden 已解除）', st.display === 'flex', st.display);
  check('横幅固定顶部通栏', st.position === 'fixed' && st.top === '0px' && st.left === 0, st.position + '/top=' + st.top + '/left=' + st.left);
  check('横幅宽度铺满 393 视口', st.width === 393, 'width=' + st.width);
  check('横幅用危险色底 + 白字', st.bg === 'rgb(193, 62, 46)' && st.color === 'rgb(255, 255, 255)', st.bg + ' / ' + st.color);
  check('横幅层级 320（高于弹窗 100 / confirm 300）', st.zIndex === '320', st.zIndex);
  check('横幅带状态圆点', st.dot === true);
  check('横幅文案正确', /已断开/.test(st.text) && /重连/.test(st.text), st.text);
  await shot('41-net-banner-on.png');

  // 打开一个弹窗，确认横幅仍压在最上层
  await ev("document.getElementById('btn-flow').click()");
  await sleep(200);
  const modalOpen = await ev("document.getElementById('modal-flow').classList.contains('show')");
  check('弹窗已打开（用于层级对比）', modalOpen === true);
  const zs = await ev(`(function(){
    const b = document.getElementById('net-banner').getBoundingClientRect();
    return { bannerZ: +getComputedStyle(document.getElementById('net-banner')).zIndex,
             modalZ: +getComputedStyle(document.getElementById('modal-flow')).zIndex,
             bannerTop: Math.round(b.top), bannerBottom: Math.round(b.bottom) };
  })()`);
  check('横幅层级高于弹窗（断线提示不会被弹窗盖住）', zs.bannerZ > zs.modalZ, 'banner=' + zs.bannerZ + ' modal=' + zs.modalZ);
  await shot('42-net-banner-over-modal.png');

  // 复位
  await ev("document.getElementById('net-banner').hidden = true");
  await ev("document.getElementById('modal-flow').classList.remove('show')");

  // ── 第二种变体：房主暂时离开（info 金色，不锁结算） ──
  await ev(`(function(){
    const el = document.getElementById('net-banner');
    el.classList.remove('warn'); el.classList.add('info');
    el.querySelector('.net-banner-text').textContent =
      '房主暂时离开，结算可继续（流局/修正/撤回/结束暂不可用）';
    el.hidden = false;
  })()`);
  await sleep(120);
  const st2 = await ev(`(function(){
    const el = document.getElementById('net-banner');
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, color: cs.color,
             text: el.textContent.trim(), width: Math.round(el.getBoundingClientRect().width) };
  })()`);
  check('info 变体用金色底（温和提示，区别于断线红）', st2.bg === 'rgb(143, 107, 18)', st2.bg);
  check('info 变体文案为「房主暂时离开」', /房主暂时离开/.test(st2.text), st2.text);
  check('info 变体同样铺满 393 视口', st2.width === 393, 'width=' + st2.width);
  await shot('43-net-banner-host-away.png');
  await ev("document.getElementById('net-banner').hidden = true");

  console.log('\n--- 复核结果 ---');
  results.forEach((r) => console.log(r));
  console.log('汇总: ' + results.filter((r) => r.startsWith('PASS')).length + ' PASS / ' + results.filter((r) => r.startsWith('FAIL')).length + ' FAIL');
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.error('脚本异常:', e.message); process.exit(1); });
