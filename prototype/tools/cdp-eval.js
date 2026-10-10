/**
 * cdp-eval.js —— 通过 CDP 在真机 WebView / 真 Chrome 里执行一段 JS 并取回结果。
 *
 * 用法：
 *   node tools/cdp-eval.js <表达式文件路径 | 表达式字符串> [端口]
 *
 * 为什么用「表达式文件」：JS 里引号/中文/反斜杠经 Git Bash 传参会失真，
 * 把表达式写进 .js 文件再传路径最稳。
 *
 * 前置（每一步都要写在同一条 Bash 命令里，adb server 会被回收导致 forward 丢失）：
 *   SOCK=$(adb shell cat /proc/net/unix | grep -o "@webview_devtools_remote_[0-9]*" | head -1)
 *   adb forward tcp:9222 "localabstract:${SOCK#@}"      # localabstract 不带 @
 *   NODE_PATH=<本仓库>/prototype/node_modules node tools/cdp-eval.js probe.js
 */
const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');

function getTargets(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: port, path: '/json', timeout: 5000 }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => { req.destroy(new Error('连接 127.0.0.1:' + port + ' 超时 —— forward 是否失效？')); });
    req.on('error', reject);
  });
}

(async () => {
  const arg = process.argv[2];
  const port = parseInt(process.argv[3] || '9222', 10);
  if (!arg) { console.error('用法: node cdp-eval.js <表达式文件|表达式> [端口]'); process.exit(2); }

  let expr;
  try {
    if (fs.existsSync(arg) && fs.statSync(arg).isFile()) expr = fs.readFileSync(arg, 'utf8');
    else expr = arg;
  } catch (e) { expr = arg; }

  const targets = await getTargets(port);
  const page = targets.find((t) => t.type === 'page') || targets[0];
  if (!page) { console.error('没有可用的 page target'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, handshakeTimeout: 5000 });

  ws.on('open', () => {
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true },
    }));
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg.id !== 1) return;
    const det = msg.result && msg.result.exceptionDetails;
    if (det) {
      console.error('EXCEPTION:', (det.exception && det.exception.description) || det.text);
    }
    const r = msg.result && msg.result.result;
    const v = r && Object.prototype.hasOwnProperty.call(r, 'value') ? r.value : r;
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
    try { ws.close(); } catch (e) {}
    process.exit(det ? 3 : 0);
  });

  ws.on('error', (e) => { console.error('WS ERROR:', e.message); process.exit(1); });
  // 表达式里可能用 awaitPromise 做延时采样（如观察 20s 内的重连行为），
  // 故给足 60s；可用 CDP_EVAL_TIMEOUT 覆盖。
  const tmo = parseInt(process.env.CDP_EVAL_TIMEOUT || '60000', 10);
  setTimeout(() => { console.error('CDP 超时'); process.exit(1); }, tmo);
})();
