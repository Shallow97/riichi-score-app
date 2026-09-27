/**
 * net-integration.js — 无房间码联网集成测试
 *
 * 用真实 WebSocket 客户端连接 serve.js（无房间码·操作权互斥），验证：
 *   1. 房主(?host=1)连接 → room-created isHost=true
 *   2. 成员连接 → joined isHost=false，且无房间码
 *   3. 房主广播权威状态 → 成员收到一致状态
 *   4. 新成员加入时能拿到当前权威态
 *   5. 成员申请操作权 → granted；另一成员申请 → denied(by=操作者名)
 *   6. 释放操作权 → operator-change=null → 另一成员再申请成功
 *   7. 房主断开 → 成员收到 host-left
 *
 * 每个用例启动一个独立端口上的独立服务器实例，用例结束即关闭，
 * 并用 Promise 串行化（避免回调嵌套导致的重复执行），结果可重复。
 *
 * 运行：node tests/net-integration.js
 */
const WebSocket = require('ws');
const assert = require('assert');
const path = require('path');

const { createServer } = require(path.join(__dirname, '..', 'serve.js'));

let pass = 0, fail = 0;
function ok(name) { pass++; console.log('  ✓ ' + name); }
function bad(name, e) { fail++; console.log('  ✗ ' + name + ' — ' + (e && e.message)); }
function wsc(url) { return new WebSocket(url); }
function closeAll(...sockets) { for (const s of sockets) { try { s.close(); } catch (e) {} } }

// 在指定端口启动服务器，返回 { server, port }
function startServer(port) {
  return new Promise((resolve) => {
    const server = createServer(port, () => resolve({ server, port }));
  });
}

// 包装 socket：从创建起就缓存所有消息，避免 open 之前到达的消息被错过
function wrap(socket) {
  const queue = [];
  const waiters = [];
  socket.on('message', (d) => {
    let m; try { m = JSON.parse(d.toString()); } catch { return; }
    // 找到第一个 pred 匹配的 waiter；没有则入队
    const wi = waiters.findIndex((w) => w.pred(m));
    if (wi >= 0) { const w = waiters.splice(wi, 1)[0]; w.resolve(m); }
    else queue.push(m);
  });
  socket.__waitMsg = (pred, timeout = 4000) => new Promise((resolve, reject) => {
    const qi = queue.findIndex(pred);
    if (qi >= 0) { resolve(queue.splice(qi, 1)[0]); return; }
    const timer = setTimeout(() => {
      const wi = waiters.findIndex((w) => w._timer === timer);
      if (wi >= 0) waiters.splice(wi, 1);
      reject(new Error('等待消息超时'));
    }, timeout);
    waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); }, _timer: timer });
  });
  return socket;
}
// socket 连接建立
function waitOpen(socket, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('连接超时')); }, timeout);
    if (socket.readyState === WebSocket.OPEN) { clearTimeout(timer); return resolve(); }
    socket.once('open', () => { clearTimeout(timer); resolve(); });
  });
}

async function testHostMemberFlow() {
  const { server, port } = await startServer(8801);
  console.log('\n== 测试: 房主(host=1)与成员自动连接 ==');
  const host = wrap(wsc('ws://localhost:' + port + '/ws?host=1'));
  const member = wrap(wsc('ws://localhost:' + port + '/ws'));
  try {
    await waitOpen(host); await waitOpen(member);
    const rc = await host.__waitMsg( (m) => m.type === 'room-created');
    ok('房主连接即被识别（isHost=true）');
    assert.strictEqual(rc.isHost, true);
    await host.__waitMsg( (m) => m.type === 'member-count');
    ok('房主收到成员加入通知');

    member.send(JSON.stringify({ type: 'set-name', name: '小明' }));
    host.send(JSON.stringify({ type: 'host-state', state: '{"round":"东1局","p":1}' }));

    const j = await member.__waitMsg( (m) => m.type === 'joined');
    ok('成员连接即加入（isHost=false），无需房间码');
    assert.strictEqual(j.isHost, false);
    const st = await member.__waitMsg( (m) => m.type === 'state');
    ok('成员收到房主广播状态: ' + st.state);
    assert.strictEqual(st.state, '{"round":"东1局","p":1}');

    const m2 = wrap(wsc('ws://localhost:' + port + '/ws'));
    await waitOpen(m2);
    const j2 = await m2.__waitMsg( (m) => m.type === 'joined');
    ok('新成员加入即拿到当前权威态: ' + j2.state);
    assert.strictEqual(j2.state, '{"round":"东1局","p":1}');
    closeAll(host, member, m2);
  } catch (e) { bad('房主-成员流程', e); }
  finally { closeAll(host, member); try { server.close(); } catch (e) {} }
}

async function testActionLock() {
  const { server, port } = await startServer(8802);
  console.log('\n== 测试: 操作权互斥（无房间码）==');
  const host = wrap(wsc('ws://localhost:' + port + '/ws?host=1'));
  const m1 = wrap(wsc('ws://localhost:' + port + '/ws'));
  const m2 = wrap(wsc('ws://localhost:' + port + '/ws'));
  try {
    await waitOpen(host); await waitOpen(m1); await waitOpen(m2);
    await host.__waitMsg( (m) => m.type === 'room-created');
    await m1.__waitMsg( (m) => m.type === 'joined');

    m1.send(JSON.stringify({ type: 'request-action', name: '小明' }));
    const g1 = await m1.__waitMsg( (m) => m.type === 'action-granted');
    ok('成员1申请操作权被授予');

    m2.send(JSON.stringify({ type: 'request-action', name: '小红' }));
    const denied = await m2.__waitMsg( (m) => m.type === 'action-denied');
    ok('成员2申请被拒绝（by=' + denied.by + '）');
    assert.strictEqual(denied.by, '小明');

    m1.send(JSON.stringify({ type: 'release-action' }));
    const oc = await m2.__waitMsg( (m) => m.type === 'operator-change' && m.name === null);
    ok('操作权释放后广播 operator-change=null');

    m2.send(JSON.stringify({ type: 'request-action', name: '小红' }));
    const g2 = await m2.__waitMsg( (m) => m.type === 'action-granted');
    ok('操作权释放后，成员2再次申请成功');
    closeAll(host, m1, m2);
  } catch (e) { bad('操作权互斥流程', e); }
  finally { closeAll(host, m1, m2); try { server.close(); } catch (e) {} }
}

async function testHostLeft() {
  const { server, port } = await startServer(8803);
  console.log('\n== 测试: 房主断开解散 ==');
  const host = wrap(wsc('ws://localhost:' + port + '/ws?host=1'));
  const member = wrap(wsc('ws://localhost:' + port + '/ws'));
  try {
    await waitOpen(host); await waitOpen(member);
    await host.__waitMsg( (m) => m.type === 'room-created');
    const hlPromise = member.__waitMsg( (m) => m.type === 'host-left');
    host.close();
    await hlPromise;
    ok('房主断开，成员收到房间解散通知');
  } catch (e) { bad('房主断开流程', e); }
  finally { closeAll(host, member); try { server.close(); } catch (e) {} }
}

async function testMemberToHostBroadcast() {
  const { server, port } = await startServer(8804);
  console.log('\n== 测试(回归): 成员(操作者)提交状态 → 房主也能收到 ==');
  const host = wrap(wsc('ws://localhost:' + port + '/ws?host=1'));
  const member = wrap(wsc('ws://localhost:' + port + '/ws'));
  try {
    await waitOpen(host); await waitOpen(member);
    await host.__waitMsg( (m) => m.type === 'room-created');
    await member.__waitMsg( (m) => m.type === 'joined');

    // 成员申请操作权
    member.send(JSON.stringify({ type: 'request-action', name: '小明' }));
    await member.__waitMsg( (m) => m.type === 'action-granted');
    ok('成员申请到操作权');

    // 成员(操作者)提交权威态 → 房主必须收到（修复点：broadcastState 之前漏发 host）
    member.send(JSON.stringify({ type: 'host-state', state: '{"round":"东2局","from":"member"}' }));
    const toHost = await host.__waitMsg( (m) => m.type === 'state', 2000);
    ok('成员提交状态 → 房主收到权威态: ' + toHost.state);
    assert.strictEqual(toHost.state, '{"round":"东2局","from":"member"}');

    // 另一个成员也应收到（验证仍会广播给其他成员）
    const m2 = wrap(wsc('ws://localhost:' + port + '/ws'));
    await waitOpen(m2);
    await m2.__waitMsg( (m) => m.type === 'joined');
    m2.send(JSON.stringify({ type: 'host-state', state: '{"x":2}' })); // 非操作者提交无效
    // 房主确认 m2 提交被忽略（不广播）
    let gotBadState = false;
    host.on('message', (d) => { try { const mm = JSON.parse(d.toString()); if (mm.type === 'state' && mm.state === '{"x":2}') gotBadState = true; } catch (e) {} });
    await new Promise((r) => setTimeout(r, 300));
    ok('非操作者成员提交被服务器忽略（不广播）', !gotBadState);
    closeAll(host, member, m2);
  } catch (e) { bad('成员→房主广播', e); }
  finally { closeAll(host, member); try { server.close(); } catch (e) {} }
}

async function testGameEndBroadcast() {
  const { server, port } = await startServer(8805);
  console.log('\n== 测试(回归): 房主结束对局 → 成员收到 game-end 及归档记录 ==');
  const host = wrap(wsc('ws://localhost:' + port + '/ws?host=1'));
  const member = wrap(wsc('ws://localhost:' + port + '/ws'));
  try {
    await waitOpen(host); await waitOpen(member);
    await host.__waitMsg( (m) => m.type === 'room-created');
    await member.__waitMsg( (m) => m.type === 'joined');

    const rec = { id: 'g1', finishedAt: '2026-09-01T12:00:00Z', mode: 4, endReason: '南四局结束', history: [] };
    host.send(JSON.stringify({ type: 'game-end', record: rec }));
    const ge = await member.__waitMsg( (m) => m.type === 'game-end');
    ok('房主结束对局 → 成员收到 game-end');
    assert.strictEqual(ge.record.id, 'g1');
    assert.strictEqual(ge.record.endReason, '南四局结束');

    // 非房主（成员）发送 game-end 应被忽略
    const m2 = wrap(wsc('ws://localhost:' + port + '/ws'));
    await waitOpen(m2);
    await m2.__waitMsg( (m) => m.type === 'joined');
    let gotBadEnd = false;
    host.on('message', (d) => { try { const mm = JSON.parse(d.toString()); if (mm.type === 'game-end') gotBadEnd = true; } catch (e) {} });
    m2.send(JSON.stringify({ type: 'game-end', record: { id: 'x' } }));
    await new Promise((r) => setTimeout(r, 300));
    ok('非房主发送 game-end 被服务器忽略（不广播）', !gotBadEnd);
    closeAll(host, member, m2);
  } catch (e) { bad('房主结束对局广播', e); }
  finally { closeAll(host, member); try { server.close(); } catch (e) {} }
}

// 串行执行
(async () => {
  await testHostMemberFlow();
  await testActionLock();
  await testHostLeft();
  await testMemberToHostBroadcast();
  await testGameEndBroadcast();
  console.log('\n====================================');
  console.log('无房间码联网集成测试: ' + pass + ' 通过，' + fail + ' 失败');
  console.log('====================================');
  process.exit(fail === 0 ? 0 : 1);
})();
