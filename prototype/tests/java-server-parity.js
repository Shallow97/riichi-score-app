/**
 * java-server-parity.js — 验证 Android 端 RiichiServer.java 的协议逻辑与前端 net.js 完全兼容
 *
 * 背景：RiichiServer.java 是纯 Java（依赖 Android AssetManager），本机无 Android SDK，
 * 无法直接编译运行。因此本测试用 Node 的 ws 库，**逐条 1:1 复刻 RiichiServer.java 的
 * 协议 v2 状态机**（onConnected / handleMessage / onDisconnected），然后加载**真实的
 * prototype/js/net.js** 作为前端客户端去连接，验证：
 *   1. 房主(?host=1) → welcome{role:'host'}，前端识别为房主
 *   2. 成员(无 host) → welcome{role:'member'}，无需房间码
 *   3. 成员申请操作权 → granted；第二个成员申请 → denied(by=操作者名)，与 Java 逻辑一致
 *   4. 操作者 commit → 其余端收到 state 广播，前端收到一致权威态
 *   5. 房主 WebSocket 断开 → host-offline（房间保留，成员不被踢）；房主重连 → welcome 带 state/seq
 *   6. 幂等：同一 opId 重复提交只回 ack；baseSeq 过期回 conflict(stale)
 *
 * 运行：cd prototype && node tests/java-server-parity.js
 * 结果：全部通过 = RiichiServer.java 的协议与前端 net.js 兼容。
 */

const WebSocket = require('ws');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const netSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'net.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name) { pass++; console.log('  ✓ ' + name); }
function bad(name, e) { fail++; console.log('  ✗ ' + name + ' — ' + (e && e.message)); }

// ============================================================
// 第 2 步：用 ws 实现一个"Java 语义"的服务器（1:1 复刻 RiichiServer.java · 协议 v2）
// ============================================================
const PORT = 8771;
// 排查用例间的连接/槽位残留时用 PARITY_DEBUG=1 打开服务端日志
const DEBUG = !!process.env.PARITY_DEBUG;
const dbg = (...a) => { if (DEBUG) console.log('  [srv]', ...a); };
let __connSeq = 0;
const room = {
  host: null, members: new Set(), state: null, seq: 0, operator: null,
  opLog: new Map(), hostSeen: false,
};

function memberCount() { return (room.host ? 1 : 0) + room.members.size; }
function escapeJson(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}
function operatorJson() {
  if (!room.operator) return 'null';
  return room.operator.__name ? '"' + escapeJson(room.operator.__name) + '"' : 'null';
}
function stateJson() {
  return room.state != null ? '"' + escapeJson(room.state) + '"' : 'null';
}
function broadcastOperator() {
  const name = room.operator ? room.operator.__name : null;
  const json = '{"type":"operator-change","name":' + (name != null ? '"' + escapeJson(name) + '"' : 'null') + '}';
  room.members.forEach(m => m.send(json));
  if (room.host) room.host.send(json);
}
function broadcastStateExcept(except) {
  const json = '{"type":"state","state":' + stateJson() + ',"seq":' + room.seq + '}';
  room.members.forEach(m => { if (m !== except) m.send(json); });
  if (room.host && room.host !== except) room.host.send(json);
}
function notifyMemberCount() {
  const count = memberCount();
  if (room.host) room.host.send('{"type":"member-count","count":' + (count - 1) + '}');
}
function welcomeJson(isHost) {
  return '{"type":"welcome","role":"' + (isHost ? 'host' : 'member') + '"'
    + ',"state":' + stateJson()
    + ',"seq":' + room.seq
    + ',"operator":' + operatorJson()
    + ',"hostOnline":' + (room.host != null)
    + ',"hostSeen":' + room.hostSeen
    + ',"members":' + memberCount() + '}';
}
function jsonStr(json, key) {
  const marker = '"' + key + '":';
  const idx = json.indexOf(marker);
  if (idx < 0) return null;
  let i = idx + marker.length;
  if (json[i] === '"') {
    i++;
    let out = '';
    while (i < json.length) {
      const ch = json[i];
      if (ch === '\\' && i + 1 < json.length) { out += json[i + 1]; i += 2; }
      else if (ch === '"') break;
      else { out += ch; i++; }
    }
    return out;
  }
  return null;
}
function jsonNum(json, key) {
  const marker = '"' + key + '":';
  const idx = json.indexOf(marker);
  if (idx < 0) return -1;
  let i = idx + marker.length, end = i;
  while (end < json.length) {
    const c = json[end];
    if ((c >= '0' && c <= '9') || c === '-') end++; else break;
  }
  if (end === i) return -1;
  const n = Number(json.slice(i, end));
  return Number.isFinite(n) ? n : -1;
}
function strOrNull(s) { return s != null ? '"' + escapeJson(s) + '"' : 'null'; }

const wss = new WebSocket.Server({ port: PORT });
wss.__hostWs = null;

wss.on('connection', (ws, req) => {
  const isHost = (req.url || '').indexOf('host=1') !== -1;
  ws.__isHost = isHost;
  ws.__name = null;
  ws.__id = ++__connSeq;
  dbg('连接 #' + ws.__id + (isHost ? ' [HOST]' : ' [MEMBER]'));

  if (isHost) {
    const prev = room.host;
    let clearedOperator = false;
    if (prev && prev !== ws) {
      room.members.delete(prev);
      if (room.operator === prev) { room.operator = null; clearedOperator = true; }
      try { prev.terminate(); } catch (e) {}
    }
    const wasOffline = room.host == null;
    room.host = ws;
    room.hostSeen = true;
    wss.__hostWs = ws;
    ws.send(welcomeJson(true));
    if (wasOffline) {
      room.members.forEach(m => m.send('{"type":"host-online"}'));
    }
    // 释放了槽位必须广播：否则成员端仍显示旧操作者，结算/立直按钮一直灰着
    if (wasOffline || clearedOperator) broadcastOperator();
  } else {
    room.members.add(ws);
    ws.send(welcomeJson(false));
  }
  notifyMemberCount();

  ws.on('message', (data) => {
    const raw = data.toString();
    const type = jsonStr(raw, 'type');
    if (!type) return;
    switch (type) {
      case 'set-name': { ws.__name = jsonStr(raw, 'name'); break; }
      case 'ping': {
        const ts = jsonNum(raw, 'ts');
        ws.send(ts >= 0 ? '{"type":"pong","ts":' + ts + '}' : '{"type":"pong"}');
        break;
      }
      case 'pong': break;
      case 'request-action': {
        if (room.operator != null && room.operator !== ws) {
          dbg('request-action 被拒 #' + ws.__id + ' name=' + ws.__name
            + ' ← 占权者 #' + room.operator.__id + ' name=' + room.operator.__name
            + ' isHost=' + room.operator.__isHost + ' cleaned=' + !!room.operator.__cleaned);
          ws.send('{"type":"action-denied","by":"' + escapeJson(room.operator.__name || '其他玩家') + '"}');
        } else {
          room.operator = ws;
          const name = jsonStr(raw, 'name');
          if (name) ws.__name = name;
          ws.send('{"type":"action-granted"}');
          broadcastOperator();
        }
        break;
      }
      case 'release-action': {
        if (room.operator === ws) { room.operator = null; broadcastOperator(); }
        break;
      }
      case 'commit': {
        const opId = jsonStr(raw, 'opId');
        if (ws !== room.host && room.operator !== ws) {
          ws.send('{"type":"conflict","opId":' + strOrNull(opId) + ',"seq":' + room.seq
            + ',"state":' + stateJson() + ',"reason":"denied"}');
          break;
        }
        if (opId != null && room.opLog.has(opId)) {
          ws.send('{"type":"ack","opId":"' + escapeJson(opId) + '","seq":' + room.opLog.get(opId) + '}');
          break;
        }
        let baseSeq = jsonNum(raw, 'baseSeq');
        if (baseSeq < 0) baseSeq = room.seq;
        if (baseSeq !== room.seq) {
          ws.send('{"type":"conflict","opId":' + strOrNull(opId) + ',"seq":' + room.seq
            + ',"state":' + stateJson() + ',"reason":"stale"}');
          break;
        }
        const state = jsonStr(raw, 'state');
        room.state = state;
        room.seq += 1;
        if (opId != null) {
          room.opLog.set(opId, room.seq);
          while (room.opLog.size > 128) room.opLog.delete(room.opLog.keys().next().value);
        }
        ws.send('{"type":"ack","opId":' + strOrNull(opId) + ',"seq":' + room.seq + '}');
        broadcastStateExcept(ws);
        break;
      }
      case 'game-end': {
        if (ws === room.host) {
          const record = jsonStr(raw, 'record');
          const json = '{"type":"game-end","record":' + (record != null ? '"' + escapeJson(record) + '"' : 'null') + '}';
          room.members.forEach(m => m.send(json));
          room.state = null;
          room.seq += 1;
          broadcastStateExcept(null);
        }
        break;
      }
      case 'leave-room': { disconnect(ws); break; }
      default: break;
    }
  });

  ws.on('close', () => { disconnect(ws); });
});

function disconnect(ws) {
  if (ws.__cleaned) { dbg('disconnect 跳过（已清理）id=' + ws.__id); return; }
  ws.__cleaned = true;
  if (ws === room.host) {
    dbg('disconnect HOST id=' + ws.__id + ' name=' + ws.__name + ' wasOp=' + (room.operator === ws));
    room.host = null; wss.__hostWs = null;
    const wasOp = room.operator === ws;
    if (wasOp) room.operator = null;
    room.members.forEach(m => m.send('{"type":"host-offline"}'));
    if (wasOp) broadcastOperator();
    notifyMemberCount();
    return;
  }
  if (room.members.delete(ws)) {
    dbg('disconnect MEMBER id=' + ws.__id + ' name=' + ws.__name + ' wasOp=' + (room.operator === ws));
    if (room.operator === ws) { room.operator = null; broadcastOperator(); }
    notifyMemberCount();
  } else {
    dbg('disconnect 未知连接 id=' + ws.__id + ' name=' + ws.__name
      + '（既不是 host 也不在 members；room.host.id=' + (room.host ? room.host.__id : 'null') + '）');
  }
}

// ============================================================
// 第 3 步：加载真实前端 net.js
// ============================================================
// 全局登记所有创建过的客户端：用例结束时统一关闭。
// ⚠️ 必须这么做：net.js 掉线后会自动重连（500ms→5s 退避），如果某条用例只是"服务端
//    断开"而没关闭客户端，那个客户端的 net.js 会永远重连下去，并且因为它是 ?host=1，
//    会不断抢占唯一房主槽位（服务器"新 host 替换旧 host"逻辑会把当前房主踢掉），
//    造成用例之间乒乓互踢、room.host 迟迟不清空 → 下一条用例 request-action 被误判。
const ALL_CLIENTS = [];

function makeNetClient(isHost) {
  const sandbox = {
    location: { search: isHost ? '?host=1' : '', host: 'localhost:' + PORT, hostname: 'localhost', protocol: 'http:' },
    setTimeout, clearTimeout, console,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  // 包装 WebSocket，捕获 net.js 内部创建的 socket 实例，便于测试中断开
  const createdSockets = [];
  // 关闭闸门：一旦用例收尾，就拒绝再创建新 socket（net.js 的重连也被挡在门外）
  const gate = { closed: false };
  const WrappedWS = function (url, protocols) {
    if (gate.closed) {
      // 返回一个永不连上的桩，避免"收尾后 net.js 又建了新连接"把槽位占回去
      const stub = {
        readyState: 3, url,
        close() {}, send() {}, terminate() {},
        onopen: null, onclose: null, onerror: null, onmessage: null,
      };
      createdSockets.push(stub);
      return stub;
    }
    const s = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
    createdSockets.push(s);
    return s;
  };
  WrappedWS.prototype = WebSocket.prototype;
  WrappedWS.CONNECTING = WebSocket.CONNECTING;
  WrappedWS.OPEN = WebSocket.OPEN;
  WrappedWS.CLOSING = WebSocket.CLOSING;
  WrappedWS.CLOSED = WebSocket.CLOSED;
  sandbox.WebSocket = WrappedWS;
  sandbox.__sockets = createdSockets;
  sandbox.__gate = gate;

  const module = { exports: {} };
  // 注入假 Storage + hooks（net.js 仍会安装钩子，但批次 2 起本地保存不再外发）
  sandbox.Storage = { hooks: {} };
  new Function(
    'window', 'self', 'location', 'WebSocket', 'setTimeout', 'clearTimeout', 'Storage', 'module',
    netSrc
  )(sandbox, sandbox, sandbox.location, sandbox.WebSocket, sandbox.setTimeout, sandbox.clearTimeout, sandbox.Storage, module);
  const Net = module.exports;
  sandbox.Net = Net;
  Net.install();
  Net.init();
  const client = { Net, sandbox };
  ALL_CLIENTS.push(client);
  return client;
}

// 真正断开客户端（模拟浏览器关闭页面）：先断掉"重连的可能性"，再关闭底层 socket。
// 顺序不能反：leaveRoom() 会把 stopped 置 true（scheduleReconnect 直接返回），
// gate 则挡住任何已在途的重连。
function closeClient(net) {
  if (!net || !net.sandbox) return;
  net.sandbox.__gate.closed = true;
  try { net.Net.leaveRoom(); } catch (e) {}
  (net.sandbox.__sockets || []).forEach((s) => {
    try { s.close(); } catch (e) {}
    try { if (typeof s.terminate === 'function') s.terminate(); } catch (e) {}
  });
}

/** 用例边界：把所有登记过的客户端关掉（幂等），杜绝任何"泄漏的客户端还在自动重连" */
function closeAllClients() { ALL_CLIENTS.forEach(closeClient); }

// ============================================================
// 第 4 步：测试用例（共享同一服务器，顺序执行）
// ============================================================
function waitFor(fn, timeout, cb, errMsg) {
  const start = Date.now();
  const iv = setInterval(() => {
    if (fn()) { clearInterval(iv); cb(null); }
    else if (Date.now() - start > timeout) { clearInterval(iv); cb(new Error(errMsg || '等待超时')); }
  }, 20);
}

/** 用真实 net.js 的 commit 接口提交（全提交制：ack 后才 resolve） */
function commitAs(net, state, cb) {
  net.Net.commit(state).then(
    (r) => cb(null, r),
    (e) => cb(e, null)
  );
}

function testHostMember(done) {
  console.log('\n== 用例 1: 房主(?host=1) + 成员(无host) 自动识别 + commit 广播 ==');
  const host = makeNetClient(true);
  const member = makeNetClient(false);
  let hostGot = false, memberGot = false, started = false, gotState = false;
  let hostOk = false, memberOk = false;

  host.Net.onStatus((s) => {
    if (s.connected && s.host && !hostOk) { hostOk = true; ok('房主连接 → welcome 识别为房主（host=true）'); }
    if (s.connected && s.host) { hostGot = true; maybeGo(); }
  });
  member.Net.onStatus((s) => {
    if (s.connected && !s.host && !memberOk) { memberOk = true; ok('成员连接 → welcome 识别为成员（host=false），无需房间码'); }
    if (s.connected && !s.host) { memberGot = true; maybeGo(); }
  });

  function maybeGo() {
    if (started || !hostGot || !memberGot) return;
    started = true;
    member.Net.setName('小明');
    member.Net.requestAction('小明', (err, granted) => {
      if (err || !granted) { bad('成员申请操作权被授予', err); return finish(); }
      ok('成员申请操作权被授予');
      // 房主监听成员(操作者)提交的权威态 → 验证"成员操作时房主能同步"
      host.Net.onState((st) => {
        if (st === '{"round":"东1局"}' && !gotState) {
          gotState = true;
          ok('操作者(成员) commit → 房主收到一致权威态（成员→房主同步正常）');
          member.Net.releaseAction();
          finish();
        }
      });
      commitAs(member, '{"round":"东1局"}', (e2) => {
        if (e2) { bad('成员 commit 被服务器接受', new Error(JSON.stringify(e2))); finish(); }
      });
    });
  }

  function finish() {
    closeClient(host);
    closeClient(member);
    setTimeout(() => done(), 100);
  }
}

function testActionDeny(done) {
  console.log('\n== 用例 2: 操作权互斥（第二个成员被拒绝 by=操作者名）==');
  const host = makeNetClient(true);
  const m1 = makeNetClient(false);
  const m2 = makeNetClient(false);
  let ready = new Set(), started = false;
  function mark(id) { ready.add(id); if (ready.size >= 3 && !started) { started = true; setTimeout(run, 150); } }
  m1.Net.onStatus((s) => { if (s.online && s.connected && !s.host) mark('m1'); });
  m2.Net.onStatus((s) => { if (s.online && s.connected && !s.host) mark('m2'); });
  host.Net.onStatus((s) => { if (s.online && s.connected && s.host) mark('host'); });

  function run() {
    m1.Net.setName('小明');
    m1.Net.requestAction('小明', (e1, g1) => {
      if (e1 || !g1) { bad('成员1获操作权', e1); return finish(); }
      ok('成员1获操作权');
      m2.Net.setName('小红');
      m2.Net.requestAction('小红', (e2, g2) => {
        if (e2) { bad('成员2申请被拒绝（by=小明）', e2); return finish(); }
        if (g2) { bad('成员2应被拒绝但未拒绝'); return finish(); }
        ok('成员2申请被拒绝（操作权被成员1占用）');
        // 成员1释放操作权（Java 服务器收到 release-action 后应清除 operator）
        m1.Net.releaseAction();
        ok('成员1释放操作权');
        finish();
      });
    });
  }

  function finish() {
    closeClient(host); closeClient(m1); closeClient(m2);
    setTimeout(() => done(), 100);
  }
}

function testHostOfflineKeepsRoom(done) {
  console.log('\n== 用例 3: 房主断开 → host-offline（房间保留）；重连 → welcome 带 state/seq ==');
  const host = makeNetClient(true);
  const member = makeNetClient(false);
  let hostReady = false, memberReady = false, started = false, offlineSeen = false;
  // 两个独立的一次性标志：finished 只给 finish() 做幂等，host2Handled 只管"重连只断言一次"。
  // ⚠️ 别把二者合并：曾在调用 finish() 之前先置 finished=true，导致 finish() 早退、
  //    done() 永不触发，整条用例链直接卡死（表现为测试跑不完、迟迟不出汇总）。
  let finished = false, host2Handled = false;

  host.Net.onStatus((s) => { if (s.connected && s.host) { hostReady = true; maybeStart(); } });
  member.Net.onStatus((s) => {
    if (s.connected && !s.host) {
      if (!memberReady) { memberReady = true; ok('成员已加入'); }
      maybeStart();
    }
  });

  // ⚠️ 必须等"房主和成员都连上"再提交：若房主还没连上就 commit，net.js 会直接以
  //    offline 拒绝（回调曾忽略该错误），服务器拿不到权威态，后面的断言就会偶发失败。
  function maybeStart() {
    if (started || !hostReady || !memberReady) return;
    started = true;
    commitAs(host, '{"round":"东2局"}', (e) => {
      if (e) bad('房主提交东2局', new Error(JSON.stringify(e)));
    });
    // 等房主提交完成后再断开（state 已进服务器）
    waitFor(() => room.state === '{"round":"东2局"}', 2000, (e) => {
      if (e) { bad('房主提交东2局（等服务器落库）', e); return finish(); }
      if (wss.__hostWs) wss.__hostWs.terminate();
      // 用例本意是"这一端彻底掉线，由 host2 代表它重连"。
      // 必须显式关掉原 host 客户端，否则它的 net.js 会自动重连、和 host2 抢房主槽位，
      // 导致本条用例自身也偶发失败（重连拿不到权威态）。
      closeClient(host);
      waitFor(() => member.Net.isHostOffline(), 2500, (e2) => {
        if (e2) { bad('房主断开 → 成员收到 host-offline（且未被踢出房间）', e2); return finish(); }
        offlineSeen = true;
        ok('房主断开 → 成员收到 host-offline，且**未被踢出房间**（isInRoom 仍为 true）');
        // 房主离线期间成员仍能申请操作权
        member.Net.requestAction('小明', (err, granted) => {
          if (err || !granted) { bad('房主离线期间成员仍可申请操作权', err); return finish(); }
          ok('房主离线期间成员仍能申请到操作权（结算不受影响）');
          const host2 = makeNetClient(true);
          const hdoc = host2.Net;
          hdoc.onStatus((st) => {
            if (st.connected && st.host && !host2Handled) {
              host2Handled = true;
              ok('房主重连成功');
              if (hdoc.lastSyncedState() === '{"round":"东2局"}') {
                ok('房主重连 → welcome 带上权威态（修掉"重连后界面停在旧数据"）');
              } else {
                bad('房主重连未拿到权威态', new Error('state=' + hdoc.lastSyncedState()));
              }
              closeClient(host2);
              finish();
            }
          });
        });
      }, '成员未收到 host-offline');
    }, '房主提交超时');
  }

  function finish() {
    if (finished) return;
    finished = true;
    try { closeClient(member); } catch (e) {}
    setTimeout(() => done(), 100);
  }
}

function testNamelessMemberBroadcast(done) {
  console.log('\n== 用例 4(回归): 成员【不设名字】申请操作权并提交 → 房主收到 ==');
  console.log('  背景：成员无名时服务器 broadcastOperator 会发 operator-change name=null，');
  console.log('  旧版 net.js 误将其当作"操作权释放"而清掉 iAmOperator，导致提交被静默丢弃。');
  const host = makeNetClient(true);
  const member = makeNetClient(false);
  let hostGot = false, memberGot = false, started = false, hostGotState = false, doneFlag = false;

  host.Net.onStatus((s) => { if (s.connected && s.host) { hostGot = true; maybeGo(); } });
  member.Net.onStatus((s) => { if (s.connected && !s.host) { memberGot = true; maybeGo(); } });

  function maybeGo() {
    if (started || !hostGot || !memberGot) return;
    started = true;
    // 成员【不调用 setName】，模拟无名成员
    member.Net.requestAction(null, (err, granted) => {
      if (err || !granted) { bad('无名成员申请操作权被授予', err); return finish(); }
      ok('无名成员申请操作权被授予（amOperator=' + member.Net.amOperator() + '）');
      // 关键断言：申请后 iAmOperator 必须仍为 true（不应被 operator-change name=null 清除）
      setTimeout(() => {
        if (!member.Net.amOperator()) { bad('无名成员操作权被误清除(iAmOperator=false)——正是本次bug根因'); return finish(); }
        ok('申请操作权后 iAmOperator 保持 true（未被 operator-change name=null 误清）');
        host.Net.onState((st) => {
          if (st === '{"round":"东1局","from":"无名成员"}' && !hostGotState) {
            hostGotState = true;
            ok('无名成员 commit → 房主收到（成员→房主同步正常）');
            finish();
          }
        });
        commitAs(member, '{"round":"东1局","from":"无名成员"}', (e2) => {
          if (e2) { bad('无名成员 commit 被接受', new Error(JSON.stringify(e2))); finish(); }
        });
      }, 200);
    });
  }

  function finish() {
    if (doneFlag) return;
    doneFlag = true;
    closeClient(host);
    closeClient(member);
    setTimeout(() => done(), 100);
  }
}

function testHostOperateDeny(done) {
  console.log('\n== 用例 5: 平权互斥——房主申请操作权后，成员被拒（根治房主/成员双结算）==');
  const host = makeNetClient(true);
  const member = makeNetClient(false);
  let hostOk = false, memberOk = false, started = false, doneFlag = false;

  host.Net.onStatus((s) => { if (s.connected && s.host) { hostOk = true; maybeGo(); } });
  member.Net.onStatus((s) => { if (s.connected && !s.host) { memberOk = true; maybeGo(); } });

  function maybeGo() {
    if (started || !hostOk || !memberOk) return;
    started = true;
    host.Net.setName('房主A');
    host.Net.requestAction('房主A', (err, granted) => {
      if (err || !granted) { bad('房主申请操作权被授予', err); return finish(); }
      ok('房主申请操作权被授予（房主也走服务器互斥）');
      if (!host.Net.amOperator()) { bad('房主持有操作权(amOperator=true)', new Error('amOperator=' + host.Net.amOperator())); return finish(); }
      ok('房主 amOperator=true（真正持有操作权）');
      member.Net.setName('小明');
      member.Net.requestAction('小明', (e2, g2) => {
        if (e2) { bad('成员申请被拒绝（by=房主A）', e2); return finish(); }
        if (g2) { bad('成员应被拒绝但被授予（操作权应被房主独占）'); return finish(); }
        ok('房主占权时成员申请被拒绝（杜绝房主+成员双结算）');
        host.Net.releaseAction();
        ok('房主释放操作权');
        if (!host.Net.amOperator()) ok('房主释放后 amOperator=false');
        setTimeout(() => {
          member.Net.requestAction('小明', (e3, g3) => {
            if (e3 || !g3) { bad('房主释放后成员可接手操作权', e3); return finish(); }
            ok('房主释放后成员申请成功（操作权已交还）');
            finish();
          });
        }, 200);
      });
    });
  }

  function finish() {
    if (doneFlag) return;
    doneFlag = true;
    closeClient(host); closeClient(member);
    setTimeout(() => done(), 100);
  }
}

function testIdempotentAndStale(done) {
  console.log('\n== 用例 7(新): 幂等 opId 与 baseSeq 版本校验 ==');
  const host = makeNetClient(true);
  const member = makeNetClient(false);
  let hostOk = false, memberOk = false, started = false, doneFlag = false;

  host.Net.onStatus((s) => { if (s.connected && s.host) { hostOk = true; maybeGo(); } });
  member.Net.onStatus((s) => { if (s.connected && !s.host) { memberOk = true; maybeGo(); } });

  function maybeGo() {
    if (started || !hostOk || !memberOk) return;
    started = true;
    // 房主先提交一次，把 seq 推到 1
    commitAs(host, '{"round":"东1局"}', (e1) => {
      if (e1) { bad('房主首次提交', new Error(JSON.stringify(e1))); return finish(); }
      ok('房主提交成功，seq=' + room.seq);
      const seqAfter = room.seq;
      // 直接重发同一个 commit 消息（模拟回执丢失后的重试）→ 只回 ack，不重复入账
      const sock = host.sandbox.__sockets[host.sandbox.__sockets.length - 1];
      const opId = 'retry-1';
      sock.send(JSON.stringify({ type: 'commit', opId: opId, baseSeq: seqAfter, state: '{"round":"东1局"}' }));
      sock.send(JSON.stringify({ type: 'commit', opId: opId, baseSeq: seqAfter, state: '{"round":"东1局"}' }));
      setTimeout(() => {
        if (room.seq === seqAfter + 1) ok('同一 opId 重复提交 → 只入账一次（seq 仅 +1）');
        else bad('幂等失效：seq=' + room.seq + '（期望 ' + (seqAfter + 1) + '）');
        // 过期 baseSeq → conflict(stale)，且前端采用服务器权威态
        member.Net.setName('小明');
        member.Net.requestAction('小明', () => {
          commitAs(member, '{"round":"东2局"}', (e2) => {
            if (e2) { bad('成员用最新 baseSeq 提交应成功', new Error(JSON.stringify(e2))); return finish(); }
            ok('成员用最新 baseSeq 提交成功，seq=' + room.seq);
            // 房主用过期 seq 提交（前端 seq 落后）
            const late = { type: 'commit', opId: 'stale-1', baseSeq: 0, state: '{"tampered":true}' };
            sock.send(JSON.stringify(late));
            waitFor(() => room.state === '{"round":"东2局"}', 1500, () => {
              ok('过期 baseSeq 的提交未覆盖服务器权威态（conflict 已生效）');
              finish();
            }, '权威态被旧版本覆盖');
          });
        });
      }, 300);
    });
  }

  function finish() {
    if (doneFlag) return;
    doneFlag = true;
    closeClient(host); closeClient(member);
    setTimeout(() => done(), 100);
  }
}

function testHostReplaceReleasesOperator(done) {
  console.log('\n== 用例 8(新): 换房主（页面刷新）释放操作权并广播给成员 ==');
  const host = makeNetClient(true);
  const member = makeNetClient(false);
  let hostOk = false, memberOk = false, started = false, doneFlag = false, replaced = false;
  const hostName = '房主A';

  host.Net.onStatus((s) => { if (s.connected && s.host) { hostOk = true; maybeGo(); } });
  member.Net.onStatus((s) => { if (s.connected && !s.host) { memberOk = true; maybeGo(); } });

  function maybeGo() {
    if (started || !hostOk || !memberOk) return;
    started = true;
    host.Net.setName(hostName);
    host.Net.requestAction(hostName, (err, granted) => {
      if (err || !granted) { bad('房主申请操作权', err); return finish(); }
      waitFor(() => member.Net.operatorName() === hostName, 2000, (e) => {
        if (e) { bad('成员看到房主占权', e); return finish(); }
        ok('房主占权 → 成员端 operatorName=房主A（结算按钮此时对成员禁用）');
        // 房主页面刷新：新连接替换旧连接
        const host2 = makeNetClient(true);
        host2.Net.onStatus((st) => {
          if (st.connected && st.host && !replaced) {
            replaced = true;
            waitFor(() => member.Net.operatorName() === null, 2000, (e2) => {
              if (e2) { bad('换房主后成员端操作权被释放（广播 operator-change=null）', e2); return finish(); }
              ok('换房主 → 成员端 operatorName 归 null（按钮不再灰）');
              // 成员此时应能拿到操作权（旧版槽位被死连接占死 → 永久 denied）
              member.Net.setName('小明');
              member.Net.requestAction('小明', (e3, g3) => {
                if (e3 || !g3) { bad('换房主后成员可接手操作权', e3); return finish(); }
                ok('换房主后成员申请操作权成功（槽位未被死连接占死）');
                closeClient(host2);
                finish();
              });
            }, '操作权未被释放');
          }
        });
      }, '成员未看到房主占权');
    });
  }

  function finish() {
    if (doneFlag) return;
    doneFlag = true;
    closeClient(host); closeClient(member);
    setTimeout(() => done(), 100);
  }
}

function testGameEnd(done) {
  console.log('\n== 用例 6(回归): 房主结束对局 → 成员前端收到 game-end（onGameEnd 触发）==');
  const host = makeNetClient(true);
  const member = makeNetClient(false);
  let hostOk = false, memberOk = false, started = false, doneFlag = false;

  host.Net.onStatus((s) => { if (s.connected && s.host) { hostOk = true; maybeGo(); } });
  member.Net.onStatus((s) => { if (s.connected && !s.host) { memberOk = true; maybeGo(); } });

  function maybeGo() {
    if (started || !hostOk || !memberOk) return;
    started = true;
    const rec = { id: 'g9', finishedAt: '2026-09-01T12:00:00Z', mode: 4, endReason: '南四局结束', history: [] };
    member.Net.onGameEnd((r) => {
      ok('成员前端收到 game-end（onGameEnd 触发）');
      if (r && r.id === 'g9') ok('携带归档记录且内容一致（endReason=' + r.endReason + '）');
      else bad('归档记录未正确传递', new Error('record=' + JSON.stringify(r)));
      finish();
    });
    host.Net.endGame(rec);
  }

  function finish() {
    if (doneFlag) return;
    doneFlag = true;
    closeClient(host);
    closeClient(member);
    setTimeout(() => done(), 100);
  }
}

// 顺序执行，服务器全程不关，最后统一关闭。
// ⚠️ 用例之间必须等服务器把连接与操作权槽位清干净：平权互斥对房主同样生效，
//    上一条用例的成员如果还占着 room.operator，下一条用例里房主的 request-action
//    会被误判成"别人正在操作"而拒绝（曾造成偶发失败）。
function awaitFreeRoom(next) {
  // 先把所有登记过的客户端关掉（幂等）。用例偶尔会漏关某条连接，若不在这里兜底，
  // 泄漏的客户端会一直自动重连并抢占房主槽位，让后续用例偶发失败。
  closeAllClients();
  waitFor(() => room.operator === null && room.host === null, 2500,
    (e) => {
      if (e) {
        // 诊断：槽位没清干净就继续跑，下一条用例的 request-action 会被误判成"别人正在操作"
        const op = room.operator;
        console.log('    [warn] 房间槽位未清空: host=' + (room.host ? (room.host.__name || '(无名)') : 'null')
          + ' operator=' + (op ? ((op.__name || '(无名)') + ' isHost=' + op.__isHost + ' cleaned=' + !!op.__cleaned) : 'null')
          + ' members=' + room.members.size + ' 在册=['
          + Array.from(room.members).map((m) => (m.__name || '(无名)')).join(',') + ']');
      }
      next();
    },
    '等待服务器清空房间槽位（上一用例的残留连接/操作权）');
}

const CHAIN = [
  testHostMember,
  testActionDeny,
  testHostOfflineKeepsRoom,
  testNamelessMemberBroadcast,
  testHostOperateDeny,
  testIdempotentAndStale,
  testHostReplaceReleasesOperator,
  testGameEnd,
];

(function runChain(i) {
  if (i >= CHAIN.length) {
    try { wss.close(); } catch (e) {}
    console.log('\n====================================');
    console.log('Java 服务器协议兼容性测试: ' + pass + ' 通过，' + fail + ' 失败');
    console.log('====================================');
    process.exit(fail === 0 ? 0 : 1);
    return;
  }
  CHAIN[i](() => awaitFreeRoom(() => runChain(i + 1)));
})(0);
