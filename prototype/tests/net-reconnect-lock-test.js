/**
 * net-reconnect-lock-test.js — 掉线锁定 + 自动重连 + 全提交制（批次 1 & 2）
 *
 * 背景（旧版行为）：
 *  - net.js 的 ws.onclose 只重置状态、**不重连** → 掉线即永久离线；
 *  - app.js 的 isHost() 在"未进房"时返回 true → 掉线成员被当成房主，
 *    流局/修正/撤回/结束按钮全亮，结算也能点，但状态发不出去
 *    → **本地生效、服务器不知道**（"操作没同步到房主"）。
 *
 * 本测试用真实 index.html + 真实 rules/storage/net/app.js + 真实 ws 服务端
 * （1:1 复刻 RiiseServer.java 的协议 v2 分支），验证：
 *  1. 成员掉线 → 立刻锁定（横幅显示 / 六个操作按钮全禁用 / 不被误判为房主）
 *  2. 掉线期间：点主界面按钮不打开弹窗；断线前已打开的弹窗，点确认被拦截且不落本地
 *  3. 不刷新页面即自动重连；重连后解锁、横幅消失、按钮恢复、追平服务器权威态
 *  4. leaveRoom() 后不再自动重连，且不显示锁定横幅
 *  5. 房主掉线重连后仍是房主，专属按钮恢复，且能拿到服务器权威态
 *  6. **全提交制**：本地变更必须等服务器 ack 才落库；ack 前 localStorage 不变
 *  7. 双向心跳：服务器 ping → 客户端回 pong（死链检测的基础）
 *
 * 运行：cd prototype/tests && NODE_PATH=<workspace>/node_modules node net-reconnect-lock-test.js
 */
const { JSDOM } = require('jsdom');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8776;

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ FAIL: ' + msg); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (fn()) return true; await sleep(30); }
  console.log('    [超时] ' + label);
  return false;
}

// ============================================================
// 服务端：复刻 RiichiServer.java / serve.js 的协议 v2 分支
// ============================================================
const room = {
  host: null, members: new Set(), state: null, seq: 0, operator: null,
  opLog: new Map(), ackDelay: 0, lastCommit: null, gotPong: false, hostSeen: false,
  // 复现"申请应答被 operator-change 抢占"的竞态：授予之前先给申请者发一条 operator-change
  strayOperatorChange: false,
};

function send(ws, obj) {
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (e) {}
}
function operatorName() {
  return room.operator && room.operator.__name ? room.operator.__name : null;
}
function broadcastOperator() {
  const name = operatorName();
  room.members.forEach((m) => send(m, { type: 'operator-change', name }));
  send(room.host, { type: 'operator-change', name });
}
function broadcastState(except) {
  const json = { type: 'state', state: room.state, seq: room.seq };
  room.members.forEach((m) => { if (m !== except) send(m, json); });
  if (room.host && room.host !== except) send(room.host, json);
}
function welcome(ws, isHost) {
  send(ws, {
    type: 'welcome', role: isHost ? 'host' : 'member',
    state: room.state, seq: room.seq, operator: operatorName(),
    hostOnline: room.host != null, hostSeen: room.hostSeen,
    members: (room.host ? 1 : 0) + room.members.size,
  });
}

const wss = new WebSocket.Server({ port: PORT });
wss.on('connection', (ws, req) => {
  const isHost = (req.url || '').indexOf('host=1') !== -1;
  ws.__name = null;
  ws.__isHost = isHost;
  if (isHost) {
    const prev = room.host;
    if (prev && prev !== ws) {
      if (room.operator === prev) room.operator = null;
      try { prev.terminate(); } catch (e) {}
    }
    const wasOffline = room.host == null;
    room.host = ws;
    room.hostSeen = true;
    welcome(ws, true);
    if (wasOffline) {
      room.members.forEach((m) => send(m, { type: 'host-online' }));
      broadcastOperator();
    }
  } else {
    room.members.add(ws);
    welcome(ws, false);
  }
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d.toString()); } catch (e) { return; }
    switch (m.type) {
      case 'set-name': ws.__name = m.name; break;
      case 'ping': send(ws, { type: 'pong', ts: m.ts }); break;
      case 'pong': room.gotPong = true; break;
      case 'request-action':
        if (room.operator && room.operator !== ws) {
          send(ws, { type: 'action-denied', by: operatorName() || '其他玩家' });
        } else {
          // 真实服务器在房主上线、他人释放操作权时都会广播 operator-change（只带名字、
          // 不带"是否授予"）。这里刻意在授予之前先发一条，复现"应答被抢占"的竞态。
          if (room.strayOperatorChange) send(ws, { type: 'operator-change', name: null });
          room.operator = ws;
          if (m.name) ws.__name = m.name;
          send(ws, { type: 'action-granted' });
          broadcastOperator();
        }
        break;
      case 'release-action':
        if (room.operator === ws) { room.operator = null; broadcastOperator(); }
        break;
      case 'commit': {
        room.lastCommit = m;
        if (ws !== room.host && room.operator !== ws) {
          send(ws, { type: 'conflict', opId: m.opId, seq: room.seq, state: room.state, reason: 'denied' });
          break;
        }
        if (m.opId && room.opLog.has(m.opId)) {
          send(ws, { type: 'ack', opId: m.opId, seq: room.opLog.get(m.opId) });
          break;
        }
        if (m.baseSeq !== room.seq) {
          send(ws, { type: 'conflict', opId: m.opId, seq: room.seq, state: room.state, reason: 'stale' });
          break;
        }
        const apply = () => {
          room.state = m.state;
          room.seq += 1;
          if (m.opId) room.opLog.set(m.opId, room.seq);
          send(ws, { type: 'ack', opId: m.opId, seq: room.seq });
          broadcastState(ws);
        };
        // ackDelay 用于验证"ack 之前本地不落库"
        if (room.ackDelay > 0) setTimeout(apply, room.ackDelay); else apply();
        break;
      }
      case 'game-end':
        if (ws === room.host) {
          room.state = null; room.seq += 1;
          room.members.forEach((x) => send(x, { type: 'game-end', record: m.record || null }));
        }
        break;
      default: break;
    }
  });
  ws.on('close', () => {
    if (ws === room.host) {
      room.host = null;
      const wasOp = room.operator === ws;
      if (wasOp) room.operator = null;
      room.members.forEach((m) => send(m, { type: 'host-offline' }));
      if (wasOp) broadcastOperator();
    } else if (room.members.delete(ws)) {
      if (room.operator === ws) { room.operator = null; broadcastOperator(); }
    }
  });
  ws.on('error', () => {});
});
// 心跳：每 5s 向所有连接发 ping（客户端必须回 pong）
const hb = setInterval(() => {
  const conns = [];
  if (room.host) conns.push(room.host);
  room.members.forEach((m) => conns.push(m));
  conns.forEach((c) => send(c, { type: 'ping', ts: Date.now() }));
}, 5000);

// ============================================================
// 客户端：真实 index.html + 真实四个 JS
// ============================================================
const SRC = {
  rules: fs.readFileSync(path.join(ROOT, 'js/rules.js'), 'utf8'),
  storage: fs.readFileSync(path.join(ROOT, 'js/storage.js'), 'utf8'),
  net: fs.readFileSync(path.join(ROOT, 'js/net.js'), 'utf8'),
  app: fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8'),
};
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** 造一个"正在进行中的对局"客户端（房主/成员都预置一局，便于 renderMain 渲染按钮） */
function makeClient(search, points) {
  const url = 'http://localhost:' + PORT + '/' + (search || '');
  const dom = new JSDOM(HTML, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  // jsdom 的 WebSocket 换成真实 ws 客户端（能连本进程的镜像服务器）
  try { w.WebSocket = WebSocket; }
  catch (e) { Object.defineProperty(w, 'WebSocket', { value: WebSocket, configurable: true }); }

  w.eval(SRC.rules);
  w.eval(SRC.storage);
  w.eval(SRC.net);

  // 预置对局（模拟"本桌已经开打"）
  const g = w.Rules.createGame(4, { westRule: false, multiRon: true, dealerName: 'A' });
  g.players.forEach((p, i) => { p.name = ['A', 'B', 'C', 'D'][i]; p.points = points == null ? 25000 : points; });
  w.localStorage.setItem('riichi_active_game', w.Rules.serialize(g));

  w.eval(SRC.app);
  w.document.dispatchEvent(new w.Event('DOMContentLoaded', { bubbles: true }));
  return { dom, w, doc: w.document, Net: w.Net };
}

function renderedPoints(doc) {
  return Array.from(doc.querySelectorAll('#table-seats .pts')).map((e) => parseInt(e.textContent, 10));
}

// ============================================================
// 用例
// ============================================================
async function main() {
  // ---------- 用例 1：成员掉线 → 锁定 ----------
  console.log('\n== 用例 1: 成员掉线 → 立即锁定，且不被误判为房主 ==');
  const member = makeClient('');
  const doc = member.doc, Net = member.Net;

  await waitUntil(() => Net.isInRoom(), 3000, '成员连接');
  assert(Net.isInRoom() === true, '成员已进入房间（welcome role=member）');
  assert(Net.hasJoined() === true, 'hasJoined()=true（已成功进房，与"从未联网的单机"区分）');
  assert(Net.isLocked() === false, '在线时未锁定');
  assert(doc.getElementById('net-banner').hidden === true, '在线时断线横幅隐藏');
  assert(doc.getElementById('page-main').classList.contains('active'), '有进行中对局 → 停在对局主界面');
  assert(doc.getElementById('btn-tsumo-ron').disabled === false, '在线时「和牌结算」可用（操作权空闲）');
  assert(doc.getElementById('btn-flow').disabled === true, '在线时「流局」对成员禁用（房主专属）');

  // 走一次正常操作：打开立直弹窗（内部会申请到操作权）
  doc.getElementById('btn-riichi').click();
  await waitUntil(() => doc.getElementById('modal-riichi').classList.contains('show'), 2000, '立直弹窗');
  assert(doc.getElementById('modal-riichi').classList.contains('show'), '立直弹窗已打开');
  assert(Net.amOperator() === true, '成员已持有操作权');
  const storedBefore = member.w.localStorage.getItem('riichi_active_game');

  // —— 服务器侧粗暴断开（terminate = 无关闭帧，等效手机 WLAN 掉线）——
  const target = [...room.members].pop();
  assert(!!target, '找到该成员的服务器侧连接');
  target.terminate();
  await waitUntil(() => Net.isLocked(), 2500, '掉线锁定');

  assert(Net.isLocked() === true, '掉线后 isLocked()=true');
  assert(Net.hasJoined() === true, '掉线后 hasJoined() 仍为 true');
  assert(Net.isInRoom() === false, '掉线后 isInRoom()=false');
  assert(Net.isHost() === false, '⚠️ 掉线后 isHost() 仍为 false（旧版此处被当成房主）');
  assert(Net.amOperator() === false, '掉线后操作权已清零');
  assert(doc.getElementById('net-banner').hidden === false, '断线横幅已显示');
  assert(/已断开/.test(doc.getElementById('net-banner').textContent), '横幅文案包含「已断开」');
  assert(doc.getElementById('btn-tsumo-ron').disabled === true, '掉线后「和牌结算」禁用');
  assert(doc.getElementById('btn-riichi').disabled === true, '掉线后「立直」禁用');
  assert(doc.getElementById('btn-flow').disabled === true, '掉线后「流局」禁用（旧版会被误点亮）');
  assert(doc.getElementById('btn-adjust').disabled === true, '掉线后「手动修正」禁用（旧版会被误点亮）');
  assert(doc.getElementById('btn-undo').disabled === true, '掉线后「撤回」禁用（旧版会被误点亮）');
  assert(doc.getElementById('btn-end').disabled === true, '掉线后「结束对局」禁用（旧版会被误点亮）');

  // 掉线期间：点主界面操作按钮 → 不打开任何新弹窗
  const showsBefore = doc.querySelectorAll('.modal-overlay.show').length;
  doc.getElementById('btn-tsumo-ron').click();
  doc.getElementById('btn-flow').click();
  await sleep(60);
  assert(!doc.getElementById('modal-settle-type').classList.contains('show'), '掉线期间点「和牌结算」不打开结算弹窗');
  assert(!doc.getElementById('modal-flow').classList.contains('show'), '掉线期间点「流局」不打开流局弹窗');
  assert(doc.querySelectorAll('.modal-overlay.show').length === showsBefore, '掉线期间没有新增弹窗');

  // 掉线前已打开的弹窗：点里面的人 → 必须被拦截，不落本地
  const pick = doc.querySelector('#riichi-pick .p');
  assert(!!pick, '立直弹窗内已渲染人物条目（弹窗在断线前就打开了）');
  if (pick) pick.click();
  await sleep(80);
  assert(member.w.localStorage.getItem('riichi_active_game') === storedBefore, '掉线期间点立直：本地未落地（被拦截）');
  assert(/未生效/.test(doc.getElementById('toast').textContent), '提示本次操作未生效');

  // ---------- 用例 2：自动重连 + 追平 ----------
  console.log('\n== 用例 2: 自动重连（不刷新页面）并追平服务器权威态 ==');
  // 成员离线期间"别人"又结算了一局 → 服务器权威态变化
  const live = JSON.parse(room.state || storedBefore);
  live.players[0].points -= 1000;
  live.players[3].points += 1000;
  room.state = JSON.stringify(live);
  room.seq += 1;
  console.log('    [server] 成员离线期间 room.state 已更新（A 放铳给 D），seq=' + room.seq);

  const reconnected = await waitUntil(() => Net.isInRoom(), 6000, '自动重连');
  assert(reconnected, '无需刷新页面即自动重连成功');
  assert(Net.isLocked() === false, '重连后解除锁定');
  assert(doc.getElementById('net-banner').hidden === true, '重连后横幅消失');
  assert(doc.getElementById('btn-tsumo-ron').disabled === false, '重连后「和牌结算」恢复可用');
  assert(doc.getElementById('btn-flow').disabled === true, '重连后成员身份不变（「流局」仍禁用）');

  await sleep(200);
  const pts = renderedPoints(doc);
  assert(pts[0] === live.players[0].points && pts[3] === live.players[3].points,
    '重连后界面已追平服务器权威态（离线期间别人的结算没丢）：A=' + pts[0] + ' D=' + pts[3]);
  assert(member.w.localStorage.getItem('riichi_active_game') === room.state,
    '重连后权威态已落库（welcome 的 state 直接写入 localStorage）');

  // ---------- 用例 3：主动离开不再重连 ----------
  console.log('\n== 用例 3: leaveRoom() 后不再自动重连 ==');
  Net.leaveRoom();
  await sleep(1400);
  assert(Net.isOnline() === false, 'leaveRoom() 后保持离线（不再重连）');
  assert(Net.isLocked() === false, 'leaveRoom() 后不显示锁定横幅（主动离开 ≠ 掉线）');
  assert(doc.getElementById('net-banner').hidden === true, 'leaveRoom() 后横幅隐藏');

  // ---------- 用例 4：房主掉线重连 ----------
  console.log('\n== 用例 4: 房主掉线 → 同样锁定 → 重连后仍是房主且拿到权威态 ==');
  const host = makeClient('?host=1');
  const hdoc = host.doc;
  await waitUntil(() => host.Net.isInRoom(), 3000, '房主连接');
  assert(host.Net.isInRoom() === true && host.Net.isHost() === true, '房主已连接并识别为房主');
  assert(hdoc.getElementById('btn-flow').disabled === false, '房主在线时「流局」可用');

  const hostWs = room.host;
  hostWs.terminate();
  await waitUntil(() => host.Net.isLocked(), 2500, '房主掉线锁定');
  assert(host.Net.isLocked() === true, '房主掉线后同样进入锁定态');
  assert(hdoc.getElementById('net-banner').hidden === false, '房主断线横幅已显示');
  assert(hdoc.getElementById('btn-flow').disabled === true, '房主掉线期间「流局」也禁用');
  assert(hdoc.getElementById('btn-end').disabled === true, '房主掉线期间「结束对局」也禁用');

  const hostBack = await waitUntil(() => host.Net.isInRoom(), 6000, '房主自动重连');
  assert(hostBack, '房主自动重连成功');
  assert(host.Net.isHost() === true, '房主重连后仍被识别为房主');
  assert(hdoc.getElementById('net-banner').hidden === true, '房主重连后横幅消失');
  assert(hdoc.getElementById('btn-flow').disabled === false, '房主重连后「流局」恢复可用');
  await sleep(200);
  const hpts = renderedPoints(hdoc);
  assert(hpts[0] === JSON.parse(room.state).players[0].points,
    '房主重连后界面追平服务器权威态（旧版 room-created 不带 state，会停在旧数据）');

  // ---------- 用例 5：全提交制 ----------
  console.log('\n== 用例 5: 全提交制 —— 服务器 ack 之前本地不落库 ==');
  room.ackDelay = 400;                       // 服务器故意延迟回执
  const before5 = host.w.localStorage.getItem('riichi_active_game');
  const seqBefore = room.seq;
  // 房主点立直（走完整链路：申请操作权 → 弹窗 → 选人 → commit → ack）
  hdoc.getElementById('btn-riichi').click();
  const opened = await waitUntil(() => hdoc.getElementById('modal-riichi').classList.contains('show'), 2000, '房主立直弹窗');
  assert(opened, '房主立直弹窗已打开');
  const hpick = hdoc.querySelector('#riichi-pick .p');
  assert(!!hpick, '立直弹窗已渲染人物条目');
  if (hpick) hpick.click();
  await sleep(150);                          // < ackDelay：服务器还没回执
  assert(host.w.localStorage.getItem('riichi_active_game') === before5,
    '提交已发出、回执未到 → 本地**未**落库（旧版这里已经本地生效了）');
  assert(room.lastCommit && typeof room.lastCommit.opId === 'string' && room.lastCommit.baseSeq === seqBefore,
    '服务器收到的提交带 opId 与 baseSeq（' + (room.lastCommit && room.lastCommit.baseSeq) + '）');
  const acked = await waitUntil(() => host.w.localStorage.getItem('riichi_active_game') !== before5, 3000, 'ack 后落库');
  assert(acked, '收到 ack 之后本地才落库（全提交制生效）');
  assert(room.seq === seqBefore + 1, '服务器权威态版本号已推进（seq ' + seqBefore + ' → ' + room.seq + '）');
  room.ackDelay = 0;

  // 版本冲突：服务器权威态被"别人"推进（这里直接在镜像服务器上推进，不广播给客户端），
  // 客户端仍带着旧 seq 提交 → 必须被 conflict 拒绝，并采用服务器权威态（不残留本地改动）。
  const serverState = JSON.parse(host.w.localStorage.getItem('riichi_active_game'));
  serverState.players[0].points -= 500;
  serverState.players[1].points += 500;
  room.state = JSON.stringify(serverState);
  room.seq += 1;
  const stale = await host.Net.commit('{"tampered":true}').then(
    () => ({ ok: true }),
    (err) => ({ reason: err && err.reason })
  );
  assert(stale.reason === 'stale',
    '旧版本提交被 conflict 拒绝（reason=' + JSON.stringify(stale) + '）');
  const adopted = await waitUntil(() => {
    const s = host.w.localStorage.getItem('riichi_active_game');
    if (!s) return false;
    try { return JSON.parse(s).players[0].points === serverState.players[0].points; } catch (e) { return false; }
  }, 2000, '采用服务器权威态');
  assert(adopted, '被拒后本地采用服务器权威态（分数=服务器值 ' + serverState.players[0].points
    + '），不残留本地私有改动');

  // 被拒时"结果弹窗"必须一起关掉 —— 它展示的是没生效的那份数字
  const rmod = hdoc.getElementById('modal-result');
  rmod.classList.add('show');
  const g2 = JSON.parse(room.state);
  g2.players[1].points -= 500;
  g2.players[0].points += 500;
  room.state = JSON.stringify(g2);
  room.seq += 1;                                   // 客户端 seq 再次落后 → 提交必被拒
  hdoc.getElementById('btn-riichi').click();       // 上一个立直弹窗已关闭，重新打开
  await waitUntil(() => hdoc.getElementById('modal-riichi').classList.contains('show'), 2000, '二次立直弹窗');
  const pick3 = Array.from(hdoc.querySelectorAll('#riichi-pick .p'))[1];
  assert(!!pick3, '二次立直弹窗已渲染人物条目（用于验证被拒时的界面收尾）');
  if (pick3) pick3.click();
  const closed = await waitUntil(() => !rmod.classList.contains('show'), 2000, '结果弹窗关闭');
  assert(closed, '提交被拒 → 结果弹窗自动关闭（不让用户对着已作废的分数判断）');
  assert(/已被其他玩家更新/.test(hdoc.getElementById('toast').textContent),
    '提示文案与失败原因一致（stale）');

  // ---------- 用例 6：心跳 ----------
  console.log('\n== 用例 6: 双向心跳 ==');
  await waitUntil(() => room.gotPong === true, 7000, '收到客户端 pong');
  assert(room.gotPong === true, '服务器 ping → 客户端回 pong（死链检测基础）');

  // ---------- 用例 7：操作权申请的应答不能被无关的 operator-change 抢占 ----------
  console.log('\n== 用例 7: request-action 的应答只认 action-granted/denied ==');
  console.log('  背景：服务器在房主上线、他人释放操作权时会广播 operator-change（只带名字，不带"是否授予"）。');
  console.log('  旧版 net.js 把它当成对本次申请的答复 → granted=undefined → app.js 判定"别人正在操作"而静默放弃结算。');
  {
    const m7 = makeClient('');
    await waitUntil(() => m7.Net.isInRoom(), 3000, '成员加入');
    room.operator = null;                 // 保证本次申请会被授予
    room.strayOperatorChange = true;      // 授予之前先插一条 operator-change（复现竞态）
    const r = await new Promise((resolve) => {
      m7.Net.requestAction('小明', (err, granted) => resolve({ err, granted }));
    });
    room.strayOperatorChange = false;
    assert(r.granted === true,
      'operator-change 抢先到达时，申请仍被判定为"已授予"（granted=' + r.granted + '，err=' + r.err + '）');
    assert(m7.Net.amOperator() === true, '此时本机确实持有操作权（amOperator=true）');
    m7.Net.leaveRoom();
    m7.w.close();
  }

  // ---------- 用例 8：设备数只有房主端可见（修复 B） ----------
  console.log('\n== 用例 8: 成员端不感知全屋设备数（memberCount 恒为 1）==');
  {
    // 先让用例 4 的房主退场：它带 ?host=1，留着会自动重连并与新宿主抢槽位（乒乓互踢）
    host.Net.leaveRoom();
    await sleep(200);
    const h8 = makeClient('?host=1');
    const m8 = makeClient('');
    await waitUntil(() => h8.Net.isInRoom() && m8.Net.isInRoom(), 4000, '房主+成员进房');
    assert(h8.Net.memberCount() >= 2,
      '房主端 memberCount() 反映真实设备数（含自己，当前 ' + h8.Net.memberCount() + '）');
    assert(m8.Net.memberCount() === 1, '成员端 memberCount() 恒为 1（不感知全屋设备数）');

    // 反向验证：即使服务器把设备数推到成员端，成员端也必须忽略（协议上本就不该发）
    const memberWs8 = [...room.members].pop();
    if (memberWs8) send(memberWs8, { type: 'member-count', count: 9 });
    await sleep(250);
    assert(m8.Net.memberCount() === 1, '成员端即使收到 member-count 也忽略（仍是 1）');

    h8.Net.leaveRoom(); m8.Net.leaveRoom();
    h8.w.close(); m8.w.close();
  }

  // 收尾
  host.Net.leaveRoom();
  member.w.close();
  host.w.close();
  clearInterval(hb);
  try { wss.close(); } catch (e) {}
  await sleep(200);

  console.log('\n====================================');
  console.log('掉线锁定 / 自动重连 / 全提交制测试: ' + pass + ' 通过，' + fail + ' 失败');
  console.log('====================================');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('脚本异常:', e); process.exit(1); });
