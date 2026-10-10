/* 场风盘推送模块（e-ink 板用，独立页面，不进 APP 主界面）
 *
 * 推图方式对齐参考上位机 https://breeze4dev.github.io/epd-noclock/（epd-noclock，
 * 支持无时钟固件的分支），与其 application 逻辑逐行一致；协议底座仍是 tsl0922/EPD-nRF5：
 *   - Service  62750001-d828-918d-fb46-b6c11c675aec
 *   - EPD 特征 62750002-...（write + notify）
 *   - 版本特征 62750003-...（uint8，需 >= 0x16 才支持 WRITE_IMG=0x30）
 *   - 连接后第 1 条 notify = 设备自报配置（byte0-6 引脚 / byte7 驱动）
 *     之后为文本消息，其中 "mtu=N"（可带 "rle=1"）是唯一可信的 MTU 来源
 *   - 推图序列（参考站 sendimg）：
 *       INIT(0x01，裸命令) → 等设备上报 mtu
 *       → WRITE_IMG(0x30) 黑白面 → WRITE_IMG 红面 → REFRESH(0x05)
 *     ⚠️ INIT 一律不带驱动字节：固件 EPD_service.c 的 EPD_CMD_INIT 只要参数长度>1，
 *        就用该字节改写 flash 里的 model_id（永久），参考站推图也是发裸 INIT。
 *     WRITE_IMG 载荷 = [0x30, 标志位, 数据]，每块数据 = mtu-2 字节；
 *     标志位（与参考站一致，按设备是否支持 RLE 分两套编码）：
 *       支持 RLE：bit0=0 黑白/1 红，bit1=1 首块，bit2=1 本块是 RLE 数据
 *       不支持 RLE（固件 v1.6 口径）：黑白首块 0x0F / 后续 0xFF，红面首块 0x00 / 后续 0xF0
 *     回执策略（确认间隔）：每 50 块要一次带响应写入，最后一块必须带响应
 *   - 画面参数（用户指定，与价签同步助手 / 参考站一致）：
 *       面板 4.2 寸三色 UC8176 400×300（引脚 1413060504030207，设备已存，推图流程不写）
 *       抖动算法 Floyd-Steinberg、抖动强度 1.0（上位机档位 10）、对比度 1.2
 *       MTU 244、确认间隔 50
 *     处理顺序（参考站 convertDithering）：对比度拉伸 → Floyd-Steinberg 抖动
 *       → 按 140 灰度/红通道阈值转 1bpp 双平面
 *   - 位图格式：1bpp，byteWidth=ceil(w/8)，行序、MSB 在前；1=白 0=黑（红面 0=红）
 *
 * ⚠️ 不提供黑白快刷（改 PSR/CDI/LUT 寄存器）等非标路径：实测该类操作会把屏卡死、
 *    甚至让固件失联。推图一律走上面的标准三色流程。
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

  /** 确认间隔（参考站 interleavedcount 默认值）：每 N 块要一次带响应写入，末块必带 */
  const ACK_INTERVAL = 50;
  /** 运行时可变（诊断用）。默认 50 ⇒ RLE 压缩后只有二十来块时，实际上只有「末块」带回执。
   *  设为 1 即「逐块回执」：最慢但能排除 BLE 无响应写入被丢包的可能。 */
  let ackInterval = ACK_INTERVAL;
  /** ATT 载荷上限兜底值（设备会回报 mtu=244；拿不到回报时用同值，与 Android requestMtu(247) 对应） */
  const MTU_DEFAULT = 244;

  /* ---------------- 画面参数（用户指定，与参考上位机默认一致） ---------------- */
  const DRIVER_BWR      = 0x03;   // 4.2寸 三色 UC8176（EPD_driver.h 模型 ID）
  const CONTRAST        = 1.2;    // 对比度
  const DITHER_STRENGTH = 1.0;    // 抖动强度（参考站滑杆 0~5 步长 0.1，档位 10 = 1.0）

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
    msgIndex: 0, mtu: MTU_DEFAULT, mtuReported: 0, rleSupport: false, appVersion: 0x16,
    pins: '', driver: '', connected: false, reconnectTimer: null,
  };
  let logFn = function () {};
  let statusFn = function () {};
  let diagFn = function () {};
  /** 只读诊断：连接后不发热身 INIT —— 固件收到带参数的 INIT 会把驱动编号写进 flash 的 model_id */
  let readOnly = false;

  /** 诊断事件出口（tag.html 诊断面板用；默认丢弃） */
  function diag(o) { try { diagFn(o); } catch (e) {} }

  function toHex(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += ('0' + bytes[i].toString(16)).slice(-2);
    return s;
  }

  function hex2bytes(hex) {
    const bytes = [];
    for (let c = 0; c < hex.length; c += 2) bytes.push(parseInt(hex.substr(c, 2), 16));
    return new Uint8Array(bytes);
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /* 写序列化链：并发调用（手动推送 + 自动推送）不会交叉写 GATT */
  let writeChain = Promise.resolve();
  function enqueue(run) {
    const p = writeChain.then(run, run);
    writeChain = p.then(() => undefined, () => undefined);
    return p;
  }

  /** 控制命令（带响应写入；[cmd, ...data] 单包） */
  function write(cmd, data) {
    if (!st.char) { logFn('服务不可用，请检查蓝牙连接'); return Promise.resolve(false); }
    const payload = [cmd];
    if (data) {
      if (typeof data === 'string') data = hex2bytes(data);
      if (data instanceof Uint8Array) data = Array.from(data);
      payload.push(...data);
    }
    const bytes = Uint8Array.from(payload);
    return enqueue(async () => {
      try { await st.char.writeValueWithResponse(bytes); return true; }
      catch (e) { logFn('write: ' + (e && e.message ? e.message : e)); return false; }
    });
  }

  /** 原始字节写入（图像块用）：无响应失败时重试一次，再退回带响应写入（参考站 gattWriteBytes） */
  function writeBytes(bytes, withResponse) {
    if (!st.char) { logFn('服务不可用，请检查蓝牙连接'); return Promise.resolve(false); }
    return enqueue(async () => {
      try {
        if (withResponse) await st.char.writeValueWithResponse(bytes);
        else await st.char.writeValueWithoutResponse(bytes);
        return true;
      } catch (e) {
        if (!withResponse) {
          try {
            await sleep(8);
            await st.char.writeValueWithoutResponse(bytes);
            return true;
          } catch (_) { /* 落到带响应重试 */ }
          try {
            await st.char.writeValueWithResponse(bytes);
            return true;
          } catch (e2) {
            logFn('write: ' + (e2 && e2.message ? e2.message : e2));
            return false;
          }
        }
        logFn('write: ' + (e && e.message ? e.message : e));
        return false;
      }
    });
  }

  /* ---------------- MTU：只认设备上报值（Web Bluetooth 拿不到协商结果） ---------------- */

  /** 已收到设备回报就用回报值，否则用配置的 244（与 Android requestMtu(247) 对应） */
  function attPayloadMtu() { return st.mtuReported > 0 ? st.mtuReported : MTU_DEFAULT; }

  async function ensureImageMtuReady(timeoutMs) {
    const t0 = Date.now();
    while (st.mtuReported <= 0 && Date.now() - t0 < timeoutMs) await sleep(50);
    if (st.mtuReported <= 0) st.mtuReported = MTU_DEFAULT;
    st.mtu = st.mtuReported;
    return st.mtu;
  }

  function handleNotify(value) {
    const data = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const raw = toHex(data);
    if (st.msgIndex === 0) {
      // 设备自报配置：byte0-6 引脚 / byte7 驱动（部分固件 byte10 为扩展引脚）
      let pins = '';
      for (let i = 0; i < 7 && i < data.length; i++) pins += ('0' + data[i].toString(16)).slice(-2);
      if (data.length > 10) pins += ('0' + data[10].toString(16)).slice(-2);
      st.pins = pins;
      if (data.length > 7) st.driver = ('0' + data[7].toString(16)).slice(-2);
      logFn('设备配置: pins=' + st.pins + ' driver=' + st.driver);
      diag({ kind: 'device-config', raw: raw, len: data.length, pins: st.pins, driver: st.driver });
    } else {
      let msg = '';
      for (let i = 0; i < data.length; i++) msg += String.fromCharCode(data[i]);
      logFn('⇓ ' + msg);
      if (msg.indexOf('mtu=') === 0 && msg.length > 4) {
        const n = parseInt(msg.substring(4), 10);
        if (isFinite(n) && n >= 20) { st.mtuReported = n; st.mtu = n; }
        if (msg.indexOf('rle=1') >= 0) st.rleSupport = true;
        logFn('MTU=' + st.mtu + (st.rleSupport ? ' (RLE 支持)' : ''));
        diag({ kind: 'mtu', raw: raw, text: msg, mtu: st.mtu, rle: st.rleSupport });
      } else {
        diag({ kind: 'text', raw: raw, text: msg });
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
    st.mtu = MTU_DEFAULT;
    st.mtuReported = 0;
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
    if (readOnly) {
      // 只读诊断：不发 INIT（固件 EPD_CMD_INIT 带参数时会 epd_config_write 改写 flash 的 model_id）
      logFn('只读诊断模式：跳过热身 INIT，不会改写设备型号');
      diag({ kind: 'skip-init' });
    } else {
      // 连接后的热身 INIT（裸命令）：固件按 flash 里已存的 model_id 复位并给面板上电
      // ⚠️ 不传驱动字节 —— 带参数的 INIT 会让固件把该值永久写进 flash 的 model_id
      logFn('发送裸 INIT（按设备已存型号初始化，不改写 flash）');
      diag({ kind: 'init' });
      await write(EpdCmd.INIT);
      await sleep(500);
    }
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
    st.mtuReported = 0;
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

  /* ---------------- 画面处理：对比度 → Floyd-Steinberg 抖动 → 三色量化 ----------------
   * 逐行对齐参考上位机 s2.js：rgbToLab / labDistance / findClosestColor(threeColor)
   * / adjustContrast / floydSteinbergDither + processImageData(threeColor)。
   * 抖动与最终量化用的都是"最近调色板颜色"，量化阈值仍是官方口径：
   * 灰度 >=140 判白，r>160 且 r>g、r>b 判红（抖动后的像素已落在黑/白/红三色上）。
   */

  const THREE_COLOR_PALETTE = [{ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, { r: 255, g: 0, b: 0 }];

  function rgbToLab(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
    g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
    b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;
    r *= 100; g *= 100; b *= 100;
    let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 95.047;
    let y = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 100.0;
    let z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 108.883;
    x = x > 0.008856 ? Math.pow(x, 1 / 3) : (7.787 * x) + (16 / 116);
    y = y > 0.008856 ? Math.pow(y, 1 / 3) : (7.787 * y) + (16 / 116);
    z = z > 0.008856 ? Math.pow(z, 1 / 3) : (7.787 * z) + (16 / 116);
    return { l: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) };
  }

  function labDistance(p, q) {
    const dl = p.l - q.l, da = p.a - q.a, db = p.b - q.b;
    return Math.sqrt(0.2 * dl * dl + 3 * da * da + 3 * db * db);
  }

  /** 三色模式下取 Lab 距离最近的调色板色（与参考站 findClosestColor(threeColor) 一致） */
  function nearestThreeColor(r, g, b) {
    const lab = rgbToLab(r, g, b);
    let best = THREE_COLOR_PALETTE[0], bestD = Infinity;
    for (let i = 0; i < THREE_COLOR_PALETTE.length; i++) {
      const c = THREE_COLOR_PALETTE[i];
      const d = labDistance(lab, rgbToLab(c.r, c.g, c.b));
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  /** 对比度拉伸：v' = clamp((v-128)*factor+128) */
  function applyContrast(data, factor) {
    for (let i = 0; i < data.length; i += 4) {
      data[i]     = Math.min(255, Math.max(0, (data[i] - 128) * factor + 128));
      data[i + 1] = Math.min(255, Math.max(0, (data[i + 1] - 128) * factor + 128));
      data[i + 2] = Math.min(255, Math.max(0, (data[i + 2] - 128) * factor + 128));
    }
  }

  /** Floyd-Steinberg 误差扩散（就地把像素吸附到三色调色板） */
  function floydSteinbergDither(imageData, strength) {
    const width = imageData.width, height = imageData.height;
    const data = imageData.data;
    const tmp = new Uint8ClampedArray(data);
    const spread = (idx, er, eg, eb, k) => {
      tmp[idx]     = Math.min(255, Math.max(0, tmp[idx] + er * k));
      tmp[idx + 1] = Math.min(255, Math.max(0, tmp[idx + 1] + eg * k));
      tmp[idx + 2] = Math.min(255, Math.max(0, tmp[idx + 2] + eb * k));
    };
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const r = tmp[idx], g = tmp[idx + 1], b = tmp[idx + 2];
        const c = nearestThreeColor(r, g, b);
        const er = (r - c.r) * strength, eg = (g - c.g) * strength, eb = (b - c.b) * strength;
        if (x + 1 < width) spread(idx + 4, er, eg, eb, 7 / 16);
        if (y + 1 < height) {
          if (x > 0) spread(idx + width * 4 - 4, er, eg, eb, 3 / 16);
          spread(idx + width * 4, er, eg, eb, 5 / 16);
          if (x + 1 < width) spread(idx + width * 4 + 4, er, eg, eb, 1 / 16);
        }
      }
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const c = nearestThreeColor(tmp[idx], tmp[idx + 1], tmp[idx + 2]);
        data[idx] = c.r; data[idx + 1] = c.g; data[idx + 2] = c.b;
      }
    }
    return imageData;
  }

  /** 三色量化（与官方 processImageData threeColor 分支一致） */
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

  /** 完整画面处理链：对比度 → 抖动 → 量化（不改动原 canvas 像素） */
  function processCanvasImage(imageData) {
    const copy = {
      width: imageData.width,
      height: imageData.height,
      data: new Uint8ClampedArray(imageData.data),
    };
    applyContrast(copy.data, CONTRAST);
    floydSteinbergDither(copy, DITHER_STRENGTH);
    return quantizeThreeColor(copy);
  }

  /* ---------------- 面板自检：清屏 ----------------
   * 只走固件内部路径：EPD_CMD_CLEAR → drv->init()（复位+上电+按三色初始化）
   * → drv->clear(true)（两平面填 0xFF 白 + 全屏刷新）。
   * 完全不经过我们的位图 / 标志位 / RLE 编码，用来把「硬件/型号/刷新链路」与「画面数据」切开：
   *   - 清屏有效（约 15s 后全白）→ 面板、型号、上电、刷新都正常，问题在画面数据路径
   *   - 清屏无效 → 面板不响应，优先怀疑 flash 里的型号（0x03 vs 0x02）或驱动字节
   * 副作用：固件会把 display_mode 置为 MODE_PICTURE(0)，与推图用途一致。
   */
  function clearPanel() {
    if (!st.connected) return Promise.resolve(false);
    logFn('发送 CLEAR（面板自检：清屏→全白）');
    return write(EpdCmd.CLEAR).then((ok) => {
      diag({ kind: 'clear', ok: ok });
      statusFn(ok ? '已发清屏，约 15 秒后屏应变全白' : '清屏失败');
      return ok;
    });
  }

  /* ---------------- 推图 ---------------- */

  /** 发送一个颜色平面（参考站 writeImage） */
  async function writeImage(data, step) {
    const chunkSize = Math.max(1, attPayloadMtu() - 2);
    let noReplyCount = ackInterval;
    const stepText = step === 'bw' ? '黑白面' : '红面';

    const rleChunks = st.rleSupport ? rleCompressMTU(data, chunkSize) : null;
    const rleLength = rleChunks ? rleChunks.reduce((t, c) => t + c.length, 0) : data.length;
    const useRle = st.rleSupport && rleLength < data.length;
    const totalChunks = useRle ? rleChunks.length : Math.ceil(data.length / chunkSize);

    const flagFor = (i) => st.rleSupport
      ? ((step === 'bw' ? 0x00 : 0x01) | (i === 0 ? 0x02 : 0x00) | (useRle ? 0x04 : 0x00))
      : ((step === 'bw' ? 0x0F : 0x00) | (i === 0 ? 0x00 : 0xF0));

    diag({
      kind: 'plane', step: step, bytes: data.length, chunkSize: chunkSize,
      chunks: totalChunks, encoded: useRle ? 'rle' : 'raw', useRle: useRle,
      firstFlag: flagFor(0), nextFlag: flagFor(1),
      rleSupport: st.rleSupport, rawRleBytes: rleLength, ackInterval: ackInterval,
    });

    for (let i = 0; i < totalChunks; i++) {
      const raw = useRle ? rleChunks[i] : data.slice(i * chunkSize, i * chunkSize + chunkSize);
      const chunk = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
      const flag = flagFor(i);
      const pkt = new Uint8Array(2 + chunk.length);
      pkt[0] = EpdCmd.WRITE_IMG;
      pkt[1] = flag;
      pkt.set(chunk, 2);

      // ⚠️ noReplyCount 从 ackInterval 起算 ⇒ 首块必然不带回执；ackInterval<=1 时必须显式
      //    走「逐块回执」，否则会退化成「每隔一块回执」（实测 ack 数只有一半）
      const needAck = (i === totalChunks - 1) || (ackInterval <= 1) || (noReplyCount <= 0);
      if (!await writeBytes(pkt, needAck)) {
        diag({ kind: 'write-fail', step: step, index: i, total: totalChunks, ack: needAck, bytes: pkt.length });
        statusFn('写入失败 ' + stepText + ' ' + (i + 1) + '/' + totalChunks);
        return false;
      }
      if (needAck) noReplyCount = ackInterval; else noReplyCount--;

      if (i === 0 || i === totalChunks - 1 || (i % 8) === 0) {
        statusFn('推送中 ' + stepText + ' ' + (i + 1) + '/' + totalChunks + (useRle ? ' RLE' : ''));
      }
    }
    diag({ kind: 'plane-done', step: step, chunks: totalChunks });
    return true;
  }

  /** 推送一个 canvas（400×300，或开启旋转后 300×400） */
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
    statusFn('推送中...');
    const t0 = Date.now();
    diag({ kind: 'push-start', w: src.width, h: src.height, mtu: attPayloadMtu(),
           rle: st.rleSupport, pins: st.pins, driver: st.driver });

    // 1) 每次推图前先发裸 INIT 复位寄存器：设备休眠/上次刷屏都可能让寄存器残留
    //    （裸 INIT 用设备 flash 里已存的型号，不会改写型号 —— 参考站推图同此）
    if (!await write(EpdCmd.INIT)) { statusFn('推送中断（初始化失败）'); throw new Error('INIT 写入失败'); }
    // 2) 等设备上报 MTU 再分包（拿不到回报就按 244 兜底）
    await ensureImageMtuReady(5000);
    // 3) 画面处理：对比度 1.2 → Floyd-Steinberg 抖动（强度 1.0）→ 三色双平面
    const planes = processCanvasImage(imageData);
    let ok = await writeImage(planes.bw, 'bw');
    if (ok) ok = await writeImage(planes.red, 'red');
    if (!ok) { statusFn('推送中断（蓝牙写入失败）'); throw new Error('WRITE_IMG 写入失败'); }
    // 4) 刷新：真正让画面变化的一步。⚠️ 以前这里丢掉返回值，写失败也会报「推送完成」，
    //    诊断 dump 因此永远看着是绿的 —— 现在必须把结果上报。
    const ms = Date.now() - t0;
    const okRefresh = await write(EpdCmd.REFRESH);
    diag({ kind: 'refresh', ok: okRefresh, ms: ms });
    if (!okRefresh) { statusFn('刷新指令写入失败（画面不会变化）'); throw new Error('REFRESH 写入失败'); }
    diag({ kind: 'push-done', ms: Date.now() - t0 });
    statusFn('推送完成（三色全刷，约 15 秒后画面更新）');
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
    clearPanel: clearPanel,
    listenState: listenState,
    quantizeThreeColor: quantizeThreeColor,
    processCanvasImage: processCanvasImage,
    applyContrast: applyContrast,
    floydSteinbergDither: floydSteinbergDither,
    attPayloadMtu: attPayloadMtu,
    ensureImageMtuReady: ensureImageMtuReady,
    rleCompress: rleCompress,
    rleCompressMTU: rleCompressMTU,
    /** 日志出口（此前缺失：内部 logFn/statusFn 从未被外部赋值，所有诊断日志都被丢弃） */
    setLog: function (fn) { logFn = (typeof fn === 'function') ? fn : function () {}; },
    setStatus: function (fn) { statusFn = (typeof fn === 'function') ? fn : function () {}; },
    /** 结构化诊断事件出口：device-config / mtu / init / plane / write-fail / push-done */
    onDiag: function (fn) { diagFn = (typeof fn === 'function') ? fn : function () {}; },
    /** 只读诊断：连接后不发热身 INIT（避免改写设备 flash 里的型号） */
    setReadOnly: function (on) { readOnly = !!on; },
    isReadOnly: function () { return readOnly; },
    /** 确认间隔：1 = 逐块回执（慢但稳），50 = 参考站默认（只有末块带回执） */
    setAckInterval: function (n) { ackInterval = (typeof n === 'number' && n >= 1) ? Math.floor(n) : ACK_INTERVAL; },
    getAckInterval: function () { return ackInterval; },
    params: { DRIVER_BWR: DRIVER_BWR, CONTRAST: CONTRAST, DITHER_STRENGTH: DITHER_STRENGTH, ACK_INTERVAL: ACK_INTERVAL, MTU_DEFAULT: MTU_DEFAULT },
    state: st,
    EpdCmd: EpdCmd,
  };
})();
