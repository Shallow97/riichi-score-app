/**
 * op-lease-test.js — 操作权租约：持有者被系统挂起时，服务器必须回收它占着的操作权槽位。
 *
 * 背景（真机实测，2026-10-03）：
 *   批次 3 给「房主连接」豁免了死链看门狗（房主页面跑在本机、回环链路，真断开由
 *   阻塞 read 返回 -1 走 onDisconnected 清理）。于是房主一锁屏，链路还是活的、
 *   页面却既收不到 ping 也发不出任何消息 —— 若房主此刻正持有操作权（例如打开了
 *   结算弹窗后手机自动息屏），槽位就被**永久占死**：成员端按钮全灰、文案
 *   「XXX 正在结算/操作，请稍候」，实测 90 秒后仍申请不到。
 *
 * 修复：hbWatch 增加「操作权租约」——持有者超过 OP_LEASE_MS 没有任何上行消息，
 *       就释放操作权（**只释放槽位，绝不 close 连接**：房主连接可能只是被挂起）。
 *
 * 本测试直接 require 真实 serve.js 并驱动真实协议（裸 ws 客户端，便于精确控制
 * 「谁在什么时候说了话」）。租期通过环境变量压到 1.2s 以便秒级验证。
 *
 * 运行：cd prototype/tests && node op-lease-test.js
 */
process.env.RIICHI_OP_LEASE_MS = '1200';   // ⚠️ 必须在 require ../serve.js 之前设置
const { createServer } = require('../serve.js');
const WebSocket = require('ws');

const PORT = 8777;
// serve.js 的检查周期固定 5000ms（HB_CHECK_MS），租期 1.2s 时最长需等 ~6.2s 才被观察到
const OVER_CHECK = 6500;

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ FAIL: ' + msg); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClient(name, isHost) {
  const url = `ws://127.0.0.1:${PORT}/ws` + (isHost ? '?host=1' : '');
  const ws = new WebSocket(url);
  const c = { ws, name, open: false, granted: 0, denied: 0, opChanges: [], closed: false, welcomes: [] };
  ws.on('open', () => { c.open = true; });
  ws.on('close', () => { c.closed = true; });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'action-granted') c.granted++;
    else if (m.type === 'action-denied') c.denied++;
    else if (m.type === 'operator-change') c.opChanges.push(m.name);
    else if (m.type === 'welcome') c.welcomes.push(m);
  });
  return c;
}
async function waitOpen(c, t = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) { if (c.open) return true; await sleep(20); }
  return false;
}
const tell = (c, obj) => { try { c.ws.send(JSON.stringify(obj)); } catch (e) {} };
const lastOp = (c) => (c.opChanges.length ? c.opChanges[c.opChanges.length - 1] : undefined);

(async () => {
  const server = createServer(PORT, () => {});
  await sleep(300);

  // ── 用例 1：正常授予 ──
  console.log('\n[用例 1] 正常申请操作权');
  const A = makeClient('A');
  assert(await waitOpen(A), '客户端 A 已连上');
  const observer = makeClient('OBS');
  assert(await waitOpen(observer), '旁观客户端 OBS 已连上');
  tell(A, { type: 'request-action', name: 'A' });
  await sleep(400);
  assert(A.granted === 1, 'A 收到 action-granted');
  assert(A.denied === 0, 'A 未被拒绝');
  assert(lastOp(observer) === 'A', 'OBS 观察到 operator-change → A');

  // ── 用例 2：持有者持续活跃 → 租约不生效（不能误伤"开着弹窗慢慢填表"的人）──
  console.log('\n[用例 2] 持有者持续有上行消息 → 跨过租期也不释放');
  const beforeChanges = A.opChanges.length;
  // 跑满一个检查周期（5s），期间每 400ms 说一次话
  for (let i = 0; i < Math.ceil(OVER_CHECK / 400); i++) {
    tell(A, { type: 'ping', ts: Date.now() });
    await sleep(400);
  }
  const nullSeen = A.opChanges.slice(beforeChanges).some((n) => n === null);
  assert(!nullSeen, '活跃持有者期间没有出现 operator-change → null（未误释放）');
  tell(A, { type: 'release-action' });   // 归还，避免影响后续用例
  await sleep(300);
  // 重新授予，供用例 3 使用
  tell(A, { type: 'request-action', name: 'A' });
  await sleep(300);
  assert(A.granted === 2, 'A 重新申请成功（重置现场）');

  // ── 用例 3：持有者静默 → 租约到期自动释放，且广播出去 ──
  console.log('\n[用例 3] 持有者静默超过租期 → 自动释放并广播');
  const changesBeforeIdle = observer.opChanges.length;
  await sleep(OVER_CHECK);   // 期间 A 一个字都不发（模拟页面被系统挂起）
  const idleChanges = observer.opChanges.slice(changesBeforeIdle);
  assert(idleChanges.includes(null), 'OBS 收到 operator-change → null（槽位已回收）');
  assert(!A.closed, '⚠️ A 的连接**没有**被断开（只释放操作权，不 close）');

  // ── 用例 4：释放后别人能拿到操作权 ──
  console.log('\n[用例 4] 槽位释放后，另一台设备可以拿到操作权');
  const B = makeClient('B');
  assert(await waitOpen(B), '客户端 B 已连上');
  tell(B, { type: 'request-action', name: 'B' });
  await sleep(400);
  assert(B.granted === 1, 'B 申请操作权 → granted（不再被死槽位挡住）');
  assert(B.denied === 0, 'B 未被拒绝');
  tell(B, { type: 'release-action' });
  await sleep(300);

  // ── 用例 5：租约同样作用于「挂着操作权的房主」，且房主连接保持 ──
  console.log('\n[用例 5] 房主持有操作权后静默 → 同样被回收，但房主连接保留');
  const H = makeClient('Host', true);
  assert(await waitOpen(H), '房主连接已建立（?host=1）');
  await sleep(300);
  tell(H, { type: 'request-action', name: 'Host' });
  await sleep(400);
  assert(H.granted === 1, '房主拿到操作权');
  const hChanges = observer.opChanges.length;
  await sleep(OVER_CHECK);   // 房主"锁屏"：一个字都不发
  assert(observer.opChanges.slice(hChanges).includes(null), '房主的操作权也被租约回收');
  assert(!H.closed, '⚠️ 房主连接**没有**被断开（锁屏期间必须保持在线）');
  const welcome = H.welcomes[0];
  assert(!!welcome && welcome.role === 'host', '房主身份未被剥夺（welcome.role=host）');

  // ── 用例 6：被回收后，房主自己再申请也能立刻拿回来（人醒了）──
  console.log('\n[用例 6] 房主恢复活动后可重新拿回操作权');
  tell(H, { type: 'request-action', name: 'Host' });
  await sleep(400);
  assert(H.granted === 2, '房主重新申请 → granted');
  tell(H, { type: 'release-action' });

  [A, B, H, observer].forEach((c) => { try { c.ws.close(); } catch (e) {} });
  await sleep(200);
  server.close();

  console.log('\n================');
  console.log(`通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
