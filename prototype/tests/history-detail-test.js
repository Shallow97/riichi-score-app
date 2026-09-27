/**
 * history-detail-test.js — 验证「对局历史 → 对局详情」新增的逐局分数记录
 * 覆盖：
 *  1) 历史详情顶部仍显示最终结果（各玩家最终分）
 *  2) 最终结果下方追加逐局分数记录（时间正序：东1局·0本…）
 *  3) 逐局里每家结束分/净变化，颜色类 up绿/down红/zero
 *  4) 无逐局记录的历史条目 → 显示空态提示
 * 运行：NODE_PATH=<workspace>/node_modules node history-detail-test.js
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
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.eval(fs.readFileSync(path.join(ROOT, 'js/rules.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/storage.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8'));
  const { document } = window;
  document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

  // 建三人局
  document.getElementById('btn-goto-history').click();
  document.getElementById('btn-new-game-history').click();
  document.getElementById('mode-3').click();
  document.getElementById('btn-next-setup').click();
  document.querySelectorAll('.setup-name').forEach((inp) => { inp.value = 'H' + inp.dataset.wind; });
  document.getElementById('btn-create-game').click();
  assert(document.getElementById('page-main').classList.contains('active'), '进入对局主界面');

  console.log('\n== 1: 结算两局（东1局·0本、东2局·0本）后结束对局入历史 ==\n');
  // 第1手：H南 放铳 H西 2000（闲家H西和牌→换庄，进入东2局·0本）
  function settleRon(payerWind, recvWind, amt) {
    document.getElementById('btn-tsumo-ron').click();
    document.getElementById('btn-settle-ron').click();
    Array.from(document.querySelectorAll('#pay-pick .p')).find((p) => p.textContent.includes(payerWind)).click();
    Array.from(document.querySelectorAll('#recv-pick .p')).find((p) => p.textContent.includes(recvWind)).click();
    document.getElementById('settle-amount').value = String(amt);
    document.getElementById('btn-settle-confirm').click();
    document.getElementById('btn-result-close').click();
  }
  settleRon('H南', 'H西', 2000);
  // 第2手：H东 放铳 H南 1000
  settleRon('H东', 'H南', 1000);
  // 结束对局
  document.getElementById('btn-end').click();
  document.getElementById('btn-end-confirm').click();
  assert(document.getElementById('page-history').classList.contains('active'), '结束后进入历史页');

  console.log('\n== 2: 打开历史详情，最终结果 + 逐局记录（时间正序） ==\n');
  const items = document.querySelectorAll('#history-list .list-item');
  assert(items.length >= 1, '历史列表有记录');
  items[0].click();
  assert(document.getElementById('modal-detail').classList.contains('show'), '历史详情弹窗打开');
  const db = document.getElementById('detail-body').textContent;
  assert(db.includes('最终结果'), '详情含"最终结果"分区');
  assert(db.includes('逐局分数记录'), '详情含"逐局分数记录"分区');
  // 顶部最终结果：初始35000；第1手H西+2000=37000、H南-2000=33000；第2手H东-1000=34000、H南+1000=34000
  const detailTitle = document.getElementById('detail-body').textContent;
  assert(detailTitle.includes('H东：34000点'), '最终结果显示 H东 34000 点');
  assert(detailTitle.includes('H南：34000点'), '最终结果显示 H南 34000 点');
  assert(detailTitle.includes('H西：37000点'), '最终结果显示 H西 37000 点');
  // 逐局记录按时间先后（最旧在上）
  const handLabels = Array.from(document.querySelectorAll('#detail-body .rl-hand-label')).map((e) => e.textContent);
  assert(handLabels.length === 2, '共2条逐局记录：' + JSON.stringify(handLabels));
  assert(handLabels[0] === '东1局·0本' && handLabels[1] === '东2局·0本', '时间正序（东1局→东2局）：' + JSON.stringify(handLabels));
  // 首条（东1局）里 H西 +2000 绿、H南 -2000 红
  const firstHand = document.querySelectorAll('#detail-body .rl-hand')[0];
  const firstWest = Array.from(firstHand.querySelectorAll('.rl-player-name')).find((e) => e.textContent === 'H西').parentElement;
  assert(firstWest.querySelector('.rl-player-delta').classList.contains('up') && firstWest.querySelector('.rl-player-delta').textContent === '(+2000)', '第1手 H西 +2000 up(绿)');
  const firstSouth = Array.from(firstHand.querySelectorAll('.rl-player-name')).find((e) => e.textContent === 'H南').parentElement;
  assert(firstSouth.querySelector('.rl-player-delta').classList.contains('down') && firstSouth.querySelector('.rl-player-delta').textContent === '(-2000)', '第1手 H南 -2000 down(红)');
  // 末条（东2局）里 H东 -1000 红、H南 +1000 绿
  const lastHand = document.querySelectorAll('#detail-body .rl-hand')[1];
  const lastEast = Array.from(lastHand.querySelectorAll('.rl-player-name')).find((e) => e.textContent === 'H东').parentElement;
  assert(lastEast.querySelector('.rl-player-delta').classList.contains('down') && lastEast.querySelector('.rl-player-delta').textContent === '(-1000)', '第2手 H东 -1000 down(红)');
  const lastSouth = Array.from(lastHand.querySelectorAll('.rl-player-name')).find((e) => e.textContent === 'H南').parentElement;
  assert(lastSouth.querySelector('.rl-player-delta').classList.contains('up') && lastSouth.querySelector('.rl-player-delta').textContent === '(+1000)', '第2手 H南 +1000 up(绿)');
  document.getElementById('btn-detail-delete').click();
  document.getElementById('btn-confirm-ok').click();
  assert(document.getElementById('modal-detail').classList.contains('show') === false, '删除后详情关闭');

  console.log('\n== 3: 无逐局记录的历史条目 → 空态提示 ==\n');
  // 直接注入一条无 .hand 的历史（模拟本功能上线前完成的对局）
  window.localStorage.setItem('riichi_finished', JSON.stringify([{
    id: 'legacy_1', finishedAt: '2026-09-01T00:00:00Z', mode: 3,
    endReason: '南三局结束（未开启西入）',
    players: [{ seat: '东', wind: '东', name: 'A', points: 42000, riichi: false },
              { seat: '南', wind: '南', name: 'B', points: 36000, riichi: false },
              { seat: '西', wind: '西', name: 'C', points: 27000, riichi: false }],
    history: [],   // 无可展示逐局记录的 .hand
  }]));
  document.getElementById('btn-new-game-history').click();
  document.getElementById('btn-goto-history').click();
  assert(document.getElementById('page-history').classList.contains('active'), '回到历史页');
  document.querySelectorAll('#history-list .list-item')[0].click();
  assert(document.getElementById('modal-detail').classList.contains('show'), '老历史详情弹窗打开');
  const db2 = document.getElementById('detail-body').textContent;
  assert(db2.includes('最终结果') && db2.includes('A：42000点'), '老历史仍显示最终结果摘要');
  assert(db2.includes('该对局无可展示的逐局记录'), '无逐局记录时显示空态提示');
  // 空态下不应渲染出任何 .rl-hand
  assert(document.querySelectorAll('#detail-body .rl-hand').length === 0, '空态无 .rl-hand 条目');

  console.log('\n====================================');
  console.log('测试通过: ' + pass + '，失败: ' + fail);
  console.log('====================================');
  process.exit(fail > 0 ? 1 : 0);
}

try { main(); }
catch (e) { console.error('测试异常:', e); process.exit(1); }
