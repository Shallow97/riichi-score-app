/**
 * serve.js — 日麻计分原型服务器（无房间码 · 单房间 · 全员协作 · 全提交制）
 *
 * ⚠️ 本文件必须与 android/.../RiichiServer.java **逐条同步**：
 *    两者是同一份协议的两个实现（电脑端跑这个，手机房主端跑 Java 那个）。
 *    协议不一致 → 电脑端联机行为与真机不同，tests/java-server-parity.js 也会失真。
 *
 * 模型：
 *  - 房主打开 APP/页面时访问 http://<host>:8765/?host=1 → 识别为房主(host)。
 *  - 其他玩家浏览器访问 http://<host>:8765/ → 识别为成员(member)。
 *  - 单房间：所有连接进同一个房间，无需输入房间码。
 *  - 任意玩家可"申请操作权"执行结算/立直，服务器仲裁互斥并广播。
 *  - **服务器是唯一账本**：任何端（含房主）的变更都要 commit 上行，
 *    服务器校验 baseSeq、幂等去重后落库并广播，客户端收到 ack 才渲染/持久化。
 *  - 房主链路断开：**保留房间**（成员可继续结算），只广播 host-offline。
 *
 * 消息协议（WebSocket JSON）v2：
 *  客户端→服务器：
 *    {type:'set-name', name}
 *    {type:'request-action', name}      // 任意玩家申请操作权（结算/立直）
 *    {type:'release-action'}            // 操作完成后释放
 *    {type:'commit', opId, baseSeq, state}  // 提交权威态（房主或当前操作者）
 *    {type:'game-end', record}          // 房主结束对局：附带归档记录，广播给成员
 *    {type:'ping', ts} / {type:'pong', ts}
 *    {type:'leave-room'}
 *  服务器→客户端：
 *    {type:'welcome', role, state, seq, operator, hostOnline, hostSeen, members?}
 *                                       // members 只下发给房主（成员端不感知设备数）
 *    {type:'state', state, seq}         // 广播给"非提交者"
 *    {type:'ack', opId, seq}            // 提交成功
 *    {type:'conflict', opId, seq, state, reason}  // reason: 'stale' | 'denied'
 *    {type:'game-end', record}
 *    {type:'action-granted'} / {type:'action-denied', by}
 *    {type:'operator-change', name}
 *    {type:'member-count', count}       // ⚠️ 只发给房主
 *    {type:'host-offline'} / {type:'host-online'}
 *    {type:'ping', ts} / {type:'pong', ts}
 *    {type:'error', message}
 *
 * 可作为模块导出 createServer(port) 供测试使用（测试在独立端口起实例，互不污染）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const types = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

let WebSocketServer = null;
const WS_CANDIDATES = [
  () => require('ws'),
  () => require(path.join(__dirname, 'node_modules', 'ws')),
  () => require(path.join(process.cwd(), 'node_modules', 'ws')),
];
for (const load of WS_CANDIDATES) {
  try { ({ WebSocketServer } = load()); break; }
  catch (e) { /* 下一个 */ }
}

// —— 心跳参数（与 RiichiServer.java 保持一致）——
const HB_INTERVAL_MS = 20000;  // 服务器每 20s 向所有连接发 ping
const HB_CHECK_MS = 5000;      // 死链检查周期
// 超过这么久没收到任何消息 → 判定死链并断开（顺带释放它占着的操作权）。
// 取 75s（≈3 个 ping 周期）：手机后台/息屏会把网页定时器降频到分钟级，
// 余量太小会把"活着但被降频"的客户端误杀。
// ⚠️ 只对成员生效；房主连接豁免（房主页面就在本机，见下方 hbWatch 里的说明）。
const HB_TIMEOUT_MS = 75000;
// 操作权租约：持有者超过这么久「没有任何上行消息」→ 释放操作权槽位。
// ⚠️ 只释放"操作权"，**绝不断开连接**（房主连接可能只是被系统挂起了）。
// 为什么必须有它：房主连接豁免了死链看门狗（见 hbWatch），当房主页面被系统挂起
// （锁屏 / 切后台）时，TCP 链路还活着、但客户端再也发不出任何消息 —— 若不回收，
// 操作权就被**永久占死**：全桌的结算/立直按钮一直灰着，成员端只显示
// 「XXX 正在操作，请稍候」，而那个人其实锁着屏，无从自救。
// 取 45s：页面可见时客户端每 10s 必发一次 ping（lastSeen 持续刷新）；后台节流到
// ~41% 时约 24s 一次，仍在租期内不会误释放；息屏后心跳被拉长到 75s 以上 → 正常回收。
const OP_LEASE_MS = (() => {
  const v = parseInt(process.env.RIICHI_OP_LEASE_MS, 10);
  return v > 0 ? v : 45000;
})();
const OP_LOG_MAX = 128;        // 幂等去重保留的最近提交编号条数

/**
 * 获取本机局域网 IPv4（供房主展示给其他玩家输入的连接地址）。
 * 网页端无法自行获知本机 IP（浏览器没有相关 API），必须由服务器注入。
 */
function getLocalLanIp() {
  try {
    const os = require('os');
    const ifaces = os.networkInterfaces();
    // 优先无线/有线网卡：虚拟机（VMware/VirtualBox/Hyper-V）、蓝牙等虚拟网卡
    // 往往先被枚举到，取"第一个非回环"会给出访客网络地址（其他手机根本连不上）。
    const preferred = [];
    const others = [];
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (iface.family !== 'IPv4' || iface.internal) continue;
        const n = name.toLowerCase();
        const isVirtual = /virtual|vmware|vbox|hyper-v|vethernet|bluetooth|loopback|docker|wsl/.test(n);
        if (isVirtual) { others.push(iface.address); continue; }
        if (/^(wlan|wl|wifi|en|eth|ap)/.test(n)) preferred.push(iface.address);
        else others.push(iface.address);
      }
    }
    if (preferred.length) return preferred[0];
    if (others.length) return others[0];
  } catch (e) { /* ignore */ }
  return null;
}

const LAN_IP = getLocalLanIp();

function createServer(port, onListening) {
  onListening = typeof onListening === 'function' ? onListening
    : (onListening && typeof onListening.onListening === 'function' ? onListening.onListening : null);
  const server = http.createServer((req, res) => {
    let url = req.url.split('?')[0];
    if (url === '/') url = '/index.html';
    const fp = path.join(process.cwd(), decodeURIComponent(url));
    if (!fp.startsWith(process.cwd())) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('403'); return;
    }
    fs.readFile(fp, (e, d) => {
      if (e) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404 ' + fp); return; }
      res.writeHead(200, { 'Content-Type': types[path.extname(fp)] || 'text/plain' });
      // 为 index.html 注入本机局域网 IP：网页端无法获知本机 IP，
      // 否则首页"其他玩家访问"会回退成 location.hostname（本机访问时为 127.0.0.1），
      // 导致手机等其他设备无法访问。注入后 app.js 优先读取 window.__LAN_IP__。
      if (url === '/index.html' && LAN_IP) {
        const html = d.toString('utf8');
        const injected = html.replace('</head>',
          '<script>window.__LAN_IP__=' + JSON.stringify(LAN_IP) + ';</script></head>');
        res.end(injected);
      } else {
        res.end(d);
      }
    });
  });

  // —— 单房间状态 ——
  const connMeta = new Map();     // ws -> { name, lastSeen }
  const room = {
    host: null, members: new Set(), state: null, seq: 0, operator: null,
    opLog: new Map(),             // opId -> 提交后的 seq（幂等去重）
    hostSeen: false,              // 本房间是否曾有过房主（区分"房主离开"与"房主还没进来"）
  };

  function memberCount() { return (room.host ? 1 : 0) + room.members.size; }
  function allConns() {
    const list = [];
    if (room.host) list.push(room.host);
    for (const m of room.members) list.push(m);
    return list;
  }
  function send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
  }
  function operatorName() {
    if (!room.operator) return null;
    const meta = connMeta.get(room.operator);
    return (meta && meta.name) || null;
  }
  function rememberOp(opId, seq) {
    room.opLog.set(opId, seq);
    while (room.opLog.size > OP_LOG_MAX) {
      const oldest = room.opLog.keys().next().value;
      room.opLog.delete(oldest);
    }
  }
  function broadcastState(exceptWs) {
    const json = { type: 'state', state: room.state, seq: room.seq };
    for (const m of room.members) if (m !== exceptWs) send(m, json);
    if (room.host && room.host !== exceptWs) send(room.host, json);
  }
  function broadcastOperator() {
    const json = { type: 'operator-change', name: operatorName() };
    for (const m of room.members) send(m, json);
    if (room.host) send(room.host, json);
  }
  /**
   * 设备数变更通知。⚠️ **只发给房主**：成员端不感知也不展示全屋设备数（B 项），
   * 发过去只会让成员端多维护一个它用不到的字段（旧版还因此出现"两端数字不一致"的假象）。
   */
  function notifyMemberCount() {
    const count = memberCount();
    if (room.host) send(room.host, { type: 'member-count', count: count - 1 });
  }
  function welcome(ws, isHost) {
    const msg = {
      type: 'welcome',
      role: isHost ? 'host' : 'member',
      state: room.state,
      seq: room.seq,
      operator: operatorName(),
      hostOnline: room.host != null,
      hostSeen: room.hostSeen,
    };
    // 设备数同样只给房主（成员端不感知）
    if (isHost) msg.members = memberCount();
    send(ws, msg);
  }

  /**
   * 连接清理。房主断开时**不**解散房间（成员可继续结算），只广播 host-offline；
   * 同时释放房主可能持有的操作权，避免槽位被死连接占死（旧版正是"全员被 action-denied 卡死"的成因）。
   */
  function disconnectCleanup(ws) {
    const meta = connMeta.get(ws);
    connMeta.delete(ws);
    if (room.host === ws) {
      room.host = null;
      const wasOperator = room.operator === ws;
      if (wasOperator) room.operator = null;
      for (const m of room.members) send(m, { type: 'host-offline' });
      if (wasOperator) broadcastOperator();
      notifyMemberCount();
      return;
    }
    if (room.members.delete(ws)) {
      if (room.operator === ws) { room.operator = null; broadcastOperator(); }
      notifyMemberCount();
    }
  }

  let wss = null;
  if (WebSocketServer) {
    wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', (ws, req) => {
      const isHost = (req.url || '').includes('host=1');
      connMeta.set(ws, { name: null, lastSeen: Date.now() });
      if (isHost) {
        const prevHost = room.host;
        let clearedOperator = false;
        if (prevHost && prevHost !== ws) {
          room.members.delete(prevHost);
          // 换房主（页面刷新/重连）：旧连接必须一并释放操作权。
          // 旧版只换 room.host，槽位仍指向死连接 → 成员申请操作权被永久拒绝。
          if (room.operator === prevHost) { room.operator = null; clearedOperator = true; }
          try { prevHost.terminate(); } catch (e) { try { prevHost.close(); } catch (e2) {} }
          connMeta.delete(prevHost);
        }
        const wasOffline = room.host == null;
        room.host = ws;
        room.hostSeen = true;
        welcome(ws, true);
        if (wasOffline) {
          for (const m of room.members) send(m, { type: 'host-online' });
        }
        // 释放了槽位必须广播出去：否则成员端 operatorName() 仍是旧名字，
        // 结算/立直按钮会一直灰着（判定条件是「无人占权 或 本机持权」）。
        if (wasOffline || clearedOperator) broadcastOperator();
      } else {
        room.members.add(ws);
        welcome(ws, false);
      }
      notifyMemberCount();

      ws.on('message', (raw) => {
        const meta = connMeta.get(ws);
        if (meta) meta.lastSeen = Date.now();
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        switch (msg.type) {
          case 'set-name': {
            if (meta) meta.name = msg.name || null;
            break;
          }
          case 'ping': {
            send(ws, msg.ts != null ? { type: 'pong', ts: msg.ts } : { type: 'pong' });
            break;
          }
          case 'pong': break;
          case 'request-action': {
            if (room.operator && room.operator !== ws) {
              const by = operatorName() || '其他玩家';
              send(ws, { type: 'action-denied', by });
              break;
            }
            room.operator = ws;
            if (meta && msg.name) meta.name = msg.name;
            send(ws, { type: 'action-granted' });
            broadcastOperator();
            break;
          }
          case 'release-action': {
            if (room.operator === ws) { room.operator = null; broadcastOperator(); }
            break;
          }
          case 'commit': {
            // 只有房主或当前操作者能提交
            if (room.host !== ws && room.operator !== ws) {
              send(ws, { type: 'conflict', opId: msg.opId, seq: room.seq, state: room.state, reason: 'denied' });
              break;
            }
            // 幂等：同一 opId 重复提交只回 ack，不重复入账（回执丢失后重发的兜底）
            if (msg.opId && room.opLog.has(msg.opId)) {
              send(ws, { type: 'ack', opId: msg.opId, seq: room.opLog.get(msg.opId) });
              break;
            }
            const baseSeq = typeof msg.baseSeq === 'number' ? msg.baseSeq : room.seq;
            if (baseSeq !== room.seq) {
              send(ws, { type: 'conflict', opId: msg.opId, seq: room.seq, state: room.state, reason: 'stale' });
              break;
            }
            room.state = msg.state != null ? msg.state : null;
            room.seq += 1;
            if (msg.opId) rememberOp(msg.opId, room.seq);
            send(ws, { type: 'ack', opId: msg.opId, seq: room.seq });
            broadcastState(ws);
            break;
          }
          case 'game-end': {
            // 房主结束对局：把归档记录广播给所有成员，成员据此同步结束并跳转历史页。
            // 同时把权威态清空（对局已归档，新加入的成员不应再看到这局）。
            if (room.host === ws) {
              room.state = null;
              room.seq += 1;
              const json = { type: 'game-end', record: msg.record || null };
              for (const m of room.members) send(m, json);
              broadcastState(null);
            }
            break;
          }
          case 'leave-room': {
            disconnectCleanup(ws);
            break;
          }
          default: break;
        }
      });
      ws.on('close', () => { disconnectCleanup(ws); });
      ws.on('error', () => {});
    });

    // 心跳：周期 ping + 死链看门狗（unref 保证测试进程能正常退出）
    const hbPing = setInterval(() => {
      const ts = Date.now();
      for (const c of allConns()) send(c, { type: 'ping', ts: ts });
    }, HB_INTERVAL_MS);
    if (hbPing.unref) hbPing.unref();
    const hbWatch = setInterval(() => {
      const now = Date.now();
      for (const c of allConns()) {
        const meta = connMeta.get(c);
        if (!meta) continue;
        // ⚠️ 房主连接豁免应用层空闲看门狗：房主页面就跑在服务器本机（回环连接），
        // 手机锁屏 / 页面切后台时浏览器会挂起页面的任务投递，页面既收不到 ping、
        // 也回不了 pong，但 TCP 链路本身是活的。真断开（页面关闭 / 进程退出）会走
        // 'close' → disconnectCleanup，不需要靠超时兜底。
        // 若照常判死，房主一锁屏就会被踢下线，而隐藏中的页面连"我已掉线"都察觉不到。
        if (c === room.host) continue;
        if (now - meta.lastSeen > HB_TIMEOUT_MS) {
          try { c.terminate(); } catch (e) { try { c.close(); } catch (e2) {} }
        }
      }
      // 操作权租约：持有者长时间无任何上行消息 → 释放槽位（不 close 连接）。
      // 房主连接被系统挂起时不会走 disconnectCleanup（链路还活着），只能靠这里回收。
      if (room.operator) {
        const om = connMeta.get(room.operator);
        if (!om || now - om.lastSeen > OP_LEASE_MS) {
          room.operator = null;
          broadcastOperator();
        }
      }
    }, HB_CHECK_MS);
    if (hbWatch.unref) hbWatch.unref();
  }

  server.listen(port, '0.0.0.0', () => {
    if (onListening) onListening(server);
  });
  return server;
}

// 直接运行时自动监听 8765；被测试 require 时仅导出 createServer
if (require.main === module) {
  const server = createServer(8765, ({ }) => {
    console.log('server on 8765' + (WebSocketServer ? ' (+WebSocket /ws, 无房间码·全提交制)' : ' (无WebSocket)'));
  });
  module.exports = { createServer, server };
} else {
  module.exports = { createServer };
}
