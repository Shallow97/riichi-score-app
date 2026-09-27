/**
 * multiron-honba-kyotaku-test.js — 回归测试：一炮多响(荣和)且存在【本场数+供托】时的归属
 *
 * 规则口径（用户确认）：
 *   - 多响荣和时，本场加算 300×N 与供托都归「离放铳者行牌次序最近的和牌者」
 *     （放铳者逆时针第一个和牌者收取全部），其余和牌者不拿本场（旧实现是均分，已修正）。
 *
 * 场景：四人局开启多响。玩家 P0 立直(供托1000)后放铳，双响给 P1(南)、P2(西)；本场手动设为 2。
 *   players 数组顺序 = 索引0庄(东,P0)/1(南,P1)/2(西,P2)/3(北,P3)。
 *   放铳=P0(东)，pickKyotakuReceiver 从 P0 的下家 P1 开始找第一个赢家 → P1。
 *   期望：供托 1000 与 本场 300×2=600 都归 P1；P2 只拿自己录入的和牌点数，不拿本场。
 *   P0 付 = (两笔和牌分) + 600 + 1000(本局立直款) ；展示净变化总和守恒为 0。
 *   （立直款计入立直当局的口径见 riichi-delta-test.js，2026-09-11 起生效）
 *
 * 运行：NODE_PATH=<workspace>/node_modules node multiron-honba-kyotaku-test.js
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
function pickText(sel, text) {
  return Array.from(document.querySelectorAll(sel)).find((p) => p.textContent.includes(text));
}
function readNet() {
  const rp = Array.from(document.querySelectorAll('#result-players .list-item'));
  const net = {};
  rp.forEach((it) => {
    const txt = it.textContent.replace(/\s+/g, ' ');
    const m = txt.match(/(P[东南西北])：(\d+)点 \(([+-]?\d+)\)/);
    if (m) net[m[1]] = parseInt(m[3], 10);
  });
  return net;
}

let document, window;
async function main() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  window = dom.window; document = window.document;
  window.eval(fs.readFileSync(path.join(ROOT, 'js/rules.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/storage.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8'));
  document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  window.localStorage.removeItem('riichi_active_game');

  console.log('\n== 建四人局并开启一炮多响 ==\n');
  document.getElementById('mode-4').click();
  document.getElementById('btn-next-setup').click();
  document.querySelectorAll('.setup-name').forEach((inp) => { inp.value = 'P' + inp.dataset.wind; });
  document.getElementById('switch-multiron').classList.add('on');
  document.getElementById('btn-create-game').click();
  assert(document.getElementById('page-main').classList.contains('active'), '进入对局主界面');

  console.log('\n== 预置供托：P0(庄/东) 立直 → 供托1000 ==\n');
  document.getElementById('btn-riichi').click();
  pickText('#riichi-pick .p', 'P东').click();
  assert(document.querySelector('#center-kyotaku').textContent.includes('1000') ||
         Array.from(document.querySelectorAll('*')).some((e) => e.id === 'center-kyotaku' && e.textContent.includes('供托 1000')), 'P0 立直后供托为 1000');
  const kyotakuTxt = document.getElementById('center-kyotaku').textContent;
  console.log('   (供托显示: ' + kyotakuTxt + ')');

  console.log('\n== 预置本场数：手动修正 → 2 本 ==\n');
  document.getElementById('btn-adjust').click();
  document.getElementById('btn-adjust-type-honba').click();
  document.getElementById('adjust-honba-value').value = '2';
  document.getElementById('btn-honba-confirm').click();
  assert(document.getElementById('modal-confirm').classList.contains('show'), '本场修正需二次确认');
  document.getElementById('btn-confirm-ok').click();
  assert(document.getElementById('center-honba').textContent.includes('2'), '本场数设为 2: ' + document.getElementById('center-honba').textContent);
  // 关闭本场弹窗
  const hx = document.querySelector('#modal-adjust-honba .close-x');
  if (hx) hx.click();

  console.log('\n== 第1笔荣和：付分人 P0(东) → 收分人 P1(南) ==\n');
  document.getElementById('btn-tsumo-ron').click();
  document.getElementById('btn-settle-ron').click();
  pickText('#pay-pick .p', 'P东').click();
  pickText('#recv-pick .p', 'P南').click();
  document.getElementById('settle-amount').value = '2000';
  document.getElementById('btn-settle-confirm').click();
  assert(document.getElementById('modal-settle-more').classList.contains('show'), '第1笔后询问"是否还有其它和牌者"');

  console.log('\n== 第2笔荣和：仍由 P0 放铳 → 收分人 P2(西) ==\n');
  document.getElementById('btn-settle-more-yes').click();
  pickText('#recv-pick .p', 'P西').click();
  document.getElementById('settle-amount').value = '1000';
  document.getElementById('btn-settle-confirm').click();
  assert(document.getElementById('modal-settle-more').classList.contains('show'), '第2笔后询问');

  console.log('\n== 完成结算（此时本场2、供托1000） ==\n');
  document.getElementById('btn-settle-more-done').click();
  assert(document.getElementById('modal-result').classList.contains('show'), '显示结果弹窗');

  console.log('\n== 校验归属（本场600与供托1000都应归离P0最近的赢家=P南） ==\n');
  const net = readNet();
  console.log('   net: ' + JSON.stringify(net));
  // 净变化（含 P0 本局立直已扣的 1000 —— 2026-09-11 起立直款计入立直当局）：
  // 和牌点数 P1+2000 / P2+1000；本场600归P1；供托1000归P1；P0立直-1000。
  assert(net['P东'] === -(2000 + 1000) - 600 - 1000, 'P0(放铳+立直)净付 3000+600+1000立直=4600，实际 ' + net['P东']);
  assert(net['P南'] === 2000 + 600 + 1000, 'P1(最近赢家) 收和牌2000+本场600+供托1000=3600，实际 ' + net['P南']);
  assert(net['P西'] === 1000, 'P2(远赢家) 只收和牌1000、不拿本场/供托，实际 ' + net['P西']);
  assert(net['P北'] === 0, 'P3(未参与) 净 0，实际 ' + net['P北']);
  // 守恒：立直款与其在供托中的收入现在都计入本局，展示净变化总和应为 0。
  const sum = Object.values(net).reduce((a, b) => a + b, 0);
  assert(sum === 0, '展示净变化和 = 0（立直款 -1000 与供托收入 +1000 同局计入），实际 ' + sum);

  // 供托收入文字应指向 P南
  const kEl = document.getElementById('result-kyotaku');
  assert(kEl && kEl.style.display !== 'none' && kEl.textContent.includes('P南') && kEl.textContent.includes('1000'),
    '供托收入提示归P南1000: ' + (kEl ? kEl.textContent : '无'));

  console.log('\n====================================');
  console.log('多响+本场+供托归属测试: ' + pass + ' 通过，' + fail + ' 失败');
  console.log('====================================');
  dom.window.close();
  process.exit(fail === 0 ? 0 : 1);
}

main();
