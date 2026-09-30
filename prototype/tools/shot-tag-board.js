/**
 * shot-tag-board.js — 真 Chrome(CDP) 渲染截图：tag.html 场风盘版式
 *
 * 用法：
 *   1) chrome --headless=new --disable-gpu --no-proxy-server --remote-debugging-port=9333 \
 *        --user-data-dir=D:/_cdp_tag --window-size=640,900 "file:///D:/日麻计分APP/prototype/tag.html?demo=1"
 *   2) node prototype/tools/shot-tag-board.js   → 图输出到 .workbuddy/tmp/
 *
 * 输出：01-tag-demo.png（整页）+ 02-tag-canvas.png（仅 400×300 画布，即墨水屏实显内容）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const OUT = 'D:/日麻计分APP/.workbuddy/tmp';
fs.mkdirSync(OUT, { recursive: true });

function getJson(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => {
      let s = '';
      r.on('data', (d) => { s += d; });
      r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const targets = await getJson('http://127.0.0.1:9333/json');
  const page = targets.find((t) => t.type === 'page' && t.url.indexOf('tag.html') >= 0)
    || targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没有 page 调试目标');
  console.log('target:', page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 连接失败')); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const call = (method, params) => new Promise((res) => {
    const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  });

  await call('Runtime.enable', {});
  await call('Page.enable', {});
  await call('Emulation.setDeviceMetricsOverride', { width: 640, height: 900, deviceScaleFactor: 2, mobile: false });

  async function ev(expr) {
    const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 800));
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  async function shot(name) {
    const r = await call('Page.captureScreenshot', { format: 'png' });
    const b64 = r.result && r.result.data;
    if (!b64) throw new Error('截图失败: ' + JSON.stringify(r).slice(0, 300));
    const f = path.join(OUT, name);
    fs.writeFileSync(f, Buffer.from(b64, 'base64'));
    console.log('saved', f, fs.statSync(f).size, 'bytes');
  }

  for (let i = 0; i < 40; i++) {
    if (await ev("document.getElementById('board') && document.getElementById('board').__rendered")) break;
    await sleep(250);
  }

  console.log('页面错误检查:', await ev("window.__err || 'none'"));
  await shot('01-tag-demo.png');

  // 仅截画布本体（墨水屏实际显示的内容）
  const dataUrl = await ev("document.getElementById('board').toDataURL('image/png')");
  fs.writeFileSync(path.join(OUT, '02-tag-canvas.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('saved', path.join(OUT, '02-tag-canvas.png'));

  // 三色量化自检：黑/白/红像素占比
  console.log('像素统计:', await ev(`
    (function(){
      var d = document.getElementById('board').getContext('2d').getImageData(0,0,400,300).data;
      var bk=0, wh=0, rd=0;
      for (var i=0;i<d.length;i+=4){
        if (d[i]>200 && d[i+1]<80 && d[i+2]<80) rd++;
        else if (d[i]<80 && d[i+1]<80 && d[i+2]<80) bk++;
        else if (d[i]>200 && d[i+1]>200 && d[i+2]>200) wh++;
      }
      return 'black='+(bk/10000)+'% white='+(wh/10000)+'% red='+(rd/10000)+'%';
    })()
  `));

  ws.close();
  console.log('done');
  setTimeout(() => process.exit(0), 200);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
