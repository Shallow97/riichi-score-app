/**
 * push-qr-test.js — 首页「推送二维码到场风盘」按钮回归测试（2026-10-05）
 *
 * 需求：首页「联网对局」卡片里加「推送二维码到场风盘」按钮 ——
 *   · 仅在与场风盘蓝牙连接时可点，未连接置灰；
 *   · 没有可推送的二维码（非房主 / 未联网）时随卡片一起隐藏；
 *   · 点击后把卡片里那个「加入本桌」链接的二维码推到场风盘墨水屏。
 *
 * jsdom 能覆盖的：按钮显隐 / 置灰状态机 / 点击前置校验（不发原生调用）。
 * jsdom 覆盖不了、由真 Chrome CDP 覆盖的：二维码位图生成与解码结果
 *   （400×300 PNG、jsQR 解回 http://<IP>:8765/）—— 见改动说明。
 *
 * 运行：NODE_PATH=<workspace>/node_modules node push-qr-test.js
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ FAIL: ' + msg); }
}

async function main() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:8765/?host=1&lanip=192.168.0.101',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;

  // jsdom 无 canvas 实现：renderQR 与 buildQrPngBase64 都依赖 toDataURL，必须打桩
  window.HTMLCanvasElement.prototype.getContext = function () {
    return {
      fillStyle: '', fillRect() {}, drawImage() {},
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    };
  };
  window.HTMLCanvasElement.prototype.toDataURL = function () { return 'data:image/png;base64,AAAABBBB'; };
  window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
  window.HTMLMediaElement.prototype.pause = function () {};

  // 原生桥桩：连接态由 einkConn 控制；记录被推送的 base64
  let einkConn = false;
  const pushCalls = [];
  window.NativeBridge = {
    einkIsConnected: () => einkConn,
    einkPushQr: (b64) => pushCalls.push(b64),
  };

  window.eval(fs.readFileSync(path.join(ROOT, 'js/rules.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/storage.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/net.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/qrcode.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8'));
  document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

  const btn = document.getElementById('btn-push-qr');
  const qrBlock = document.getElementById('net-room-qr');
  const toastEl = document.getElementById('toast');
  const on = (type, data) => window.EinkNative.onStatus(type, data);
  const click = (el) => el.dispatchEvent(new window.Event('click', { bubbles: true }));

  console.log('\n[1] 按钮存在、位置、初始态');
  assert(!!btn, '#btn-push-qr 存在');
  assert(qrBlock && qrBlock.contains(btn), '★ 按钮位于二维码卡片 #net-room-qr 内 → 无二维码时随之隐藏');
  assert(btn.disabled === true, '★ 初始（未连接场风盘）为置灰不可点');

  console.log('\n[2] 无二维码时卡片整体隐藏（jsdom 里连不上服务器 → 非房主）');
  assert(window.getComputedStyle(qrBlock).display === 'none', '★ 未进房 → #net-room-qr 隐藏（按钮一并隐藏）');

  console.log('\n[3] 蓝牙连接状态机驱动置灰');
  on('connected', 'NRF_EPD_2');
  assert(btn.disabled === false, '★ connected → 解除置灰、可点');
  on('disconnected', '');
  assert(btn.disabled === true, '★ disconnected → 重新置灰');
  on('connecting', 'NRF_EPD_2');
  assert(btn.disabled === true, 'connecting（连接中）→ 仍置灰');
  on('connect-fail', '连接超时');
  assert(btn.disabled === true, 'connect-fail → 置灰');

  console.log('\n[4] 点击前置校验：未连接不发起推图');
  pushCalls.length = 0;
  click(btn);
  assert(pushCalls.length === 0, '★ 未连接时点击**不**调用原生推图');
  assert(toastEl.textContent.indexOf('场风盘未连接') >= 0, '并提示「场风盘未连接」');

  console.log('\n[5] 已连接但没有可推送二维码：仍不推图');
  on('connected', 'NRF_EPD_2');
  pushCalls.length = 0;
  click(btn);
  assert(pushCalls.length === 0, '★ 无二维码内容时点击**不**推图');
  assert(toastEl.textContent.indexOf('当前没有可推送的二维码') >= 0, '并提示「没有可推送的二维码」');

  console.log('\n====================================');
  console.log('push-qr 测试: ' + pass + ' 通过，' + fail + ' 失败');
  console.log('====================================');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常：', e); process.exit(1); });
