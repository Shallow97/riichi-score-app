/**
 * app.js — 日麻计分 APP 原型主逻辑（页面切换 + 对局交互 + 绑定规则引擎）
 */

(function () {
  const $ = (sel, root = document) => root.querySelector(sel);

  /**
   * 本场费（区分荣和/自摸，自摸损只作用于自摸）：
   * - 荣和：无"自摸损"概念，放铳者一人承担本场费 → 无论几人局恒付 300×N。
   * - 自摸：每多 1 本场，在场的每家承担 100 点本场费；总额 = 100N×(在场其他家数)。
   *   四人(其他3家)=300N（各家各100N）；三人缺北(仅其他2家,即"自摸损")=200N（两家各100N）。
   */
  /** 荣和本场费：放铳者一人支付 300×N（与人数无关） */
  function honbaRonTotal(honba) {
    return 300 * honba;
  }
  /** 自摸：每本场每家承担的本场费基数（100×N） */
  function honbaPerPlayer(honba) {
    return 100 * honba;
  }

  // 当前对局状态（内存中的活跃副本）
  let game = null;
  // 当前登录的用户名（本机资料）
  let profile = null;
  // 视角锁定：本机把哪名玩家固定显示在桌面下方（仅本设备生效，null=未锁定）
  // 锁定仅影响"座位卡片渲染到哪个屏幕槽位"，不改动任何对局数据，半庄内持续有效。
  let viewLock = null;
  // 视角弹窗中当前选中的玩家名（临时选中态，未锁定时用于高亮）
  let viewSel = null;

  // 物理方位 → 默认屏幕槽位类（未锁定时：东=左/南=下/西=右/北=上）
  const SEAT_MAP = {
    '东': 'seat-east', '南': 'seat-south', '西': 'seat-west', '北': 'seat-north'
  };
  // 四个屏幕槽位（首尾相接构成环），用于"整桌旋转"的同向位移。
  // 顺序即屏幕上绕桌一周（左→上→右→下），保证位移后四人的相对邻座/对家关系不变。
  const SLOT_RING = ['seat-east', 'seat-north', 'seat-west', 'seat-south'];
  // 本机希望"自己"所在的槽位 = 下方
  const SLOT_SELF = 'seat-south';

  /**
   * 计算某玩家渲染到哪个屏幕槽位。
   * - 未锁定：按其物理方位对应默认槽位（seatMap[p.seat]）。
   * - 已锁定 viewLock：让被锁玩家的默认槽位转到 SLOT_SELF(下方)，
   *   其余玩家沿 SLOT_RING 同向位移相同步数 → 整桌旋转，邻座关系保持不变。
   * 仅影响渲染，不改动对局数据（分数/风牌/庄家等）。
   */
  function seatClassFor(p) {
    const base = SEAT_MAP[p.seat] || SEAT_MAP[p.wind] || 'seat-south';
    if (!viewLock || !game) return base;
    const locked = game.players.find((q) => q.name === viewLock);
    if (!locked) return base;
    const lockedBase = SEAT_MAP[locked.seat] || SEAT_MAP[locked.wind];
    if (!lockedBase || lockedBase === SLOT_SELF) {
      // 已在下或定位异常：仍整桌不动，避免重复移位
      return base;
    }
    const li = SLOT_RING.indexOf(lockedBase);
    const si = SLOT_RING.indexOf(SLOT_SELF);
    const k = (si - li + SLOT_RING.length) % SLOT_RING.length; // 使锁定者到下方所需位移
    const bi = SLOT_RING.indexOf(base);
    if (bi < 0) return base;
    return SLOT_RING[(bi + k) % SLOT_RING.length];
  }

  // ============ 页面导航 ============
  function showPage(id) {
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
    const page = $('#' + id);
    if (page) page.classList.add('active');
    // 回到模式选择页时，同步"继续进行中的对局"按钮的显隐
    if (id === 'page-mode') { updateContinueBtn(); refreshEinkConnected(); }
  }

  // 首页"继续当前对局"按钮：仅当存在进行中对局（已持久化）时显示
  function updateContinueBtn() {
    const btn = $('#btn-continue-game');
    if (!btn) return;
    btn.style.display = game ? '' : 'none';
  }

  // ============ Toast ============
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ============ 初始化 ============
  function init() {
    profile = Storage.getProfile();

    // 联网层初始化（服务器不可用时自动降级为单机）
    if (window.Net) {
      Net.init();
      Net.install();
      // 本机名补报（修复 C）：刷新页面 / 重开 App 后也带着名字重连。
      // 旧版只在"建立对局"时上报一次，房主重启后服务器上 conn.name 变 null，
      // 别人被拒时的提示就退化成"暂时无法操作"（而不是"XXX 正在操作"）。
      // 此刻 socket 可能还没 open —— net.js 会把名字存下来、在每个连接 onopen 时重发。
      if (profile && profile.name) Net.setName(profile.name);
      // 收到服务器权威态（加入/重连的 welcome、或别人提交后的广播）：
      // 全提交制下这份就是唯一账本，直接采用并落库（刷新/重启不丢）。
      Net.onState((serializedState) => {
        try {
          game = Rules.deserialize(serializedState);
          Storage.saveActive(game);
          // 成员收到权威状态后切到对局主界面
          if (!$('#page-main').classList.contains('active')) showPage('page-main');
          renderMain();
        } catch (e) { toast('同步数据异常'); }
      });
      // 联网状态变化时刷新 UI；掉线锁定 / 重连恢复在这里统一处理（横幅、回滚、提示）
      Net.onStatus(() => { updateNetStatusUI(); onNetStatusChanged(); renderMain(); });
      // 操作权变化（谁在操作）：刷新按钮状态
      Net.onOperator(() => { renderMain(); });
      // 房主结束对局：成员同步结束本次对局并跳转到历史界面
      Net.onGameEnd((record) => {
        // 把房主归档的记录插入本机历史（按 id 去重），若无记录则只结束本地对局
        if (record) Storage.receiveFinished(record);
        game = null;
        Storage.clearActive();
        showPage('page-history');
        renderHistory();
        toast('对局已由房主结束');
      });
    }

    // 若有未完成对局，进入主界面
    const saved = Storage.loadActive();
    if (saved) {
      game = saved;
      showPage('page-main');
      renderMain();
    } else {
      showPage('page-mode');
    }
    bindGlobalEvents();
    bindNetUI();
    updateNetStatusUI();
    refreshEinkConnected();   // 冷启动若场风盘已连接，首页按钮也应可点

    // Android 返回键二次确认用：房主端"对局进行中"标记（见 MainActivity.onBackPressed）
    window.__netHostBusy = function () { return !!(game && !game.over && isHost()); };
  }

  // ============ 全局事件 ============
  function bindGlobalEvents() {
    // 模态关闭
    document.querySelectorAll('.modal-overlay').forEach((ov) => {
      ov.addEventListener('click', (e) => {
        if (e.target !== ov) return;
        // 扫码弹窗的特殊情况：摄像头还没起来时忽略"点空白关闭"。
        // 首次使用会弹系统相机授权框，用户在授权框上那一下有可能穿透到页面，
        // 直接把刚打开的扫码窗关掉（看起来像"点了允许却没反应"）。
        if (ov.id === 'modal-scanqr' && !scanStream) return;
        closeModal(ov.id);
      });
    });
    // 关闭按钮
    document.querySelectorAll('.close-x').forEach((x) => {
      x.addEventListener('click', () => closeModal(x.closest('.modal-overlay').id));
    });
  }

  // ============ 联网 UI ============

  /** 本机局域网 IPv4：优先 ?lanip=（Android 房主端注入），其次 serve.js 的 __LAN_IP__，最后 null */
  function currentLanIp() {
    try {
      const m = location.search.match(/[?&]lanip=([^&]+)/);
      if (m) return decodeURIComponent(m[1]);
      if (typeof window !== 'undefined' && window.__LAN_IP__) return window.__LAN_IP__;
      return null;
    } catch (e) { return null; }
  }

  /** 房主服务器默认端口（与 RiichiServer / MainActivity 一致） */
  const DEFAULT_SERVER_PORT = '8765';
  /** 加入房间的跳转出口（测试可替换，避免 jsdom 报 navigation 未实现） */
  let navHandler = (url) => { window.location.href = url; };
  function navigateTo(url) { navHandler(url); }
  let joinPending = false;

  /**
   * 规范化用户输入的房主地址 → { ok, host, port, url } 或 { ok:false, error }
   * 接受：192.168.0.101 / 192.168.0.101:8765 / http://192.168.0.101:8765/ / 192.168.0.101/join
   * 容错：自动补默认端口、忽略协议头与路径、忽略首尾空格
   */
  function normalizeJoinTarget(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return { ok: false, error: '请输入房主的 IP 地址' };
    let t = s.replace(/\s+/g, '').replace(/^https?:\/\//i, '');
    t = t.split('/')[0].split('?')[0];
    const m = t.match(/^([^:]+)(?::(\d{1,5}))?$/);
    if (!m) return { ok: false, error: 'IP 地址格式不正确，正确示例：192.168.0.101' };
    const host = m[1];
    const port = m[2] || DEFAULT_SERVER_PORT;
    if (!/^\d{1,5}$/.test(port) || +port < 1 || +port > 65535) {
      return { ok: false, error: '端口不正确（应为 1~65535）' };
    }
    // 合法主机：IPv4（四段 0~255）或含点的域名/主机名
    const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
      && host.split('.').every((n) => +n >= 0 && +n <= 255);
    // 纯数字点分串必须是合法 IPv4（否则 999.1.1.1 会被下面的主机名规则误放行）
    if (/^[\d.]+$/.test(host) && !isIpv4) {
      return { ok: false, error: 'IP 地址格式不正确，正确示例：192.168.0.101' };
    }
    const isHostname = host.includes('.') && /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host);
    if (!isIpv4 && !isHostname) {
      return { ok: false, error: 'IP 地址格式不正确，正确示例：192.168.0.101' };
    }
    return { ok: true, host, port: String(port), url: 'http://' + host + ':' + port + '/' };
  }

  /** 输入地址是否指向本机（本机 Wi-Fi IP / 回环地址）：是则无需加入 */
  function isSelfHostName(host) {
    const h = String(host || '').toLowerCase();
    if (h === '127.0.0.1' || h === 'localhost' || h === '0.0.0.0') return true;
    const self = currentLanIp();
    return !!self && h === String(self).toLowerCase();
  }

  /**
   * 探测房主服务器是否可达。
   * no-cors 拿不到响应内容，但足以区分"连得上/连不上"（不可达会 reject，超时也按失败处理）。
   */
  function probeRemoteServer(url, timeoutMs) {
    return new Promise((resolve) => {
      if (typeof fetch !== 'function') { resolve(true); return; } // 老 WebView 无 fetch：直接尝试跳转
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; resolve(false); } }, timeoutMs || 3000);
      fetch(url, { mode: 'no-cors', cache: 'no-store' })
        .then(() => { if (!settled) { settled = true; clearTimeout(timer); resolve(true); } })
        .catch(() => { if (!settled) { settled = true; clearTimeout(timer); resolve(false); } });
    });
  }

  function setJoinTip(text, kind) {
    const el = $('#join-tip');
    if (!el) return;
    el.textContent = text;
    el.className = 'net-joinroom-tip' + (kind ? ' ' + kind : '');
  }

  /** 加入他人房间会"离开"什么：需要二次确认时返回文案，否则 null */
  function leaveRoomWarning() {
    const parts = [];
    if (game) parts.push('本机有进行中的对局，加入后将离开本桌（数据仍保留在本机）');
    if (window.Net && Net.isInRoom() && Net.isHost() && Net.memberCount() > 1) {
      parts.push('你正作为房主接待 ' + (Net.memberCount() - 1) + ' 名玩家，加入后本桌会解散');
    }
    return parts.length ? '确定继续加入吗？' + parts.join('；') + '。' : null;
  }

  /** 真正进入房主房间：先断开本机房间连接，再跳到房主页面（成员身份由对方服务器建立） */
  function enterRemoteRoom(target) {
    setJoinTip('已连接，正在进入 ' + target.host + ' 的对局…', 'ok');
    if (window.Net && Net.leaveRoom) Net.leaveRoom();
    navigateTo(target.url);
  }

  /**
   * 加入他人对局主流程：校验 → 本机地址拦截 → 可达性探测 → （必要时确认）→ 跳转
   * 同步返回 { ok, target? , error? }，探测为异步。
   */
  function joinRemoteRoom(raw) {
    const target = normalizeJoinTarget(raw);
    if (!target.ok) { setJoinTip(target.error, 'warn'); toast(target.error); return { ok: false, error: target.error }; }
    if (isSelfHostName(target.host)) {
      const msg = '这就是本机地址，你已经是房主，无需加入';
      setJoinTip(msg, 'warn');
      toast(msg);
      return { ok: false, error: msg };
    }
    if (joinPending) return { ok: false, error: '正在连接中，请稍候' };
    joinPending = true;
    setJoinTip('正在连接 ' + target.host + ':' + target.port + ' …');
    probeRemoteServer(target.url, 3000).then((reachable) => {
      joinPending = false;
      if (!reachable) {
        const msg = '连接不上 ' + target.host + ':' + target.port +
          '，请确认房主已开启对局、且两台设备在同一 Wi-Fi';
        setJoinTip(msg, 'warn');
        toast(msg);
        return;
      }
      const warn = leaveRoomWarning();
      if (warn) confirmDialog('加入他人对局', warn, () => enterRemoteRoom(target));
      else enterRemoteRoom(target);
    });
    return { ok: true, target };
  }

  // ============ 扫码加入（摄像头取流 + jsQR 逐帧解码 → 复用 joinRemoteRoom） ============
  // 房主端用 qrcode.js 生成的二维码内容就是成员访问地址 http://<IP>:<端口>/，
  // 因此扫码只需把解出的文本交给 joinRemoteRoom，后续校验/探测/跳转与手动输入完全一致。
  const SCAN_INTERVAL_MS = 150;   // 解码目标节拍：太密耗电、太疏半天扫不上
  const SCAN_MAX_EDGE = 1280;     // 解码帧长边上限：jsQR 开销与像素数成正比，超大帧先等比缩小
  const SCAN_IDEAL_W = 1280;      // 期望取流分辨率：部分机型默认只给 640x480，远距离就扫不动
  const SCAN_IDEAL_H = 720;
  let scanStream = null;          // 当前摄像头的 MediaStream
  let scanTimer = null;           // 解码轮询定时器
  let scanCanvas = null;          // 离屏取帧画布
  let scanCtx = null;
  let scanHit = false;            // 本次已命中（防重复跳转）

  /** 扫码文本 → 加入目标。二维码里可能是完整链接、host:port，甚至是带引号/空格的写法 */
  function parseScanPayload(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return { ok: false, error: '二维码内容为空，无法识别' };
    const target = normalizeJoinTarget(s);
    if (target.ok) return target;
    const brief = s.length > 32 ? s.slice(0, 32) + '…' : s;
    return { ok: false, error: '这不是对局二维码（内容：' + brief + '），请扫房主手机上的「扫一扫加入本桌」' };
  }

  function setScanStatus(text, kind) {
    const el = $('#scan-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'scan-status' + (kind ? ' ' + kind : '');
  }

  /** 摄像头 / 权限异常 → 中文可读提示 */
  function cameraErrorMessage(err) {
    const name = (err && err.name) || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return '摄像头权限被拒绝，请在系统设置里允许本应用使用相机后重试';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return '没有找到可用的摄像头';
    if (name === 'NotReadableError' || name === 'AbortError') return '摄像头被其他应用占用，请关闭后重试';
    return '无法打开摄像头：' + ((err && err.message) || name || '未知错误');
  }

  /** 停止取流并释放摄像头（关闭弹窗、命中、页面切到后台时都要调） */
  function stopQrScan() {
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    if (scanStream) {
      try { scanStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      scanStream = null;
    }
    const v = $('#qr-video');
    if (v) {
      try { v.pause(); } catch (e) {}
      try { v.srcObject = null; } catch (e) {}
      if (v.removeAttribute) v.removeAttribute('src');
    }
    scanHit = false;
  }

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  /**
   * 解码节拍：做完一帧再排下一帧（而不是固定 setInterval）。
   * 这样在解码较慢的机型/较高分辨率下只是扫描变慢，不会让任务越堆越多、把预览卡住。
   */
  function scanLoop() {
    scanTimer = null;
    if (!scanStream || scanHit) return;
    const t0 = nowMs();
    scanTick();
    if (!scanStream) return;                      // 这一帧命中并已释放摄像头
    const cost = nowMs() - t0;
    const wait = Math.max(0, SCAN_INTERVAL_MS - cost);
    scanTimer = setTimeout(scanLoop, wait);
  }

  /** 取一帧交给 jsQR 解码；命中则走 onScanHit */
  function scanTick() {
    if (scanHit) return;
    const v = $('#qr-video');
    if (!v || !v.videoWidth || !v.videoHeight) return;      // 摄像头还没出流
    if (typeof window.jsQR !== 'function') return;          // 解码库缺失（不应发生）
    if (!scanCanvas) {
      scanCanvas = document.createElement('canvas');
      scanCtx = scanCanvas.getContext ? scanCanvas.getContext('2d') : null;
    }
    if (!scanCtx) return;
    // 等比缩放到长边 <= SCAN_MAX_EDGE 再解码：缩小后仍远高于二维码所需像素，
    // 但能避免 1080p 逐帧解码把主线程占满（预览卡顿、扫码变慢）
    const vw = v.videoWidth, vh = v.videoHeight;
    const scale = Math.min(1, SCAN_MAX_EDGE / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    scanCanvas.width = w;
    scanCanvas.height = h;
    let img = null;
    try {
      scanCtx.drawImage(v, 0, 0, w, h);   // 按目标尺寸绘制即为缩放
      img = scanCtx.getImageData(0, 0, w, h);
    } catch (e) { return; }
    if (!img) return;
    let res = null;
    try { res = window.jsQR(img.data, w, h, { inversionAttempts: 'attemptBoth' }); } catch (e) { return; }
    if (res && res.data) onScanHit(res.data);
  }

  function onScanHit(text) {
    scanHit = true;                                  // 先占位，防止连拍同一码触发多次
    const target = parseScanPayload(text);
    if (!target.ok) {
      setScanStatus(target.error, 'warn');           // 扫到别的码：提示但不关摄像头，可继续扫
      scanHit = false;
      return;
    }
    stopQrScan();
    closeModal('modal-scanqr');
    try { if (navigator.vibrate) navigator.vibrate(40); } catch (e) {}
    // 复用既有加入流程：本机地址拦截 → 可达性探测 → （必要时确认）→ 跳转
    joinRemoteRoom(target.url);
  }

  /** 打开扫码弹窗并启动摄像头；出错时关弹窗并回到「加入他人对局」的提示区 */
  function startQrScan() {
    const fail = (msg) => {
      stopQrScan();
      closeModal('modal-scanqr');
      setJoinTip(msg, 'warn');
      toast(msg);
      return { ok: false, error: msg };
    };
    if (typeof window.jsQR !== 'function') return fail('扫码组件未加载，请重启应用后重试');
    const md = (typeof navigator !== 'undefined' && navigator.mediaDevices) || null;
    if (!md || typeof md.getUserMedia !== 'function') {
      // 非安全上下文（如已跳到房主页面 http://192.168.x.x:8765）时 mediaDevices 不存在
      return fail(window.isSecureContext === false
        ? '当前页面不是本机地址，无法调用摄像头；请按返回键回到本机界面后再扫码'
        : '当前环境不支持摄像头取流，请手动输入房主 IP 加入');
    }
    openModal('modal-scanqr');
    setScanStatus('正在启动摄像头…');
    md.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        // 只给 ideal：机型不支持时自动退到最接近的分辨率，不会因约束过严直接失败
        width: { ideal: SCAN_IDEAL_W },
        height: { ideal: SCAN_IDEAL_H },
      },
      audio: false,
    })
      .then((stream) => {
        const v = $('#qr-video');
        if (!v) { stopQrScan(); return; }
        scanStream = stream;
        try {
          v.srcObject = stream;
        } catch (e) {
          try { v.src = (window.URL || window.webkitURL).createObjectURL(stream); }
          catch (e2) { fail('无法显示摄像头画面'); return; }
        }
        try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
        scanHit = false;
        setScanStatus('将房主手机上的二维码放入框内');
        if (scanTimer) clearTimeout(scanTimer);
        scanTimer = setTimeout(scanLoop, SCAN_INTERVAL_MS);
      })
      .catch((err) => { fail(cameraErrorMessage(err)); });
    return { ok: true };
  }

  /**
   * 记录"本机用户名"——仅用于联网时"谁在操作"的提示文案，不参与任何计分。
   *
   * 只有**用户的显式动作**会走到这里（修复 A）：
   *   ① 「设置名字」按钮
   *   ② 视角锁定（"选哪一个用户名对应你自己"＝声明我就是这家）
   * 建局、重连、自动流程一律不写它，避免把牌桌上别人的名字当成本机名。
   *
   * 落盘（修复 C）：名字一旦存在就持久化；配合 init() 的补报 + net.js 每次
   * onopen 重发，刷新页面 / 重开 App / 掉线重连后服务器都拿得到本机名，
   * 不会退化成"无名操作者"。
   */
  function applyLocalName(name) {
    const n = String(name || '').trim();
    if (!n) return;
    if (window.Net && Net.setName) Net.setName(n);
    profile = Object.assign({}, profile || {}, { name: n });
    Storage.saveProfile(profile);
  }

  function bindNetUI() {
    if (!window.Net) return;
    // 加入他人对局：输入房主 IP → 加入（点按钮或回车）
    const joinInput = $('#join-ip');
    const joinBtn = $('#btn-join-room');
    const doJoin = () => { joinRemoteRoom(joinInput && joinInput.value); };
    if (joinBtn) joinBtn.addEventListener('click', doJoin);
    if (joinInput) joinInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doJoin(); }
    });
    // 扫码加入：打开摄像头扫房主手机上的二维码（等价于自动填 IP 并加入）
    const scanBtn = $('#btn-scan-qr');
    if (scanBtn) scanBtn.addEventListener('click', () => { startQrScan(); });
    const scanCloseBtn = $('#btn-scan-close');
    if (scanCloseBtn) scanCloseBtn.addEventListener('click', () => closeModal('modal-scanqr'));
    // 无房间码模型：房主(host=1)自动成为本机房间的房主；
    // 成员通过在首页"加入他人对局"输入房主 IP 跳转到对方页面（见 joinRemoteRoom）。
    // 名字输入框：加入后设置名字（用于操作权显示）
    const nameInput = $('#net-name');
    const setNameBtn = $('#btn-set-name');
    // 回填已保存的本机名，避免每次都要重输
    if (nameInput && !nameInput.value && profile && profile.name) nameInput.value = profile.name;
    if (setNameBtn) setNameBtn.addEventListener('click', () => {
      const n = (nameInput && nameInput.value || '').trim() || '玩家';
      applyLocalName(n);
      toast('名字已设为 ' + n);
    });
    if (nameInput) nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && setNameBtn) setNameBtn.click();
    });
  }

  // ============ 首页「推送二维码到场风盘」（2026-10-05） ============
  // 首页卡片里那个「加入本桌」二维码 → 推到场风盘墨水屏，其他设备扫墨水屏即可加入。
  // 可用性：① 有二维码（房主且已进房，随 #net-room-qr 一起显隐）；
  //         ② 场风盘蓝牙已连接（未连接则置灰，不可点）。
  let currentJoinUrl = null;   // 当前卡片的加入链接（= 二维码内容）
  let einkConnected = false;   // 场风盘蓝牙连接态（由 EinkNative.onStatus 事件维护）

  /** 同步「推送二维码」按钮的可用性：未连接场风盘则置灰 */
  function syncPushQrBtn() {
    const btn = $('#btn-push-qr');
    if (!btn) return;
    btn.disabled = !einkConnected;
  }

  /** 点击「推送二维码到场风盘」：生成二维码位图 → 交原生 BLE 推屏 */
  function onPushQrClick() {
    if (!einkConnected) { toast('场风盘未连接'); return; }
    if (!currentJoinUrl) { toast('当前没有可推送的二维码'); return; }
    const b = window.NativeBridge;
    if (!b || !b.einkPushQr) { toast('当前环境不支持推送场风盘'); return; }
    const b64 = buildQrPngBase64(currentJoinUrl);
    if (!b64) { toast('二维码生成失败'); return; }
    try { b.einkPushQr(b64); } catch (e) { toast('推送失败：' + ((e && e.message) || e)); return; }
    toast('正在推送二维码到场风盘…');
  }

  /** 向后端问一次当前是否已连场风盘（进首页/初始化时用；浏览器环境无此接口 → 视为未连接） */
  function refreshEinkConnected() {
    const b = window.NativeBridge;
    if (b && b.einkIsConnected) {
      try { einkConnected = !!b.einkIsConnected(); } catch (e) { einkConnected = false; }
    } else {
      einkConnected = false;
    }
    syncPushQrBtn();
  }

  /**
   * 生成二维码 → 400×300 白底 PNG（base64，不含 data: 前缀），供原生直接推屏。
   * 直接按模块整数倍绘制（不做二次缩放），保证墨水屏上边缘锐利、好扫。
   * 内容为空 / 依赖缺失时返回 null。
   */
  function buildQrPngBase64(text) {
    if (!text || typeof window.qrcode !== 'function') return null;
    try {
      const qr = window.qrcode(0, 'M');   // 自动扩容、纠错级 M
      qr.addData(text);
      qr.make();
      const modules = qr.getModuleCount();
      const W = 400, H = 300, margin = 4; // 静默区 4 模块（QR 规范下限）
      const total = modules + margin * 2;
      let scale = Math.floor(Math.min(W, H) / total);
      if (scale < 1) scale = 1;
      const size = total * scale;
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#000000';
      const ox = Math.floor((W - size) / 2) + margin * scale;
      const oy = Math.floor((H - size) / 2) + margin * scale;
      for (let r = 0; r < modules; r++) {
        for (let c = 0; c < modules; c++) {
          if (qr.isDark(r, c)) ctx.fillRect(ox + c * scale, oy + r * scale, scale, scale);
        }
      }
      return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
    } catch (e) {
      return null;
    }
  }

  // 更新模式选择页的联网状态展示（无房间码）
  function updateNetStatusUI() {
    if (!window.Net) return;
    const statusEl = $('#net-status');
    const roomEl = $('#net-room');
    const actionsEl = $('#net-actions');
    const codeVal = $('#net-room-code-val');
    const meta = $('#net-room-meta');
    const qrBlock = $('#net-room-qr');
    const qrCanvas = $('#qr-canvas');

    if (!statusEl) return;
    // "加入他人对局"提示：成员身份时告知如何回到本机；其余状态回到默认说明
    // （带 warn 的是刚发生的错误提示，不覆盖）
    const joinTipEl = $('#join-tip');
    if (joinTipEl && !joinTipEl.classList.contains('warn')) {
      if (Net.isInRoom() && !Net.isHost()) {
        joinTipEl.className = 'net-joinroom-tip';
        joinTipEl.textContent = '已加入房主的对局 · 按手机返回键可回到本机界面';
      } else {
        joinTipEl.className = 'net-joinroom-tip';
        joinTipEl.textContent = '在房主手机上查看 IP 后输入即可加入（需在同一 Wi-Fi/局域网），或点「扫码」扫房主的二维码';
      }
    }
    if (!Net.isOnline()) {
      statusEl.textContent = '未连接服务器（单机模式，可正常使用）';
      statusEl.className = 'net-status off';
      roomEl.style.display = 'none';
      actionsEl.style.display = 'none';
      if (qrBlock) qrBlock.style.display = 'none';
      currentJoinUrl = null;   // 无二维码 → 「推送二维码」按钮随卡片一起隐藏
      return;
    }
    if (Net.isInRoom()) {
      if (Net.isHost()) {
        statusEl.textContent = '你是房主（服务器） · 其他玩家输入本机 IP 即可加入';
        roomEl.style.display = 'block';
        // 本机局域网 IP 的优先级：
        //  1. ?lanip= 查询参数（Android 房主端由 MainActivity 注入本机 Wi-Fi IP）
        //  2. window.__LAN_IP__（电脑版 serve.js 注入，网页端无法自行获知本机 IP）
        //  3. location.hostname（本机访问时为 127.0.0.1 / localhost，其他设备不可用）
        const hostIp = (currentLanIp() || location.hostname).replace(/^https?:\/\//, '');
        // 房主端口：跟随当前页面端口（Android / PC 均 8765），兜底 8765
        const port = (location.port) || '8765';
        codeVal.textContent = hostIp + ':' + port;
        // 其他玩家扫码访问的完整链接（以成员身份加入，不带 host=1）
        const fullUrl = 'http://' + hostIp + ':' + port + '/';
        $('#qr-url').textContent = fullUrl;
        renderQR(qrBlock, qrCanvas, fullUrl);
        currentJoinUrl = fullUrl;   // 「推送二维码」按钮的推送内容
        // ⚠️ 与对局内 `.actions .hint` 保持同一口径：这里数的是"加入的其他设备"，
        //    不含房主自己（memberCount() 含自己，故 -1）。旧版此处直接写 memberCount()，
        //    于是"已连接 1 台设备"在没人加入时就出现，与房间提示行的"已连接 0 台设备"自相矛盾。
        meta.textContent = '已连接 ' + Math.max(0, Net.memberCount() - 1) + ' 台设备 · 全员可结算/立直';
      } else {
        statusEl.textContent = '已连接到房主的对局 · 全员可结算/立直';
        roomEl.style.display = 'none';
        meta.textContent = '';
        if (qrBlock) qrBlock.style.display = 'none';
        currentJoinUrl = null;
      }
      statusEl.className = 'net-status on';
      // 对局中也保留"设置名字"入口：房主一旦建局就再没有别的机会声明本机名
      // （旧版这里 display:none → 服务器上房主永远是"无名"，别人被挡下时只能看到
      //  「有人正在操作」，而不是「谁是操作者」）。名字改完立即上报并落盘。
      actionsEl.style.display = 'block';
    } else {
      statusEl.textContent = '已连接服务器，等待房主建局';
      statusEl.className = 'net-status on';
      roomEl.style.display = 'none';
      actionsEl.style.display = 'block';
      if (qrBlock) qrBlock.style.display = 'none';
      currentJoinUrl = null;
    }
  }

  // 在房主端生成"扫一扫加入本桌"二维码（内容=成员访问的完整链接）
  // block=外层容器(#net-room-qr，控制显隐)；canvas=实际放<img>的格子(#qr-canvas)
  // 依赖 assets 内置的 js/qrcode.js（window.qrcode，纯 JS 离线可用）
  let _lastQRText = null;
  function renderQR(block, canvas, text) {
    if (!block || !canvas) return;
    if (typeof window.qrcode !== 'function') {
      block.style.display = 'none';
      return;
    }
    // 链接未变化则无需重绘，避免成员数变化等触发闪烁
    if (text === _lastQRText && canvas.childNodes.length) {
      block.style.display = 'block';
      return;
    }
    try {
      const qr = window.qrcode(0, 'M'); // typeNumber 0=自动扩容, 纠错级 M
      qr.addData(text);
      qr.make();
      const dataUrl = qr.createDataURL(4, 8); // cellSize=4px, 白边 8px
      canvas.innerHTML = '';
      const img = document.createElement('img');
      img.src = dataUrl;
      img.width = 160; // 固定 160px 便于扫描
      img.height = 160;
      img.alt = '扫码加入';
      canvas.appendChild(img);
      block.style.display = 'block';
      _lastQRText = text;
    } catch (e) {
      block.style.display = 'none';
    }
  }

  // ============ 模态打开/关闭 ============
  // 会占用"结算/立直操作权"的流程弹窗集合：只要其中任一仍打开，就说明玩家还没结束本次操作。
  // 关闭（×/点空白/取消/流程推进）导致这些弹窗全部关闭、回到主界面时，才释放操作权。
  const OP_MODALS = new Set([
    'modal-riichi',          // 立直选人
    'modal-settle-type',     // 结算：选荣和/自摸
    'modal-settle-pay',      // 结算：选付分人
    'modal-settle-recv',     // 结算：选收分人
    'modal-settle-amount',   // 结算：填分
    'modal-settle-more',     // 结算：是否还有和牌者
    'modal-tsumo',           // 自摸：选自摸者
    'modal-tsumo-amounts',   // 自摸：输入应付额
  ]);

  // 链内推进判定：同一事件里"关旧开新"（两种顺序都有）或叠层打开时零动画，
  // 只有从主界面新开弹窗才播淡入。closeModal 记时间戳，openModal 判定。
  const MODAL_CHAIN_MS = 150;
  let lastModalCloseAt = 0;

  function openModal(id) {
    const el = $('#' + id);
    const chainSwitch = (Date.now() - lastModalCloseAt < MODAL_CHAIN_MS) ||
      !!document.querySelector('.modal-overlay.show');
    el.classList.toggle('instant', chainSwitch);
    el.classList.add('show');
  }
  function closeModal(id) {
    const el = $('#' + id);
    if (el) {
      el.classList.remove('show');
      el.classList.remove('instant');
      lastModalCloseAt = Date.now();
    }
    // 扫码弹窗关闭（×/点空白/命中成功）时必须释放摄像头，否则指示灯常亮且耗电
    if (id === 'modal-scanqr') stopQrScan();
    // 番符表关闭（关闭按钮/×/点空白）：若本次是由结算填分唤起，把结果回填到分数输入框
    if (id === 'modal-calc') onCalcClosed();
    // 操作流程弹窗会在同一事件里 close+open 推进，故用微任务等过渡完成后再判是否需释放
    if (window.Net && Net.isInRoom()) {
      setTimeout(() => {
        if (!Net.amOperator()) return;
        let anyOpen = false;
        OP_MODALS.forEach((mid) => {
          const m = document.getElementById(mid);
          if (m && m.classList.contains('show')) anyOpen = true;
        });
        if (!anyOpen) Net.releaseAction();
      }, 0);
    }
  }

  // 通用确认弹窗（替代原生 confirm，兼容预览面板/WebView）
  let confirmCb = null;
  function confirmDialog(title, msg, onOk) {
    $('#confirm-title').textContent = title || '确认';
    $('#confirm-msg').textContent = msg || '';
    confirmCb = onOk || null;
    openModal('modal-confirm');
  }
  function confirmOk() {
    closeModal('modal-confirm');
    if (confirmCb) { const cb = confirmCb; confirmCb = null; cb(); }
  }
  function confirmCancel() {
    confirmCb = null;
    closeModal('modal-confirm');
  }

  // ============ 页面1：模式选择 ============
  function bindModePage() {
    let selectedMode = 4;

    $('#mode-3').addEventListener('click', () => {
      selectedMode = 3;
      $('#mode-3').classList.add('selected');
      $('#mode-4').classList.remove('selected');
    });
    $('#mode-4').addEventListener('click', () => {
      selectedMode = 4;
      $('#mode-4').classList.add('selected');
      $('#mode-3').classList.remove('selected');
    });
    $('#btn-next-setup').addEventListener('click', () => {
      setupMode = selectedMode;
      renderSetupPage();
      showPage('page-setup');
    });
    // 首页跳转到对局记录页
    $('#btn-goto-history').addEventListener('click', () => {
      renderHistory();
      showPage('page-history');
    });
  }

  // ============ 页面2：开局设置 ============
  let setupMode = 4;
  function renderSetupPage() {
    $('#setup-mode-label').textContent = (setupMode === 3 ? '三人模式' : '四人模式') +
      '（初始 ' + (setupMode === 3 ? '35000' : '25000') + ' 点）';
    // 西入阈值提示：三人40000 / 四人30000；南场最后局三人南三/四人南四
    $('#setup-west-hint').textContent =
      '西入规则（开启后' + (setupMode === 3 ? '南三' : '南四') + '最低不足' + (setupMode === 3 ? '40000' : '30000') + '自动进入西场）';
    // 渲染座次选择（起庄 + 用户名）
    renderSetupSeats();
  }

  function renderSetupSeats() {
    const winds = setupMode === 3 ? ['东', '南', '西'] : ['东', '南', '西', '北'];
    const container = $('#setup-seats');
    container.innerHTML = '';
    winds.forEach((w) => {
      const div = document.createElement('div');
      div.className = 'card';
      div.innerHTML = `
        <h3>${w} 方位</h3>
        <div class="field">
          <label>用户名</label>
          <input type="text" class="setup-name" data-wind="${w}" placeholder="输入用户名" value="">
        </div>`;
      container.appendChild(div);
    });
    // 起庄选择
    const dealerSel = $('#setup-dealer');
    dealerSel.innerHTML = '';
    winds.forEach((w) => {
      const opt = document.createElement('option');
      opt.value = w;
      opt.textContent = w + '（起庄）';
      dealerSel.appendChild(opt);
    });
    dealerSel.value = '东';
  }

  function bindSetupPage() {
    $('#btn-create-game').addEventListener('click', createGameFromSetup);
  }

  function createGameFromSetup() {
    // 联网对局由房主建立
    if (!isHost()) { toast('对局由房主建立，请等待房主操作'); return; }
    // 收集各座用户名
    const names = {};
    let valid = true;
    document.querySelectorAll('.setup-name').forEach((inp) => {
      const w = inp.dataset.wind;
      const n = inp.value.trim();
      if (!n) { valid = false; }
      names[w] = n;
    });
    if (!valid) { toast('请为每个座次填写用户名'); return; }

    // 用户名查重：规则引擎按名字定位玩家（indexByName 取第一个同名），
    // 重名会导致后续操作（立直/结算/修正等）作用到错误的座位，故不允许重复。
    const nameToSeats = {};
    Object.keys(names).forEach((w) => {
      const n = names[w];
      (nameToSeats[n] = nameToSeats[n] || []).push(w);
    });
    const dups = Object.keys(nameToSeats).filter((n) => nameToSeats[n].length > 1);
    if (dups.length) {
      const desc = dups.map((n) => `“${n}”（${nameToSeats[n].join('、')}座）`).join('、');
      toast('用户名重复，无法建局：' + desc + '。请改为不同名字');
      return;
    }

    const dealerWind = $('#setup-dealer').value;
    const westRule = $('#switch-west').classList.contains('on');
    const multiRon = $('#switch-multiron').classList.contains('on');

    // 创建对局（初始 wind=方位占位，随后重排）
    game = Rules.createGame(setupMode, { westRule, multiRon, dealerName: names[dealerWind] });
    // 新开局：清除上一局的本地视角锁定（半庄内锁定，跨局需重新选择）
    viewLock = null;
    viewSel = null;

    // 按起庄玩家确定"游戏内方位"分配：
    //   - 玩家在 setup 页填的是【实际方位】（线下物理座位），固定不变 → 存 seat
    //   - 对局内的东/南/西/北是【游戏内方位】，会随换庄动态旋转 → 存 wind
    //   - 起庄者（其实际方位=dealerWind）开局为庄，游戏内方位="东"
    // 例：四人局 windOrder=[东,南,西,北]。若起庄选"实际南"，则：
    //     实际南玩家 → 游戏内东（庄），实际西→游戏内南，实际北→游戏内西，实际东→游戏内北
    const windOrder = setupMode === 3 ? ['东', '南', '西'] : ['东', '南', '西', '北'];
    const dPos = windOrder.indexOf(dealerWind); // 起庄者的实际方位在 windOrder 中的位置
    // seatAssign[i] = 坐 windOrder[i]（实际方位）的玩家 开局得到的游戏内方位
    const seatAssign = [];
    for (let i = 0; i < windOrder.length; i++) {
      seatAssign.push(windOrder[(i - dPos + windOrder.length) % windOrder.length]);
    }
    const newPlayers = windOrder.map((physicalWind, i) => ({
      seat: physicalWind,            // 实际方位（固定）
      wind: seatAssign[i],           // 游戏内方位（开局：起庄者为东）
      name: names[physicalWind],
      points: setupMode === 3 ? 35000 : 25000,
      riichi: false,
      riichiBars: 0,
      isConnected: true,
    }));
    game.players = newPlayers;
    game.dealerIndex = newPlayers.findIndex((p) => p.wind === '东'); // 庄=游戏内东

    // ⚠️ 这里**不写**本机用户资料（修复 A）。
    //    旧版是 `profile = { name: names['南'] || names['东'] || names['西'] }` + Storage.saveProfile：
    //    把"南座那格填的名字"当成本机用户名永久落盘 —— 实测把用户已设的「高琦」
    //    改成了牌桌上别人的名字「小明」，是在悄悄篡改用户资料；
    //    而且联网后房主可能坐任意方位，"南座=我"这个原型假设也不成立。
    //    本机名只由用户的显式动作产生（「设置名字」/ 视角锁定"我就是这家"），见 applyLocalName()。
    //    建局只负责对局数据，不碰身份。
    commitGame();
    showPage('page-main');
    renderMain();
    toast('对局已建立，欢迎来到' + (setupMode === 3 ? '三人' : '四人') + '麻将');
  }

  // ============ 主界面（对局桌面） ============
  // 记录上次做过总分校验的局数标记（wind+num+honba），用于检测"进入新局"
  let lastCheckedRound = null;

  /**
   * 每进入一个新局时校验场上总分是否等于该模式的合理总分。
   * 四人：25000×4=100000；三人：35000×3=105000。
   * 分数转移是零和的，总分应恒定；一旦不符，几乎必然是手动修正输错或数据异常。
   * 仅警告不阻断：显示红色警告横幅 + toast，仍可继续。
   */
  function checkTotalScore() {
    if (!game || game.over) return;
    const expected = game.mode === 3 ? 35000 * 3 : 25000 * 4;
    // 场上总分 = 各玩家分数总和 + 供托池（立直棒暂存，未进入任何玩家口袋，总量仍守恒）
    const total = game.players.reduce((s, p) => s + p.points, 0) + (game.kyotaku || 0);
    const banner = $('#total-check-banner');
    if (total === expected) {
      banner.style.display = 'none';
      return;
    }
    const diff = total - expected;
    const playersText = game.players.map((p) => `${p.wind}${p.name}:${p.points}`).join('　');
    banner.innerHTML =
      `⚠ 场上总分 ${total}，${game.mode === 3 ? '三人' : '四人'}模式应为 ${expected}，差额 ${diff > 0 ? '+' : ''}${diff} 点` +
      `<div style="font-size:12px;margin-top:4px;color:#A33B2E">${escapeHtml(playersText)}</div>` +
      `<div style="font-size:12px;margin-top:4px;color:#A33B2E">请检查是否输错分数，或用手动修正校准。</div>`;
    banner.style.display = 'block';
    toast('⚠ 场上总分异常，请核对各玩家分数');
  }

  function renderMain() {
    if (!game) return;

    // 结束横幅
    const endBanner = $('#end-banner');
    if (game.over) {
      endBanner.style.display = 'block';
      endBanner.textContent = '半庄结束：' + game.endReason;
    } else {
      endBanner.style.display = 'none';
    }

    // 玩家座位渲染：
    //   - 槽位位置默认用【实际方位 p.seat】定位（固定，对应线下物理座位）；
    //     若本机做了视角锁定，则由 seatClassFor 做整桌旋转映射，把"自己"转到下方。
    //   - 显示的风牌用【游戏内方位 p.wind】（动态，随换庄旋转；"东"即本局庄家）
    const table = $('#table-seats');
    table.innerHTML = '';
    game.players.forEach((p) => {
      const cls = seatClassFor(p);
      const div = document.createElement('div');
      div.className = 'seat ' + cls;
      const ptsCls = p.points < 0 ? 'pts neg' : (p.points === 0 ? 'pts neg2' : 'pts');
      const windCls = 'wind wind-' + p.wind; // 风牌四色（东红/南绿/西蓝/北黑）
      const youTag = viewLock && p.name === viewLock ? '<div class="you-mark">我</div>' : '';
      div.innerHTML = `
        <div class="${windCls}">${p.wind}</div>
        <div class="name">${escapeHtml(p.name)}</div>
        ${youTag}
        <div class="${ptsCls}">${p.points}</div>
        ${p.riichi ? '<div class="riichi-stick"><span class="riichi-stick-dot"></span></div>' : ''}
      `;
      table.appendChild(div);
    });

    // 中心信息
    $('#center-round').textContent = game.round.wind + game.round.num + '局';
    $('#center-honba').textContent = '本场 ' + game.honba;
    $('#center-kyotaku').textContent = '供托 ' + game.kyotaku + '点';
    $('#center-mode').textContent = (game.mode === 3 ? '三人' : '四人') +
      (game.opts.multiRon ? ' · 可多响' : '') +
      (game.opts.westRule ? ' · 西入' : '');

    // 操作按钮可用性（全员协作：结算/立直对所有玩家开放，全局操作仅房主）
    // 掉线锁定：曾进房但当前未连上 → 一切会写状态的操作全部禁用（口径：锁住等重连）
    const locked = netLocked();
    const globalOnly = !isHost() || locked; // 流局/修正/撤回/结束仅房主
    // 结算/立直：联网成员需在"空闲或自己持有操作权"时可用
    const localOper = canOperateLocal();
    $('#btn-riichi').disabled = game.over || !localOper;        // 立直：所有玩家可操作
    $('#btn-flow').disabled = globalOnly;                        // 流局仅房主
    $('#btn-adjust').disabled = globalOnly;                      // 手动修正仅房主
    $('#btn-undo').disabled = globalOnly || game.history.length === 0; // 撤回仅房主
    $('#btn-tsumo-ron').disabled = game.over || !localOper;      // 和牌结算：所有玩家可操作
    $('#btn-end').disabled = globalOnly;                         // 结束对局仅房主

    // 场风盘「立即推送」：仅房主显示（单机也是房主）；掉线锁定期间一并隐藏
    $('#btn-tag-push').style.display = (isHost() && !locked) ? '' : 'none';

    // 新局开始校验：局数/本场变化时校验场上总分
    const roundMark = game.round.wind + game.round.num + '-' + game.honba;
    if (roundMark !== lastCheckedRound) {
      lastCheckedRound = roundMark;
      checkTotalScore();
    }

    // 主界面联网状态提示
    const netHint = $('.actions .hint');
    if (netHint) {
      if (window.Net && Net.isInRoom()) {
        const nMembers = Net.memberCount() - 1; // 非房主设备数
        const globalNote = isHost()
          ? '流局等全局操作仅你可点'
          : '流局等全局操作仅房主可点';
        if (Net.amOperator()) {
          netHint.textContent = '你正在操作（结算/立直）。完成后或关闭窗口即自动释放操作权。';
        } else if (Net.operatorName()) {
          netHint.textContent = Net.operatorName() + ' 正在结算/操作，请稍候。' + globalNote;
        } else {
          netHint.textContent = isHost()
            ? '房主模式 · 已连接 ' + nMembers + ' 台设备 · 结算/立直全员平权 · ' + globalNote
            : '全员可结算/立直 · 结算/立直平权互斥 · ' + globalNote;
        }
      } else if (window.Net && Net.isOnline()) {
        netHint.textContent = '已连接服务器，可创建或加入房间';
      } else {
        netHint.textContent = '单机模式 · 房主可操作：流局 · 手动修正 · 撤回 · 结束对局';
      }
    }

    // 主界面下方：刷新"本半庄已结算各局"的分数记录
    renderRoundLog();
  }

  /**
   * 渲染"半庄分数记录"（page-main 操作区下方，可折叠）。
   * 数据来源：从 game.history 过滤出携带 `.hand`（每局结算）标记的快照。
   * - 每局一条：局号·本场 标签 + 各玩家"结束分 + 括号内本局净变化"。
   * - 净变化 delta 已由 Rules.buildHandRecord 计入本局立直扣的 1000（口径见 rules.js）。
   * - 颜色沿用结算弹窗习惯：增加分绿(#1E9E63)、减少分红(#D94F3D)、0 灰。
   * - 撤回会弹出快照，对应记录自动消失；手动修正的快照无标记，不产生记录。
   */
  function renderRoundLog() {
    const card = $('#round-log');
    const body = $('#round-log-body');
    const countEl = $('#round-log-count');
    if (!card || !body) return;
    // 从历史中收集携带 .hand 的已结算局（按下标顺序即时间顺序）
    const records = (game && Array.isArray(game.history))
      ? game.history.filter((s) => s && s.hand).map((s) => s.hand)
      : [];
    if (countEl) countEl.textContent = records.length ? `（${records.length} 局）` : '';
    if (!records.length) {
      body.innerHTML = '<div class="round-log-empty"><span class="empty-riichi" aria-hidden="true"><span class="er-bar"></span></span>尚无已结算的对局，完成第一局结算后会显示在这里。</div>';
      return;
    }
    // 最新在前，便于一眼看到刚结算的局
    const frag = [];
    for (let i = records.length - 1; i >= 0; i--) {
      frag.push(handRecordHtml(records[i]));
    }
    body.innerHTML = frag.join('');
  }

  /**
   * 渲染一条"已结算对局"记录（半庄分数记录 / 历史详情 逐局记录 共用同一版式）。
   * - 立直小标记：rec.players[].riichi 为 true 时，在名字后插一支迷你立直棒。
   *   该字段由新版 Rules.buildHandRecord 写入；新版之前归档的老对局没有此字段，
   *   渲染结果与改动前完全一致（无标记、delta 也不补记 1000），符合"只对新对局生效"。
   */
  function handRecordHtml(rec) {
    const playersHtml = (rec.players || []).map((p) => {
      const sign = p.delta > 0 ? '+' : (p.delta < 0 ? '' : '');
      const cls = p.delta > 0 ? 'up' : (p.delta < 0 ? 'down' : 'zero');
      return `<span class="rl-player"><span class="rl-player-name">${escapeHtml(p.name)}</span>` +
        (p.riichi ? '<span class="rl-player-riichi"><span class="rl-player-riichi-dot"></span></span>' : '') +
        `<span class="rl-player-pts">${p.pts}</span>` +
        `<span class="rl-player-delta ${cls}">(${sign}${p.delta})</span></span>`;
    }).join('');
    return `<div class="rl-hand">` +
      `<div class="rl-hand-label">${escapeHtml(rec.label || '')}</div>` +
      `<div class="rl-hand-players">${playersHtml}</div></div>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // 房主判断：
  //  - 从未联网（单机，含电脑浏览器无服务器）：本机即房主，保持单机体验完整
  //  - 曾成功进房（含当前掉线重连中）：以服务器确认的角色为准，**绝不因为在重连就升格成房主**
  //    ⚠️ 旧版此处写的是 `if (Net.isInRoom()) return Net.isHost(); return true;`，
  //    掉线时 isInRoom() 为 false → 直接返回 true → 成员手机凭空获得房主权限
  //    （流局/修正/撤回/结束按钮全亮），这是"掉线后本地继续计分且不上行"的直接成因。
  function isHost() {
    if (!window.Net) return true;
    if (Net.hasJoined && Net.hasJoined()) return Net.isHost();
    return true;
  }

  // ============ 场风盘蓝牙推送（2026-09-30，需求定稿见 memory） ============
  // 自动推送触发：立直宣言/取消、每局结算（荣和/自摸/流局）；手动修正不自动推。
  // 节流在原生侧（EinkBoardManager 1s 合并）；immediate=true（立即推送按钮）不受限。
  // 通道：联网走 WS push-tag 消息（服务器=房主手机原生侧处理）；WS 不可用但有
  // NativeBridge（APP 内）时直接调原生；电脑浏览器无两者则静默跳过。
  function tagDataFromGame() {
    if (!game) return null;
    return {
      mode: game.mode,
      over: !!game.over,
      endReason: game.endReason || '',
      roundWind: game.round.wind,
      roundNum: game.round.num,
      honba: game.honba,
      kyotaku: game.kyotaku,
      players: game.players.map((p) => ({
        seat: p.seat, wind: p.wind, points: p.points, riichi: !!p.riichi,
      })),
    };
  }

  function notifyTagPush(immediate) {
    const data = tagDataFromGame();
    if (!data) return;
    let sent = false;
    if (window.Net && Net.isOnline()) sent = Net.sendTagPush(data, immediate);
    if (!sent && window.NativeBridge && window.NativeBridge.pushTag) {
      try { window.NativeBridge.pushTag(JSON.stringify(data), !!immediate); } catch (e) {}
    }
  }
  // 本机能否操作"结算/立直"（平权模型，房主与成员一致）：
  //  - 单机/未进房：始终可
  //  - 联网：操作权空闲 或 本机正持有操作权 时可用（房主也不例外，
  //    若已被某成员/玩家占用，房主也点不开，杜绝双份结算）
  function canOperateLocal() {
    if (netLocked()) return false;                 // 掉线锁定：任何写状态的操作都不许
    if (!window.Net || !Net.isInRoom()) return true;
    return Net.amOperator() || !Net.operatorName();
  }
  function dealerIsYou() {
    return true;
  }

  // ============ 联网锁定 / 掉线回滚（2026-10-03 批次 1） ============
  // 口径：一旦与服务器断开，就锁住所有会写状态的操作，并把"没同步成功的本地改动"
  // 回滚到最后一次与服务器一致的状态 —— 杜绝本地悄悄记下服务器不知道的对局
  // （旧版掉线后 app.js 会把本机当成房主，按钮全亮、算完也不上行）。
  let netWasLocked = false;

  /** 是否处于"曾进房但当前掉线"的锁定态 */
  function netLocked() {
    return !!(window.Net && Net.isLocked && Net.isLocked());
  }

  /**
   * 本次操作是否还允许落地；不允许则返回给用户的说明（null = 放行）。
   * 三种拦法：
   *  1. 掉线锁定（等重连）
   *  2. 联网成员丢失操作权 —— 典型场景：结算/立直弹窗在断线前就打开了，
   *     掉线重连后 iAmOperator 已被重置，此时若照常提交，服务器会以
   *     conflict(denied) 拒绝 → 本地白操作一场（就是"操作没同步"的一种）
   *  3. 单机/房主不拦（房主全局操作本就不占用操作权，服务器也接受房主提交）
   */
  function operationBlockReason() {
    if (netLocked()) return '连接已断开，正在自动重连';
    if (!window.Net || !Net.isInRoom()) return null;   // 单机：放行
    if (Net.isHost()) return null;                     // 房主：全局操作/结算均可提交
    if (!Net.amOperator()) return '操作权已失效，请重新操作';
    return null;
  }

  /** 把本地未同步的改动回滚到最后一次与服务器一致的状态；返回是否真的回滚了 */
  function rollbackToSynced() {
    if (!window.Net || !Net.lastSyncedState || !game) return false;
    const synced = Net.lastSyncedState();
    if (!synced) return false;
    let cur = null;
    try { cur = Rules.serialize(game); } catch (e) { return false; }
    if (cur === synced) return false;              // 没有未同步改动
    try { game = Rules.deserialize(synced); } catch (e) { return false; }
    Storage.saveActive(game);                      // 本地写回同步态（不再外发，提交一律走 Net.commit）
    return true;
  }

  /** 联网状态变化：掉线锁定 → 回滚 + 提示；恢复连接 → 提示解除 */
  function onNetStatusChanged() {
    const locked = netLocked();
    if (locked && !netWasLocked) {
      netWasLocked = true;
      const rolled = rollbackToSynced();
      toast(rolled ? '连接已断开，未同步的操作已撤销' : '连接已断开，正在自动重连…');
    } else if (!locked && netWasLocked) {
      netWasLocked = false;
      toast('已重新连接');
    }
    updateNetBanner();
  }

  /**
   * 顶部横幅。两种状态：
   *  - warn（红）：本机与服务器断开 → 全部写状态的操作已禁用，等自动重连
   *  - info（金）：房主页面离开了（服务器还在、分数都在）→ 成员的结算照常，
   *    只有流局/修正/撤回/结束这四项房主专属操作暂时不可用
   */
  function updateNetBanner() {
    const el = document.getElementById('net-banner');
    if (!el) return;
    const locked = netLocked();
    const hostAway = !locked && !!window.Net
      && Net.hasJoined && Net.hasJoined() && !Net.isHost() && Net.isHostOffline();
    if (!locked && !hostAway) {
      el.hidden = true;
      el.classList.remove('warn', 'info');
      return;
    }
    el.hidden = false;
    el.classList.toggle('warn', locked);
    el.classList.toggle('info', hostAway);
    const txt = el.querySelector('.net-banner-text');
    if (txt) {
      txt.textContent = locked
        ? '与服务器的连接已断开，正在自动重连…（期间无法操作）'
        : '房主暂时离开，结算可继续（流局/修正/撤回/结束暂不可用）';
    }
  }

  /**
   * 所有业务变更的唯一落库出口（全提交制，2026-10-03 批次 2）。
   *  - 单机（从未联网）：本机即权威，直接写 localStorage
   *  - 联网：先把当前状态 commit 上行，**收到服务器 ack 才落库**；
   *    被拒/冲突/超时/掉线 → 采用或回滚到服务器权威态并提示。
   *    这样即使界面上某条路径漏了拦截，本地也不会留下"服务器不知道的一局"。
   */
  function commitGame() {
    const block = operationBlockReason();
    if (block) {
      rollbackToSynced();
      toast(block + '，本次操作未生效');
      renderMain();
      return false;
    }
    if (!window.Net || !Net.hasJoined || !Net.hasJoined()) {
      Storage.saveActive(game);         // 单机：无服务器，本地即权威
      return true;
    }
    let state;
    try { state = Rules.serialize(game); } catch (e) { return false; }
    Net.commit(state).then(() => {
      Storage.saveActive(game);         // 服务器已确认 → 这时才落库
      renderMain();
    }).catch((err) => {
      const reason = (err && err.reason) || 'offline';
      if (reason === 'stale') toast('记录已被其他玩家更新，已采用最新状态');
      else if (reason === 'denied') toast('操作权已失效，请重新操作');
      else if (reason === 'timeout') toast('未收到服务器确认，正在重新同步…');
      else toast('连接已断开，本次操作未生效');
      // conflict（stale/denied）时 net.js 已把权威态推给 onState，game 已被替换并落库；
      // 其余情况回滚到最后一次与服务器一致的状态。
      if (reason !== 'stale') rollbackToSynced();
      // 结算/流局的结果弹窗是在 commit 之后同步打开的，它展示的是"没生效"的那份数字，
      // 必须一起关掉，否则用户对着一屏已作废的分数做判断。
      const resultModal = document.getElementById('modal-result');
      if (resultModal && resultModal.classList.contains('show')) closeModal('modal-result');
      renderMain();
    });
    return true;
  }

  // ============ 操作：立直 ============
  // 平权模型：无论房主/成员，联网时都先向服务器申请操作权，成功才进入操作。
  // 单机/未进房：直接进入（房主本地体验）。
  function tryBeginOperate(fn) {
    // 掉线锁定：连弹窗都不打开，直接提示等重连
    if (netLocked()) { toast('连接已断开，正在自动重连，请稍候'); return; }
    if (!window.Net || !Net.isInRoom()) { fn(); return; }
    if (Net.amOperator()) { fn(); return; }
    Net.requestAction(Net.memberName(), (err, granted) => {
      if (err || !granted) {
        // 被拒 = 别人正占着操作权。优先报出是谁（来自服务器 operator-change 广播）；
        // 名字可能确实取不到（对方还没设过本机名）→ 退化成不点名的提示，
        // 而不是含糊的"暂时无法操作"（旧版这个兜底文案会让人以为是自己操作错了）。
        const by = Net.operatorName();
        toast(err || (by ? (by + ' 正在操作，请稍候') : '有人正在操作，请稍候'));
        return;
      }
      fn();
    });
  }

  function bindMainPage() {
    // 立直
    $('#btn-riichi').addEventListener('click', () => {
      if (!game) return;
      tryBeginOperate(() => {
        openModal('modal-riichi');
        renderRiichiPick();
      });
    });
    $('#btn-flow').addEventListener('click', () => {
      openModal('modal-flow');
    });
    $('#btn-adjust').addEventListener('click', () => {
      // 手动修正：先弹「修正类型」面板（分数 / 所在局 / 本场数 / 供托点）
      openModal('modal-adjust');
    });
    $('#btn-undo').addEventListener('click', () => {
      // 二次确认：撤回是撤销一整局结算的误操作风险点，先弹确认窗
      const overNote = game && game.over
        ? '（当前对局已结束，撤回后将回到上一局结束前的状态并继续本局）'
        : '';
      confirmDialog(
        '确认撤回上一局',
        `将撤销最近一局的结算，回退到上一局开始前的分数与牌局状态${overNote}。确定要撤回吗？`,
        () => {
          const r = Rules.undo(game);
          toast(r.msg);
          commitGame();
          renderMain();
        }
      );
    });
    $('#btn-end').addEventListener('click', () => {
      openModal('modal-end');
    });
    // 骰子：右下角按钮打开弹窗
    $('#btn-dice').addEventListener('click', () => {
      openModal('modal-dice');
      renderDice(); // 打开即展示两个骰子（默认1点）
    });
    // 关闭
    $('#btn-dice-close').addEventListener('click', () => {
      closeModal('modal-dice');
    });
    // 摇一摇
    $('#btn-dice-shake').addEventListener('click', shakeDice);
    // 番符表计算器：左下角按钮（与骰子对称）。独立打开 → 自由模式（座位可切换、关闭不回填）
    $('#btn-calc').addEventListener('click', () => {
      resetCalcLink();
      openModal('modal-calc');
      updateCalc(); // 打开即按默认值(3番/30符/子家)算出结果
    });
    $('#btn-calc-close').addEventListener('click', () => {
      closeModal('modal-calc');
    });
    // 番/符/亲闲 变化 → 实时刷新结果
    ['#calc-han', '#calc-fu'].forEach((sel) => {
      const el = $(sel);
      if (el) el.addEventListener('change', updateCalc);
    });
    ['#calc-seat-ko', '#calc-seat-oya'].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener('click', () => {
        // 由结算填分唤起时，座位恒等于该笔和牌者（亲/子），锁定不可切换
        if (calcLink) { toast('座位已按本笔和牌者锁定，不可切换'); return; }
        document.querySelectorAll('.seat-chip').forEach((c) => c.classList.remove('active'));
        el.classList.add('active');
        updateCalc();
      });
    });
    // 视角切换：左上角按钮 → 打开弹窗（纯本机工具，不占操作权、不同步）
    $('#btn-view').addEventListener('click', () => {
      openModal('modal-view');
      renderViewPick();
    });
    $('#btn-view-lock').addEventListener('click', lockView);
    $('#btn-view-unlock').addEventListener('click', unlockView);

    // 规则速查：右上角"？"按钮 → 打开页签弹窗（只读，不占操作权、不同步，纯本机工具）
    // 关闭由全局 .close-x 绑定负责；此处只负责打开 + 页签切换
    $('#btn-help').addEventListener('click', () => {
      openModal('modal-help');
    });
    function switchHelpTab(tab) {
      ['han', 'fu'].forEach((t) => {
        const tb = $('#help-tab-' + t);
        const pn = $('#help-pane-' + t);
        if (tb) tb.classList.toggle('active', t === tab);
        if (pn) pn.style.display = (t === tab) ? '' : 'none';
      });
    }
    ['han', 'fu'].forEach((t) => {
      const tb = $('#help-tab-' + t);
      if (tb) tb.addEventListener('click', () => switchHelpTab(t));
    });

    // 半庄分数记录：点标题栏折叠/展开（默认展开，状态不持久化）
    const rlHead = $('#round-log-head');
    const rlCard = $('#round-log');
    if (rlHead && rlCard) {
      const toggleRoundLog = () => {
        rlCard.classList.toggle('collapsed');
        // 展开时重新渲染（各玩家可能已随视角/对局变化），折叠态仅收起
        if (!rlCard.classList.contains('collapsed')) renderRoundLog();
      };
      rlHead.addEventListener('click', toggleRoundLog);
      rlHead.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRoundLog(); }
      });
    }
  }

  // ============ 视角锁定（本机整桌旋转，让"自己"固定在下方位） ============
  // 打开弹窗时：列出当前玩家供选择；已锁定则高亮"我"并显示解除锁定按钮。
  function renderViewPick() {
    const cont = $('#view-pick');
    cont.innerHTML = '';
    const curEl = $('#view-current');
    if (!game) return;
    // 选中态：优先保持已有选中；否则默认选"我"(viewLock) 或第 0 位
    if (!viewSel) {
      viewSel = game.players.some((q) => q.name === viewLock) ? viewLock : game.players[0].name;
    }
    game.players.forEach((p) => {
      const div = document.createElement('div');
      div.className = 'p' + (viewSel === p.name ? ' selected' : '');
      div.innerHTML = `
        <div class="wind">${p.wind}</div>
        <div class="name">${escapeHtml(p.name)}</div>
        ${viewLock === p.name ? '<div class="pts" style="color:var(--accent);font-size:12px">我（下方）</div>' : ''}`;
      div.addEventListener('click', () => {
        viewSel = p.name;
        document.querySelectorAll('#view-pick .p').forEach((c) => c.classList.remove('selected'));
        div.classList.add('selected');
      });
      cont.appendChild(div);
    });
    if (curEl) {
      if (viewLock) {
        const me = game.players.find((q) => q.name === viewLock);
        curEl.textContent = me
          ? '当前已锁定：' + me.name + '（风' + me.wind + '）固定在下方'
          : '';
      } else {
        curEl.textContent = '未锁定 · 桌面按建立时的方位摆放';
      }
    }
    // 已锁定时显示"解除锁定"按钮
    const unlockBtn = $('#btn-view-unlock');
    if (unlockBtn) unlockBtn.style.display = viewLock ? '' : 'none';
  }

  function lockView() {
    if (!game) return;
    if (!viewSel || !game.players.some((q) => q.name === viewSel)) {
      toast('请先选择你对应的玩家名');
      return;
    }
    viewLock = viewSel;
    // 视角锁定 = 用户显式声明"我就是这名玩家" → 一并作为本机用户名上报/落盘。
    // 这是联网后唯一能在对局内声明身份的地方（对局中"设置名字"入口不可见）。
    // 只有它会写本机名，所以不会像旧版建局那样把牌桌上别人的名字写成"我"。
    applyLocalName(viewSel);
    closeModal('modal-view');
    renderMain();
    toast('已锁定：' + viewSel + ' 固定显示在桌面下方' +
      (window.Net && Net.isInRoom() ? '（你的操作会显示为「' + viewSel + '」）' : '（仅本机生效）'));
  }

  function unlockView() {
    viewLock = null;
    viewSel = null;
    closeModal('modal-view');
    renderMain();
    toast('已解除视角锁定，恢复初始方位');
  }

  // ============ 番符点数计算 ============
  function updateCalc() {
    const han = parseInt($('#calc-han').value, 10) || 1;
    const fu = parseInt($('#calc-fu').value, 10) || 30;
    const seat = document.querySelector('.seat-chip.active')?.dataset.seat || 'ko';
    // 传入当前局人数：自摸总额要把"三人缺北自摸损"（少收一份）算进去
    const r = Rules.calcScore(han, fu, seat, game ? game.players.length : 4);
    const ronEl = $('#calc-ron');
    const tsumoEl = $('#calc-tsumo');
    const noteEl = $('#calc-note');
    if (r.error) {
      ronEl.textContent = '—';
      tsumoEl.textContent = '—';
      noteEl.textContent = r.error;
      return;
    }
    const fmt = (n) => (n == null ? '—' : n.toLocaleString());
    ronEl.textContent = fmt(r.ron);
    tsumoEl.textContent = fmt(r.tsumo);
    // 说明：满贯档位标签 + 自摸分摊
    let note = r.tsumoNote ? `自摸：${r.tsumoNote}` : '';
    if (r.limit) note = `【${r.limit}】` + (note ? '　' + note : '');
    noteEl.innerHTML = note;
  }

  // ---- 番符表 ⇄ 和牌结算联动 ----
  // 由结算类弹窗唤起时非 null，形如 { seat:'ko'|'oya', receiverName, mode:'ron'|'tsumo' }：
  //   seat 由该笔和牌者（收分方）是否庄家推导，座位 chip 锁定不可切换；
  //   mode 决定关闭时的回填目标（'ron' → 结算填分框；'tsumo' → 自摸填额层的分类输入框）；
  //   关闭番符表（关闭按钮/×/点空白任一方式）时执行回填。
  let calcLink = null;

  /** 设置番符表座位 chip 选中态；locked=true 时把另一座位置灰并禁止切换 */
  function applyCalcSeat(seat, locked) {
    ['ko', 'oya'].forEach((s) => {
      const el = $('#calc-seat-' + s);
      if (!el) return;
      el.classList.toggle('active', s === seat);
      el.classList.toggle('locked', !!locked && s !== seat);
    });
  }

  /** 恢复自由模式：清除联动状态、解锁座位、隐藏联动提示 */
  function resetCalcLink() {
    calcLink = null;
    const cur = document.querySelector('.seat-chip.active')?.dataset.seat || 'ko';
    applyCalcSeat(cur, false);
    const hint = $('#calc-link-hint');
    if (hint) { hint.style.display = 'none'; hint.textContent = ''; }
  }

  /**
   * 共用的"唤起番符表 + 按和牌者锁定座位"逻辑。
   * @param {'oya'|'ko'} seat 和牌者（收分方）的亲/子身份
   * @param {string} name 和牌者名
   * @param {string} wind 和牌者方位（仅用于提示文案）
   * @param {'ron'|'tsumo'} mode 关闭后的回填目标
   */
  function openCalcLinked(seat, name, wind, mode) {
    calcLink = { seat: seat, receiverName: name, mode: mode };
    applyCalcSeat(seat, true);
    const hint = $('#calc-link-hint');
    if (hint) {
      hint.style.display = 'block';
      hint.textContent = '已锁定和牌者 ' + wind + ' ' + name +
        '（' + (seat === 'oya' ? '亲家/庄' : '子家/闲') + '）· 选好番符后点「关闭」自动填入' +
        (mode === 'tsumo' ? '应付额' : '分数');
    }
    openModal('modal-calc');
    updateCalc();
  }

  /** 从「和牌结算-填写应付分数」唤起番符表；和牌者 = 本笔收分对象 */
  function openCalcForSettle() {
    if (!settleReceiver) { toast('请先选择和牌者'); return; }
    openCalcLinked(isDealerByName(settleReceiver.name) ? 'oya' : 'ko',
      settleReceiver.name, settleReceiver.wind, 'ron');
  }

  /** 从「自摸结算-输入应付额」唤起番符表；和牌者 = 本笔自摸者 */
  function openCalcForTsumo() {
    if (!tsumoPlayer) { toast('请先选择自摸者'); return; }
    openCalcLinked(isDealerByName(tsumoPlayer.name) ? 'oya' : 'ko',
      tsumoPlayer.name, tsumoPlayer.wind, 'tsumo');
  }

  /**
   * 番符表关闭回调（由 closeModal 统一触发，覆盖按钮/×/点空白三种关法）：
   * 联动模式下把当前番符结果写入对应的结算输入框。
   * 荣和：填放铳者应付额（= 和牌者所得 ron）。
   * 自摸：按类填入「闲家应付 / 庄家应付」——不能用总额，录入层收的是两个分类金额，
   *       且三人局自摸者若为闲家时付款家数会变（见 Rules.calcScore 的字段说明）。
   */
  function onCalcClosed() {
    const link = calcLink;
    if (!link) return;
    resetCalcLink();
    const han = parseInt($('#calc-han').value, 10) || 1;
    const fu = parseInt($('#calc-fu').value, 10) || 30;
    const r = Rules.calcScore(han, fu, link.seat, game ? game.players.length : 4);
    if (r.error) return;
    const label = han + ' 番 ' + fu + ' 符（' + (link.seat === 'oya' ? '亲家' : '子家') + '）';
    if (link.mode === 'tsumo') { fillTsumoAmounts(r, label); return; }
    const val = r.ron;
    if (val == null) return;
    const input = $('#settle-amount');
    if (input) input.value = val;
    toast('已按 ' + label + ' 填入 ' + val.toLocaleString() + ' 点');
  }

  /**
   * 把番符结果写入自摸填额层的分类输入框。
   * 庄家自摸：只需「每位闲家应付」= tsumoKo（无庄付项）。
   * 闲家自摸：「每位闲家(子)应付」= tsumoKo、「庄家(亲)应付」= tsumoOya。
   * 定位方式与 collectTsumoDraft 一致（按 .tsumo-shared / .tsumo-koha / .tsumo-oya 类名）。
   * @returns {boolean} 是否至少填入了 1 个输入框
   */
  function fillTsumoAmounts(r, label) {
    const list = $('#tsumo-amount-list');
    if (!list || !tsumoPlayer) return false;
    const parts = [];
    const setVal = (sel, val, text) => {
      const el = list.querySelector(sel);
      if (!el || val == null) return;
      el.value = val;
      parts.push(text + ' ' + val.toLocaleString());
    };
    if (isDealerByName(tsumoPlayer.name)) {
      setVal('.tsumo-shared', r.tsumoKo, '每位闲家');
    } else {
      setVal('.tsumo-koha', r.tsumoKo, '闲家');
      setVal('.tsumo-oya', r.tsumoOya, '庄家');
    }
    if (parts.length === 0) return false;
    toast('已按 ' + label + ' 填入 ' + parts.join(' / ') + ' 点');
    return true;
  }

  // ============ 骰子 ============
  // 3×3 点阵下标（0~8）对应的点数布局，参考标准骰子面：
  //   0 1 2   ←顶行
  //   3 4 5   ←中行
  //   6 7 8   ←底行
  const DIE_FACES = {
    1: [4],
    2: [2, 6],
    3: [2, 4, 6],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8], // 两列各3点（左列：0,3,6；右列：2,5,8），中间留空
  };

  // 渲染单个骰子的点数
  function renderDie(dieEl, val) {
    const positions = DIE_FACES[val] || [4];
    dieEl.dataset.val = val;
    dieEl.innerHTML = '';
    for (let i = 0; i < 9; i++) {
      const pip = document.createElement('span');
      pip.className = 'pip';
      pip.dataset.i = i;
      pip.style.display = positions.includes(i) ? 'block' : 'none';
      dieEl.appendChild(pip);
    }
  }

  // 打开弹窗时展示两个骰子（初始 1 点，无动画）
  function renderDice() {
    document.querySelectorAll('#dice-row .die').forEach((el) => {
      el.classList.remove('shaking');
      renderDie(el, 1);
    });
  }

  // 摇一摇：短暂动画后显示 1~6 随机点数
  function shakeDice() {
    const diceEls = [...document.querySelectorAll('#dice-row .die')];
    // 若上次摇动仍在进行，先清除定时器
    if (window.__diceTimer) { clearInterval(window.__diceTimer); window.__diceTimer = null; }
    // 进入摇动状态：快速轮换点数，营造"正在摇动"的视觉效果
    diceEls.forEach((el) => el.classList.add('shaking'));
    const start = Date.now();
    window.__diceTimer = setInterval(() => {
      // 已摇动满约 700ms，停止并显示最终随机点数
      if (Date.now() - start >= 700) {
        clearInterval(window.__diceTimer);
        window.__diceTimer = null;
        diceEls.forEach((el) => {
          el.classList.remove('shaking');
          renderDie(el, 1 + Math.floor(Math.random() * 6));
        });
        return;
      }
      // 摇动中：每 90ms 随机换面
      diceEls.forEach((el) => renderDie(el, 1 + Math.floor(Math.random() * 6)));
    }, 90);
  }

  // 立直选人（开关式：点击已立直者则取消）
  // 已立直者：分数下方显示立直棒（白条+红点），与桌面一致，作为"已立直"指示，无高亮。
  function renderRiichiPick() {
    const cont = $('#riichi-pick');
    cont.innerHTML = '';
    game.players.forEach((p) => {
      const div = document.createElement('div');
      div.className = 'p';
      div.innerHTML = `
        <div class="wind">${p.wind}</div>
        <div class="name">${escapeHtml(p.name)}</div>
        <div class="pts">${p.points}点</div>
        ${p.riichi ? '<div class="riichi-stick"><span class="riichi-stick-dot"></span></div>' : ''}`;
      div.addEventListener('click', () => {
        // 弹窗可能在断线/丢操作权之前就打开了，这里挡住最后一步（否则只本地生效不上行）
        const block = operationBlockReason();
        if (block) { toast(block + '，本次立直未生效'); return; }
        const r = Rules.doRiichi(game, p.name);
        if (r.ok && r.action === 'riichi' && window.Sfx) Sfx.riichi();  // 仅实际宣言立直时响（取消不响）；本弹窗只在操作权持有者设备打开，天然"仅操作者手机响"
        if (r.ok) notifyTagPush(false);  // 立直宣言/取消 → 场风盘自动推送（节流）
        toast(r.msg);
        commitGame();
        renderMain();
        closeModal('modal-riichi');
        if (window.Net && Net.isInRoom() && Net.amOperator()) Net.releaseAction();
      });
      cont.appendChild(div);
    });
  }

  // ============ 操作：和牌结算 ============
  // 先选本局和牌类型（荣和/自摸），再进入对应录入流程
  let settleType = 'ron'; // 'ron' | 'tsumo'：本局和牌类型（用于本场加算）
  function bindSettlement() {
    // 打开和牌类型选择（申请操作权后进入）
    $('#btn-tsumo-ron').addEventListener('click', () => {
      tryBeginOperate(() => {
        $('#settle-type-honba').textContent =
          '当前本场 ' + game.honba + (game.honba > 0
            ? ' 本（荣和放铳者付 300 点/本；自摸各家付 100 点/本，自摸者共收 ' + (game.mode === 3 ? '200' : '300') + ' 点/本）'
            : '');
        openModal('modal-settle-type');
      });
    });
    // 荣和：进通用"选付分人→选收分人→填分"
    $('#btn-settle-ron').addEventListener('click', () => {
      settleType = 'ron';
      closeModal('modal-settle-type');
      openModal('modal-settle-pay');
      renderPayPick();
    });
    // 自摸：进自摸专用流程
    $('#btn-settle-tsumo').addEventListener('click', () => {
      settleType = 'tsumo';
      closeModal('modal-settle-type');
      renderTsumoPick();
      openModal('modal-tsumo');
    });
  }

  // ---- 自摸流程：选自摸者 → 输入应付额 → 确认结算 ----
  // 简化后不再逐家手填：程序根据"自摸者是否庄家"决定每家应付额来自哪个输入框并自动复制到各家。
  let tsumoPlayer = null;    // 自摸者（和牌者，收分人）

  /** 当前庄家名（用于判断自摸者是否庄家） */
  function dealerName() {
    return (game && game.players[game.dealerIndex]) ? game.players[game.dealerIndex].name : null;
  }

  /** 是否为庄家（索引0/dealerIndex 指向的玩家） */
  function isDealerByName(name) {
    return dealerName() === name;
  }

  function renderTsumoPick() {
    const cont = $('#tsumo-pick');
    cont.innerHTML = '';
    game.players.forEach((p) => {
      const div = document.createElement('div');
      div.className = 'p';
      div.innerHTML = `<div class="wind">${p.wind}</div><div class="name">${escapeHtml(p.name)}</div>`;
      div.addEventListener('click', () => {
        tsumoPlayer = p;
        renderTsumoAmounts(p);
        openModal('modal-tsumo-amounts');
        closeModal('modal-tsumo');
      });
      cont.appendChild(div);
    });
  }

  /**
   * 渲染应付额输入层：
   * - 自摸者=庄家：只需输入一个"每位闲家应付"值，程序复制给所有闲家（庄自摸由各家均摊）。
   * - 自摸者=闲家：需输入"每位闲家(子)应付"和"庄家(亲)应付"两值（子家自摸庄付2份）。
   */
  function renderTsumoAmounts(self) {
    const isDealerSelf = isDealerByName(self.name);
    const list = $('#tsumo-amount-list');
    list.innerHTML = '';
    resetCalcLink(); // 清除上一次联动的残留（座位锁定/提示条）
    const others = game.players.filter((p) => p.name !== self.name); // 付分候选（含自摸者除外的所有家）

    // 自摸者（含方位）展示
    $('#tsumo-recv-name').textContent = '自摸者：' + self.wind + ' ' + self.name +
      (isDealerSelf ? '（庄家）' : '（闲家）');

    if (isDealerSelf) {
      // 庄家自摸：单一输入框，复制给所有付分者（其余皆为闲家）
      const ids = others.map((p) => p.name);
      const div = document.createElement('div');
      div.className = 'field-row';
      div.innerHTML = `
        <span class="lbl">每位闲家应付</span>
        <input type="number" class="num-input tsumo-shared" data-payers="${ids.join(',')}" placeholder="0" min="0">`;
      list.appendChild(div);
    } else {
      // 闲家自摸：两个输入框。闲家集=除自摸者外的闲家；庄家单独。
      const dealer = game.players[game.dealerIndex];
      const kohaIds = others.filter((p) => p.name !== dealer.name).map((p) => p.name);
      const div = document.createElement('div');
      div.className = 'field-row';
      div.innerHTML = `
        <span class="lbl">每位闲家(子)应付</span>
        <input type="number" class="num-input tsumo-koha" data-payers="${kohaIds.join(',')}" placeholder="0" min="0">`;
      list.appendChild(div);
      const divOya = document.createElement('div');
      divOya.className = 'field-row';
      divOya.innerHTML = `
        <span class="lbl">${dealer.wind} ${escapeHtml(dealer.name)}(庄/亲)应付</span>
        <input type="number" class="num-input tsumo-oya" data-payers="${dealer.name}" placeholder="0" min="0">`;
      list.appendChild(divOya);
    }

    // 本场加算提示（自动计入，不需手填）。三人缺北属"自摸损"：仅在场其他2家付，故总额 200N
    const perPlayer = honbaPerPlayer(game.honba); // 每家 100N
    const selfTotal = perPlayer * (game.players.length - 1); // 4人=300N、3人缺北(自摸损)=200N
    $('#tsumo-honba-hint').textContent = game.honba > 0
      ? `本场 ${game.honba} 本：本局自摸加算 ${selfTotal} 点，自摸者多收，其余各家各摊 ${perPlayer} 点（${game.mode === 3 ? '3人缺北自摸损，仅2家支付' : '每家支付'}，将自动计入）`
      : '本场 0：无本场加算';
  }

  /** 收集当前输入层的应付额，生成明细草案 */
  function collectTsumoDraft() {
    const rows = [];
    const inputs = [...document.querySelectorAll('.tsumo-shared, .tsumo-koha, .tsumo-oya')];
    let any = false;
    inputs.forEach((inp) => {
      const v = parseInt(inp.value, 10);
      if (isNaN(v) || v <= 0) return;
      any = true;
      const payers = inp.dataset.payers.split(',').filter(Boolean);
      const role = inp.classList.contains('tsumo-oya') ? '庄家/亲' : inp.classList.contains('tsumo-koha') ? '闲家/子' : '闲家';
      payers.forEach((nm) => {
        const pl = game.players.find((p) => p.name === nm);
        rows.push({ name: nm, wind: pl ? pl.wind : '', amt: v, role });
      });
    });
    if (!any || rows.length === 0) return null;
    // 求和自摸者应收（不含本场，本场在 finalize 时统一加算）
    const totalRecv = rows.reduce((s, r) => s + r.amt, 0);
    return { rows, recvName: tsumoPlayer.name, totalRecv };
  }

  function bindTsumoConfirm() {
    // 「点数计算（番符表）」：打开番符表并按本笔自摸者锁定座位，关闭后按闲/庄分类回填应付额
    $('#btn-tsumo-calc').addEventListener('click', openCalcForTsumo);
    // 「确认结算」：读输入层 → 组装各笔转移 → 直接入账（不再经过核对明细弹窗）
    $('#btn-tsumo-confirm').addEventListener('click', () => {
      if (!tsumoPlayer) return;
      const draft = collectTsumoDraft();
      if (!draft) { toast('请填写应付额（至少一家需大于 0）'); return; }
      draft.rows.forEach((r) => {
        settleQueue.push({
          transfers: [
            { player: r.name, delta: -r.amt },
            { player: tsumoPlayer.name, delta: +r.amt },
          ],
          receiverName: tsumoPlayer.name,
          payerName: r.name,
        });
      });
      closeModal('modal-tsumo-amounts');
      finalizeSettlement();
    });
  }

  function renderPayPick() {
    const cont = $('#pay-pick');
    cont.innerHTML = '';
    game.players.forEach((p) => {
      const div = document.createElement('div');
      div.className = 'p';
      div.innerHTML = `<div class="wind">${p.wind}</div><div class="name">${escapeHtml(p.name)}</div>`;
      div.addEventListener('click', () => {
        settlePayer = p;
        // 进入选收分对象
        renderRecvPick(p.name);
        openModal('modal-settle-recv');
        closeModal('modal-settle-pay');
      });
      cont.appendChild(div);
    });
  }

  let settlePayer = null;

  /**
   * 渲染"选收分人（和牌者）"列表。
   * 一炮多响（multiRon）语义：放铳者唯一（=payerName），可有多个和牌者收分。
   * 因此收分人候选必须排除：放铳者本人、以及已经收过分（已录入 settleQueue）的和牌者，
   * 以避免把付分人选错、或让同一和牌者重复收分。
   * @param {string} payerName 放铳者（付分人）名，多响时由第一笔固定，不可重选
   * @returns {boolean} 是否存在可选收分人
   */
  function renderRecvPick(payerName) {
    const cont = $('#recv-pick');
    cont.innerHTML = '';
    // 已经收过分（已录入队列）的和牌者，多响时不可再选
    const already = new Set(settleQueue.map((q) => q.receiverName));
    // 是否处于多响后续笔（settleQueue 已含同一放铳者的前序笔）
    const isMultiMore = settleQueue.length > 0 && settleQueue.some((q) => q.payerName === payerName);
    $('#recv-hint').textContent = isMultiMore
      ? `放铳者【${payerName}】本局还向哪位和牌者付分？`
      : payerName + ' 本局给谁付分？';
    let any = false;
    game.players.forEach((p) => {
      if (p.name === payerName) return;    // 不能收自己的分（付分人 ≠ 和牌者）
      if (already.has(p.name)) return;     // 已收过分的和牌者不可重复选
      any = true;
      const div = document.createElement('div');
      div.className = 'p';
      div.innerHTML = `<div class="wind">${p.wind}</div><div class="name">${escapeHtml(p.name)}</div>`;
      div.addEventListener('click', () => {
        settleReceiver = p;
        $('#settle-recv-name').textContent = p.wind + ' ' + p.name;
        $('#settle-amount').value = '';
        resetCalcLink(); // 清除上一次联动的残留（座位锁定/提示条）
        // 荣和本场加算提示：放铳者一人付 300×N（无自摸损，4人/3人均同），和牌者多收同额
        if (game.honba > 0) {
          $('#settle-amount-honba').style.display = 'block';
          $('#settle-amount-honba').textContent =
            `本场 ${game.honba} 本：此笔将自动含本场加算 +${honbaRonTotal(game.honba)} 点（${settlePayer.name} 多付，和牌者多收）`;
        } else {
          $('#settle-amount-honba').style.display = 'none';
        }
        openModal('modal-settle-amount');
        closeModal('modal-settle-recv');
      });
      cont.appendChild(div);
    });
    if (!any) {
      toast('所有其他玩家均已和牌收分，请点"没有"完成本局结算');
      return false;
    }
    return true;
  }

  let settleReceiver = null;

  function bindSettleAmount() {
    // 「点数计算（番符表）」：打开番符表并按本笔和牌者锁定座位，关闭后结果自动回填输入框
    $('#btn-settle-calc').addEventListener('click', openCalcForSettle);
    $('#btn-settle-confirm').addEventListener('click', () => {
      const amt = parseInt($('#settle-amount').value, 10);
      if (isNaN(amt) || amt <= 0) { toast('请输入有效的分数'); return; }
      if (!settlePayer || !settleReceiver) return;

      // 付分人减少，收分人增加
      const transfers = [
        { player: settlePayer.name, delta: -amt },
        { player: settleReceiver.name, delta: +amt },
      ];
      // 这里本局可能还有其他人之前已录入的转移（多响/多方）。简化：先单笔结算。
      // 应用结果（不推进局数——多响时会多次结算，最后一次结算才推进）
      // 我们用一个"临时 pending"机制：见下方 settleQueue
      settleQueue.push({ transfers, receiverName: settleReceiver.name, payerName: settlePayer.name });
      $('#settle-queue-count').textContent = '本局已有 ' + settleQueue.length + ' 位和牌者收分（放铳者：' + settlePayer.name + '）';

      if (game.opts.multiRon) {
        // 开启"允许一炮多响"：本局可能还有其他人付分，询问是否继续
        openModal('modal-settle-more');
        closeModal('modal-settle-amount');
      } else {
        // 未开启多响：即使一炮多响也由放铳者逆时针第一个和牌者收分，其他人被截胡，
        // 不存在"本局还有其他人付分"的情况，直接完成本局结算。
        closeModal('modal-settle-amount');
        finalizeSettlement();
      }
    });
  }

  // 多响/多次结算队列：同一局可能多次触发和牌结算
  let settleQueue = [];

  function bindSettleMore() {
    $('#btn-settle-more-yes').addEventListener('click', () => {
      // 一炮多响：放铳者已由第一笔确定，不可重选；直接进入"选下一位和牌者(收分人)"。
      const first = settleQueue[0];
      if (!first) { finalizeSettlement(); return; }
      settlePayer = game.players.find((p) => p.name === first.payerName) || null;
      if (!settlePayer) { finalizeSettlement(); return; }
      // 若无更多可收分和牌者，renderRecvPick 返回 false 并提示，保持询问框打开由用户点"没有"完成
      if (renderRecvPick(first.payerName) === false) return;
      openModal('modal-settle-recv');
      closeModal('modal-settle-more');
    });
    $('#btn-settle-more-done').addEventListener('click', () => {
      // 完成本局结算：汇总所有 pending，应用，推进局数
      finalizeSettlement();
    });
  }

  function finalizeSettlement() {
    if (settleQueue.length === 0) return;
    // 结算弹窗链可能在断线/丢操作权之前就打开了，这里挡住最后一步
    const block = operationBlockReason();
    if (block) { toast(block + '，本次结算未生效'); return; }
    // 关闭"是否还有其他人付分"询问弹窗，避免残留
    closeModal('modal-settle-more');
    // 汇总所有转移
    const allTransfers = settleQueue.flatMap((q) => q.transfers);
    // 收分对象（赢家集合）——用于连庄判定
    const winners = [...new Set(settleQueue.map((q) => q.receiverName))];
    // 放铳者（付分人）：取第一笔的付分人
    const payerName = settleQueue[0].payerName || null;

    // ---- 本场加算 ----
    // 荣和：放铳者一人承担本场费，无自摸损 → 无论几人局恒 300×N，归「离放铳者行牌次序
    //   最近的和牌者」（多响时由放铳者逆时针第一个和牌者收取全部，其余和牌者不拿本场）——与供托归属一致。
    // 自摸：每家(在场非自摸者)各付 100N，自摸者收 100N×在场其他家数；
    //   三人局缺北（自摸损）：仅 2 家各付 100N → 自摸者收 200N（而非荣和的 300N）。
    const honbaBonus = [];
    const N = game.honba;
    const kyotakuTo = (winners.length > 0)
      ? pickKyotakuReceiver(game, payerName, winners)
      : null; // 供托/本场（荣和）的共同归属：离放铳者最近（逆时针第一）的赢家
    if (N > 0 && winners.length > 0) {
      const perPlayer = honbaPerPlayer(N);               // 自摸每家承担 100N
      if (settleType === 'ron') {
        // 荣和：放铳者付 300N（4人/3人均同，荣和不存在自摸损）
        const total = honbaRonTotal(N);
        const whoRecv = kyotakuTo || winners[0]; // 兜底
        const whoPays = payerName || whoRecv;    // 无放铳者时兜底
        honbaBonus.push({ player: whoRecv, delta: +total });
        honbaBonus.push({ player: whoPays, delta: -total });
      } else {
        // 自摸：自摸者（第一个赢家）多收 100N×在场其他家，其余各家各付 100N
        const self = winners[0];
        const others = game.players.map((p) => p.name).filter((n) => n !== self);
        if (self && others.length > 0) {
          const total = perPlayer * others.length; // 整除：3人(缺北2家)=200N、4人=300N
          honbaBonus.push({ player: self, delta: +total });
          others.forEach((n) => honbaBonus.push({ player: n, delta: -perPlayer }));
        }
      }
    }
    const allTransfersBonus = allTransfers.concat(honbaBonus);

    // 检查平衡（含本场加算后）
    const { balanced, diff } = Rules.checkBalance(allTransfersBonus);
    settleQueue = [];

    // 本局供托金额（applyRoundResult 会将其清零，故在此先取）
    const kyotakuAmount = (kyotakuTo && game.kyotaku > 0) ? game.kyotaku : 0;

    // 计算分数
    const prePoints = {};
    game.players.forEach((p) => { prePoints[p.name] = p.points; });
    // 本局立直者（applyRoundResult 会清空立直标记，须先取）
    const riichiNames = currentRiichiNames();

    const result = {
      type: settleType,        // 'ron' | 'tsumo'
      winners,
      transfers: allTransfersBonus,  // 含本场加算
      kyotakuTo,
      kyotakuAmount,           // 本局收取的供托金额
      balanceDiff: diff,
      honbaBonusCount: honbaBonus.length,
    };

    if (!balanced) {
      // 强度1：提示差额，但允许继续
      result.balanceWarning = `本局分数不平衡，差额 ${diff} 点，请确认是否填错`;
    }

    const r = Rules.applyRoundResult(game, result);
    // 结算后保存
    commitGame();
    notifyTagPush(false);  // 局结算 → 场风盘自动推送（节流）

    if (!balanced) {
      toast(result.balanceWarning);
    } else {
      toast(r.msg);
    }

    // 显示结果详情弹窗
    $('#result-warning').textContent = result.balanceWarning || '';
    $('#result-warning').style.display = result.balanceWarning ? 'block' : 'none';
    // 本场加算提示
    if (honbaBonus.length > 0) {
      const self = settleType === 'ron' ? winners.join('、') : winners[0];
      $('#result-honba').style.display = 'block';
      $('#result-honba').textContent =
        (settleType === 'ron' ? '荣和' : '自摸') + `：本场 ${N} 本，本场加算 ${
          settleType === 'ron'
            ? honbaRonTotal(N)
            : honbaPerPlayer(N) * (game.players.length - 1)
        } 点（和牌者收）`;
    } else {
      $('#result-honba').style.display = 'none';
    }
    // 供托收入提示
    const kyotakuEl = $('#result-kyotaku');
    if (kyotakuAmount > 0) {
      kyotakuEl.style.display = 'block';
      kyotakuEl.textContent = `供托收入：${kyotakuTo} 收取 ${kyotakuAmount} 点供托（已并入其分数）`;
    } else {
      kyotakuEl.style.display = 'none';
    }
    // 展示用的转移：含本场加算 + 供托收入（使各玩家 delta 与最终分数一致）
    const displayTransfers = kyotakuAmount > 0
      ? allTransfersBonus.concat([{ player: kyotakuTo, delta: +kyotakuAmount }])
      : allTransfersBonus;
    renderResultPlayers(displayTransfers, riichiNames);
    openModal('modal-result');
    renderMain();
    // 结算完成，释放操作权（平权：房主/成员都可能在持有）
    if (window.Net && Net.isInRoom() && Net.amOperator()) Net.releaseAction();
  }

  /**
   * 多响时确定供托收取者：从放铄者起，逆时针方向第一个和牌者。
   * 放铄者 = payerName；逆时针方向 = players 数组中的下一位（next）。
   * @returns {string|null} 收取供托的玩家名
   */
  function pickKyotakuReceiver(game, payerName, winners) {
    if (winners.length === 0) return null;
    // 无放铄者（如自摸），默认给第一个赢家
    if (!payerName) return winners[0];
    const payerIdx = game.players.findIndex((p) => p.name === payerName);
    const n = game.players.length;
    // 从放铄者的下家开始，顺时针找第一个赢家
    for (let step = 1; step <= n; step++) {
      const idx = (payerIdx + step) % n;
      if (winners.includes(game.players[idx].name)) {
        return game.players[idx].name;
      }
    }
    return winners[0]; // 兜底
  }

  // 结算弹窗 delta 的口径与逐局记录保持一致：立直者补记 -1000
  // （立直款在 doRiichi 时就已扣除，不体现在 transfers 里；结算后立直标记会被
  //  applyRoundResult 清空，故必须在调用它之前先取好名单）。
  function currentRiichiNames() {
    return (game && Array.isArray(game.players))
      ? game.players.filter((p) => p.riichi).map((p) => p.name)
      : [];
  }

  function renderResultPlayers(transfers, riichiNames) {
    const riichiSet = new Set(riichiNames || []);
    const cont = $('#result-players');
    cont.innerHTML = '';
    game.players.forEach((p) => {
      // 累加该玩家所有转移的净变化（自摸/多响时同一玩家可能有多笔）
      let delta = transfers
        .filter((x) => x.player === p.name)
        .reduce((s, x) => s + (x.delta || 0), 0);
      if (riichiSet.has(p.name)) delta -= 1000; // 本局立直扣款
      const div = document.createElement('div');
      div.className = 'list-item';
      div.innerHTML = `
        <div class="players">${escapeHtml(p.name)}：${p.points}点
        <span style="color:${delta>=0?'#1E9E63':'#D94F3D'}">(${delta>0?'+':''}${delta})</span></div>`;
      cont.appendChild(div);
    });
  }

  // ============ 操作：流局 ============
  function bindFlow() {
    $('#flow-koei').addEventListener('click', () => {
      // 荒牌流局：勾选听牌者
      openModal('modal-flow-koei');
      renderTanyouPick();
      closeModal('modal-flow');
    });
    $('#flow-other').addEventListener('click', () => {
      // 其他流局：无分，直接推进
      // 立直款仍需计入本局变化（立直者本局 -1000），故结算前先取名单
      const riichiNames = currentRiichiNames();
      const result = {
        type: 'ryukyoku',
        winners: [],
        transfers: [],       // 无分
        kyotakuTo: null,     // 无人收，供托继承
        tanyou: [],          // 无听牌者，庄家必换庄
      };
      const r = Rules.applyRoundResult(game, result);
      commitGame();
      notifyTagPush(false);  // 流局结算 → 场风盘自动推送（节流）
      toast(r.msg);
      closeModal('modal-flow');
      renderMain();
      // 显示流局结果
      $('#result-warning').textContent = '';
      $('#result-warning').style.display = 'none';
      $('#result-honba').textContent = '其他流局（无分数转移）';
      $('#result-honba').style.display = 'block';
      $('#result-kyotaku').style.display = 'none';
      renderResultPlayers([], riichiNames);
      openModal('modal-result');
    });
  }

  // 未听罚符（荒牌流局）总转移分数：三人模式 2000 点，四人模式 3000 点
  function notenBappuTotal() {
    return game.players.length === 3 ? 2000 : 3000;
  }

  function renderTanyouPick() {
    const cont = $('#tanyou-pick');
    cont.innerHTML = '';
    const total = notenBappuTotal();
    $('#tanyou-hint').textContent = '荒牌流局：勾选所有听牌的玩家（总转移 ' + total + ' 点）';
    $('#btn-koei-confirm').textContent = '确认流局（总转移' + total + '）';
    game.players.forEach((p) => {
      const div = document.createElement('div');
      div.className = 'p';
      div.innerHTML = `<div class="wind">${p.wind}</div><div class="name">${escapeHtml(p.name)}</div>`;
      div.dataset.name = p.name;
      div.addEventListener('click', () => {
        div.classList.toggle('selected');
      });
      cont.appendChild(div);
    });
  }

  function bindFlowKoei() {
    $('#btn-koei-confirm').addEventListener('click', () => {
      const tanyou = [...document.querySelectorAll('#tanyou-pick .p.selected')].map((d) => d.dataset.name);
      if (tanyou.length === 0) { toast('请至少勾选一名听牌者，或选择"其他流局"'); return; }

      // 荒牌流局（未听罚符）：总转移固定（三人 2000 点 / 四人 3000 点）。
      // 规则：只要不是"全部听牌"也不是"无人听牌"，听牌者合计收 total、未听者合计付 total。
      // - 全部听牌 或 无人听牌：无分数转移（0）。
      // - 其余情形：total 由听牌者平分收、未听者平分付。
      const all = game.players.map((p) => p.name);
      const notTanyou = all.filter((n) => !tanyou.includes(n));
      const transfers = [];

      if (notTanyou.length === 0) {
        // 全部听牌：无转移（无人未听，听牌者之间不结算）
      } else {
        const total = notenBappuTotal();
        const perTenpai = total / tanyou.length;   // 每位听牌者收
        const perNoten = total / notTanyou.length; // 每位未听者付
        notTanyou.forEach((n) => transfers.push({ player: n, delta: -perNoten }));
        tanyou.forEach((n) => transfers.push({ player: n, delta: +perTenpai }));
      }

      const result = {
        type: 'ryukyoku',
        winners: [],
        transfers,
        kyotakuTo: null,
        tanyou,
      };
      // 本局立直者（须在 applyRoundResult 清空立直标记前取，用于弹窗补记 -1000）
      const riichiNames = currentRiichiNames();
      const r = Rules.applyRoundResult(game, result);
      commitGame();
      notifyTagPush(false);  // 流局结算 → 场风盘自动推送（节流）
      toast(r.msg);
      closeModal('modal-flow-koei');
      renderMain();
      // 显示荒牌流局结果：转移明细（听牌者各+total，未听者均摊）
      $('#result-warning').textContent = '';
      $('#result-warning').style.display = 'none';
      $('#result-honba').textContent =
        '荒牌流局：听牌者 ' + tanyou.join('、') + ' 收分、未听者付分（总转移 ' + notenBappuTotal() + ' 点）';
      $('#result-honba').style.display = 'block';
      $('#result-kyotaku').style.display = 'none';
      renderResultPlayers(transfers, riichiNames);
      openModal('modal-result');
    });
  }

  // ============ 操作：手动修正 ============
  function renderAdjustPick() {
    const cont = $('#adjust-pick');
    cont.innerHTML = '';
    game.players.forEach((p) => {
      const div = document.createElement('div');
      div.className = 'p';
      div.innerHTML = `<div class="wind">${p.wind}</div><div class="name">${escapeHtml(p.name)}</div><div class="pts">${p.points}点</div>`;
      div.addEventListener('click', () => {
        adjustTarget = p;
        $('#adjust-name').textContent = p.wind + ' ' + p.name;
        $('#adjust-delta').value = '';
        openModal('modal-adjust-amount');
        closeModal('modal-adjust-score');
      });
      cont.appendChild(div);
    });
  }

  let adjustTarget = null;
  function bindAdjustAmount() {
    $('#btn-adjust-confirm').addEventListener('click', () => {
      const delta = parseInt($('#adjust-delta').value, 10);
      if (isNaN(delta) || delta === 0) { toast('请输入有效的增减分数'); return; }
      const r = Rules.manualAdjust(game, adjustTarget.name, delta);
      toast(r.msg);
      commitGame();
      closeModal('modal-adjust-amount');
      renderMain();
      checkTotalScore(); // 手动修正后立即重新校验总分（横幅随修正结果更新）
    });
  }

  // ============ 手动修正：类型面板 + 各类子流程 ============
  // 选定的目标局（所在局修正）
  let adjustRoundTarget = null;

  function bindAdjustType() {
    // —— ① 修正分数 ——
    $('#btn-adjust-type-score').addEventListener('click', () => {
      closeModal('modal-adjust');
      renderAdjustPick();
      openModal('modal-adjust-score');
    });

    // —— ② 修正所在局 ——
    $('#btn-adjust-type-round').addEventListener('click', () => {
      closeModal('modal-adjust');
      renderAdjustRound();
      openModal('modal-adjust-round');
    });
    $('#btn-round-confirm').addEventListener('click', () => {
      if (!adjustRoundTarget) { toast('请先选择目标局'); return; }
      const r = Rules.adjustRound(game, adjustRoundTarget.wind, adjustRoundTarget.num);
      toast(r.msg);
      commitGame();
      closeModal('modal-adjust-round');
      renderMain();
      checkTotalScore();
    });

    // —— ③ 修正本场数 ——
    $('#btn-adjust-type-honba').addEventListener('click', () => {
      closeModal('modal-adjust');
      renderAdjustHonba();
      openModal('modal-adjust-honba');
    });
    $('#btn-honba-confirm').addEventListener('click', () => {
      const v = parseInt($('#adjust-honba-value').value, 10);
      if (isNaN(v) || v < 0 || v > 20) { toast('请输入 0~20 的本场数'); return; }
      // 二次确认：提示对后续结算的影响
      confirmDialog(
        '确认修改本场数',
        `将本场数由 ${game.honba} 改为 ${v}？\n此后每笔和牌结算将按新本场数自动加算：荣和放铳者付 300 点/本（无自摸损，${game.mode === 3 ? '3人与4人相同' : '各家'}）；自摸各付 100 点/本，自摸者共收 ${game.mode === 3 ? '200' : '300'} 点/本（${game.mode === 3 ? '3人缺北自摸损' : '3家支付'}）。此前已结算局不追溯。`,
        () => {
          const r = Rules.setHonba(game, v);
          toast(r.msg);
          commitGame();
          closeModal('modal-adjust-honba');
          renderMain();
          checkTotalScore();
        }
      );
    });

    // —— ④ 修正供托点 ——
    $('#btn-adjust-type-kyotaku').addEventListener('click', () => {
      closeModal('modal-adjust');
      renderAdjustKyotaku();
      openModal('modal-adjust-kyotaku');
    });
    $('#btn-kyotaku-minus').addEventListener('click', () => {
      const cur = parseInt($('#adjust-kyotaku-value').value, 10);
      const base = isNaN(cur) ? game.kyotaku : cur;
      $('#adjust-kyotaku-value').value = Math.max(0, base - 1000);
    });
    $('#btn-kyotaku-plus').addEventListener('click', () => {
      const cur = parseInt($('#adjust-kyotaku-value').value, 10);
      const base = isNaN(cur) ? game.kyotaku : cur;
      $('#adjust-kyotaku-value').value = Math.min(20000, base + 1000);
    });
    $('#btn-kyotaku-confirm').addEventListener('click', () => {
      const v = parseInt($('#adjust-kyotaku-value').value, 10);
      if (isNaN(v) || v < 0 || v > 20000) { toast('请输入 0~20000 的供托点数'); return; }
      const payer = $('#adjust-kyotaku-payer').value;
      if (!payer) { toast('请选择承担差额的玩家'); return; }
      const r = Rules.adjustKyotaku(game, v, payer);
      toast(r.msg);
      commitGame();
      closeModal('modal-adjust-kyotaku');
      renderMain();
      checkTotalScore();
    });
  }

  /** 渲染「修正所在局」：列出可选目标局，选中后预览重排后的庄家与各家方位 */
  function renderAdjustRound() {
    const perWind = game.mode === 3 ? 3 : 4;
    $('#adjust-round-current').textContent = `${game.round.wind}${game.round.num}局`;
    const grid = $('#round-pick-grid');
    grid.innerHTML = '';
    // 局数网格按玩家人数定列（三/四），对应每场局数
    grid.style.gridTemplateColumns = `repeat(${perWind}, 1fr)`;
    adjustRoundTarget = null;
    $('#btn-round-confirm').disabled = true;
    $('#adjust-round-preview').style.display = 'none';
    ['东', '南', '西'].forEach((wind) => {
      for (let num = 1; num <= perWind; num++) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'round-cell';
        cell.textContent = `${wind}${num}局`;
        cell.dataset.wind = wind;
        cell.dataset.num = num;
        if (wind === game.round.wind && num === game.round.num) cell.classList.add('cur');
        cell.addEventListener('click', () => {
          grid.querySelectorAll('.round-cell').forEach((c) => c.classList.remove('selected'));
          cell.classList.add('selected');
          adjustRoundTarget = { wind, num };
          // 预览：目标局庄家及各玩家重排后的方位（不改动分数，仅展示）
          const dIdx = Rules.dealerIndexForRound(game, wind, num);
          const seatMap = ['东', '南', '西', '北'];
          const newWinds = game.players.map((_, i) => {
            const off = (i - dIdx + game.players.length) % game.players.length;
            return seatMap[off];
          });
          const dealerName = game.players[dIdx].name;
          $('#adjust-round-preview').innerHTML =
            `修正后：${wind}${num}局 · 庄家= ${dealerName}（坐东）` +
            `<div style="font-size:12px;margin-top:4px">` +
            game.players.map((p, i) => `${p.wind}${p.name} → ${newWinds[i]}`).join('　') +
            `</div>`;
          $('#adjust-round-preview').style.display = 'block';
          $('#btn-round-confirm').disabled = false;
        });
        grid.appendChild(cell);
      }
    });
  }

  /** 渲染「修正本场数」 */
  function renderAdjustHonba() {
    $('#adjust-honba-current').textContent = `当前本场 ${game.honba} 本`;
    $('#adjust-honba-value').value = game.honba;
  }

  /** 渲染「修正供托点」 */
  function renderAdjustKyotaku() {
    $('#adjust-kyotaku-current').textContent = `当前供托 ${game.kyotaku} 点`;
    $('#adjust-kyotaku-value').value = game.kyotaku;
    const sel = $('#adjust-kyotaku-payer');
    sel.innerHTML = '';
    game.players.forEach((p) => {
      const o = document.createElement('option');
      o.value = p.name;
      o.textContent = `${p.wind} ${p.name}（${p.points}点）`;
      sel.appendChild(o);
    });
  }

  // ============ 操作：结束对局 ============
  function bindEnd() {
    // 真正的"结束并保存"逻辑（供托已为 0 时才执行）
    function doArchiveGame() {
      // 全提交制：结束对局也要上行（服务器据此清空权威态并通知成员），断线时不允许本地归档
      const block = operationBlockReason();
      if (block) { toast(block + '，暂时无法结束对局'); return; }
      const rec = Storage.archiveGame(game);
      Storage.clearActive();
      game = null;
      if (window.Net) Net.endGame(rec); // 通知手机端同步结束并跳转历史页
      closeModal('modal-end');
      showPage('page-history');
      renderHistory();
      toast('对局已结束并保存到历史');
    }

    $('#btn-end-confirm').addEventListener('click', () => {
      // 若场上仍存在剩余供托（立直棒未归入任何玩家），各玩家分数总和无法等于该模式总分，
      // 直接保存会产生对不上账的历史记录。此时拦截并引导先修正供托点。
      if (game && game.kyotaku > 0) {
        $('#end-kyotaku-msg').textContent =
          `当前供托池还剩 ${game.kyotaku} 点（立直棒），尚未归入任何玩家。` +
          `此时保存，各玩家分数总和将不等于${game.mode === 3 ? '105000' : '100000'}。` +
          `请先修正供托点，将剩余供托归入玩家后再结束保存。`;
        closeModal('modal-end'); // 关闭"结束对局"，改由提示弹窗接管（关闭/修正后回到对局界面）
        openModal('modal-end-kyotaku');
        return;
      }
      doArchiveGame();
    });
    // 弹窗：进入现有"修正供托点"功能（确认后回到对局主界面，玩家可再次结束保存）
    $('#btn-end-fix-kyotaku').addEventListener('click', () => {
      closeModal('modal-end-kyotaku');
      renderAdjustKyotaku();
      openModal('modal-adjust-kyotaku');
    });
    // 弹窗：仅关闭，返回对局主界面，不结束对局
    $('#btn-end-kyotaku-close').addEventListener('click', () => {
      closeModal('modal-end-kyotaku');
    });
    $('#btn-end-history').addEventListener('click', () => {
      closeModal('modal-end');
      showPage('page-history');
      renderHistory();
    });
  }

  // ============ 历史记录页 ============
  function renderHistory() {
    const list = Storage.getFinishedList();
    const cont = $('#history-list');
    cont.innerHTML = '';
    if (list.length === 0) {
      cont.innerHTML = '<div class="empty-state"><span class="empty-riichi" aria-hidden="true"><span class="er-bar"></span></span>还没有完成的对局记录，开一局试试。</div>';
      return;
    }
    list.forEach((g) => {
      const div = document.createElement('div');
      div.className = 'list-item';
      div.innerHTML = `
        <div class="top"><span class="mode">${g.mode === 3 ? '三人' : '四人'}麻将</span>
        <span>${new Date(g.finishedAt).toLocaleString()}</span></div>
        <div class="players">
          ${g.players.map((p) => `${escapeHtml(p.name)}:<b>${p.points}</b>`).join('　')}
        </div>
        <div style="font-size:11px;color:#8A979E;margin-top:4px">${escapeHtml(g.endReason)}</div>`;
      div.addEventListener('click', () => viewHistoryDetail(g.id));
      cont.appendChild(div);
    });
  }

  // 当前正在查看详情的历史记录 id（供删除按钮使用）
  let detailGameId = null;

  function viewHistoryDetail(id) {
    const list = Storage.getFinishedList();
    const g = list.find((x) => x.id === id);
    if (!g) return;
    detailGameId = id;
    // 原型：弹窗展示详情
    $('#detail-title').textContent = (g.mode === 3 ? '三人' : '四人') + '麻将对局详情';
    let html = `<div class="notice ok">${escapeHtml(g.endReason)}</div>`;
    // 最终结果摘要（保留原有：各玩家最终分数）
    html += `<div class="card"><div class="detail-sec-title">最终结果</div>`;
    g.players.forEach((p) => {
      html += `<div class="players">${escapeHtml(p.name)}：${p.points}点</div>`;
    });
    html += `</div>`;
    // 逐局分数记录：取该半庄内各次结算快照上的 .hand 记录（时间正序）
    const records = (Array.isArray(g.history) ? g.history : [])
      .filter((s) => s && s.hand)
      .map((s) => s.hand);
    html += `<div class="card">`;
    if (records.length === 0) {
      html += `<div class="detail-sec-title">逐局分数记录</div>`;
      html += `<div class="hint">该对局无可展示的逐局记录。</div>`;
    } else {
      html += `<div class="detail-sec-title">逐局分数记录（共 ${records.length} 局，按时间先后）</div>`;
      // 时间正序：history 按下标即发生先后，最旧在 records[0]、最新在末尾
      records.forEach((rec) => { html += handRecordHtml(rec); });
    }
    html += `</div>`;
    $('#detail-body').innerHTML = html;
    openModal('modal-detail');
  }

  // ============ 绑定所有 ============
  // ============ 场风盘蓝牙控制页（page-eink） ============
  // 原生 → JS 状态回调入口（MainActivity.evaluateJavascript 调用；浏览器/jsdom 中不触发）
  let einkScanning = false;

  /** 推图日志留屏：原生日志以前只走 toast，一闪就没，故障时等于没有日志 */
  function einkLog(msg, cls) {
    const box = $('#eink-log');
    if (!box || !msg) return;
    const ln = document.createElement('span');
    ln.className = 'ln' + (cls ? ' ' + cls : '');
    ln.textContent = msg;
    box.appendChild(ln);
    while (box.children.length > 200) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }
  function einkLogClear() {
    const box = $('#eink-log');
    if (box) box.innerHTML = '';
  }
  /** 自检按钮只在已连接时可用 */
  function syncEinkSelfTest(connected) {
    const c = $('#btn-eink-clear'), t = $('#btn-eink-test'), f = $('#btn-eink-fixpins');
    if (c) c.disabled = !connected;
    if (t) t.disabled = !connected;
    if (f) f.disabled = !connected;
  }

  /**
   * 连接进行中：锁住「直连」入口。
   * 系统侧一次连接最久要等 30 秒才报超时，期间页面上原本**毫无变化** ——
   * 用户点完直连只会觉得"按钮坏了"。所以：状态栏立刻变「正在连接…」，入口禁用，超时后明确报错。
   */
  function setEinkConnecting(on) {
    const b = $('#btn-eink-connect-addr');
    if (b) b.disabled = !!on;
    const i = $('#eink-manual-addr');
    if (i) i.disabled = !!on;
  }

  /**
   * 扫描列表排序权重：命中场风盘(0) → 有名字(1) → 无名(2)。
   * 周围常年有十来个「（无名设备）」（手环/耳机/车机等随机地址设备），
   * 按到达顺序排会把真正想找的那一行淹掉。
   */
  function einkRank(it) {
    if (it.dataset.hit === '1') return 0;
    return it.dataset.named === '1' ? 1 : 2;
  }
  /** 按权重把节点插到「同权重之后、下一个更高权重之前」，同类内保持到达顺序 */
  function einkPlace(item) {
    const list = $('#eink-scan-list');
    if (!list) return;
    const r = einkRank(item);
    let ref = null;
    for (let i = 0; i < list.children.length; i++) {
      const c = list.children[i];
      if (c === item) continue;
      if (einkRank(c) > r) { ref = c; break; }
    }
    if (ref) list.insertBefore(item, ref);
    else list.appendChild(item);
  }
  /** 列表上方的一行统计：让"扫到 15 个但没有场风盘"和"一个都没扫到"一眼能分开 */
  function renderScanCount() {
    const list = $('#eink-scan-list'), el = $('#eink-scan-count');
    if (!list || !el) return;
    const kids = list.children;
    let named = 0, hits = 0;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].dataset.hit === '1') hits++;
      if (kids[i].dataset.named === '1') named++;
    }
    if (kids.length === 0) { el.textContent = ''; return; }
    el.textContent = '共 ' + kids.length + ' 个设备：有名字 ' + named
      + '，无名 ' + (kids.length - named)
      + (hits ? '，★ 场风盘 ' + hits + ' 个' : '，未发现场风盘');
  }

  window.EinkNative = {
    onStatus: function (type, data) {
      const st = $('#eink-status');
      if (type === 'scanning') {
        einkScanning = true;
        if (st) st.textContent = '扫描中…（再次点击可提前停止；若设备未开蓝牙常开，请先按一下设备蓝牙键）';
        const btn = $('#btn-eink-connect');
        if (btn) btn.textContent = '停止扫描';
        const list = $('#eink-scan-list');
        if (list) list.innerHTML = '';
        renderScanCount();
        einkLog('开始扫描蓝牙设备…');
      } else if (type === 'scan') {
        let dev = null;
        try { dev = JSON.parse(data); } catch (e) { return; }
        const list = $('#eink-scan-list');
        if (!list || !dev || !dev.addr) return;
        // ⚠️ 同一设备会被**多次上报**：BLE 的 advertising data 与 scan response 是两个包，
        //    首个回调常常拿不到名字（此时原生侧报的是「（无名设备）」），名字要等带
        //    scan response 的那个回调才出现。所以这里必须**按地址 upsert**，不能无脑 append：
        //    否则同一设备会出现重复行，或者「（无名设备）」条目一直占位不更新 ——
        //    这正是"列表里全是无名设备、怎么都找不到场风盘"的成因。
        let item = null;
        for (let i = 0; i < list.children.length; i++) {
          if (list.children[i].dataset.addr === dev.addr) { item = list.children[i]; break; }
        }
        if (!item) {
          item = document.createElement('div');
          item.addEventListener('click', () => {
            if (!item.dataset.addr) return;
            if (window.NativeBridge && window.NativeBridge.einkConnectAddr) {
              window.NativeBridge.einkConnectAddr(item.dataset.addr);
              toast('正在连接 ' + (item.dataset.name || '设备') + ' …');
            }
          });
        }
        const nm = dev.name && dev.name !== '（无名设备）' ? dev.name : '（无名设备）';
        const prevRank = item.parentNode ? einkRank(item) : -1;
        item.dataset.addr = dev.addr;
        item.dataset.name = nm;
        item.dataset.named = nm === '（无名设备）' ? '0' : '1';
        item.dataset.hit = dev.hit ? '1' : '0';
        item.className = 'eink-scan-item' + (dev.hit ? ' hit' : '');
        item.innerHTML = '<span class="nm">' + escapeHtml(nm)
          + (dev.hit ? '<i class="tag">场风盘</i>' : '') + '</span>'
          + '<span class="meta">' + (typeof dev.rssi === 'number' ? dev.rssi : '?') + ' dBm</span>';
        // 权重变了才重排（否则每来一个同名广播都把节点搬一次，无名设备之间会互相扰动）
        if (!item.parentNode || einkRank(item) !== prevRank) einkPlace(item);
        renderScanCount();
      } else if (type === 'scan-done') {
        einkScanning = false;
        const btn = $('#btn-eink-connect');
        if (btn) btn.textContent = '扫描并连接场风盘';
        renderScanCount();
        const list = $('#eink-scan-list');
        const found = list ? list.children.length : 0;
        const hits = list ? list.querySelectorAll('.eink-scan-item.hit').length : 0;
        if (st) {
          if (found === 0) st.textContent = '未发现任何蓝牙设备';
          else if (hits === 0) st.textContent = '发现 ' + found + ' 个蓝牙设备（疑似场风盘 0 个）';
          else st.textContent = '发现场风盘，点击列表项连接';
        }
        // 明确区分「一个设备都没扫到」和「扫到了但都不像场风盘」——旧版一律提示"未发现场风盘"，
        // 会把"设备没广播""权限没给""被过滤器滤掉"这几种完全不同的故障混成一团
        if (found === 0) {
          einkLog('未发现任何蓝牙设备。请检查：① 墨水屏已按蓝牙键激活（或已开蓝牙常开）；'
            + '② 手机系统蓝牙已打开；③ 已授予「附近的设备」权限。', 'warn');
        } else if (hits === 0) {
          einkLog('扫描本身正常（收到 ' + found + ' 个广播），但没有场风盘 —— 问题在设备侧：'
            + '① 长按墨水屏按键直到指示灯亮（默认蓝牙是关的，勾了「蓝牙常开」则免按键）；'
            + '② 按键后 120 秒内扫描，超时需重新按键；'
            + '③ 微信小程序若还连着该设备，设备会停止广播，先在小程序里断开再扫。', 'warn');
        } else {
          einkLog('本次发现 ' + found + ' 个蓝牙设备，其中场风盘 ' + hits + ' 个。', 'ok');
        }
        // 连接成功时状态由 connected 事件覆盖
      } else if (type === 'connecting') {
        // 系统侧建连最长 30 秒，期间必须有可见状态，否则「点了直连没反应」
        if (st) st.textContent = '正在连接 ' + data + ' …（最长等 30 秒）';
        setEinkConnecting(true);
        einkConnected = false; syncPushQrBtn();
        einkLog('正在连接 ' + data + ' …');
      } else if (type === 'connect-fail') {
        if (st) st.textContent = '连接失败：' + data;
        setEinkConnecting(false);
        einkConnected = false; syncPushQrBtn();
        einkLog('连接失败：' + data, 'warn');
      } else if (type === 'connect-giveup') {
        setEinkConnecting(false);
        einkConnected = false; syncPushQrBtn();
      } else if (type === 'connected') {
        if (st) st.textContent = '已连接：' + data;
        const btnScan = $('#btn-eink-connect');
        if (btnScan) btnScan.textContent = '扫描并连接场风盘';
        const btnC = $('#btn-eink-connect'), btnD = $('#btn-eink-disconnect');
        if (btnC) btnC.style.display = 'none';
        if (btnD) btnD.style.display = '';
        setEinkConnecting(false);
        const list = $('#eink-scan-list');
        if (list) list.innerHTML = '';
        renderScanCount();
        syncEinkSelfTest(true);
        einkConnected = true; syncPushQrBtn();   // 首页「推送二维码」按钮解除置灰
        // 不清日志：连接过程的历史（重试、失败原因）是排查问题的唯一线索，
        // 以前一连上就清空，等于把线索擦掉
        einkLog('✅ 已连接：' + data + '（可推送）', 'ok');
      } else if (type === 'disconnected') {
        if (st) st.textContent = '未连接';
        einkScanning = false;
        setEinkConnecting(false);
        const btnC = $('#btn-eink-connect'), btnD = $('#btn-eink-disconnect');
        if (btnC) { btnC.style.display = ''; btnC.textContent = '扫描并连接场风盘'; }
        if (btnD) btnD.style.display = 'none';
        const sw = $('#switch-eink-always');
        if (sw) sw.classList.remove('on');
        syncEinkSelfTest(false);
        einkConnected = false; syncPushQrBtn();
      } else if (type === 'ble') {
        const sw = $('#switch-eink-always');
        if (sw) sw.classList.toggle('on', data === '1');
      } else if (type === 'pins-fixed') {
        toast('引脚配置已回写，请断开重连确认');
      } else if (type === 'devcfg') {
        // data = "<引脚串>|<驱动字节>"，设备自报。日志里已打印，这里只做异常提示。
        const parts = String(data || '').split('|');
        if (parts[0] && parts[0] !== '1413060504030207') {
          toast('注意：设备引脚配置异常，可点「修复引脚配置」');
        }
      } else if (type === 'log') {
        einkLog(data);
      } else if (type === 'push-status') {
        if (data === 'done') toast('场风盘已更新');
        else if (data === 'busy') einkLog('上一次推送尚未结束，本次跳过', 'warn');
      }
    },
  };

  function bindEinkPage() {
    $('#btn-goto-eink').addEventListener('click', () => {
      showPage('page-eink');
      // 进入页面时：已记住设备则自动连接（原生侧处理）
      if (window.NativeBridge && window.NativeBridge.einkAutoConnect) {
        window.NativeBridge.einkAutoConnect();
      }
    });
    $('#btn-back-eink').addEventListener('click', () => showPage('page-mode'));
    $('#btn-eink-connect').addEventListener('click', () => {
      const b = window.NativeBridge;
      if (einkScanning) {          // 扫描中：同一按钮变为「停止扫描」
        if (b && b.einkStopScan) b.einkStopScan();
        return;
      }
      if (b && b.einkConnect) {
        b.einkConnect();           // 原生处理权限请求→扫描
      } else {
        toast('蓝牙推送仅支持在 APP 内使用');
      }
    });
    $('#btn-eink-disconnect').addEventListener('click', () => {
      if (window.NativeBridge && window.NativeBridge.einkDisconnect) window.NativeBridge.einkDisconnect();
    });
    // 蓝牙诊断：一键输出权限/蓝牙开关/扫描器/定位服务等扫描前提，日志区会留屏
    $('#btn-eink-diag').addEventListener('click', () => {
      const b = window.NativeBridge;
      if (b && b.einkDiagnose) { einkLogClear(); b.einkDiagnose(); }
      else toast('此功能需在 APP 内使用');
    });
    // 直接连接地址：绕过扫描的兜底路径。BLE 设备被别的 App 占用 / 广播已超时 / 系统层没把
    // 广播交给本 App 时，扫描必然失败；但只要知道 MAC 就能直接 GATT 连接。
    $('#btn-eink-connect-addr').addEventListener('click', () => {
      const inp = $('#eink-manual-addr');
      const raw = inp ? inp.value : '';
      const hex = String(raw || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
      if (hex.length !== 12) {
        einkLog('地址格式不对：需要 12 位十六进制 MAC（如 AA:BB:CC:DD:EE:FF），当前输入「' + raw + '」', 'warn');
        return;
      }
      const mac = hex.match(/../g).join(':');
      const b = window.NativeBridge;
      if (b && b.einkConnectAddr) {
        // 立刻给可见反馈：系统建连最长 30 秒才回结果，此前状态栏若不动，用户只会以为按钮失灵
        const st = $('#eink-status');
        if (st) st.textContent = '正在连接 ' + mac + ' …（最长等 30 秒）';
        einkLog('直接连接 ' + mac + ' …');
        b.einkConnectAddr(mac);
      } else {
        toast('此功能需在 APP 内使用');
      }
    });
    // 推图自检：清屏 / 测试图案（不依赖对局数据，用于验证整条推图链路）
    $('#btn-eink-clear').addEventListener('click', () => {
      const b = window.NativeBridge;
      if (b && b.einkClearPanel) b.einkClearPanel();
      else toast('此功能需在 APP 内使用');
    });
    $('#btn-eink-test').addEventListener('click', () => {
      const b = window.NativeBridge;
      if (b && b.einkTestPattern) b.einkTestPattern();
      else toast('此功能需在 APP 内使用');
    });
    // 修复引脚：把正确引脚串回写设备 flash（仅在引脚被写坏时用）
    $('#btn-eink-fixpins').addEventListener('click', () => {
      const b = window.NativeBridge;
      if (b && b.einkRepairPins) b.einkRepairPins();
      else toast('此功能需在 APP 内使用');
    });
    // 蓝牙常开开关：连接后才可操作；状态以设备回报（ble=0/1）为准
    $('#switch-eink-always').addEventListener('click', () => {
      const sw = $('#switch-eink-always');
      const bridge = window.NativeBridge;
      if (!bridge || !bridge.einkSetAlwaysOn) {
        toast('此功能需在 APP 内使用');
        return;
      }
      const turningOn = !sw.classList.contains('on');
      sw.classList.toggle('on', turningOn); // 乐观更新，设备回报（ble=）会纠正
      bridge.einkSetAlwaysOn(turningOn);
    });
  }

  function bindAll() {
    if (window.__appBound) return; // 幂等：避免 DOMContentLoaded 重复触发导致的重复绑定
    window.__appBound = true;
    bindModePage();
    bindSetupPage();
    bindMainPage();
    bindSettlement();
    bindSettleAmount();
    bindSettleMore();
    bindTsumoConfirm();
    bindFlow();
    bindFlowKoei();
    bindAdjustAmount();
    bindAdjustType();
    bindEnd();

    // 返回按钮：回到主菜单（模式选择页），保留当前对局（本地已持久化）
    $('#btn-back-main').addEventListener('click', () => {
      showPage('page-mode');
    });
    // 首页"继续当前对局"：回到进行中的对局主界面
    $('#btn-continue-game').addEventListener('click', () => {
      showMain();
    });
    // 新对局按钮：自定义确认弹窗，确认后清空当前对局并回模式选择
    $('#btn-new-game').addEventListener('click', () => {
      confirmDialog(
        '新对局',
        '确定要放弃当前进行中的对局并新开一局吗？当前对局进度将被清空，不会保存到历史记录。',
        () => {
          game = null;
          viewLock = null;
          viewSel = null;
          Storage.clearActive();
          showPage('page-mode');
        }
      );
    });
    // 通用确认弹窗按钮
    $('#btn-confirm-ok').addEventListener('click', confirmOk);
    $('#btn-confirm-cancel').addEventListener('click', confirmCancel);
    // 结算结果弹窗关闭（原先用内联 onclick，改为此处统一绑定，便于 jsdom 测试与维护）
    $('#btn-result-close').addEventListener('click', () => closeModal('modal-result'));
    $('#btn-new-game-history').addEventListener('click', () => {
      showPage('page-mode');
    });
    // 历史详情：删除本对局记录
    $('#btn-detail-delete').addEventListener('click', () => {
      if (!detailGameId) return;
      confirmDialog(
        '删除对局记录',
        '确定要删除这条对局记录吗？删除后不可恢复。',
        () => {
          Storage.deleteFinishedGame(detailGameId);
          detailGameId = null;
          closeModal('modal-detail');
          renderHistory();
          toast('对局记录已删除');
        }
      );
    });

    // 开关组件（蓝牙常开开关在下方单独绑定，需发命令+校验连接）
    document.querySelectorAll('.switch').forEach((sw) => {
      if (sw.id === 'switch-eink-always' || sw.id === 'switch-eink-fast') return; // 跳过，见 bindEinkPage
      sw.addEventListener('click', () => sw.classList.toggle('on'));
    });

    // ============ 场风盘蓝牙控制页 ============
    bindEinkPage();
    // 立即推送按钮
    $('#btn-tag-push').addEventListener('click', () => {
      notifyTagPush(true);  // 立即推送（不受节流限制）
      toast('已请求推送到场风盘');
    });
    // 首页「推送二维码到场风盘」（仅有二维码且已连场风盘时可点）
    const pushQrBtn = $('#btn-push-qr');
    if (pushQrBtn) pushQrBtn.addEventListener('click', onPushQrClick);

    // 切到后台时立刻释放摄像头（避免扫码弹窗还开着就把摄像头一直占着）
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && scanStream) closeModal('modal-scanqr');
    });

    // 启动
    init();
  }

  // 暴露少量全局函数供 HTML 内联调用
  window.closeModal = closeModal;
  window.showMode = () => showPage('page-mode');
  window.showMain = () => { if (game) { showPage('page-main'); renderMain(); } };

  // 加入他人房间（输入房主 IP 后跳转到对方页面，以成员身份加入）
  // setNavigate 供测试替换跳转出口，避免 jsdom 的 navigation 未实现报错
  window.JoinRoom = {
    normalize: normalizeJoinTarget,
    join: joinRemoteRoom,
    probe: probeRemoteServer,
    parseScan: parseScanPayload,   // 二维码文本 → 加入目标
    startScan: startQrScan,        // 打开扫码弹窗并启动摄像头
    stopScan: stopQrScan,          // 释放摄像头
    setNavigate: (fn) => {
      navHandler = typeof fn === 'function' ? fn : (url) => { window.location.href = url; };
    },
  };

  // 页面加载完成
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindAll);
  } else {
    bindAll();
  }
})();
