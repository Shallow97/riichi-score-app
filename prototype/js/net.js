/**
 * net.js — 联网同步层（无房间码 · 单房间 · 操作权互斥 · 全提交制）
 *
 * 设计（协议 v2，2026-10-03 批次 2）：
 *  - 无房间码：房主通过 URL ?host=1 识别身份，其他玩家输 IP 直接连入。
 *  - 全员平权（结算/立直）：房主与成员都要向服务器申请操作权，同一时刻只授予一人。
 *  - **全提交制**：任何端（含房主）的变更都先 `commit` 上行 → 服务器校验并落库
 *    → 回 `ack` 后本地才渲染/持久化；版本不符回 `conflict`，本地直接采用服务器态。
 *    这样"断线期间的本地操作"天然不会沉淀成服务器不知道的记录。
 *  - 单一权威态：服务器持有 `state` + 自增 `seq`。重连/加入时以 `welcome` 全量下发，
 *    提交带 `opId`（服务器幂等去重）与 `baseSeq`（拒绝旧版本倒灌）。
 *  - 双向心跳：本机每 10s 发 ping、服务器每 20s 发 ping；任一方 25s 无任何消息即判定
 *    死链并断开重连（手机息屏/换网造成的"半开连接"没有任何 FIN，只能靠心跳发现）。
 *  - 房主链路断开时服务器**保留房间**（成员可继续结算），只广播 host-offline。
 *
 * 对外接口（window.Net）：
 *  ﹒ init()                        启动时调用一次（自动识别房主/成员并连接）
 *  ﹒ isOnline() / isInRoom() / isHost() / hasJoined() / isLocked() / phase()
 *  ﹒ memberCount() / operatorName() / amOperator() / isHostOffline() / serverSeq()
 *    ⚠️ memberCount() 只有房主端有意义（成员端不感知全屋设备数，恒为 1＝仅本机）
 *  ﹒ requestAction(name, cb)       申请操作权（结算/立直）
 *  ﹒ releaseAction()               释放操作权
 *  ﹒ commit(stateStr) → Promise    全提交制：提交权威态，ack 后 resolve，否则 reject
 *  ﹒ endGame(record)               房主结束对局：广播归档记录给成员
 *  ﹒ leaveRoom()                   断开（停止自动重连）
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

  let RECONNECT_MIN_MS = 500;
  let RECONNECT_MAX_MS = 5000;
  // 心跳时序。用 let 是为了让测试可以缩短它们（Net.__setTimings）：
  // 40s / 5s 这种量级在单测里没法等。生产路径不允许改。
  let HEARTBEAT_SEND_MS = 10000;   // 本机周期：每 10s 发一个 ping
  let HEARTBEAT_WATCH_MS = 5000;   // 死链检查周期
  // 超过这么久没收到任何消息 → 判定死链。服务器每 20s 一定发一次 ping，取 2 倍余量：
  // 手机后台/息屏会把网页定时器降频，余量太小会造成"活着却被判死"的误重连。
  let HEARTBEAT_IDLE_MS = 40000;
  const COMMIT_TIMEOUT_MS = 6000;    // 提交回执超时 → 断开重连，拉权威态自证

  let ws = null;
  let online = false;
  let connected = false;   // 已建立身份（服务器 welcome）
  let host = IS_HOST;      // 房主身份由 URL 决定；掉线期间保持不变
  // 全屋设备数。⚠️ 只有房主端维护：成员端不需要也不显示这个数（B 项修复），
  // 服务器也只在 welcome / member-count 里发给房主。成员端恒为 1（＝仅本机）。
  let members = 1;
  let operator = null;
  // 平权模型：本机是否"正持有结算/立直操作权"。房主不天然持有，也要向服务器申请。
  let iAmOperator = false;
  // 曾成功建立过身份（房主或成员）。用于把"从未联网的单机"与"进过房但掉线"区分开。
  let hasJoined = false;
  // 连接阶段：idle（未连/单机）| connecting（首次连接中）| online（已在线）| reconnecting（掉线重连中）
  let phase = 'idle';
  // 服务器权威态版本号（自增）。提交时带 baseSeq，服务端不符即回 conflict。
  let seq = 0;
  // 房主（其网页连接）是否在线。房主端恒为 true；成员端由 host-offline/host-online 驱动。
  let hostOnline = true;
  // 本房间是否曾经有过房主：用于区分"房主离开了"与"房主还没进来"（后者不该提示）
  let hostSeen = false;
  // 最后一次"与服务器一致"的序列化状态：用于掉线回滚，避免本地留下服务器不知道的对局。
  let lastSynced = null;
  let reconnectTimer = null;
  let reconnectDelay = 0;
  let everOpened = false;  // 是否至少成功连上过一次：决定"掉线后是否自动重连"
  let stopped = false;     // 主动 leaveRoom → 不再自动重连
  let hbTimer = null;
  let hbWatchTimer = null;
  let lastRecvAt = 0;
  // 提交编号前缀（跨重连唯一）：sessionId 随机 + 自增序号
  const SESSION_ID = 'op' + Math.random().toString(36).slice(2, 8);
  let opCounter = 0;
  const pendingCommits = Object.create(null);  // opId -> { resolve, reject, state, timer, settled }

  const stateListeners = [];
  const operatorListeners = [];
  const statusListeners = [];
  const gameEndListeners = [];

  // 操作权申请的"在途请求"。**只有 action-granted / action-denied 能应答它**。
  // ⚠️ 绝不能用 operatorListeners 来应答：`operator-change` 只带一个"谁在操作"的名字，
  //    不带"是否授予"。服务器在**房主上线**、**他人释放操作权**等时刻都会广播
  //    operator-change；若它先于 action-granted 到达，就会被误当成对本次申请的答复
  //    （granted=undefined）→ 上层判定"别人正在操作"而**静默放弃本次结算**，
  //    表现为"我点了结算却提示别人在操作、结果没同步"。
  let actionReq = null;
  function settleActionReq(granted) {
    if (!actionReq || actionReq.done) return;
    const r = actionReq; actionReq = null; r.done = true;
    clearTimeout(r.timer);
    try { r.cb(null, granted); } catch (e) {}
  }
  function abortActionReq(err) {
    if (!actionReq || actionReq.done) return;
    const r = actionReq; actionReq = null; r.done = true;
    clearTimeout(r.timer);
    try { r.cb(err); } catch (e) {}
  }

  let myName = null;

  function emitStatus() {
    statusListeners.forEach((fn) => {
      try {
        fn({
          online, connected, host, members, operator, iAmOperator,
          phase, hasJoined, seq, hostOnline,
          // 联网锁定：进过房但当前没连上 → 所有会写状态的操作必须禁止
          locked: hasJoined && !connected,
        });
      } catch (e) {}
    });
  }

  function emitState(s) {
    stateListeners.forEach((fn) => { try { fn(s); } catch (e) {} });
  }

  function setPhase(p) {
    if (phase === p) return;
    phase = p;
    emitStatus();
  }

  function sendRaw(obj) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  /** 所有在途提交一律拒绝（掉线/离开）：调用方据此回滚并提示 */
  function failPendingCommits(reason) {
    Object.keys(pendingCommits).forEach((opId) => {
      const p = pendingCommits[opId];
      if (!p || p.settled) { delete pendingCommits[opId]; return; }
      p.settled = true;
      clearTimeout(p.timer);
      delete pendingCommits[opId];
      try { p.reject({ reason: reason }); } catch (e) {}
    });
  }

  function stopHeartbeat() {
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
    if (hbWatchTimer) { clearInterval(hbWatchTimer); hbWatchTimer = null; }
  }

  /**
   * 双向心跳。
   * 发：每 10s 一个 {type:'ping'}，服务器回 pong（也让服务器看到本机还活着）。
   * 收：超过 25s 没收到任何消息 → 判定死链（手机息屏/切网时 TCP 可能既不报错也不关闭，
   *     本地以为还连着、其实发出去的消息全进了黑洞 —— 正是"操作没同步"最隐蔽的一种）。
   *     此时主动 close 并触发重连，重连后由 welcome 全量拉平。
   */
  function startHeartbeat(sock) {
    stopHeartbeat();
    lastRecvAt = Date.now();
    hbTimer = setInterval(() => {
      if (ws !== sock || sock.readyState !== 1) return;
      try { sock.send(JSON.stringify({ type: 'ping', ts: Date.now() })); } catch (e) {}
    }, HEARTBEAT_SEND_MS);
    hbWatchTimer = setInterval(() => {
      if (ws !== sock || sock.readyState !== 1) { stopHeartbeat(); return; }
      // ⚠️ 页面被隐藏（锁屏 / 切后台 / 被系统覆盖）时，浏览器会挂起页面的任务投递：
      // 既收不到服务器 ping，也收不到 socket 的 close 事件。此时"久久没有消息"不是
      // 死链的证据，贸然判死只会造成"一锁屏就自我踢下线"。隐藏期间一律不判死，
      // 恢复可见时由 installVisibilityProbe() 主动探活（真死链仍会被揪出来）。
      if (typeof document !== 'undefined' && document.hidden) return;
      if (Date.now() - lastRecvAt <= HEARTBEAT_IDLE_MS) return;
      stopHeartbeat();
      try { sock.close(); } catch (e) {}
      handleClose(sock);
    }, HEARTBEAT_WATCH_MS);
  }

  /**
   * 页面重新可见时立即探活（只装一次）。
   *
   * 为什么需要：锁屏期间上面的看门狗被跳过，恢复可见时 lastRecvAt 可能已经"过期很久"，
   * 但链路其实一直是好的（房主就是这种情况，服务器会一直保着他的连接）。
   * 所以不能直接按 lastRecvAt 判死，而是主动发一个 ping —— 服务器对 ping 必回 pong ——
   * 并把判死期限压到"半个空闲窗口"之后：收到回音就没事，收不到才交给看门狗重连。
   * 这样"解锁瞬间"既能迅速救回真死链，又不会对好链路做无谓的重连。
   */
  function installVisibilityProbe() {
    if (typeof document === 'undefined' || !document.addEventListener) return;
    if (document.__riichiVisProbe) return;
    document.__riichiVisProbe = true;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      if (!ws || ws.readyState !== 1) { scheduleReconnect(); return; }
      try { ws.send(JSON.stringify({ type: 'ping', ts: Date.now() })); } catch (e) {}
      const grace = Date.now() - Math.floor(HEARTBEAT_IDLE_MS / 2);
      if (lastRecvAt < grace) lastRecvAt = grace;
    });
  }

  /**
   * 掉线自动重连：500ms 起步指数退避，5s 封顶，一直重试到成功或主动离开。
   * 只在"曾经连上过"之后启用：本页面本身就是那台服务器发出来的，页面能加载就说明
   * 服务器在；首次连接失败属于异常场景（电脑直接开 file:// / jsdom 测试），不重试。
   */
  function scheduleReconnect() {
    if (stopped || reconnectTimer || !everOpened) return;
    const next = reconnectDelay ? Math.min(reconnectDelay * 2, RECONNECT_MAX_MS) : RECONNECT_MIN_MS;
    reconnectDelay = next;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, next);
  }

  /** 连接断开后的统一状态复位（幂等：onclose 与心跳看门狗都会调） */
  function handleClose(sock) {
    if (ws !== sock || sock.__dropped) return;
    sock.__dropped = true;
    online = false; connected = false; members = 1;
    operator = null; iAmOperator = false;
    hostOnline = true; hostSeen = false;
    stopHeartbeat();
    failPendingCommits('offline');
    abortActionReq('连接已断开，正在重连');
    emitStatus();
    scheduleReconnect();
  }

  function connect() {
    if (typeof WebSocket === 'undefined' || stopped) return;
    setPhase(hasJoined ? 'reconnecting' : 'connecting');
    let sock;
    try { sock = new WebSocket(SERVER_WS); }
    catch (e) { online = false; emitStatus(); scheduleReconnect(); return; }
    ws = sock;

    sock.onopen = () => {
      if (ws !== sock) return;          // 已被更新的连接取代（旧 socket 的迟到事件）
      online = true;
      everOpened = true;
      reconnectDelay = 0;               // 连上即重置退避
      setPhase('online');
      startHeartbeat(sock);
      // 重连后补发名字，服务器据此恢复操作权显示
      if (myName) { try { sock.send(JSON.stringify({ type: 'set-name', name: myName })); } catch (e) {} }
      emitStatus();
    };
    sock.onclose = () => { handleClose(sock); };
    sock.onerror = () => {};
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      lastRecvAt = Date.now();
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      switch (m.type) {
        // 服务器对每个新连接的招呼：角色 + 权威态 + 版本号 + 当前操作者。
        // 房主与成员走同一条消息，房主重连也能拿到 state（旧版 room-created 不带 state，
        // 导致房主界面停在掉线前的旧数据，之后一操作就把成员的结算覆盖掉）。
        case 'welcome': {
          connected = true;
          host = m.role === 'host';
          hasJoined = true;
          // 设备数只有房主端关心/展示；成员端一律不感知（恒 1，UI 也不显示）
          members = (host && typeof m.members === 'number' && m.members > 0) ? m.members : 1;
          operator = m.operator || null;
          iAmOperator = false;
          if (typeof m.seq === 'number') seq = m.seq;
          hostOnline = host ? true : (m.hostOnline !== false);
          hostSeen = host ? true : !!m.hostSeen;
          if (m.state) {
            lastSynced = m.state;
            emitState(m.state);
          }
          setPhase('online');
          emitStatus();
          break;
        }
        // 其他端提交成功后的权威态广播（服务器不发给提交者本人）
        case 'state':
          if (typeof m.seq === 'number') seq = m.seq;
          if (m.state) { lastSynced = m.state; emitState(m.state); }
          break;
        case 'ack': {
          if (typeof m.seq === 'number') seq = m.seq;
          const p = pendingCommits[m.opId];
          if (p && !p.settled) {
            p.settled = true;
            clearTimeout(p.timer);
            delete pendingCommits[m.opId];
            lastSynced = p.state;      // 已获服务器确认 → 这份就是权威态
            try { p.resolve({ ok: true, seq: seq }); } catch (e) {}
          }
          emitStatus();
          break;
        }
        // 提交被拒：baseSeq 过期（别人先提交了）或本机已无操作权。
        // 无论哪种，服务器都带上最新权威态，本地直接采用（不保留这次本地改动）。
        case 'conflict': {
          if (typeof m.seq === 'number') seq = m.seq;
          if (m.state) { lastSynced = m.state; emitState(m.state); }
          const p = pendingCommits[m.opId];
          if (p && !p.settled) {
            p.settled = true;
            clearTimeout(p.timer);
            delete pendingCommits[m.opId];
            try { p.reject({ reason: m.reason || 'stale' }); } catch (e) {}
          }
          emitStatus();
          break;
        }
        case 'game-end':
          // 房主结束对局：通知成员端（携带归档记录）同步结束并跳转历史页
          {
            let rec = null;
            if (m.record) { try { rec = JSON.parse(m.record); } catch (e) { rec = null; } }
            try { gameEndListeners.forEach((fn) => fn(rec)); } catch (e) {}
          }
          break;
        // 设备数变更：服务器只发给房主（成员端不感知，即使误收也忽略）
        case 'member-count':
          if (!host) break;
          members = (m.count || 0) + 1; emitStatus(); break;
        case 'operator-change':
          operator = m.name || null;
          // 注意：不要在此根据 name===null 清除 iAmOperator。
          // 服务器在"成员申请操作权成功"后会立刻广播 operator-change，
          // 此时若该成员尚未设置名字，name 为 null，会被误判成"操作权已释放"，
          // 从而把刚拿到的 iAmOperator 重置为 false，导致后续提交被静默丢弃
          // —— 正是"成员操作不同步到房主"的根因。
          // iAmOperator 只应由 action-granted(置true) 与 releaseAction/leaveRoom(置false) 管理。
          try { operatorListeners.forEach((fn) => fn(operator)); } catch (e) {}
          emitStatus(); break;
        case 'action-granted':
          iAmOperator = true;
          settleActionReq(true);
          operatorListeners.forEach((fn) => { try { fn(Net.memberName(), true); } catch (e) {} });
          emitStatus(); break;
        case 'action-denied':
          iAmOperator = false;
          settleActionReq(false);
          operatorListeners.forEach((fn) => { try { fn(m.by, false); } catch (e) {} });
          emitStatus(); break;
        // 房主链路断开/恢复（服务器本体还活着）：成员端只需提示，不锁结算。
        case 'host-offline':
          hostOnline = false; hostSeen = true;
          emitStatus(); break;
        case 'host-online':
          hostOnline = true;
          emitStatus(); break;
        case 'ping': {
          // 收到就回：服务器靠它判定本机是不是还活着
          if (typeof m.ts === 'number') sendRaw({ type: 'pong', ts: m.ts });
          else sendRaw({ type: 'pong' });
          break;
        }
        case 'pong':
          break;   // lastRecvAt 已在上面更新，足够
        default: break;
      }
    };
  }

  Net.setName = function (n) { myName = n || null; if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ type: 'set-name', name: myName })); } catch (e) {} } };
  Net.memberName = function () { return myName; };

  Net.init = function () {
    stopped = false;
    installVisibilityProbe();
    connect();
  };
  /**
   * 仅供测试：缩短心跳时序，让"隐藏不判死 / 恢复可见即探活"这类行为可以秒级验证。
   * 生产代码不要调用。
   */
  Net.__setTimings = function (o) {
    o = o || {};
    if (o.sendMs) HEARTBEAT_SEND_MS = o.sendMs;
    if (o.watchMs) HEARTBEAT_WATCH_MS = o.watchMs;
    if (o.idleMs) HEARTBEAT_IDLE_MS = o.idleMs;
    if (o.reconnectMinMs) RECONNECT_MIN_MS = o.reconnectMinMs;
    if (o.reconnectMaxMs) RECONNECT_MAX_MS = o.reconnectMaxMs;
  };
  Net.isOnline = function () { return online; };
  Net.isInRoom = function () { return connected; };
  Net.isHost = function () { return host; };
  /** 全屋设备数（含本机）。⚠️ 成员端不感知设备数，恒返回 1 —— 上层只有房主端会展示 */
  Net.memberCount = function () { return host ? members : 1; };
  Net.operatorName = function () { return operator; };
  Net.amOperator = function () { return iAmOperator; };
  /** 是否曾经成功建立过身份（含当前掉线重连中）。false = 从未联网的单机 */
  Net.hasJoined = function () { return hasJoined; };
  /** 联网锁定：进过房但当前未连上 → 上层必须禁止一切写状态的操作 */
  Net.isLocked = function () { return hasJoined && !connected; };
  /** 连接阶段：idle | connecting | online | reconnecting */
  Net.phase = function () { return phase; };
  /** 最后一次与服务器一致的序列化状态（无则 null）；掉线回滚用 */
  Net.lastSyncedState = function () { return lastSynced; };
  /** 服务器权威态版本号 */
  Net.serverSeq = function () { return seq; };
  /** 房主（其网页链路）是否曾在线且当前离开。房主端恒为 false */
  Net.isHostOffline = function () { return hostSeen && !hostOnline; };
  Net.onState = function (fn) { stateListeners.push(fn); };
  Net.onOperator = function (fn) { operatorListeners.push(fn); };
  Net.onStatus = function (fn) { statusListeners.push(fn); };

  Net.requestAction = function (name, cb) {
    cb = cb || function () {};
    // 服务器不可用 / 单机：房主本地直接授予（保持单机体验），成员报错
    if (!online || !ws || !connected) {
      // 进过房但已掉线：一律不授予，等重连（旧版会在这里给房主本地授予，
      // 掉线成员则因判定失效而变成"房主"，从而继续本地计分不上行）
      if (hasJoined) { cb('连接已断开，正在重连'); return; }
      if (host) { iAmOperator = true; cb(null, true); return; }
      cb('服务器未连接'); return;
    }
    // 平权：房主与成员统一向服务器申请；已持有则幂等返回成功
    if (iAmOperator) { cb(null, true); return; }
    // 同一客户端同一时刻只保留一个在途申请：若上一个还没结果，先以"未授予"结束它，
    // 避免旧的 cb 永远挂着、也避免两个申请在服务器侧互相踩。
    if (actionReq && !actionReq.done) {
      const old = actionReq; actionReq = null; old.done = true;
      clearTimeout(old.timer);
      try { old.cb('操作权申请已被新的操作取代'); } catch (e) {}
    }
    ws.send(JSON.stringify({ type: 'request-action', name: name || myName }));
    const req = { done: false, cb: cb, timer: null };
    req.timer = setTimeout(() => {
      if (req.done) return;
      req.done = true;
      if (actionReq === req) actionReq = null;
      cb('操作权申请超时');
    }, 3000);
    actionReq = req;
  };

  Net.releaseAction = function () {
    // 平权：房主持有操作权时同样要向服务器释放
    if (ws && ws.readyState === 1 && connected && iAmOperator) {
      try { ws.send(JSON.stringify({ type: 'release-action' })); } catch (e) {}
    }
    iAmOperator = false;
  };

  /**
   * 全提交制：把权威态提交给服务器，等 ack 后才算生效。
   * 返回 Promise：
   *   resolve({ ok:true, seq })          —— 服务器已接受（本地可落库）
   *   reject({ reason:'offline' })       —— 未连接/掉线（本地必须回滚）
   *   reject({ reason:'denied' })        —— 本机已不持有操作权
   *   reject({ reason:'stale' })         —— baseSeq 过期，服务器已下发最新态（本地已采用）
   *   reject({ reason:'timeout' })       —— 回执超时（已主动断开重连，重连后拉权威态自证）
   */
  Net.commit = function (stateStr) {
    return new Promise((resolve, reject) => {
      if (!online || !connected || !ws || ws.readyState !== 1) {
        reject({ reason: 'offline' });
        return;
      }
      if (!host && !iAmOperator) {
        reject({ reason: 'denied' });
        return;
      }
      const opId = SESSION_ID + '-' + (++opCounter);
      const timer = setTimeout(() => {
        const p = pendingCommits[opId];
        if (!p || p.settled) return;
        p.settled = true;
        delete pendingCommits[opId];
        try { p.reject({ reason: 'timeout' }); } catch (e) {}
        // 结果未知：断开重连，用 welcome 的全量权威态自证这笔到底生效没有
        try { if (ws) ws.close(); } catch (e) {}
      }, COMMIT_TIMEOUT_MS);
      pendingCommits[opId] = { resolve, reject, state: stateStr, timer, settled: false };
      try {
        ws.send(JSON.stringify({ type: 'commit', opId: opId, baseSeq: seq, state: stateStr }));
      } catch (e) {
        clearTimeout(timer);
        delete pendingCommits[opId];
        reject({ reason: 'offline' });
      }
    });
  };

  Net.leaveRoom = function () {
    // 主动离开（返回本机 / 加入他人房间前）→ 停止自动重连，避免"走后还在偷偷重连"
    stopped = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    reconnectDelay = 0;
    stopHeartbeat();
    failPendingCommits('offline');
    abortActionReq('已离开房间');
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: 'leave-room' })); } catch (e) {}
    }
    connected = false; members = 1; operator = null; iAmOperator = false;
    hostOnline = true; hostSeen = false; seq = 0;
    hasJoined = false; phase = 'idle'; online = false;   // 主动离开：不再参与，也不显示锁定横幅
    emitStatus();
  };

  // 场风盘推送请求：发给房主服务器（原生侧收到后经 EinkBoardManager 渲染推送到墨水屏）。
  // immediate=true 立即推送（立即推送按钮）；false 走 1s 节流（自动推送）。
  // data = 渲染所需精简状态（mode/over/endReason/roundWind/roundNum/honba/kyotaku/players）。
  Net.sendTagPush = function (data, immediate) {
    if (!online || !ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify({ type: 'push-tag', immediate: !!immediate, data: data }));
      return true;
    } catch (e) { return false; }
  };

  // 房主结束对局：把归档记录广播给所有成员，成员据此同步结束并跳转历史页
  // 记录以序列化字符串传输（与 commit 的 state 一致，兼容 Java 字符串协议）
  Net.endGame = function (record) {
    if (!online || !connected || !ws || ws.readyState !== 1) return false;
    if (!host) return false;
    const recStr = record ? JSON.stringify(record) : null;
    try { ws.send(JSON.stringify({ type: 'game-end', record: recStr })); return true; } catch (e) { return false; }
  };
  // 成员端监听"房主结束对局"
  Net.onGameEnd = function (fn) { gameEndListeners.push(fn); };

  /**
   * 兼容保留：批次 1 之前用 Storage.hooks.onSave 做"保存即广播"，
   * 批次 2 起状态提交统一走 Net.commit（全提交制），本地保存不再外发。
   * 这里只把钩子清空，避免遗留路径绕过服务器确认。
   */
  Net.install = function () {
    if (typeof Storage !== 'undefined' && Storage.hooks) {
      Storage.hooks.onSave = null;
    }
  };

  if (typeof window !== 'undefined') window.Net = Net;
  if (typeof module !== 'undefined' && module.exports) module.exports = Net;
})();
