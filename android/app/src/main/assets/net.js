/**
 * net.js — 联网同步层（无房间码 · 单房间 · 操作权互斥 · 全员协作）
 *
 * 设计：
 *  - 无房间码：房主通过 URL ?host=1 识别身份，其他玩家输 IP 直接连入。
 *  - 房主：拥有"全局操作"权（流局/修正/撤回/结束），仅房主可点。
 *  - 全员平权（结算/立直）：房主与成员在"和牌结算/立直"上地位相同，
 *    都要向服务器申请操作权，且同一时刻服务器只授予一人，杜绝双份结算。
 *  - 成员：可参与"和牌结算/立直"（申请操作权），全局操作仅房主。
 *  - 服务器不可用 / WebSocket 不支持：房主降级为单机（本地直接授予），不阻塞功能。
 *
 * 对外接口（window.Net）：
 *  ﹒ init()                        启动时调用一次（自动识别房主/成员并连接）
 *  ﹒ isOnline() / isInRoom() / isHost()
 *  ﹒ memberCount() / operatorName() / amOperator()
 *  ﹒ requestAction(name, cb)       申请操作权（结算/立直）
 *  ﹒ releaseAction()               释放操作权
 *  ﹒ endGame(record)               房主结束对局：广播归档记录给成员
 *  ﹒ leaveRoom()                   断开
 *  ﹒ onState(cb) / onOperator(cb) / onStatus(cb) / onGameEnd(cb)
 */
(function () {
  const Net = {};
  // 无房间码：房主访问带 ?host=1，WebSocket 也带此标记
  const IS_HOST = (function () {
    try { return /[?&]host=1/.test(location.search || ''); } catch (e) { return false; }
  })();
  const SERVER_WS = (function () {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws' + (IS_HOST ? '?host=1' : '');
  })();

  let ws = null;
  let online = false;
  let connected = false;   // 已建立身份（房主 room-created / 成员 joined）
  let host = IS_HOST;      // 房主身份由 URL 决定（离线时也成立）
  let members = 1;
  let operator = null;
  // 平权模型：本机是否"正持有结算/立直操作权"。房主不再天然持有，
  // 需与成员一样向服务器申请、经 room-created/action-granted 后才为 true。
  let iAmOperator = false;
  // 房主"全局操作"（流局/修正/撤回/结束）无需占用该槽位；canOperate 判定在 app.js 处理。
  const stateListeners = [];
  const operatorListeners = [];
  const statusListeners = [];
  const gameEndListeners = [];

  function emitStatus() {
    statusListeners.forEach((fn) => {
      try { fn({ online, connected, host, members, operator, iAmOperator }); } catch (e) {}
    });
  }

  function broadcastOnSave(serializedState) {
    if (!online || !connected || !ws || ws.readyState !== 1) return;
    if (!host && !iAmOperator) return;
    try { ws.send(JSON.stringify({ type: 'host-state', state: serializedState })); } catch (e) {}
  }

  function connect() {
    if (typeof WebSocket === 'undefined') return;
    try { ws = new WebSocket(SERVER_WS); }
    catch (e) { online = false; emitStatus(); return; }

    ws.onopen = () => { online = true; emitStatus(); };
    ws.onclose = () => {
      online = false; connected = false; members = 1;
      operator = null; iAmOperator = false;
      emitStatus();
    };
    ws.onerror = () => {};
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      switch (m.type) {
        case 'room-created':
          connected = true; host = true; members = 1; iAmOperator = false;
          emitStatus(); break;
        case 'joined':
          connected = true; host = false; members = 1;
          operator = m.operator || null; iAmOperator = false;
          if (m.state) { try { stateListeners.forEach((fn) => fn(m.state)); } catch (e) {} }
          emitStatus(); break;
        case 'state':
          try { stateListeners.forEach((fn) => fn(m.state)); } catch (e) {}
          break;
        case 'game-end':
          // 房主结束对局：通知成员端（携带归档记录）同步结束并跳转历史页
          // 记录在线上以序列化字符串传输（与 host-state 的 state 一致，兼容 Java 字符串协议）
          {
            let rec = null;
            if (m.record) { try { rec = JSON.parse(m.record); } catch (e) { rec = null; } }
            try { gameEndListeners.forEach((fn) => fn(rec)); } catch (e) {}
          }
          break;
        case 'member-count':
          members = (m.count || 0) + 1; emitStatus(); break;
        case 'operator-change':
          operator = m.name || null;
          // 注意：不要在此根据 name===null 清除 iAmOperator。
          // 服务器在"成员申请操作权成功"后会立刻广播 operator-change，
          // 此时若该成员尚未设置名字，name 为 null，会被误判成"操作权已释放"，
          // 从而把刚拿到的 iAmOperator 重置为 false，导致后续 saveActive 的
          // broadcastOnSave 因 !iAmOperator 而静默丢弃 —— 正是"成员操作不同步到房主"的根因。
          // iAmOperator 只应由 action-granted(置true) 与 releaseAction/leaveRoom(置false) 管理。
          try { operatorListeners.forEach((fn) => fn(operator)); } catch (e) {}
          emitStatus(); break;
        case 'action-granted':
          iAmOperator = true;
          operatorListeners.forEach((fn) => { try { fn(Net.memberName(), true); } catch (e) {} });
          emitStatus(); break;
        case 'action-denied':
          iAmOperator = false;
          operatorListeners.forEach((fn) => { try { fn(m.by, false); } catch (e) {} });
          emitStatus(); break;
        case 'host-left':
          connected = false; members = 1; operator = null; iAmOperator = false;
          emitStatus(); break;
        default: break;
      }
    };
  }

  let myName = null;
  Net.setName = function (n) { myName = n || null; if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ type: 'set-name', name: myName })); } catch (e) {} } };
  Net.memberName = function () { return myName; };

  Net.init = function () {
    connect();
  };
  Net.isOnline = function () { return online; };
  Net.isInRoom = function () { return connected; };
  Net.isHost = function () { return host; };
  Net.memberCount = function () { return members; };
  Net.operatorName = function () { return operator; };
  Net.amOperator = function () { return iAmOperator; };
  Net.onState = function (fn) { stateListeners.push(fn); };
  Net.onOperator = function (fn) { operatorListeners.push(fn); };
  Net.onStatus = function (fn) { statusListeners.push(fn); };

  Net.requestAction = function (name, cb) {
    cb = cb || function () {};
    // 服务器不可用 / 单机：房主本地直接授予（保持单机体验），成员报错
    if (!online || !ws || !connected) {
      if (host) { iAmOperator = true; cb(null, true); return; }
      cb('服务器未连接'); return;
    }
    // 平权：房主与成员统一向服务器申请；已持有则幂等返回成功
    if (iAmOperator) { cb(null, true); return; }
    ws.send(JSON.stringify({ type: 'request-action', name: name || myName }));
    let handled = false;
    const onOp = (nm, granted) => {
      if (handled) return;
      handled = true;
      cb(null, granted);
    };
    Net.onOperator(onOp);
    setTimeout(() => { if (!handled) { handled = true; cb('操作权申请超时'); } }, 3000);
  };

  Net.releaseAction = function () {
    // 平权：房主持有操作权时同样要向服务器释放
    if (ws && ws.readyState === 1 && connected && iAmOperator) {
      try { ws.send(JSON.stringify({ type: 'release-action' })); } catch (e) {}
    }
    iAmOperator = false;
  };

  Net.leaveRoom = function () {
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: 'leave-room' })); } catch (e) {}
    }
    connected = false; members = 1; operator = null; iAmOperator = false;
    emitStatus();
  };

  // 场风盘推送请求：发给房主服务器（原生侧收到后经 EinkBoardManager 渲染推送到墨水屏）。
  // immediate=true 立即推送（立即推送按钮）；false 走 10s 节流（自动推送）。
  // data = 渲染所需精简状态（mode/over/endReason/roundWind/roundNum/honba/kyotaku/players）。
  Net.sendTagPush = function (data, immediate) {
    if (!online || !ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify({ type: 'push-tag', immediate: !!immediate, data: data }));
      return true;
    } catch (e) { return false; }
  };

  // 房主结束对局：把归档记录广播给所有成员，成员据此同步结束并跳转历史页
  // 记录以序列化字符串传输（与 host-state 的 state 一致，兼容 Java 字符串协议）
  Net.endGame = function (record) {
    if (!online || !connected || !ws || ws.readyState !== 1) return;
    if (!host) return;
    const recStr = record ? JSON.stringify(record) : null;
    try { ws.send(JSON.stringify({ type: 'game-end', record: recStr })); } catch (e) {}
  };
  // 成员端监听"房主结束对局"
  Net.onGameEnd = function (fn) { gameEndListeners.push(fn); };

  Net.install = function () {
    if (typeof Storage !== 'undefined' && Storage.hooks) {
      Storage.hooks.onSave = broadcastOnSave;
    }
  };

  if (typeof window !== 'undefined') window.Net = Net;
  if (typeof module !== 'undefined' && module.exports) module.exports = Net;
})();
