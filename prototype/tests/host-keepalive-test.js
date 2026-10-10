/**
 * host-keepalive-test.js — 页面隐藏期间不得"自我踢下线"（批次 3 真机缺陷的回归）
 *
 * 真机实测（小米14，2026-10-03）：
 *   房主 App 锁屏/切后台后，WebView 会挂起页面的任务投递 —— 页面既收不到服务器 ping，
 *   也收不到 socket 的 close 事件。旧版 net.js 的死链看门狗只看"多久没收到消息"，
 *   于是在隐藏期间把还活着的连接判死并 close；更糟的是重连定时器同样被挂起，
 *   页面在整段锁屏期间都回不来（成员端一直显示"房主暂时离开"）。
 *
 * 本测试用受控假 WebSocket 秒级复现，并锁死修复后的四条行为：
 *   A. 可见 + 长时间无消息 → 仍按空闲超时判死并重连（原有行为不许退化）
 *   B. 隐藏 + 长时间无消息 → **不判死**（静默不等于断链）
 *   C. 恢复可见 + 探活无回音 → 立即发 ping 探活，探不通才重连（真死链仍能救回）
 *   D. 恢复可见 + ping 被回 pong → 保持连接，不做多余重连
 *
 * 运行：cd prototype/tests && node host-keepalive-test.js
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ FAIL: ' + msg); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------
// 1) 最小运行环境：net.js 只在浏览器/WebView 里跑，这里补齐它的全局
// ------------------------------------------------------------
const visListeners = [];
const fakeDoc = {
  hidden: false,
  __riichiVisProbe: false,
  addEventListener(type, fn) { if (type === 'visibilitychange') visListeners.push(fn); },
};
global.location = { protocol: 'http:', host: '127.0.0.1:8765', search: '?host=1' };
global.document = fakeDoc;

// 受控假 WebSocket：不连网络，只在测试手里收发
const sockets = [];
class FakeWS {
  constructor(url) {
    this.url = url;
    this.readyState = 0;          // CONNECTING
    this.sent = [];
    this.closed = false;
    sockets.push(this);
    setTimeout(() => {
      if (this.closed) return;
      this.readyState = 1;        // OPEN
      if (this.onopen) this.onopen();
    }, 0);
  }
  send(d) { if (this.readyState === 1) this.sent.push(d); }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    if (this.onclose) this.onclose();
  }
  emit(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
}
global.WebSocket = FakeWS;

const Net = require(path.join(ROOT, 'js', 'net.js'));

const WELCOME = {
  type: 'welcome', role: 'host', state: null, seq: 0,
  operator: null, hostOnline: true, hostSeen: true, members: 1,
};
const cur = () => sockets[sockets.length - 1];
const pingsOf = (s) => s.sent.map((x) => { try { return JSON.parse(x); } catch (e) { return {}; } })
  .filter((m) => m.type === 'ping');

/** 等到最新连接处于 OPEN 且已收到 welcome（在线态） */
async function onlineSock(timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeout || 800)) {
    const s = cur();
    if (s && s.readyState === 1 && !s.closed) {
      s.emit(WELCOME);
      await sleep(5);
      if (Net.isInRoom()) return s;
    }
    await sleep(5);
  }
  return null;
}

(async () => {
  // 时序全部压到毫秒级：发 ping 周期放很长（不干扰），看门狗 30ms 一轮，空闲阈值 120ms
  Net.__setTimings({
    sendMs: 100000, watchMs: 30, idleMs: 120,
    reconnectMinMs: 15, reconnectMaxMs: 30,
  });
  Net.init();
  await sleep(5);
  ok(sockets.length === 1, '初始建立 1 条连接');
  ok(Net.isHost() === true, '识别为房主（url 带 ?host=1）');
  sockets[0].emit(WELCOME);
  await sleep(5);
  ok(Net.isInRoom() === true, '收到 welcome 后进入在线态');

  // ---------- A. 可见 + 无消息 → 空闲超时判死并重连 ----------
  const nA = sockets.length, sA = cur();
  await sleep(400);
  ok(sockets.length > nA, 'A 可见且长时间无消息 → 判死并重连（原有行为未退化）');
  ok(sA.closed === true, 'A 旧连接已被关闭');
  ok(await onlineSock() !== null, 'A 重连后重新在线');

  // ---------- B. 隐藏 + 无消息 → 不判死 ----------
  fakeDoc.hidden = true;
  const sB = cur(), nB = sockets.length;
  await sleep(500);
  ok(sockets.length === nB, 'B 隐藏期间无消息 → 不重连（静默不等于断链）');
  ok(sB.closed === false && sB.readyState === 1, 'B 隐藏期间原连接保持打开');
  ok(Net.isLocked() === false, 'B 隐藏期间不会被误标成掉线锁定');

  // ---------- C. 恢复可见 + 探活无回音 → 重连 ----------
  fakeDoc.hidden = false;
  const sC = cur(), nC = sockets.length;
  visListeners.forEach((fn) => fn());
  await sleep(5);
  ok(pingsOf(sC).length >= 1, 'C 恢复可见时主动发 ping 探活');
  await sleep(400);
  ok(sockets.length > nC, 'C 探活无回音 → 判死并重连（真死链仍能救回）');
  ok(await onlineSock() !== null, 'C 重连后重新在线');

  // ---------- D. 恢复可见 + 有回音 → 不重连 ----------
  const sD = cur();
  fakeDoc.hidden = true;
  await sleep(200);
  ok(sD.closed === false, 'D 再次隐藏后连接仍保持');
  fakeDoc.hidden = false;
  const nD = sockets.length;
  visListeners.forEach((fn) => fn());
  // 模拟"链路其实是好的"：服务器对 ping 必回 pong，且持续有 ping 往返
  const echo = setInterval(() => { try { sD.emit({ type: 'pong', ts: Date.now() }); } catch (e) {} }, 40);
  await sleep(400);
  clearInterval(echo);
  ok(sockets.length === nD, 'D 探活有回音 → 保持连接，不做多余重连');
  ok(sD.closed === false, 'D 连接未被关闭');
  ok(Net.isLocked() === false, 'D 全程未被锁定');

  console.log('\n====================================');
  console.log('host keepalive 测试: ' + pass + ' 通过，' + fail + ' 失败');
  console.log('====================================');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('脚本异常:', e); process.exit(1); });
