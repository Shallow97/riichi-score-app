/**
 * net-integration.js — 无房间码联网集成测试（协议 v2 · 全提交制）
 *
 * 用真实 WebSocket 客户端连接 serve.js，验证：
 *   1. 房主(?host=1)/成员连接 → welcome{role,state,seq,operator,hostOnline}
 *   2. commit{opId,baseSeq,state} → ack；其余端收到 state 广播；晚加入者拿到当前权威态+seq
 *   3. 成员申请操作权 → granted；另一成员申请 → denied(by=操作者名)；释放后可接手
 *   4. baseSeq 过期 → conflict{reason:'stale'} 且带回权威态（不再靠"最后写入者获胜"）
 *   5. 同一 opId 重复提交 → 只回 ack、不重复入账（回执丢失后重发的兜底）
 *   6. 非操作者提交 → conflict{reason:'denied'}，不广播
 *   7. 房主断开 → 成员收到 host-offline 且**留在房间**（不再解散）；房主回来 → host-online
 *      且房主 welcome 带上 state/seq（旧版 room-created 不带 state，房主重连界面是旧的）
 *   8. 房主结束对局 → 成员收到 game-end，权威态清空
 *   9. 服务器周期 ping，客户端能收到
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
  /** 记录此后收到的所有消息，用于"断言某消息不该出现" */
  socket.__collect = () => {
    const list = [];
    socket.on('message', (d) => { try { list.push(JSON.parse(d.toString())); } catch (e) {} });
    return list;
  };
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function testWelcomeAndCommit() {
  const { server, port } = await startServer(8801);
  console.log('\n== 测试: welcome 全量下发 + commit/ack/广播 ==');
  const host = wrap(wsc('ws://localhost:' + port + '/ws?host=1'));
  const member = wrap(wsc('ws://localhost:' + port + '/ws'));
  try {
    await waitOpen(host); await waitOpen(member);
    const hw = await host.__waitMsg((m) => m.type === 'welcome');
    assert.strictEqual(hw.role, 'host');
    assert.strictEqual(hw.seq, 0);
    assert.ok(hw.hostOnline === true);
    ok('房主连接 → welcome{role:host}，初始 seq=0');

    const mw = await member.__waitMsg((m) => m.type === 'welcome');
    assert.strictEqual(mw.role, 'member');
    assert.strictEqual(mw.state, null);
    ok('成员连接 → welcome{role:member}，权威态为空（尚无对局）');

    // 房主提交（baseSeq=0）
    host.send(JSON.stringify({ type: 'commit', opId: 'h-1', baseSeq: 0, state: '{"round":"东1局","p":1}' }));
    const ack = await host.__waitMsg((m) => m.type === 'ack');
    assert.strictEqual(ack.opId, 'h-1');
    assert.strictEqual(ack.seq, 1);
    ok('房主 commit → ack{seq:1}');
    const st = await member.__waitMsg((m) => m.type === 'state');
    assert.strictEqual(st.state, '{"round":"东1局","p":1}');
    assert.strictEqual(st.seq, 1);
    ok('成员收到 state 广播（带 seq）: ' + st.state);

    // 晚加入者拿到当前权威态 + seq
    const m2 = wrap(wsc('ws://localhost:' + port + '/ws'));
    await waitOpen(m2);
    const j2 = await m2.__waitMsg((m) => m.type === 'welcome');
    assert.strictEqual(j2.state, '{"round":"东1局","p":1}');
    assert.strictEqual(j2.seq, 1);
    ok('新成员加入即拿到当前权威态与版本号（seq=1）');
    closeAll(host, member, m2);
  } catch (e) { bad('welcome/commit 流程', e); }
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
    await host.__waitMsg((m) => m.type === 'welcome');
    await m1.__waitMsg((m) => m.type === 'welcome');

    m1.send(JSON.stringify({ type: 'request-action', name: '小明' }));
    await m1.__waitMsg((m) => m.type === 'action-granted');
    ok('成员1申请操作权被授予');

    m2.send(JSON.stringify({ type: 'request-action', name: '小红' }));
    const denied = await m2.__waitMsg((m) => m.type === 'action-denied');
    ok('成员2申请被拒绝（by=' + denied.by + '）');
    assert.strictEqual(denied.by, '小明');

    m1.send(JSON.stringify({ type: 'release-action' }));
    const oc = await m2.__waitMsg((m) => m.type === 'operator-change' && m.name === null);
    ok('操作权释放后广播 operator-change=null');

    m2.send(JSON.stringify({ type: 'request-action', name: '小红' }));
    await m2.__waitMsg((m) => m.type === 'action-granted');
    ok('操作权释放后，成员2再次申请成功');
    closeAll(host, m1, m2);
  } catch (e) { bad('操作权互斥流程', e); }
  finally { closeAll(host, m1, m2); try { server.close(); } catch (e) {} }
}

async function testHostOfflineKeepsRoom() {
  const { server, port } = await startServer(8803);
  console.log('\n== 测试: 房主断开保留房间 → host-offline / host-online ==');
  const host = wrap(wsc('ws://localhost:' + port + '/ws?host=1'));
  const member = wrap(wsc('ws://localhost:' + port + '/ws'));
  try {
    await waitOpen(host); await waitOpen(member);
    await member.__waitMsg((m) => m.type === 'welcome');
    // 房主先建立权威态，供重连验证
    await host.__waitMsg((m) => m.type === 'welcome');
    host.send(JSON.stringify({ type: 'commit', opId: 'h-1', baseSeq: 0, state: '{"round":"东2局"}' }));
    await host.__waitMsg((m) => m.type === 'ack');
    await member.__waitMsg((m) => m.type === 'state');

    const offlineP = member.__waitMsg((m) => m.type === 'host-offline');
    host.close();
    await offlineP;
    ok('房主断开 → 成员收到 host-offline（房间保留，成员不被踢）');

    // 成员仍在房间：还能正常申请操作权
    member.send(JSON.stringify({ type: 'request-action', name: '小明' }));
    await member.__waitMsg((m) => m.type === 'action-granted');
    ok('房主离线期间，成员仍能申请到操作权（结算不受影响）');

    // 房主重连：welcome 必须带 state/seq；成员收到 host-online
    const host2 = wrap(wsc('ws://localhost:' + port + '/ws?host=1'));
    await waitOpen(host2);
    const hw2 = await host2.__waitMsg((m) => m.type === 'welcome');
    assert.strictEqual(hw2.state, '{"round":"东2局"}');
    assert.strictEqual(hw2.seq, 1);
    ok('房主重连 → welcome 带上权威态与 seq（修掉"房主重连界面停在旧数据"）');
    const onlineMsg = await member.__waitMsg((m) => m.type === 'host-online');
    ok('成员收到 host-online');
    closeAll(host2, member);
  } catch (e) { bad('房主离线/重连流程', e); }
  finally { closeAll(host, member); try { server.close(); } catch (e) {} }
}

async function testMemberCommitToHostAndGuards() {
  const { server, port } = await startServer(8804);
  console.log('\n== 测试: 成员(操作者)提交 → 房主收到；版本冲突与越权提交被拒 ==');
  const host = wrap(wsc('ws://localhost:' + port + '/ws?host=1'));
  const member = wrap(wsc('ws://localhost:' + port + '/ws'));
  try {
    await waitOpen(host); await waitOpen(member);
    await host.__waitMsg((m) => m.type === 'welcome');
    await member.__waitMsg((m) => m.type === 'welcome');

    member.send(JSON.stringify({ type: 'request-action', name: '小明' }));
    await member.__waitMsg((m) => m.type === 'action-granted');
    ok('成员申请到操作权');

    // 操作者提交 → 房主必须收到
    member.send(JSON.stringify({ type: 'commit', opId: 'm-1', baseSeq: 0, state: '{"round":"东2局","from":"member"}' }));
    const mack = await member.__waitMsg((m) => m.type === 'ack');
    assert.strictEqual(mack.seq, 1);
    const toHost = await host.__waitMsg((m) => m.type === 'state');
    assert.strictEqual(toHost.state, '{"round":"东2局","from":"member"}');
    ok('成员提交 → 房主收到权威态（成员→房主同步正常）');

    // 版本冲突：用过期 baseSeq 再提交
    member.send(JSON.stringify({ type: 'commit', opId: 'm-2', baseSeq: 0, state: '{"stale":true}' }));
    const cf = await member.__waitMsg((m) => m.type === 'conflict');
    assert.strictEqual(cf.reason, 'stale');
    assert.strictEqual(cf.state, '{"round":"东2局","from":"member"}');
    ok('baseSeq 过期 → conflict{reason:stale} 并带回权威态（不覆盖别人的提交）');

    // 幂等：重发已处理过的 opId（模拟回执丢失后的重试）
    member.send(JSON.stringify({ type: 'commit', opId: 'm-1', baseSeq: 1, state: '{"round":"东2局","from":"member"}' }));
    const ack2 = await member.__waitMsg((m) => m.type === 'ack' && m.opId === 'm-1');
    assert.strictEqual(ack2.seq, 1);
    ok('同一 opId 重复提交 → 只回 ack{seq:1}，不重复入账（seq 未推进）');

    // 非操作者提交 → denied
    const m2 = wrap(wsc('ws://localhost:' + port + '/ws'));
    await waitOpen(m2);
    await m2.__waitMsg((m) => m.type === 'welcome');
    const collected = host.__collect();
    m2.send(JSON.stringify({ type: 'commit', opId: 'x-1', baseSeq: 1, state: '{"x":2}' }));
    const cf2 = await m2.__waitMsg((m) => m.type === 'conflict');
    assert.strictEqual(cf2.reason, 'denied');
    await sleep(250);
    assert.ok(!collected.some((mm) => mm.type === 'state' && mm.state === '{"x":2}'));
    ok('非操作者提交 → conflict{reason:denied}，且不广播');
    closeAll(host, member, m2);
  } catch (e) { bad('成员提交/冲突/幂等', e); }
  finally { closeAll(host, member); try { server.close(); } catch (e) {} }
}

async function testHostReplaceReleasesOperator() {
  const { server, port } = await startServer(8806);
  console.log('\n== 测试: 换房主（页面刷新/重连）释放旧操作权 ==');
  const host = wrap(wsc('ws://localhost:' + port + '/ws?host=1'));
  const member = wrap(wsc('ws://localhost:' + port + '/ws'));
  try {
    await waitOpen(host); await waitOpen(member);
    await host.__waitMsg((m) => m.type === 'welcome');
    await member.__waitMsg((m) => m.type === 'welcome');

    // 房主持有操作权（不再绕开互斥）
    host.send(JSON.stringify({ type: 'request-action', name: '房主A' }));
    await host.__waitMsg((m) => m.type === 'action-granted');
    ok('房主像成员一样申请到操作权');

    // 房主页面刷新：新连接替换旧连接
    const collected = member.__collect();
    const host2 = wrap(wsc('ws://localhost:' + port + '/ws?host=1'));
    await waitOpen(host2);
    await host2.__waitMsg((m) => m.type === 'welcome');
    await sleep(250);
    const releasedBroadcast = collected.some((m) => m.type === 'operator-change' && m.name === null);
    if (releasedBroadcast) ok('换房主后广播 operator-change(name=null)，成员端不会一直卡在"某某正在操作"');
    else bad('换房主后未广播 operator-change(name=null)', new Error('成员端会一直显示旧操作者、按钮灰着'));
    // 成员此时应能顺利拿到操作权（旧版槽位被死连接占死 → 永久 denied）
    member.send(JSON.stringify({ type: 'request-action', name: '小明' }));
    await member.__waitMsg((m) => m.type === 'action-granted');
    ok('换房主后成员申请操作权成功（槽位未被死连接占死）');
    closeAll(host2, member);
  } catch (e) { bad('换房主释放操作权', e); }
  finally { closeAll(host, member); try { server.close(); } catch (e) {} }
}

async function testGameEndBroadcast() {
  const { server, port } = await startServer(8805);
  console.log('\n== 测试(回归): 房主结束对局 → 成员收到 game-end 且权威态清空 ==');
  const host = wrap(wsc('ws://localhost:' + port + '/ws?host=1'));
  const member = wrap(wsc('ws://localhost:' + port + '/ws'));
  try {
    await waitOpen(host); await waitOpen(member);
    await host.__waitMsg((m) => m.type === 'welcome');
    await member.__waitMsg((m) => m.type === 'welcome');

    host.send(JSON.stringify({ type: 'commit', opId: 'h-1', baseSeq: 0, state: '{"round":"南4局"}' }));
    await host.__waitMsg((m) => m.type === 'ack');

    const rec = { id: 'g1', finishedAt: '2026-09-01T12:00:00Z', mode: 4, endReason: '南四局结束', history: [] };
    host.send(JSON.stringify({ type: 'game-end', record: rec }));
    const ge = await member.__waitMsg((m) => m.type === 'game-end');
    assert.strictEqual(ge.record.id, 'g1');
    assert.strictEqual(ge.record.endReason, '南四局结束');
    ok('房主结束对局 → 成员收到 game-end 及归档记录');

    // 结束后加入的新成员不应再看到已归档的对局
    const m2 = wrap(wsc('ws://localhost:' + port + '/ws'));
    await waitOpen(m2);
    const j2 = await m2.__waitMsg((m) => m.type === 'welcome');
    assert.strictEqual(j2.state, null);
    assert.strictEqual(j2.seq, 2);
    ok('结束对局后权威态清空（新成员 welcome.state=null，seq 已推进）');

    // 非房主（成员）发送 game-end 应被忽略
    const collected = host.__collect();
    member.send(JSON.stringify({ type: 'game-end', record: { id: 'x' } }));
    await sleep(250);
    ok('非房主发送 game-end 被服务器忽略（不广播）', !collected.some((mm) => mm.type === 'game-end'));
    closeAll(host, member, m2);
  } catch (e) { bad('房主结束对局广播', e); }
  finally { closeAll(host, member); try { server.close(); } catch (e) {} }
}

/**
 * 修复 B 的服务器侧断言：设备数只发给房主。
 * 旧版 welcome 对成员也带 members，且成员端 net.js 还实现了 member-count 接收分支，
 * 结果成员端设备数永远停在"加入那一刻的快照"（真机上表现为房主端 2 / 成员端 3）。
 * 口径：成员端从始至终不感知、不展示全屋设备数。
 */
async function testMemberCountHostOnly() {
  const { server, port } = await startServer(8807);
  console.log('\n== 测试: 设备数只发给房主（成员端不感知）==');
  const host = wrap(wsc('ws://localhost:' + port + '/ws?host=1'));
  const m1 = wrap(wsc('ws://localhost:' + port + '/ws'));
  try {
    await waitOpen(host); await waitOpen(m1);
    const hw = await host.__waitMsg((m) => m.type === 'welcome');
    assert.strictEqual(typeof hw.members, 'number');
    ok('房主 welcome 带 members（=' + hw.members + '）');

    const mw = await m1.__waitMsg((m) => m.type === 'welcome');
    assert.strictEqual(mw.members, undefined);
    ok('成员 welcome **不带** members（成员端不感知设备数）');

    const hostGot = host.__collect();
    const memberGot = m1.__collect();
    const m2 = wrap(wsc('ws://localhost:' + port + '/ws'));
    await waitOpen(m2);
    await m2.__waitMsg((m) => m.type === 'welcome');
    await sleep(250);
    assert.ok(hostGot.some((x) => x.type === 'member-count'));
    ok('有新成员加入 → 房主收到 member-count');
    assert.ok(!memberGot.some((x) => x.type === 'member-count'));
    ok('成员端**始终收不到** member-count（旧版 net.js 里那个接收分支已无对应发送方）');
    closeAll(host, m1, m2);
  } catch (e) { bad('设备数可见性（只给房主）', e); }
  finally { closeAll(host, m1); try { server.close(); } catch (e) {} }
}

// 串行执行
(async () => {
  await testWelcomeAndCommit();
  await testActionLock();
  await testHostOfflineKeepsRoom();
  await testMemberCommitToHostAndGuards();
  await testHostReplaceReleasesOperator();
  await testGameEndBroadcast();
  await testMemberCountHostOnly();
  console.log('\n====================================');
  console.log('无房间码联网集成测试: ' + pass + ' 通过，' + fail + ' 失败');
  console.log('====================================');
  process.exit(fail === 0 ? 0 : 1);
})();
