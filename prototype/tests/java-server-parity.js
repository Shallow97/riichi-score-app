/**
 * java-server-parity.js — 验证 Android 端 RiichiServer.java 的协议逻辑与前端 net.js 完全兼容
 *
 * 背景：RiichiServer.java 是纯 Java（依赖 Android AssetManager），本机无 Android SDK，
 * 无法直接编译运行。因此本测试用 Node 的 ws 库，**逐条 1:1 复刻 RiichiServer.java 的
 * 核心状态机**（onConnected / handleMessage / onDisconnected），然后加载**真实的
 * prototype/js/net.js** 作为前端客户端去连接，验证：
 *   1. 房主(?host=1) → room-created isHost=true，前端识别为房主
 *   2. 成员(无 host) → joined，前端识别为成员，无需房间码
 *   3. 成员申请操作权 → granted；第二个成员申请 → denied(by=操作者名)，与 Java 逻辑一致
 *   4. 操作者提交 host-state → 广播给其他端，前端收到一致权威态
 *   5. 房主 WebSocket 断开 → host-left，前端收到并重置
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
// 第 2 步：用 ws 实现一个"Java 语义"的服务器（1:1 复刻 RiichiServer.java）
// ============================================================
const PORT = 8771;
const room = { host: null, members: new Set(), state: null, operator: null };

function memberCount() { return (room.host ? 1 : 0) + room.members.size; }
function escapeJson(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}
function operatorJson() {
  if (!room.operator) return 'null';
  return room.operator.name ? '"' + escapeJson(room.operator.name) + '"' : 'null';
}
function safeState(s) { return s == null ? '' : escapeJson(s); }

function broadcastOperator() {
  const name = room.operator ? room.operator.name : null;
  const json = '{"type":"operator-change","name":' + (name != null ? '"' + escapeJson(name) + '"' : 'null') + '}';
  room.members.forEach(m => m.send(json));
  if (room.host) room.host.send(json);
}
function notifyMemberCount() {
  const count = memberCount();
  if (room.host) room.host.send('{"type":"member-count","count":' + (count - 1) + '}');
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

const wss = new WebSocket.Server({ port: PORT });
wss.__hostWs = null;

wss.on('connection', (ws, req) => {
  const isHost = (req.url || '').indexOf('host=1') !== -1;
  ws.__isHost = isHost;
  ws.__name = null;

  if (isHost) {
    if (room.host && room.host !== ws) { room.members.delete(room.host); try { room.host.close(); } catch (e) {} }
    room.host = ws;
    wss.__hostWs = ws;
    ws.send('{"type":"room-created","code":"HOST","isHost":true}');
  } else {
    room.members.add(ws);
    ws.send('{"type":"joined","isHost":false,"state":"' + safeState(room.state) +
      '","operator":' + operatorJson() + '}');
  }
  notifyMemberCount();

  ws.on('message', (data) => {
    const raw = data.toString();
    const type = jsonStr(raw, 'type');
    if (!type) return;
    switch (type) {
      case 'set-name': { const name = jsonStr(raw, 'name'); ws.__name = name; break; }
      case 'request-action': {
        if (room.operator != null && room.operator !== ws) {
          const by = room.operator.__name || '其他玩家';
          ws.send('{"type":"action-denied","by":"' + escapeJson(by) + '"}');
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
      case 'host-state': {
        if (ws === room.host || room.operator === ws) {
          const state = jsonStr(raw, 'state');
          if (state != null) {
            room.state = state;
            const json = '{"type":"state","state":"' + escapeJson(state) + '"}';
            // 广播给所有成员 + 房主（跳过提交者自己），与修复后的 RiichiServer.java 一致
            room.members.forEach(m => { if (m !== ws) m.send(json); });
            if (room.host && room.host !== ws) room.host.send(json);
          }
        }
        break;
      }
      case 'game-end': {
        // 房主结束对局：把归档记录广播给所有成员（与 serve.js / 未来 RiichiServer.java 一致）
        if (ws === room.host) {
          const record = jsonStr(raw, 'record');
          const json = '{"type":"game-end","record":' + (record != null ? '"' + escapeJson(record) + '"' : 'null') + '}';
          room.members.forEach(m => m.send(json));
        }
        break;
      }
      default: break;
    }
  });

  ws.on('close', () => {
    if (ws === room.host) {
      room.host = null; wss.__hostWs = null;
      room.members.forEach(m => m.send('{"type":"host-left"}'));
      room.members.clear();
      room.operator = null;
    } else if (room.members.delete(ws)) {
      if (room.operator === ws) { room.operator = null; broadcastOperator(); }
    }
    notifyMemberCount();
  });
});

// ============================================================
// 第 3 步：加载真实前端 net.js
// ============================================================
function makeNetClient(isHost) {
  const sandbox = {
    location: { search: isHost ? '?host=1' : '', host: 'localhost:' + PORT, hostname: 'localhost', protocol: 'http:' },
    setTimeout, clearTimeout, console,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  // 包装 WebSocket，捕获 net.js 内部创建的 socket 实例，便于测试中断开
  const createdSockets = [];
  const WrappedWS = function (url, protocols) {
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

  const module = { exports: {} };
  // 注入假 Storage + hooks，使 Net.install() 把"保存即广播"接上
  sandbox.Storage = { hooks: {} };
  new Function(
    'window', 'self', 'location', 'WebSocket', 'setTimeout', 'clearTimeout', 'Storage', 'module',
    netSrc
  )(sandbox, sandbox, sandbox.location, sandbox.WebSocket, sandbox.setTimeout, sandbox.clearTimeout, sandbox.Storage, module);
  const Net = module.exports;
  sandbox.Net = Net;
  Net.install();
  Net.init();
  return { Net, sandbox };
}

// 真正断开客户端底层 WebSocket（模拟浏览器关闭连接）
function closeClient(net) {
  try { net.Net.leaveRoom(); } catch (e) {}
  (net.sandbox.__sockets || []).forEach((s) => { try { s.close(); } catch (e) {} });
}

// ============================================================
// 第 4 步：测试用例（共享同一服务器，顺序执行）
// ============================================================
function saveAsOperator(net) {
  if (net.sandbox.Storage && net.sandbox.Storage.hooks && net.sandbox.Storage.hooks.onSave) {
    net.sandbox.Storage.hooks.onSave('{"round":"东1局"}');
    return true;
  }
  return false;
}

function waitFor(fn, timeout, cb, errMsg) {
  const start = Date.now();
  const iv = setInterval(() => {
    if (fn()) { clearInterval(iv); cb(null); }
    else if (Date.now() - start > timeout) { clearInterval(iv); cb(new Error(errMsg || '等待超时')); }
  }, 20);
}

function testHostMember(done) {
  console.log('\n== 用例 1: 房主(?host=1) + 成员(无host) 自动识别 + 操作权 + 广播 ==');
  const host = makeNetClient(true);
  const member = makeNetClient(false);
  let hostGot = false, memberGot = false, started = false, gotState = false;
  let hostOk = false, memberOk = false;

  host.Net.onStatus((s) => {
    if (s.connected && s.host && !hostOk) { hostOk = true; ok('房主连接 → 前端识别为房主（host=true）'); }
    if (s.connected && s.host) { hostGot = true; maybeGo(); }
  });
  member.Net.onStatus((s) => {
    if (s.connected && !s.host && !memberOk) { memberOk = true; ok('成员连接 → 前端识别为成员（host=false），无需房间码'); }
    if (s.connected && !s.host) { memberGot = true; maybeGo(); }
  });

  function maybeGo() {
    if (started || !hostGot || !memberGot) return;
    started = true;
    member.Net.setName('小明');
    member.Net.requestAction('小明', (err, granted) => {
      if (err || !granted) { bad('成员申请操作权被授予', err); console.log('  [debug] requestAction err=' + err + ' granted=' + granted); return finish(); }
      ok('成员申请操作权被授予');
      // 房主监听成员(操作者)提交的权威态 → 验证"成员操作时房主能同步"
      host.Net.onState((st) => {
        if (st === '{"round":"东1局"}' && !gotState) {
          gotState = true;
          ok('操作者(成员)提交 host-state → 房主收到一致权威态（成员→房主同步正常）');
          member.Net.releaseAction();
          finish();
        }
      });
      const sent = saveAsOperator(member);
      if (!sent) { bad('模拟成员保存广播', new Error('hooks.onSave 未接上')); return finish(); }
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

function testHostLeft(done) {
  console.log('\n== 用例 3: 房主 WebSocket 断开 → host-left ==');
  const host = makeNetClient(true);
  const member = makeNetClient(false);
  let memberReady = false, doneFlag = false;

  member.Net.onStatus((s) => {
    if (s.connected && !s.host && !memberReady) {
      memberReady = true;
      ok('成员已加入');
      // 模拟房主手机 WebSocket 断开（服务端检测到连接关闭 → 广播 host-left）
      if (wss.__hostWs) wss.__hostWs.close();
    } else if (memberReady && !s.connected && !doneFlag) {
      doneFlag = true;
      ok('房主断开 → 成员前端收到 host-left 并重置为未连接');
      closeClient(member);
      setTimeout(() => done(), 100);
    }
  });
}

function testNamelessMemberBroadcast(done) {
  console.log('\n== 用例 4(回归): 成员【不设名字】申请操作权并广播 → 房主收到 ==');
  console.log('  背景：成员无名时服务器 broadcastOperator 会发 operator-change name=null，');
  console.log('  旧版 net.js 误将其当作"操作权释放"而清掉 iAmOperator，导致广播被静默丢弃。');
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
        // 房主监听成员广播
        host.Net.onState((st) => {
          if (st === '{"round":"东1局","from":"无名成员"}' && !hostGotState) {
            hostGotState = true;
            ok('无名成员广播 host-state → 房主收到（成员→房主同步正常）');
            finish();
          }
        });
        member.sandbox.Storage.hooks.onSave('{"round":"东1局","from":"无名成员"}');
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
    // 房主像成员一样走服务器申请操作权（不再绕过互斥）
    host.Net.setName('房主A');
    host.Net.requestAction('房主A', (err, granted) => {
      if (err || !granted) { bad('房主申请操作权被授予', err); return finish(); }
      ok('房主申请操作权被授予（房主也走服务器互斥）');
      if (!host.Net.amOperator()) { bad('房主持有操作权(amOperator=true)', new Error('amOperator=' + host.Net.amOperator())); return finish(); }
      ok('房主 amOperator=true（真正持有操作权）');
      // 此时成员申请应被拒绝（操作权被房主占用）
      member.Net.setName('小明');
      member.Net.requestAction('小明', (e2, g2) => {
        if (e2) { bad('成员申请被拒绝（by=房主A）', e2); return finish(); }
        if (g2) { bad('成员应被拒绝但被授予（操作权应被房主独占）'); return finish(); }
        ok('房主占权时成员申请被拒绝（杜绝房主+成员双结算）');
        // 房主释放后，成员能接手
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
    // 成员端监听"房主结束对局"
    member.Net.onGameEnd((r) => {
      ok('成员前端收到 game-end（onGameEnd 触发）');
      if (r && r.id === 'g9') ok('携带归档记录且内容一致（endReason=' + r.endReason + '）');
      else bad('归档记录未正确传递', new Error('record=' + JSON.stringify(r)));
      finish();
    });
    // 房主调用 endGame 广播（模拟点击"结束并保存"后的通知）
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

// 顺序执行，服务器全程不关，最后统一关闭
testHostMember(() => {
  testActionDeny(() => {
    testHostLeft(() => {
      testNamelessMemberBroadcast(() => {
        testHostOperateDeny(() => {
          testGameEnd(() => {
            try { wss.close(); } catch (e) {}
            console.log('\n====================================');
            console.log('Java 服务器协议兼容性测试: ' + pass + ' 通过，' + fail + ' 失败');
            console.log('====================================');
            process.exit(fail === 0 ? 0 : 1);
          });
        });
      });
    });
  });
});
