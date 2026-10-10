/**
 * cdp-offline.js —— 在真 Chrome 里模拟成员断网 → 恢复，观察 net.js 的掉线锁定与自动重连。
 *
 * 用法：node tools/cdp-offline.js [port=9333] [offlineMs=6000]
 *
 * 用 CDP 的 Network.emulateNetworkConditions 切断该页面的网络，
 * 观察 isLocked / phase / 横幅 / serverSeq 在「断网前 → 断网中 → 恢复后」三个阶段的变化。
 * 不断开 CDP 连接本身（断开会重置 emulation）。
 */
const http = require('http');
const WebSocket = require('ws');

const PORT = parseInt(process.argv[2] || '9333', 10);
const OFFLINE_MS = parseInt(process.argv[3] || '6000', 10);

function getTargets(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: port, path: '/json', timeout: 5000 }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('连 127.0.0.1:' + port + ' 超时')));
    req.on('error', reject);
  });
}

const PROBE = [
  '(function(){',
  'function s(f,d){try{var v=f();return v===undefined?d:v}catch(e){return "ERR:"+e.message}}',
  'var b=document.getElementById("net-banner");',
  'var t=document.getElementById("net-banner-text")||b;',
  'return JSON.stringify({',
  'locked:s(function(){return window.Net.isLocked()}),',
  'phase:s(function(){return window.Net.phase()}),',
  'hasJoined:s(function(){return window.Net.hasJoined()}),',
  'seq:s(function(){return window.Net.serverSeq()}),',
  'hostOffline:s(function(){return window.Net.isHostOffline()}),',
  'bannerText:b?t.textContent.trim().replace(/\\s+/g," "):null,',
  'bannerDisp:b?getComputedStyle(b).display:null,',
  'bannerCls:b?String(b.className):null',
  '});})()',
].join('');

(async () => {
  const targets = await getTargets(PORT);
  const page = targets.find((t) => t.type === 'page' && t.url.indexOf('8765') >= 0)
    || targets.find((t) => t.type === 'page');
  if (!page) { console.error('没有 page target'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, handshakeTimeout: 5000 });
  let id = 0;
  const pending = new Map();

  function cmd(method, params) {
    return new Promise((resolve) => {
      const myId = ++id;
      pending.set(myId, resolve);
      ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
    });
  }

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });

  await new Promise((r) => ws.on('open', r));
  await cmd('Runtime.enable');
  await cmd('Network.enable');

  async function snap(label) {
    const r = await cmd('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    const v = r.result && r.result.result ? r.result.result.value : null;
    console.log('--- ' + label + ' ---');
    console.log(v);
  }

  await snap('断网前');
  await cmd('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  });
  await new Promise((r) => setTimeout(r, OFFLINE_MS));
  await snap('断网中 (' + OFFLINE_MS + 'ms)');
  await cmd('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  await new Promise((r) => setTimeout(r, 9000));
  await snap('恢复网络 9s 后');

  ws.close();
  process.exit(0);
})();
