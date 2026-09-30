/* 场风盘推送模块（e-ink 板用，独立页面，不进 APP 主界面）
 *
 * BLE 协议来源：tsl0922/EPD-nRF5（开源，html/js/main.js + rle.js），已逐行核对：
 *   - Service  62750001-d828-918d-fb46-b6c11c675aec
 *   - EPD 特征 62750002-...（write + notify）
 *   - 版本特征 62750003-...（uint8，需 >= 0x16 才支持 WRITE_IMG=0x30）
 *   - 连接后第 1 条 notify = 设备自报配置（byte0-6 引脚 / byte7 驱动）；
 *     之后文本消息 "mtu=N"（可带 "rle=1"）
 *   - 三色传图：INIT(0x01) → WRITE_IMG 黑白面 → WRITE_IMG 红白面 → REFRESH(0x05)
 *     WRITE_IMG 载荷首字节为标志位（无 RLE 时）：黑白首块 0x0F / 后续 0xFF，
 *     红色首块 0x00 / 后续 0xF0；每块数据 = MTU-2 字节
 *   - 位图格式：1bpp，byteWidth=ceil(w/8)，行序、MSB 在前；1=白 0=黑（红面 0=红）
 *   - 三色量化阈值与官方一致：灰度 0.299/0.587/0.114，>=140 判白；r>160 且 r>g>r 判红
 *
 * ⚠️ Web Bluetooth 仅在安全上下文可用：须从 http://127.0.0.1:8765/tag.html 打开
 *    （房主手机 Chrome），WebView 内不可用。
 */
(function () {
  'use strict';

  const SERVICE_UUID = '62750001-d828-918d-fb46-b6c11c675aec';
  const EPD_UUID     = '62750002-d828-918d-fb46-b6c11c675aec';
  const VER_UUID     = '62750003-d828-918d-fb46-b6c11c675aec';

  const EpdCmd = {
    SET_PINS: 0x00, INIT: 0x01, CLEAR: 0x02, SEND_CMD: 0x03, SEND_DATA: 0x04,
    REFRESH: 0x05, SLEEP: 0x06, SET_TIME: 0x20, WRITE_IMG: 0x30,
    SET_CONFIG: 0x90, SYS_RESET: 0x91, SYS_SLEEP: 0x92, CFG_ERASE: 0x99,
  };

  /* ---------------- RLE（与官方 rle.js 逐字节一致） ---------------- */

  function rleCompress(data, maxLiteralSize) {
    maxLiteralSize = maxLiteralSize || 128;
    const input = data instanceof Uint8Array ? data : new Uint8Array(data);
    const result = [];
    let i = 0;
    while (i < input.length) {
      let runLen = 1;
      while (i + runLen < input.length && runLen < 130 && input[i + runLen] === input[i]) runLen++;
      if (runLen >= 3) {
        result.push(0x80 | (runLen - 3));
        result.push(input[i]);
        i += runLen;
      } else {
        const literalStart = i;
        let literalLen = 0;
        while (i < input.length && literalLen < maxLiteralSize) {
          if (i + 2 < input.length && input[i] === input[i + 1] && input[i] === input[i + 2]) break;
          literalLen++;
          i++;
        }
        if (literalLen === 0) {
          result.push(0x00);
          result.push(input[i++]);
        } else {
          result.push(literalLen - 1);
          for (let j = literalStart; j < literalStart + literalLen; j++) result.push(input[j]);
        }
      }
    }
    return new Uint8Array(result);
  }

  function rleCompressMTU(data, maxChunkSize) {
    const maxLit = Math.min(maxChunkSize - 1, 128);
    const input = rleCompress(data, maxLit);
    const chunks = [];
    let i = 0;
    let start = 0;
    while (i < input.length) {
      const control = input[i];
      const codeLen = (control & 0x80) ? 2 : (control + 2);
      if (i - start + codeLen > maxChunkSize && i > start) {
        chunks.push(input.slice(start, i));
        start = i;
      }
      i += codeLen;
    }
    if (i > start) chunks.push(input.slice(start, i));
    return chunks;
  }

  /* ---------------- 连接状态 ---------------- */

  const st = {
    device: null, gatt: null, char: null,
    msgIndex: 0, mtu: 20, rleSupport: false, appVersion: 0x16,
    connected: false, reconnectTimer: null,
  };
  let logFn = function () {};
  let statusFn = function () {};

  function hex2bytes(hex) {
    const bytes = [];
    for (let c = 0; c < hex.length; c += 2) bytes.push(parseInt(hex.substr(c, 2), 16));
    return new Uint8Array(bytes);
  }

  async function write(cmd, data, withResponse) {
    if (!st.char) { logFn('服务不可用，请检查蓝牙连接'); return false; }
    const payload = [cmd];
    if (data) {
      if (typeof data === 'string') data = hex2bytes(data);
      if (data instanceof Uint8Array) data = Array.from(data);
      payload.push(...data);
    }
    try {
      if (withResponse !== false) await st.char.writeValueWithResponse(Uint8Array.from(payload));
      else await st.char.writeValueWithoutResponse(Uint8Array.from(payload));
    } catch (e) {
      logFn('write: ' + (e && e.message ? e.message : e));
      return false;
    }
    return true;
  }

  function handleNotify(value) {
    const data = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (st.msgIndex === 0) {
      // 设备自报配置：byte0-6 引脚 / byte7 驱动（部分固件 byte10 为扩展引脚）
      let pins = '';
      for (let i = 0; i < 7 && i < data.length; i++) pins += ('0' + data[i].toString(16)).slice(-2);
      if (data.length > 10) pins += ('0' + data[10].toString(16)).slice(-2);
      st.pins = pins;
      if (data.length > 7) st.driver = ('0' + data[7].toString(16)).slice(-2);
      logFn('设备配置: pins=' + st.pins + ' driver=' + st.driver);
    } else {
      let msg = '';
      for (let i = 0; i < data.length; i++) msg += String.fromCharCode(data[i]);
      logFn('⇓ ' + msg);
      if (msg.indexOf('mtu=') === 0 && msg.length > 4) {
        st.mtu = parseInt(msg.substring(4));
        if (msg.indexOf('rle=1') >= 0) st.rleSupport = true;
        logFn('MTU=' + st.mtu + (st.rleSupport ? ' (RLE 支持)' : ''));
      }
    }
    st.msgIndex++;
  }

  async function doConnect() {
    try {
      st.gatt = await st.device.gatt.connect();
      const svc = await st.gatt.getPrimaryService(SERVICE_UUID);
      st.char = await svc.getCharacteristic(EPD_UUID);
    } catch (e) {
      logFn('connect: ' + (e && e.message ? e.message : e));
      resetVars();
      statusFn('disconnected');
      return false;
    }
    st.msgIndex = 0;
    st.mtu = 20;
    st.rleSupport = false;
    try {
      const verChar = await svc_get(st.gatt, VER_UUID);
      const verData = await verChar.readValue();
      st.appVersion = verData.getUint8(0);
      logFn('固件版本: 0x' + st.appVersion.toString(16));
      if (st.appVersion < 0x16) {
        logFn('!! 固件版本过低，不支持 WRITE_IMG(0x30)，请先 OTA 升级固件');
        statusFn('disconnected');
        return false;
      }
    } catch (e) {
      st.appVersion = 0x16; // 读不到版本号时按新版处理（与官方一致）
    }
    try {
      await st.char.startNotifications();
      st.char.addEventListener('characteristicvaluechanged', (ev) => handleNotify(ev.target.value));
    } catch (e) {
      logFn('startNotifications: ' + (e && e.message ? e.message : e));
    }
    st.connected = true;
    statusFn('connected');
    await write(EpdCmd.INIT);
    scheduleWatchdog();
    return true;
  }

  function svc_get(gatt, uuid) {
    return gatt.getPrimaryService(SERVICE_UUID).then((s) => s.getCharacteristic(uuid));
  }

  function resetVars() {
    st.gatt = null;
    st.char = null;
    st.msgIndex = 0;
    st.rleSupport = false;
    st.connected = false;
  }

  /* 断线自动重连（设备已授权过，无需再次手势；最多重试 5 次） */
  function scheduleWatchdog() {
    st.device.addEventListener('gattserverdisconnected', () => {
      resetVars();
      statusFn('disconnected');
      let tries = 0;
      const retry = () => {
        if (tries++ >= 5 || !st.device) return;
        logFn('蓝牙断开，自动重连 ' + tries + '/5 ...');
        setTimeout(async () => {
          if (st.connected) return;
          try { await doConnect(); } catch (e) { retry(); }
        }, 2000);
      };
      retry();
    });
  }

  async function connect() {
    if (!navigator.bluetooth) throw new Error('此浏览器不支持 Web Bluetooth（需 Chrome/Edge，且页面须从 127.0.0.1 或 https 打开）');
    resetVars();
    try {
      st.device = await navigator.bluetooth.requestDevice({
        optionalServices: [SERVICE_UUID],
        acceptAllDevices: true,
      });
    } catch (e) {
      logFn('requestDevice: ' + (e && e.message ? e.message : e));
      return false;
    }
    return doConnect();
  }

  /* ---------------- 三色量化（与官方 processImageData threeColor 分支一致） ---------------- */

  function quantizeThreeColor(imageData) {
    const width = imageData.width;
    const height = imageData.height;
    const data = imageData.data;
    const byteWidth = Math.ceil(width / 8);
    const bw = new Uint8Array(height * byteWidth);
    const red = new Uint8Array(height * byteWidth);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = (y * width + x) * 4;
        const r = data[index];
        const g = data[index + 1];
        const b = data[index + 2];
        const grayscale = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        const byteIndex = y * byteWidth + Math.floor(x / 8);
        const bitIndex = 7 - (x % 8);
        if (grayscale >= 140) bw[byteIndex] |= (0x01 << bitIndex);       // 白
        if (!(r > 160 && r > g && r > b)) red[byteIndex] |= (0x01 << bitIndex); // 非红=1，红=0
      }
    }
    return { bw: bw, red: red };
  }

  /* ---------------- 推图 ---------------- */

  async function writeImage(data, step) {
    const chunkSize = st.mtu - 2;
    let noReplyCount = 50; // 官方默认：每 50 块要一次回执
    const stepText = step === 'bw' ? '黑白面' : '红面';

    const rleChunks = st.rleSupport ? rleCompressMTU(data, chunkSize) : null;
    const rleLength = rleChunks ? rleChunks.reduce((t, c) => t + c.length, 0) : data.length;
    const useRle = st.rleSupport && rleLength < data.length;
    const totalChunks = useRle ? rleChunks.length : Math.ceil(data.length / chunkSize);

    for (let i = 0; i < totalChunks; i++) {
      const chunk = useRle ? rleChunks[i] : data.slice(i * chunkSize, i * chunkSize + chunkSize);
      const payload = [
        st.rleSupport
          ? (step === 'bw' ? 0x00 : 0x01) | (i === 0 ? 0x02 : 0x00) | (useRle ? 0x04 : 0x00)
          : (step === 'bw' ? 0x0F : 0x00) | (i === 0 ? 0x00 : 0xF0),
        ...chunk,
      ];
      if (noReplyCount > 0) {
        await write(EpdCmd.WRITE_IMG, payload, false);
        noReplyCount--;
      } else {
        await write(EpdCmd.WRITE_IMG, payload, true);
        noReplyCount = 50;
      }
      if (i % 100 === 0 || i === totalChunks - 1) statusFn('推送中 ' + stepText + ' ' + (i + 1) + '/' + totalChunks);
    }
  }

  /** 推送一个 canvas（须为 400×300，或开启旋转后 300×400） */
  async function pushCanvas(canvas, rotate) {
    if (!st.connected) throw new Error('蓝牙未连接');
    let src = canvas;
    if (rotate) {
      const tmp = document.createElement('canvas');
      tmp.width = canvas.height;
      tmp.height = canvas.width;
      const tctx = tmp.getContext('2d');
      tctx.translate(tmp.width / 2, tmp.height / 2);
      tctx.rotate(Math.PI / 2);
      tctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
      src = tmp;
    }
    const imageData = src.getContext('2d').getImageData(0, 0, src.width, src.height);
    const planes = quantizeThreeColor(imageData);
    statusFn('推送中...');
    await write(EpdCmd.INIT);
    await writeImage(planes.bw, 'bw');
    await writeImage(planes.red, 'red');
    await write(EpdCmd.REFRESH);
    statusFn('推送完成');
  }

  /* ---------------- 最小 WS 监听（哑终端，只听不发言） ---------------- */

  function listenState(onState, onWsStatus) {
    const proto = (typeof location !== 'undefined' && location.protocol === 'https:') ? 'wss' : 'ws';
    const host = (typeof location !== 'undefined' && location.host) ? location.host : '127.0.0.1:8765';
    let ws = null;
    let closed = false;
    function connect() {
      if (closed) return;
      try { ws = new WebSocket(proto + '://' + host + '/ws'); } catch (e) { setTimeout(connect, 3000); return; }
      ws.onopen = () => {
        if (onWsStatus) onWsStatus('connected');
        try { ws.send(JSON.stringify({ type: 'set-name', name: '场风盘' })); } catch (e) {}
      };
      ws.onmessage = (ev) => {
        let m = null;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'state' && m.state) { try { onState(m.state); } catch (e) {} }
        else if (m.type === 'joined' && m.state) { try { onState(m.state); } catch (e) {} }
      };
      ws.onclose = () => { if (onWsStatus) onWsStatus('closed'); setTimeout(connect, 3000); };
      ws.onerror = () => { try { ws.close(); } catch (e) {} };
    }
    connect();
    return { close() { closed = true; try { ws.close(); } catch (e) {} } };
  }

  window.TagPush = {
    connect: connect,
    pushCanvas: pushCanvas,
    listenState: listenState,
    quantizeThreeColor: quantizeThreeColor,
    rleCompress: rleCompress,
    rleCompressMTU: rleCompressMTU,
    state: st,
    EpdCmd: EpdCmd,
  };
})();
