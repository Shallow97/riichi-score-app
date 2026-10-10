/**
 * e2e-host-lock-watch.js —— 房主锁屏长时观察员（真机端到端）
 *
 * 以"成员"身份挂到房主手机的服务器上，持续记录：
 *   1. 服务器 ping 的到达节奏（服务器/网络是否停摆；房主锁屏后 Wi-Fi 是否休眠）
 *   2. host-offline / host-online 事件（房主的 WS 链路是否被看门狗判死）
 *
 * 用法：
 *   NODE_PATH=... node tools/e2e-host-lock-watch.js ws://192.168.124.6:8765/ws 12
 *   （第三个参数 = 观察分钟数，默认 10）
 *
 * 说明：服务器对新连接直接下发 welcome，无需显式 join；
 *       本脚本只需按协议回 pong，否则自己会被服务器的 75s 看门狗踢掉。
 */
const WebSocket = require('ws');

const url = process.argv[2] || 'ws://127.0.0.1:8765/ws';
const minutes = parseFloat(process.argv[3] || '10');
const t0 = Date.now();
const since = () => ((Date.now() - t0) / 1000).toFixed(1);
const log = (s) => console.log('[' + since() + 's] ' + s);

let pings = 0;
let lastPingAt = 0;
let maxGapMs = 0;
const bigGaps = [];
const events = [];
let welcomed = false;

const ws = new WebSocket(url, { handshakeTimeout: 8000 });

ws.on('open', () => {
  log('✅ 已连接 ' + url);
});

ws.on('message', (raw) => {
  let m;
  try { m = JSON.parse(raw); } catch (e) { return; }
  if (m.type === 'ping') {
    const now = Date.now();
    pings++;
    if (lastPingAt) {
      const gap = now - lastPingAt;
      if (gap > maxGapMs) maxGapMs = gap;
      if (gap > 30000) { bigGaps.push({ at: +since(), gapMs: gap }); log('⚠️ ping 间隔异常 ' + gap + 'ms'); }
    }
    lastPingAt = now;
    try { ws.send(JSON.stringify({ type: 'pong', ts: m.ts })); } catch (e) {}
    return;
  }
  if (m.type === 'pong') return;
  if (m.type === 'state') return;              // 状态广播，测试期间无操作，忽略
  if (m.type === 'welcome') {
    welcomed = true;
    log('welcome role=' + m.role + ' hostOnline=' + m.hostOnline + ' hostSeen=' + m.hostSeen + ' seq=' + m.seq);
    return;
  }
  if (m.type === 'host-offline' || m.type === 'host-online') {
    events.push({ at: +since(), type: m.type });
    log((m.type === 'host-offline' ? '❌ ' : '✅ ') + m.type);
    return;
  }
  log('其它消息 ' + m.type);
});

ws.on('close', (code, reason) => log('⛔ 连接被关闭 code=' + code + ' reason=' + (reason || '')));
ws.on('error', (e) => log('‼️ 错误 ' + e.message));

setTimeout(() => {
  const dur = (Date.now() - t0) / 1000;
  console.log('\n===== 汇总 =====');
  console.log('观察时长(s)        :', dur.toFixed(0));
  console.log('收到服务器 ping 次数:', pings, '(期望 ≈ ' + Math.round(dur / 20) + ')');
  console.log('ping 最大间隔(ms)   :', maxGapMs, '(正常 ≈ 20000)');
  if (bigGaps.length) console.log('异常间隔           :', JSON.stringify(bigGaps));
  console.log('welcome 已收到     :', welcomed);
  console.log('host 状态变更      :', events.length ? JSON.stringify(events) : '无');
  const ok = pings >= Math.round(dur / 20) - 3 && !events.some((e) => e.type === 'host-offline');
  console.log(ok ? '\n结论: ✅ 房主锁屏全程在线，服务器持续服务' : '\n结论: ❌ 出现掉线/停摆，见上');
  process.exit(ok ? 0 : 1);
}, minutes * 60 * 1000);
