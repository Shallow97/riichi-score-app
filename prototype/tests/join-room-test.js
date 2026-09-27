/**
 * join-room-test.js — 首页"加入他人对局（输入房主 IP）"专项测试
 *
 * 功能：首页联网卡片新增输入框 + 加入按钮，输入房主手机显示的 IP 后，
 *       以成员身份跳转到房主页面（http://<IP>:8765/），复用现有成员链路。
 *
 * 覆盖：
 *  1. 地址规范化：纯 IP / 带端口 / 带协议 / 带路径 / 空格；非法输入报错
 *  2. 不可达：不跳转 + warn 提示
 *  3. 可达：跳转到规范化后的房主地址
 *  4. 回车键可直接加入
 *  5. 本机地址（?lanip= 与本机 Wi-Fi IP、回环地址）被拦截且不探测
 *  6. 探测使用 no-cors 模式（跨源可发出，仅判断可达性）
 *  7. 探测超时按失败处理
 *
 * 运行：NODE_PATH=<workspace>/node_modules node join-room-test.js
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ FAIL: ' + msg); }
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms || 20));

async function main() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  // 模拟 Android 房主端：本机 Wi-Fi IP 由 ?lanip= 注入
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:8765/?host=1&lanip=192.168.0.101',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;
  window.eval(fs.readFileSync(path.join(ROOT, 'js/rules.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/storage.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/net.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8'));
  document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

  const input = document.getElementById('join-ip');
  const btn = document.getElementById('btn-join-room');
  const tip = document.getElementById('join-tip');

  // 替换跳转出口，避免 jsdom 的 navigation 未实现报错
  let navUrl = null;
  window.JoinRoom.setNavigate((u) => { navUrl = u; });

  // fetch stub：默认"连不上"
  let fetchCalls = [];
  let fetchMode = 'fail'; // 'ok' | 'fail' | 'hang'
  window.fetch = (url, opt) => {
    fetchCalls.push({ url, opt });
    if (fetchMode === 'ok') return Promise.resolve({ ok: true, status: 200 });
    if (fetchMode === 'hang') return new Promise(() => {});
    return Promise.reject(new Error('connect failed'));
  };

  console.log('\n== 1: 首页入口 ==\n');
  assert(!!document.getElementById('net-joinroom'), '联网卡片内存在"加入他人对局"区块');
  assert(btn && btn.textContent.trim() === '加入', '按钮文案为「加入」');
  assert(/在房主手机上查看 IP/.test(tip.textContent), '默认提示告知如何获取房主 IP（' + tip.textContent + '）');

  console.log('\n== 2: 地址规范化 ==\n');
  const N = window.JoinRoom.normalize;
  let r = N('192.168.0.101');
  assert(r.ok && r.host === '192.168.0.101' && r.port === '8765' && r.url === 'http://192.168.0.101:8765/',
    '纯 IP：自动补默认端口 8765 → ' + (r.url || r.error));
  r = N('  192.168.0.77:9000  ');
  assert(r.ok && r.port === '9000' && r.url === 'http://192.168.0.77:9000/', '带自定义端口 + 首尾空格容错');
  r = N('http://192.168.0.101:8765/');
  assert(r.ok && r.url === 'http://192.168.0.101:8765/', '带协议头与斜杠可识别');
  r = N('http://192.168.0.101/join?x=1');
  assert(r.ok && r.host === '192.168.0.101' && r.url === 'http://192.168.0.101:8765/', '带路径/查询串只取主机');
  r = N('');
  assert(!r.ok && /请输入/.test(r.error), '空输入报错：' + r.error);
  r = N('abc');
  assert(!r.ok && /格式不正确/.test(r.error), '非地址文本报错：' + r.error);
  r = N('999.1.1.1');
  assert(!r.ok, 'IPv4 段超范围（999）被拒绝');
  r = N('192.168.0.101:99999');
  assert(!r.ok && /端口/.test(r.error), '端口越界被拒绝：' + r.error);

  console.log('\n== 3: 连不上房主 → 不跳转并提示 ==\n');
  fetchMode = 'fail'; fetchCalls = []; navUrl = null;
  input.value = '192.168.0.50'; // 非本机地址（本机为 192.168.0.101）
  btn.click();
  await delay();
  assert(fetchCalls.length === 1 && fetchCalls[0].url === 'http://192.168.0.50:8765/',
    '先探测房主地址（' + (fetchCalls[0] && fetchCalls[0].url) + '）');
  assert(fetchCalls[0] && fetchCalls[0].opt && fetchCalls[0].opt.mode === 'no-cors',
    '探测使用 no-cors（跨源仍可发出请求）');
  assert(navUrl === null, '连不上时不跳转');
  assert(tip.className.includes('warn') && /连接不上/.test(tip.textContent),
    '提示连不上：' + tip.textContent);

  console.log('\n== 4: 能连上 → 跳转到房主页面（成员身份） ==\n');
  fetchMode = 'ok'; fetchCalls = []; navUrl = null;
  input.value = '192.168.0.77';
  btn.click();
  await delay();
  assert(navUrl === 'http://192.168.0.77:8765/', '跳转到规范化后的房主地址：' + navUrl);
  assert(!tip.className.includes('warn'), '成功时提示非告警样式：' + tip.textContent);

  console.log('\n== 5: 输入框回车即可加入 ==\n');
  navUrl = null; fetchCalls = [];
  input.value = '10.0.0.5:8000';
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await delay();
  assert(navUrl === 'http://10.0.0.5:8000/', '回车触发加入，端口跟随输入：' + navUrl);

  console.log('\n== 6: 本机地址被拦截 ==\n');
  fetchCalls = []; navUrl = null;
  input.value = '192.168.0.101'; // 与 ?lanip= 注入的本机 IP 相同
  btn.click();
  await delay();
  assert(navUrl === null && fetchCalls.length === 0, '本机 Wi-Fi IP：不探测、不跳转');
  assert(/本机/.test(tip.textContent), '提示"这就是本机地址"：' + tip.textContent);

  navUrl = null;
  input.value = '127.0.0.1';
  btn.click();
  await delay();
  assert(navUrl === null, '回环地址 127.0.0.1 不跳转');

  console.log('\n== 7: 非法输入不发起探测 ==\n');
  fetchCalls = []; navUrl = null;
  input.value = 'hello';
  btn.click();
  await delay();
  assert(fetchCalls.length === 0 && navUrl === null, '格式非法时既不探测也不跳转');
  assert(tip.className.includes('warn'), '非法输入提示为告警样式');

  console.log('\n== 8: 探测超时按失败处理（3s） ==\n');
  fetchMode = 'hang'; fetchCalls = []; navUrl = null;
  input.value = '172.16.0.9';
  btn.click();
  await delay(3300);
  assert(navUrl === null, '超时（3s）不跳转');
  assert(/连接不上/.test(tip.textContent), '超时提示连不上：' + tip.textContent);

  console.log('\n====================================');
  console.log('加入他人对局专项测试: ' + pass + ' 通过，' + fail + ' 失败');
  console.log('====================================');
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
