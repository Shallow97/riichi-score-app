/**
 * serve.js — 日麻计分原型服务器（无房间码 · 单房间 · 全员协作）
 *
 * 模型：
 *  - 房主打开 APP/页面时访问 http://<host>:8765/?host=1 → 识别为房主(host)。
 *  - 其他玩家浏览器访问 http://<host>:8765/ → 识别为成员(member)。
 *  - 单房间：所有连接进同一个房间，无需输入房间码。
 *  - 任意玩家可"申请操作权"执行结算/立直，服务器仲裁互斥并广播。
 *  - 流局/修正/撤回/结束仍仅房主（前端 isHost 判断）。
 *  - 房主断线：房间解散，成员被通知。
 *
 * 消息协议（WebSocket JSON）：
 *  客户端→服务器：
 *    {type:'set-name', name}
 *    {type:'request-action', name}    // 任意玩家申请操作权（结算/立直）
 *    {type:'release-action'}          // 操作完成后释放
 *    {type:'host-state', state}       // 房主 或 当前操作者 提交权威态
 *    {type:'game-end', record}        // 房主结束对局：附带归档记录，广播给成员
 *    {type:'leave-room'}
 *  服务器→客户端：
 *    {type:'room-created', code, isHost:true}          // 房主连接建立
 *    {type:'joined', isHost:false, state, operator}    // 成员连接建立
 *    {type:'state', state}
 *    {type:'game-end', record}        // 房主结束对局：成员据此同步结束并跳转历史页
 *    {type:'action-granted'}
 *    {type:'action-denied', by}
 *    {type:'operator-change', name}
 *    {type:'member-count', count}
 *    {type:'host-left'}
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

/**
 * 获取本机局域网 IPv4（供房主展示给其他玩家输入的连接地址）。
 * 网页端无法自行获知本机 IP（浏览器没有相关 API），必须由服务器注入。
 */
function getLocalLanIp() {
  try {
    const os = require('os');
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
      }
    }
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
  const connMeta = new WeakMap(); // ws -> { name }
  const room = { host: null, members: new Set(), state: null, operator: null };

  function send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
  }
  function memberCount() { return (room.host ? 1 : 0) + room.members.size; }
  function broadcastState(state, exceptWs) {
    room.state = state;
    for (const m of room.members) if (m !== exceptWs) send(m, { type: 'state', state });
    // 房主也必须在广播范围内：成员提交状态时，房主(host)不在 members 里，必须单独发送
    if (room.host && room.host !== exceptWs) send(room.host, { type: 'state', state });
  }
  function broadcastOperator() {
    const name = room.operator ? (connMeta.get(room.operator) || {}).name || null : null;
    const json = { type: 'operator-change', name };
    for (const m of room.members) send(m, json);
    if (room.host) send(room.host, json);
  }
  function notifyMemberCount() {
    const count = memberCount();
    if (room.host) send(room.host, { type: 'member-count', count: count - 1 });
  }
  function disconnectCleanup(ws) {
    if (room.host === ws) {
      for (const m of room.members) send(m, { type: 'host-left' });
      room.host = null;
      room.members.clear();
      room.operator = null;
      return;
    }
    if (room.members.has(ws)) {
      room.members.delete(ws);
      connMeta.delete(ws);
      if (room.operator === ws) { room.operator = null; broadcastOperator(); }
    }
  }

  if (WebSocketServer) {
    const wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', (ws, req) => {
      const isHost = (req.url || '').includes('host=1');
      connMeta.set(ws, { name: null });
      if (isHost) {
        if (room.host && room.host !== ws) {
          try { room.host.close(); } catch (e) {}
          room.members.delete(room.host);
        }
        room.host = ws;
        send(ws, { type: 'room-created', code: 'HOST', isHost: true });
      } else {
        room.members.add(ws);
        send(ws, {
          type: 'joined', isHost: false, state: room.state,
          operator: room.operator ? (connMeta.get(room.operator) || {}).name || null : null,
        });
      }
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        switch (msg.type) {
          case 'set-name': {
            const meta = connMeta.get(ws);
            if (meta) meta.name = msg.name || null;
            break;
          }
          case 'request-action': {
            if (room.operator && room.operator !== ws) {
              const by = (connMeta.get(room.operator) || {}).name || '其他玩家';
              send(ws, { type: 'action-denied', by });
              break;
            }
            room.operator = ws;
            const meta = connMeta.get(ws);
            if (msg.name) meta.name = msg.name;
            send(ws, { type: 'action-granted' });
            broadcastOperator();
            break;
          }
          case 'release-action': {
            if (room.operator === ws) { room.operator = null; broadcastOperator(); }
            break;
          }
          case 'host-state': {
            if (room.host === ws || room.operator === ws) broadcastState(msg.state, ws);
            break;
          }
          case 'game-end': {
            // 房主结束对局：把归档记录广播给所有成员，成员据此同步结束并跳转历史页
            if (room.host === ws) {
              for (const m of room.members) send(m, { type: 'game-end', record: msg.record || null });
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
      notifyMemberCount();
    });
  }

  server.listen(port, '0.0.0.0', () => {
    if (onListening) onListening(server);
  });
  return server;
}

// 直接运行时自动监听 8765；被测试 require 时仅导出 createServer
if (require.main === module) {
  const server = createServer(8765, ({ }) => {
    console.log('server on 8765' + (WebSocketServer ? ' (+WebSocket /ws, 无房间码·操作权互斥)' : ' (无WebSocket)'));
  });
  module.exports = { createServer, server };
} else {
  module.exports = { createServer };
}
