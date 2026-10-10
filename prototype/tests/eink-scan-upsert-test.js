/**
 * eink-scan-upsert-test.js — 场风盘扫描列表「同地址多次上报」回归测试
 *
 * 背景（2026-10-04 真机 bug：列表里大量「（无名设备）」、场风盘既认不出也点不到）：
 *   BLE 的 advertising data 与 scan response 是**两个独立的包**，系统会分别（或合并后）回调。
 *   本固件把服务 UUID 放在 scan response，而**首个回调常常拿不到名字** —— 原生侧先报
 *   「（无名设备）」，名字要等随后那个带 scan response 的回调才出现。旧实现两处缺陷叠加：
 *     ① 原生 `scanSeen.add(addr)` 命中即 return → 带名字的后续回调**全部被丢弃**；
 *     ② 页面无脑 append → 同一设备出现重复行。
 *
 * 覆盖：
 *  1. 同地址先无名、后有名 → **不新增行**，且名字更新为最终值
 *  2. 命中项（hit）排到最前、带「场风盘」徽标
 *  3. 不同地址各自成行，互不覆盖；列表内地址无重复
 *  4. 始终无名的设备 → 显示「（无名设备）」，且不带场风盘徽标
 *  5. 点击列表项 → 按地址发起连接
 *  6. 「直连」按钮：宽容解析 MAC（小写 / 任意分隔符），规范化后连接
 *  7. 「直连」按钮：位数不对 → 明确告警且**不**发起连接
 *  8. 排序：命中场风盘 → 有名字设备 → 无名设备；统计行给出各类计数
 *  9. 连接过程反馈：connecting → 状态栏「正在连接」+ 禁用直连；connect-fail → 显示原因并恢复
 * 10. 「修复引脚配置」按钮：连接后可用，点击调用原生 einkRepairPins
 * 11. 设备自报引脚异常（devcfg）→ 主动提示；引脚回写成功（pins-fixed）→ 提示重连确认
 *
 * 运行：NODE_PATH=<workspace>/node_modules node eink-scan-upsert-test.js
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

async function main() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:8765/?host=1&lanip=192.168.0.101',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;

  window.HTMLCanvasElement.prototype.getContext = function () {
    return {
      drawImage() {},
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    };
  };
  window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
  window.HTMLMediaElement.prototype.pause = function () {};

  // NativeBridge 桩要在 app.js 之前挂上（初始化时会读它决定按钮可用性）
  const connectCalls = [];
  const repairCalls = [];
  window.NativeBridge = {
    einkConnectAddr: (a) => connectCalls.push(a),
    einkConnect: () => {},
    einkStopScan: () => {},
    einkDiagnose: () => {},
    einkDisconnect: () => {},
    einkRepairPins: () => repairCalls.push(1),
  };

  window.eval(fs.readFileSync(path.join(ROOT, 'js/rules.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/storage.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/net.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/qrcode.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8'));
  document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

  const list = document.getElementById('eink-scan-list');
  const on = (type, data) => window.EinkNative.onStatus(type, data);
  const MAC1 = 'AA:BB:CC:DD:EE:FF';
  const click = (el) => el.dispatchEvent(new window.Event('click', { bubbles: true }));

  console.log('\n[1] 同地址：先无名 → 后带名字');
  list.innerHTML = '';
  on('scan', JSON.stringify({ name: '（无名设备）', addr: MAC1, rssi: -72, hit: false }));
  assert(list.children.length === 1, '首个（无名）回调后列表有 1 行');
  assert(list.children[0].textContent.indexOf('（无名设备）') >= 0, '首行显示（无名设备）');

  on('scan', JSON.stringify({ name: 'Xiaomi 14', addr: 'AA:BB:CC:DD:EE:01', rssi: -88, hit: false }));
  assert(list.children.length === 2, '另一台设备追加为第 2 行');

  on('scan', JSON.stringify({ name: 'NRF_EPD_2', addr: MAC1, rssi: -58, hit: true }));
  assert(list.children.length === 2, '★ 同地址补报**不新增行**（仍为 2 行）');

  const hitItem = list.children[0];
  assert(hitItem.dataset.addr === MAC1, '★ 场风盘被排到最前（第 1 行）');
  assert(hitItem.className.indexOf('hit') >= 0, '★ 该行带 hit 标记（绿描边）');
  assert(hitItem.textContent.indexOf('NRF_EPD_2') >= 0, '★ 名字已从（无名设备）更新为 NRF_EPD_2');
  assert(hitItem.textContent.indexOf('场风盘') >= 0, '★ 该行显示「场风盘」徽标');
  const addrs = Array.from(list.children).map((e) => e.dataset.addr);
  assert(addrs.length === new Set(addrs).size, '★ 列表内地址无重复');

  console.log('\n[2] 设备持续广播（1s/次）不应刷出重复行');
  on('scan', JSON.stringify({ name: 'NRF_EPD_2', addr: MAC1, rssi: -60, hit: true }));
  on('scan', JSON.stringify({ name: 'NRF_EPD_2', addr: MAC1, rssi: -61, hit: true }));
  assert(list.children.length === 2, '连续补报后仍为 2 行');

  console.log('\n[3] 始终无名的设备');
  on('scan', JSON.stringify({ name: '（无名设备）', addr: 'FF:FF:FF:FF:FF:FF', rssi: -95, hit: false }));
  assert(list.children.length === 3, '无名设备也占一行');
  assert(list.children[2].textContent.indexOf('场风盘') < 0, '无名设备不带场风盘徽标');

  console.log('\n[4] 点击列表项');
  connectCalls.length = 0;
  click(hitItem);
  assert(connectCalls.length === 1 && connectCalls[0] === MAC1, '按该行地址发起连接');

  console.log('\n[5] 「直连」按钮');
  const inp = document.getElementById('eink-manual-addr');
  const btn = document.getElementById('btn-eink-connect-addr');
  assert(!!inp && !!btn, '输入框与按钮存在');

  connectCalls.length = 0;
  inp.value = 'aa-bb-cc-dd-ee-ff';
  click(btn);
  assert(connectCalls.length === 1 && connectCalls[0] === 'AA:BB:CC:DD:EE:FF',
    '宽容解析小写/带分隔符，规范化为大写冒号格式');

  connectCalls.length = 0;
  inp.value = '1234';
  click(btn);
  assert(connectCalls.length === 0, 'MAC 位数不对时不发起连接');
  assert(document.getElementById('eink-log').textContent.indexOf('地址格式不对') >= 0,
    'MAC 位数不对时给出明确告警');

  console.log('\n[6] 排序：命中 → 有名字 → 无名（真机一屏十五个设备时的可读性）');
  list.innerHTML = '';
  on('scanning', '');
  const U1 = '11:11:11:11:11:11', U2 = '33:33:33:33:33:33', NM = '22:22:22:22:22:22';
  on('scan', JSON.stringify({ name: '（无名设备）', addr: U1, rssi: -90, hit: false }));
  on('scan', JSON.stringify({ name: 'midea', addr: NM, rssi: -70, hit: false }));
  on('scan', JSON.stringify({ name: '（无名设备）', addr: U2, rssi: -91, hit: false }));
  on('scan', JSON.stringify({ name: 'NRF_EPD_2', addr: MAC1, rssi: -58, hit: true }));
  const order = Array.from(list.children).map((e) => e.dataset.addr);
  assert(order.length === 4, '4 个设备各自成行');
  assert(order[0] === MAC1, '★ 场风盘排第 1 行');
  assert(order[1] === NM, '★ 有名字的设备排第 2 行');
  assert(order.indexOf(U1) > 1 && order.indexOf(U2) > 1, '★ 无名设备全部排到最后');

  const cntEl = document.getElementById('eink-scan-count');
  const cnt = cntEl.textContent;
  assert(cnt.indexOf('共 4 个设备') >= 0, '★ 统计行给出设备总数：' + cnt);
  assert(cnt.indexOf('有名字 2') >= 0 && cnt.indexOf('无名 2') >= 0, '★ 统计行区分有名字/无名');
  assert(cnt.indexOf('场风盘 1') >= 0, '★ 统计行标出场风盘数量');
  on('scan-done', '4');
  assert(cntEl.textContent.indexOf('共 4 个设备') >= 0, '扫描结束后统计行仍在');

  console.log('\n[7] 连接过程反馈（修「直接输入地址后点直连无反应」）');
  const st = document.getElementById('eink-status');
  const dbtn = document.getElementById('btn-eink-connect-addr');
  on('connecting', 'NRF_EPD_246B');
  assert(st.textContent.indexOf('正在连接') >= 0, '★ connecting → 状态栏立刻显示「正在连接」');
  assert(dbtn.disabled === true, '★ 连接中禁用「直连」按钮（避免并发多路 GATT）');
  on('connect-fail', '连接建立超时 —— 30 秒内设备没有响应');
  assert(st.textContent.indexOf('连接失败') >= 0, '★ connect-fail → 状态栏显示失败原因');
  assert(st.textContent.indexOf('超时') >= 0, '★ 失败原因具体到「超时」，不是笼统一句失败');
  assert(dbtn.disabled === false, '★ 失败后恢复「直连」按钮可点');
  on('disconnected', '');
  assert(st.textContent === '未连接', 'disconnected → 状态栏回到「未连接」');
  assert(dbtn.disabled === false, 'disconnected 后按钮仍可用');

  console.log('\n[8] 引脚修复入口（设备引脚被写坏时的兜底）');
  const fixBtn = document.getElementById('btn-eink-fixpins');
  assert(!!fixBtn, '★ 页面存在「修复引脚配置」按钮');
  assert(fixBtn.disabled === true, '未连接时「修复引脚配置」不可点');
  on('connected', 'NRF_EPD_246B');
  assert(fixBtn.disabled === false, '★ 连接后「修复引脚配置」可用');
  click(fixBtn);
  assert(repairCalls.length === 1, '★ 点击后调用原生 einkRepairPins');

  on('devcfg', 'ffffffffffffff07|03');
  const tst = document.getElementById('toast');
  assert(tst && tst.textContent.indexOf('引脚配置异常') >= 0,
    '★ 设备自报引脚与预期不符时主动提示：' + (tst ? tst.textContent : ''));
  on('pins-fixed', '1413060504030207');
  assert(tst.textContent.indexOf('引脚配置已回写') >= 0,
    '★ 引脚回写成功后提示断开重连确认');

  console.log('\n' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
