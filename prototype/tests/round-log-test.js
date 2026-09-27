/**
 * round-log-test.js — 验证对局主界面下方「半庄分数记录」（可折叠区块）
 * 覆盖：
 *  1) 结算一局后出现一条记录（局号·本场 label + 各玩家结束分/净变化）
 *  2) 净变化颜色类：增加=up(绿)、减少=down(红)、0=zero
 *  3) 手动修正不产生新的结算记录
 *  4) 撤回上一局 → 对应记录消失（与 history 快照整体弹出一致）
 *  5) 折叠/展开切换
 *  6) 流局也作为一条已结算记录
 * 运行：NODE_PATH=<workspace>/node_modules node round-log-test.js
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

function main() {
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

  // 建三人局（P东/P南/P西，初始35000）
  document.getElementById('btn-goto-history').click();
  document.getElementById('btn-new-game-history').click();
  document.getElementById('mode-3').click();
  document.getElementById('btn-next-setup').click();
  document.querySelectorAll('.setup-name').forEach((inp) => { inp.value = 'P' + inp.dataset.wind; });
  document.getElementById('btn-create-game').click();
  assert(document.getElementById('page-main').classList.contains('active'), '进入对局主界面');

  const rlCard = () => document.getElementById('round-log');
  const rlBody = () => document.getElementById('round-log-body');
  const rlHands = () => document.querySelectorAll('#round-log-body .rl-hand');

  console.log('\n== 0: 初始空态与折叠区块存在 ==\n');
  assert(rlCard() !== null && rlBody() !== null, '存在半庄分数记录区块');
  assert(rlCard().classList.contains('collapsed') === false, '默认展开');
  assert(rlHands().length === 0, '尚无已结算对局（无记录）');
  assert(rlBody().textContent.includes('尚无已结算的对局'), '空态提示文案正确');

  // 荣和结算：P南 放铳给 P西 2000（东一局·0本）
  console.log('\n== 1: 结算一局出现一条记录 ==\n');
  function settleRon(payerWind, recvWind, amt) {
    document.getElementById('btn-tsumo-ron').click();
    document.getElementById('btn-settle-ron').click();
    Array.from(document.querySelectorAll('#pay-pick .p')).find((p) => p.textContent.includes(payerWind)).click();
    Array.from(document.querySelectorAll('#recv-pick .p')).find((p) => p.textContent.includes(recvWind)).click();
    document.getElementById('settle-amount').value = String(amt);
    document.getElementById('btn-settle-confirm').click();
    // 未开多响直接入账
  }
  settleRon('P南', 'P西', 2000);
  assert(document.getElementById('modal-result').classList.contains('show'), '荣和结算结果弹窗出现');
  document.getElementById('btn-result-close').click();

  assert(rlHands().length === 1, '结算后出现 1 条记录（当前=' + rlHands().length + '）');
  const labelEl = rlCard().querySelector('.rl-hand-label');
  assert(labelEl && labelEl.textContent === '东1局·0本', 'label 为 东1局·0本（实际=' + (labelEl && labelEl.textContent) + '）');
  // P东 35000(0) 不变；P南 34000(-2000)；P西 37000(+2000)  —— 放铳P南扣，和牌P西加
  const firstHandPlayers = rlCard().querySelector('.rl-hand-players').textContent;
  const P = (n) => {
    const span = Array.from(rlCard().querySelectorAll('.rl-player-name')).find((e) => e.textContent === n);
    return span && span.parentElement;
  };
  const westDelta = P('P西').querySelector('.rl-player-delta');
  assert(westDelta.classList.contains('up') && westDelta.textContent === '(+2000)', '和牌者P西显示 +2000 且类为 up(绿): ' + westDelta.textContent);
  const southDelta = P('P南').querySelector('.rl-player-delta');
  assert(southDelta.classList.contains('down') && southDelta.textContent === '(-2000)', '放铳者P南显示 -2000 且类为 down(红): ' + southDelta.textContent);
  const eastDelta = P('P东').querySelector('.rl-player-delta');
  assert(eastDelta.classList.contains('zero') && eastDelta.textContent === '(0)', '未涉者P东显示 (0) 且类为 zero: ' + eastDelta.textContent);
  const wpts = P('P西').querySelector('.rl-player-pts').textContent;
  assert(wpts === '37000', 'P西结束分 37000: ' + wpts);

  console.log('\n== 2: 手动修正不产生新的结算记录 ==\n');
  const cntBeforeAdjust = rlHands().length;
  // 手动修正 P东 +500（不是一局结算）
  document.getElementById('btn-adjust').click();
  document.getElementById('btn-adjust-type-score').click();
  Array.from(document.querySelectorAll('#adjust-pick .p')).find((p) => p.textContent.includes('P东')).click();
  document.getElementById('adjust-delta').value = '500';
  document.getElementById('btn-adjust-confirm').click();
  assert(rlHands().length === cntBeforeAdjust, '手动修正后记录数不变（仍=' + rlHands().length + '）');

  console.log('\n== 3: 撤回 → 记录相应消失 ==\n');
  // 此刻 history=[hand(荣和结算), adjust(手动+500)]。撤第一次弹出的是手动修正快照（无 hand 标记），记录数不变；
  // 撤第二次弹出荣和结算快照，记录随之清空 —— 验证记录与快照同生命周期。
  document.getElementById('btn-undo').click();
  document.getElementById('btn-confirm-ok').click();
  assert(rlHands().length === 1, '撤第一次(手动修正)后记录仍为1条（hand 快照未弹）');
  document.getElementById('btn-undo').click();
  document.getElementById('btn-confirm-ok').click();
  assert(rlHands().length === 0, '撤第二次(荣和结算)后记录清空');

  console.log('\n== 4: 流局也计入一条记录（其他流局，delta 全 0） ==\n');
  document.getElementById('btn-flow').click();
  document.getElementById('flow-other').click();
  document.getElementById('btn-result-close').click();
  assert(rlHands().length === 1, '其他流局产生 1 条记录（当前=' + rlHands().length + '）');
  const flowAllZero = Array.from(rlCard().querySelectorAll('.rl-player-delta')).every((d) => d.textContent === '(0)');
  assert(flowAllZero, '其他流局各玩家 delta 均为 (0)');

  console.log('\n== 5: 折叠/展开 ==\n');
  assert(rlBody().style.display !== 'none', '展开时 body 可见');
  rlCard().querySelector('#round-log-head').click();
  assert(rlCard().classList.contains('collapsed'), '点击标题后折叠（加 collapsed 类）');
  // 折叠态下 body 隐藏（css 控制），js 层不改变 display
  rlCard().querySelector('#round-log-head').click();
  assert(rlCard().classList.contains('collapsed') === false, '再次点击后展开');

  console.log('\n====================================');
  console.log('测试通过: ' + pass + '，失败: ' + fail);
  console.log('====================================');
  process.exit(fail > 0 ? 1 : 0);
}

try { main(); }
catch (e) { console.error('测试异常:', e); process.exit(1); }
