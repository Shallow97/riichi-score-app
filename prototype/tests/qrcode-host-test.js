/**
 * qrcode-host-test.js — 验证房主"扫码加入"二维码功能
 * 1) assets 内置的 js/qrcode.js 在浏览器/WebView 全局暴露 window.qrcode（纯 JS 离线可用）
 * 2) renderQR(app.js) 在房主联网时能为完整访问链接生成可解码的 PNG data URL 并挂到 DOM
 *
 * 运行：NODE_PATH=<workspace>/node_modules node qrcode-host-test.js
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
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:8765/?host=1&lanip=192.168.1.50', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;

  console.log('\n== 测试1: qrcode.js 暴露全局 window.qrcode ==\n');
  const qrLib = fs.readFileSync(path.join(ROOT, 'js/qrcode.js'), 'utf8');
  window.eval(qrLib);
  assert(typeof window.qrcode === 'function', '加载 js/qrcode.js 后 window.qrcode 是函数');

  console.log('\n== 测试2: 能对完整访问链接生成可解码 PNG data URL ==\n');
  const url = 'http://192.168.1.50:8765/';
  let qr;
  try {
    qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
  } catch (e) { qr = null; }
  assert(!!qr && typeof qr.getModuleCount === 'function', 'qr.make() 成功，模块数=' + (qr ? qr.getModuleCount() : '?'));
  const dataUrl = qr ? qr.createDataURL(4, 8) : null;
  // 注意：该库的 createDataURL 用内置 GIF 编码器（纯 JS，无需 canvas），返回 GIF data URL
  assert(typeof dataUrl === 'string' && dataUrl.startsWith('data:image/gif'), 'createDataURL 返回可内联的 GIF data URL');
  assert(dataUrl && dataUrl.length > 500, 'data URL 非空且体积合理（len=' + (dataUrl ? dataUrl.length : 0) + '）');

  // 对非 host 的 URL 断言：host URL 不应带上 host=1（成员访问纯路径）
  assert(!/host=1/.test(url), '成员访问链接不含 host=1，扫码加入即成员');

  console.log('\n== 测试3: app.js 的 renderQR 可把二维码挂到 #qr-canvas ==\n');
  // 载入 rules/storage/app（app 引用 window.qrcode，需先已存在 qrcode）
  window.eval(fs.readFileSync(path.join(ROOT, 'js/rules.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/storage.js'), 'utf8'));
  const appCode = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');

  // 伪装一个房主 Net，模拟"已联网并建局"，使 updateNetStatusUI 进入房主分支生成二维码
  const fakeNet = {
    init: () => {}, install: () => {},
    setName: () => {}, memberName: () => 'HOST',
    isOnline: () => true, isInRoom: () => true, isHost: () => true,
    memberCount: () => 1, operatorName: () => null, amOperator: () => false,
    requestAction: (n, cb) => cb && cb(null, true), releaseAction: () => {},
    leaveRoom: () => {}, endGame: () => {},
    onStatus: () => {}, onState: () => {}, onOperator: () => {}, onGameEnd: () => {},
  };
  window.Net = fakeNet;
  window.eval(appCode);
  document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

  // 房主分支应显示 #net-room 且生成二维码图片
  const room = document.getElementById('net-room');
  assert(room.style.display === 'block', '房主联网时显示 #net-room');
  const qrBlock = document.getElementById('net-room-qr');
  assert(qrBlock.style.display === 'block', '#net-room-qr 显示');
  const img = qrBlock.querySelector('img');
  assert(!!img && img.src.startsWith('data:image/gif'), '生成了一张可内联二维码图（GIF data URL）');
  assert(img.width === 160 && img.height === 160, '二维码固定 160px');
  const urlShown = document.getElementById('qr-url').textContent;
  assert(urlShown === 'http://192.168.1.50:8765/', '展示完整访问链接=' + urlShown);
  const codeShown = document.getElementById('net-room-code-val').textContent;
  assert(codeShown === '192.168.1.50:8765', 'IP:端口 文本=' + codeShown);

  console.log('\n== 测试4: 非房主（成员）不显示二维码 ==\n');
  // 重新以成员身份载入 app（新窗口）
  const html2 = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom2 = new JSDOM(html2, { url: 'http://192.168.1.50:8765/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w2 = dom2.window;
  w2.eval(fs.readFileSync(path.join(ROOT, 'js/qrcode.js'), 'utf8'));
  w2.eval(fs.readFileSync(path.join(ROOT, 'js/rules.js'), 'utf8'));
  w2.eval(fs.readFileSync(path.join(ROOT, 'js/storage.js'), 'utf8'));
  const fakeNet2 = { init: () => {}, install: () => {}, setName: () => {}, memberName: () => 'M',
    isOnline: () => true, isInRoom: () => true, isHost: () => false,
    memberCount: () => 1, operatorName: () => null, amOperator: () => false,
    requestAction: (n, cb) => cb && cb(null, true), releaseAction: () => {}, leaveRoom: () => {}, endGame: () => {},
    onStatus: () => {}, onState: () => {}, onOperator: () => {}, onGameEnd: () => {} };
  w2.Net = fakeNet2;
  w2.eval(appCode);
  w2.document.dispatchEvent(new w2.Event('DOMContentLoaded', { bubbles: true }));
  const room2 = w2.document.getElementById('net-room');
  assert(room2.style.display === 'none', '成员端隐藏 #net-room（因此二维码不展示）');

  console.log('\n== 测试5: 离线单机不显示二维码 ==\n');
  const dom3 = new JSDOM(html2, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w3 = dom3.window;
  w3.eval(fs.readFileSync(path.join(ROOT, 'js/qrcode.js'), 'utf8'));
  w3.eval(fs.readFileSync(path.join(ROOT, 'js/rules.js'), 'utf8'));
  w3.eval(fs.readFileSync(path.join(ROOT, 'js/storage.js'), 'utf8'));
  const fakeNet3 = { init: () => {}, install: () => {}, setName: () => {}, memberName: () => 'L',
    isOnline: () => false, isInRoom: () => false, isHost: () => false,
    memberCount: () => 1, operatorName: () => null, amOperator: () => false,
    requestAction: (n, cb) => cb && cb(null, true), releaseAction: () => {}, leaveRoom: () => {}, endGame: () => {},
    onStatus: () => {}, onState: () => {}, onOperator: () => {}, onGameEnd: () => {} };
  w3.Net = fakeNet3;
  w3.eval(appCode);
  w3.document.dispatchEvent(new w3.Event('DOMContentLoaded', { bubbles: true }));
  const qr3 = w3.document.getElementById('net-room-qr');
  assert(qr3.style.display === 'none', '单机时隐藏二维码');

  console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
