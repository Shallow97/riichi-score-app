/**
 * noten-bappu-test.js — 荒牌流局（未听罚符）总转移修正 专项测试
 *
 * 规则（用户修正后）：
 *  - 全部听牌 或 无人听牌 → 无分数转移（0）
 *  - 其余情形（有人听牌有人未听）→ 总转移固定：
 *      四人模式 3000 点、三人模式 2000 点；
 *      听牌者平分收、未听者平分付。
 *
 * 回归目标：修复前"总转移 = 3000 × 听牌人数"，导致三人 2 听牌时
 * 未听者被扣 6000（应为下一位数）；另附三人模式 3000→2000 的口径变更。
 *
 * 运行：NODE_PATH=<workspace>/node_modules node noten-bappu-test.js
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

function readSeatPts(document) {
  const m = {};
  Array.from(document.querySelectorAll('#table-seats .seat')).forEach((s) => {
    m[s.querySelector('.name').textContent] = parseInt(s.querySelector('.pts').textContent, 10);
  });
  return m;
}

async function main() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const rulesCode = fs.readFileSync(path.join(ROOT, 'js/rules.js'), 'utf8');
  const storageCode = fs.readFileSync(path.join(ROOT, 'js/storage.js'), 'utf8');
  const appCode = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  window.eval(rulesCode);
  window.eval(storageCode);
  const { document } = window;
  window.eval(appCode);
  document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

  /** 开一局 mode(3/4)，用户名取 P东/P南/P西(/P北) */
  function startGame(mode) {
    // 确保回到模式页（清 active 状态）
    if (typeof window.showMode === 'function') { try { window.showMode(); } catch (e) {} }
    document.getElementById(mode === 3 ? 'mode-3' : 'mode-4').click();
    document.getElementById('btn-next-setup').click();
    document.querySelectorAll('.setup-name').forEach((inp) => { inp.value = 'P' + inp.dataset.wind; });
    document.getElementById('btn-create-game').click();
  }

  /** 驱动一次荒牌流局，选中 tenpaiNames 为听牌者，返回 { 玩家名: 净增减 } */
  function doFlow(tenpaiNames) {
    document.getElementById('btn-flow').click();
    document.getElementById('flow-koei').click();
    const before = readSeatPts(document);
    Array.from(document.querySelectorAll('#tanyou-pick .p')).forEach((it) => {
      const nm = it.querySelector('.name').textContent;
      if (tenpaiNames.includes(nm)) it.classList.add('selected');
    });
    document.getElementById('btn-koei-confirm').click();
    const after = readSeatPts(document);
    document.getElementById('btn-result-close').click();
    const delta = {};
    Object.keys(after).forEach((k) => { delta[k] = after[k] - before[k]; });
    return delta;
  }

  const players = (n) => (n === 3 ? ['P东', 'P南', 'P西'] : ['P东', 'P南', 'P西', 'P北']);
  function totalTransfer(delta) {
    let recv = 0, pay = 0;
    Object.keys(delta).forEach((k) => { if (delta[k] > 0) recv += delta[k]; else pay += -delta[k]; });
    return { recv, pay };
  }

  console.log('\n== 四人局：荒牌流局 ==\n');
  startGame(4);

  let d;

  d = doFlow(['P东']);
  let t = totalTransfer(d);
  assert(t.recv === 3000 && t.pay === 3000, '4人1听：总转移3000 (收' + t.recv + '/付' + t.pay + ')');
  assert(d['P东'] === 3000, '听牌者P东 +3000');
  assert(d['P南'] === -1000 && d['P西'] === -1000 && d['P北'] === -1000, '未听3家各 -1000');

  d = doFlow(['P东', 'P南']);
  t = totalTransfer(d);
  assert(t.recv === 3000 && t.pay === 3000, '4人2听：总转移3000 (收' + t.recv + '/付' + t.pay + ')');
  assert(d['P东'] === 1500 && d['P南'] === 1500, '两位听牌者各 +1500');
  assert(d['P西'] === -1500 && d['P北'] === -1500, '未听2家各 -1500');

  d = doFlow(['P东', 'P南', 'P西']);
  t = totalTransfer(d);
  assert(t.recv === 3000 && t.pay === 3000, '4人3听：总转移3000 (收' + t.recv + '/付' + t.pay + ')');
  assert(d['P东'] === 1000 && d['P南'] === 1000 && d['P西'] === 1000, '三位听牌者各 +1000');
  assert(d['P北'] === -3000, '唯一未听者P北 -3000');

  d = doFlow(['P东', 'P南', 'P西', 'P北']);
  t = totalTransfer(d);
  assert(t.recv === 0 && t.pay === 0, '4人全部听牌：无分数转移 (收' + t.recv + '/付' + t.pay + ')');

  console.log('\n== 三人局：荒牌流局（总转移 2000） ==\n');
  startGame(3);

  d = doFlow(['P东', 'P南']);
  t = totalTransfer(d);
  assert(t.recv === 2000 && t.pay === 2000, '3人2听：总转移2000 (收' + t.recv + '/付' + t.pay + ')');
  assert(d['P东'] === 1000 && d['P南'] === 1000, '两位听牌者各 +1000');
  assert(d['P西'] === -2000, '唯一未听者P西 -2000');

  d = doFlow(['P东']);
  t = totalTransfer(d);
  assert(t.recv === 2000 && t.pay === 2000, '3人1听：总转移2000 (收' + t.recv + '/付' + t.pay + ')');
  assert(d['P东'] === 2000, '听牌者P东 +2000');
  assert(d['P南'] === -1000 && d['P西'] === -1000, '未听2家各 -1000');

  d = doFlow(['P东', 'P南', 'P西']);
  t = totalTransfer(d);
  assert(t.recv === 0 && t.pay === 0, '3人全部听牌：无分数转移 (收' + t.recv + '/付' + t.pay + ')');

  console.log('\n== 三人局：界面文案同步 ==\n');
  document.getElementById('btn-flow').click();
  document.getElementById('flow-koei').click();
  assert(document.getElementById('tanyou-hint').textContent.includes('2000'),
    '三人模式听牌勾选提示显示总转移 2000：' + document.getElementById('tanyou-hint').textContent);
  assert(document.getElementById('btn-koei-confirm').textContent.includes('2000'),
    '三人模式确认按钮显示总转移 2000：' + document.getElementById('btn-koei-confirm').textContent);

  console.log('\n====================================');
  console.log('荒牌流局总转移修正专项: ' + pass + ' 通过，' + fail + ' 失败');
  console.log('====================================');
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
