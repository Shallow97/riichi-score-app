/**
 * qr-scan-test.js — 首页"扫描二维码加入"专项测试
 *
 * 功能：首页「加入」按钮旁新增「扫码」按钮，点击后打开扫码弹窗用摄像头取景，
 *       逐帧用 jsQR 解码，命中后把二维码文本交给既有的 joinRemoteRoom（加入流程零分叉）。
 *
 * 覆盖：
 *  1. 入口与弹窗结构（按钮在「加入」旁边、弹窗默认隐藏、含 video/状态/关闭按钮）
 *  2. 二维码文本解析：完整链接 / 裸 IP / 带端口 / 带空白；非对局二维码与空内容报错
 *  3. 点击扫码 → 打开弹窗 + 申请摄像头（后置优先、不要音频）+ 画面挂到 video + 启动轮询
 *  4. 解码命中 → 释放摄像头 + 关弹窗 + 跳转到解出的房主地址
 *  5. 扫到别的二维码 → 不跳转、告警提示、摄像头保留（可继续扫）
 *  6. 摄像头权限被拒 → 关弹窗 + 加入区告警提示 + 不跳转
 *  7. 环境不支持摄像头（无 mediaDevices）→ 提示手动输入，不抛异常
 *  8. 关闭弹窗（点 ×）→ 立即释放摄像头
 *  9. 解码库缺失 → 明确提示，不打开弹窗
 *
 * 运行：NODE_PATH=<workspace>/node_modules node qr-scan-test.js
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
const delay = (ms) => new Promise((r) => setTimeout(r, ms || 20));

async function main() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:8765/?host=1&lanip=192.168.0.101',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;

  // --- jsdom 不做布局也不实现画布：给出最小可用的 2D 上下文桩 ---
  window.HTMLCanvasElement.prototype.getContext = function () {
    return {
      drawImage() {},
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    };
  };
  // jsdom 的 play()/pause() 未实现（会刷"not implemented"），打桩保持输出干净
  window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
  window.HTMLMediaElement.prototype.pause = function () {};

  window.eval(fs.readFileSync(path.join(ROOT, 'js/rules.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/storage.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/net.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/qrcode.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8'));
  document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

  const input = document.getElementById('join-ip');
  const joinBtn = document.getElementById('btn-join-room');
  const scanBtn = document.getElementById('btn-scan-qr');
  const tip = document.getElementById('join-tip');
  const modal = document.getElementById('modal-scanqr');
  const video = document.getElementById('qr-video');
  const status = document.getElementById('scan-status');

  // 跳转出口打桩，避免 jsdom 的 navigation 未实现报错
  let navUrl = null;
  window.JoinRoom.setNavigate((u) => { navUrl = u; });

  // fetch 打桩：默认可达（扫码成功即应跳转）
  let fetchMode = 'ok';
  window.fetch = () => (fetchMode === 'ok'
    ? Promise.resolve({ ok: true, status: 200 })
    : Promise.reject(new Error('connect failed')));

  // 摄像头打桩：记录调用与 track.stop，便于断言"用完是否释放"
  let gumCalls = [];
  let gumMode = 'ok';             // 'ok' | 'deny' | 'hang'
  let trackStops = 0;
  window.navigator.mediaDevices = {
    getUserMedia: (constraints) => {
      gumCalls.push(constraints);
      if (gumMode === 'hang') return new Promise(() => {});   // 模拟系统授权框还挂着
      if (gumMode === 'deny') {
        const e = new Error('Permission denied');
        e.name = 'NotAllowedError';
        return Promise.reject(e);
      }
      return Promise.resolve({
        getTracks: () => [{ stop: () => { trackStops++; } }],
      });
    },
  };

  // 解码器打桩：jsQR 返回 null 表示这一帧没看到码
  let qrResult = null;
  let jsqrCalls = 0;
  window.jsQR = () => { jsqrCalls++; return qrResult; };

  // video 尺寸：jsdom 里恒为 0，模拟"摄像头已出流"
  Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true });
  Object.defineProperty(video, 'videoHeight', { value: 480, configurable: true });

  console.log('\n== 1: 入口与弹窗结构 ==\n');
  assert(!!scanBtn, '首页存在扫码按钮 #btn-scan-qr');
  assert(/扫码/.test(scanBtn.textContent), '按钮文案含「扫码」：' + scanBtn.textContent.trim());
  const row = joinBtn.parentElement;
  assert(row && row.classList.contains('net-joinroom-row'), '「加入」按钮位于加入区行内');
  assert(scanBtn.parentElement === row && joinBtn.nextElementSibling === scanBtn,
    '扫码按钮紧跟在「加入」按钮右（同一行、相邻）');
  assert(!!modal && !modal.classList.contains('show'), '扫码弹窗存在且默认隐藏');
  assert(!!video && !!status && !!document.getElementById('btn-scan-close'),
    '扫码弹窗含 video / 状态提示 / 关闭按钮');
  assert(scanBtn.querySelector('svg'), '按钮内带相机图标（窄屏也能一眼认出）');

  console.log('\n== 2: 二维码文本解析 ==\n');
  const P = window.JoinRoom.parseScan;
  let r = P('http://192.168.0.101:8765/');
  assert(r.ok && r.host === '192.168.0.101' && r.port === '8765' && r.url === 'http://192.168.0.101:8765/',
    '房主二维码完整链接 → ' + (r.url || r.error));
  r = P('192.168.0.77');
  assert(r.ok && r.url === 'http://192.168.0.77:8765/', '裸 IP 自动补默认端口');
  r = P('  http://10.0.0.5:9000/\n');
  assert(r.ok && r.url === 'http://10.0.0.5:9000/', '首尾空白/换行容错（相机解出的文本常带空白）');
  r = P('WIFI:S:MyNet;T:WPA;P:12345678;;');
  assert(!r.ok && /不是对局二维码/.test(r.error), '扫到 WiFi 码等无效内容 → ' + r.error);
  r = P('');
  assert(!r.ok, '空内容报错：' + r.error);
  r = P('vCard:这是一张名片，内容很长很长很长很长很长很长很长很长很长很长很长很长');
  assert(!r.ok && r.error.length < 90,
    '无法识别时提示里的原文被截断（' + r.error.length + ' 字），不会撑破提示条');

  console.log('\n== 3: 点击扫码 → 开弹窗 + 申请摄像头 ==\n');
  gumCalls = []; navUrl = null;
  scanBtn.click();
  await delay(40);
  assert(modal.classList.contains('show'), '弹窗已打开');
  assert(gumCalls.length === 1, '调用了摄像头取流（1 次）');
  const c0 = gumCalls[0] || {};
  assert(c0.audio === false, '只取视频、不要音频（audio:false）');
  assert(c0.video && c0.video.facingMode && c0.video.facingMode.ideal === 'environment',
    '优先后置摄像头：' + JSON.stringify(c0.video));
  assert(video.srcObject, '摄像头画面已挂到 <video> 上');
  assert(/放入框内/.test(status.textContent), '状态提示引导对准二维码：' + status.textContent);

  console.log('\n== 4: 扫到房主二维码 → 加入 ==\n');
  qrResult = { data: 'http://192.168.0.50:8765/' };
  jsqrCalls = 0; trackStops = 0; navUrl = null;
  await delay(400);   // 等解码轮询（150ms 一次）跑几轮
  assert(jsqrCalls > 0, '正在逐帧解码（已调用 jsQR ' + jsqrCalls + ' 次）');
  assert(navUrl === 'http://192.168.0.50:8765/', '跳转到二维码里的房主地址：' + navUrl);
  assert(trackStops >= 1, '命中后立即释放摄像头（track.stop 调用 ' + trackStops + ' 次）');
  assert(!modal.classList.contains('show'), '命中后自动关闭弹窗');

  console.log('\n== 5: 扫到非对局二维码 → 告警且不关摄像头，可继续扫 ==\n');
  qrResult = null; gumCalls = []; navUrl = null;
  scanBtn.click();
  await delay(40);
  qrResult = { data: 'WIFI:S:MyNet;T:WPA;P:12345678;;' };
  await delay(400);
  assert(navUrl === null, '非对局内容不跳转');
  assert(/不是对局二维码/.test(status.textContent) && status.className.includes('warn'),
    '弹窗内提示内容无法识别：' + status.textContent);
  assert(modal.classList.contains('show'), '弹窗仍开着，可以接着扫下一个码');
  trackStops = 0;
  document.getElementById('btn-scan-close').click();
  await delay(20);
  assert(trackStops >= 1, '随后关闭弹窗仍会释放摄像头');

  console.log('\n== 6: 摄像头权限被拒 ==\n');
  gumMode = 'deny'; navUrl = null; qrResult = null;
  scanBtn.click();
  await delay(60);
  assert(!modal.classList.contains('show'), '被拒后不留在空弹窗里');
  assert(navUrl === null, '被拒后不跳转');
  assert(tip.className.includes('warn') && /摄像头权限被拒绝/.test(tip.textContent),
    '加入区给出权限提示：' + tip.textContent);

  console.log('\n== 7: 环境不支持摄像头 ==\n');
  const md = window.navigator.mediaDevices;
  delete window.navigator.mediaDevices;
  navUrl = null;
  let threw = false;
  try { scanBtn.click(); } catch (e) { threw = true; }
  await delay(40);
  assert(!threw, '缺少摄像头 API 时不抛异常');
  assert(tip.className.includes('warn') && /摄像头|手动输入/.test(tip.textContent),
    '提示改为手动输入：' + tip.textContent);
  assert(!modal.classList.contains('show'), '不支持时不打开弹窗');
  window.navigator.mediaDevices = md;

  console.log('\n== 8: 关闭弹窗立即释放摄像头 ==\n');
  gumMode = 'ok'; trackStops = 0; qrResult = null;
  scanBtn.click();
  await delay(40);
  assert(trackStops === 0, '扫码中摄像头仍在使用');
  modal.querySelector('.close-x').click();
  await delay(20);
  assert(!modal.classList.contains('show'), '点 × 关闭弹窗');
  assert(trackStops >= 1, '关闭时释放摄像头（track.stop ' + trackStops + ' 次）');

  console.log('\n== 9: 解码库缺失 ==\n');
  const savedQR = window.jsQR;
  window.jsQR = undefined;
  tip.className = 'net-joinroom-tip'; tip.textContent = '';
  navUrl = null;
  scanBtn.click();
  await delay(30);
  assert(!modal.classList.contains('show'), '解码库缺失时不打开弹窗');
  assert(/扫码组件未加载/.test(tip.textContent), '给出明确提示：' + tip.textContent);
  window.jsQR = savedQR;

  console.log('\n== 10: 系统授权框期间，点空白不会误关扫码窗 ==\n');
  // 首次使用会弹系统相机授权框，用户在授权框上那一下可能穿透到页面把扫码窗关掉
  gumMode = 'hang'; navUrl = null;
  scanBtn.click();
  await delay(40);
  assert(modal.classList.contains('show'), '授权未返回时扫码窗开着');
  modal.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));   // 点在遮罩空白处
  await delay(20);
  assert(modal.classList.contains('show'), '点空白被忽略，扫码窗不被误关');
  document.getElementById('btn-scan-close').click();
  await delay(20);
  assert(!modal.classList.contains('show'), '显式点「关闭」仍然有效');
  gumMode = 'ok';

  console.log('\n== 11: 手动输入加入仍然可用（未被扫码改动破坏） ==\n');  navUrl = null; fetchMode = 'ok';
  input.value = '192.168.0.60';
  joinBtn.click();
  await delay(30);
  assert(navUrl === 'http://192.168.0.60:8765/', '手动输入 IP 仍可正常加入：' + navUrl);

  console.log('\n====================================');
  console.log('扫描二维码加入专项测试: ' + pass + ' 通过，' + fail + ' 失败');
  console.log('====================================');
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
