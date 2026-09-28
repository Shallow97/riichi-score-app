/**
 * tsumo3-honba-loss-test.js — 三人局「本场自摸损」专项回归测试
 *
 * 规则口径（2026-09-07 修正）：本场费区分荣和/自摸，"自摸损"只作用于自摸。
 *   荣和：无自摸损 → 放铳者一人付 300×N（4人/3人均同，与人数无关）。
 *   自摸：每本每家承担 100 点，总额 = 100N×(在场其他家数)。
 *     四人(其他3家)=300N（各家各100N）；三人缺北(仅2家,自摸损)=200N（两家各100N）。
 *
 * 覆盖：
 *   场景1 三人·庄自摸·1本场 → 自摸者 +200(番符另计)、两闲各 −100
 *   场景2 三人·闲自摸·1本场 → 自摸者 +200、另一闲−100、庄−100
 *   场景3 四人·庄自摸·1本场 → 自摸者 +300、三闲各 −100（回归，行为不变）
 *   场景4 三人·荣和·1本场   → 放铳者付 300、赢家收 300（荣和无自摸损，第三人不受影响）
 *   场景5 三人·庄自摸·3本场 → 自摸者 +600、两闲各 −300，场上总分守恒 105000
 *
 * 运行：NODE_PATH=<workspace>/node_modules node tsumo3-honba-loss-test.js
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
    const m = it.textContent.replace(/\s+/g, ' ').match(/(P[东南西北])：(\d+)点 \(([+-]?\d+)\)/);
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

  function build(mode) {
    document.getElementById(mode === 3 ? 'mode-3' : 'mode-4').click();
    document.getElementById('btn-next-setup').click();
    document.querySelectorAll('.setup-name').forEach((inp) => { inp.value = 'P' + inp.dataset.wind; });
    document.getElementById('btn-create-game').click();
    assert(document.getElementById('page-main').classList.contains('active'), '建 ' + mode + ' 人局进入主界面');
  }
  function setHonbaN(v) {
    document.getElementById('btn-adjust').click();
    document.getElementById('btn-adjust-type-honba').click();
    document.getElementById('adjust-honba-value').value = String(v);
    document.getElementById('btn-honba-confirm').click();
    document.getElementById('btn-confirm-ok').click();
    assert(document.getElementById('center-honba').textContent.includes(String(v)), '本场数设为 ' + v);
    const hx = document.querySelector('#modal-adjust-honba .close-x');
    if (hx) hx.click();
  }
  function newGame() {
    document.getElementById('btn-result-close') && document.getElementById('btn-result-close').click();
    document.getElementById('btn-new-game').click();
    document.getElementById('btn-confirm-ok').click();
    assert(document.getElementById('page-mode').classList.contains('active'), '回到模式选择页');
  }
  function startTsumo(selfWind) {
    document.getElementById('btn-tsumo-ron').click();
    document.getElementById('btn-settle-tsumo').click();
    pickText('#tsumo-pick .p', selfWind).click();
  }
  // 自摸录入并结算。shared=庄自摸单值; koha/oya=闲自摸两值
  function tsumoSettle(shared, koha, oya) {
    const s = document.querySelector('.tsumo-shared');
    if (s) s.value = String(shared);
    else {
      if (koha != null) document.querySelector('.tsumo-koha').value = String(koha);
      if (oya != null) document.querySelector('.tsumo-oya').value = String(oya);
    }
    document.getElementById('btn-tsumo-confirm').click();
    assert(document.getElementById('modal-result').classList.contains('show'), '进入结算结果弹窗');
  }

  console.log('\n===== 场景1：三人·庄家(P东)自摸·1本场 → 自摸损 收200/两闲各−100 =====');
  build(3); setHonbaN(1);
  startTsumo('P东');
  const hint1 = document.getElementById('tsumo-honba-hint').textContent;
  assert(hint1.includes('200 点') && hint1.includes('100 点') && hint1.includes('自摸损'),
    '自摸提示含 200(总额)/100(每家)/自摸损 字样: ' + hint1);
  tsumoSettle(2000, null, null);
  const net1 = readNet();
  console.log('   net: ' + JSON.stringify(net1));
  assert(net1['P东'] === 4000 + 200, '庄自摸 P东 收番符4000 + 本场200 = 4200，实际 ' + net1['P东']);
  assert(net1['P南'] === -2000 - 100, 'P南 付番符2000 + 本场100 = -2100，实际 ' + net1['P南']);
  assert(net1['P西'] === -2000 - 100, 'P西 付番符2000 + 本场100 = -2100，实际 ' + net1['P西']);

  newGame();
  console.log('\n===== 场景2：三人·闲家(P南)自摸·1本场 → 自摸损 收200 =====');
  build(3); setHonbaN(1);
  startTsumo('P南');
  const hint2 = document.getElementById('tsumo-honba-hint').textContent;
  assert(hint2.includes('200 点'), '闲自摸本场提示总额 200: ' + hint2);
  tsumoSettle(null, 1000, 2000);
  const net2 = readNet();
  console.log('   net: ' + JSON.stringify(net2));
  assert(net2['P南'] === 3000 + 200, '闲自摸 P南 收番符3000(缺北自摸损) + 本场200 = 3200，实际 ' + net2['P南']);
  assert(net2['P东'] === -2000 - 100, '庄 P东 付亲额2000 + 本场100 = -2100，实际 ' + net2['P东']);
  assert(net2['P西'] === -1000 - 100, '另一闲 P西 付子额1000 + 本场100 = -1100，实际 ' + net2['P西']);

  newGame();
  console.log('\n===== 场景3（回归）：四人·庄家(P东)自摸·1本场 → 仍收300/三闲各−100 =====');
  build(4); setHonbaN(1);
  startTsumo('P东');
  const hint3 = document.getElementById('tsumo-honba-hint').textContent;
  assert(hint3.includes('300 点') && hint3.includes('100 点'), '四人不含自摸损，总额300/每家100: ' + hint3);
  tsumoSettle(1000, null, null);
  const net3 = readNet();
  console.log('   net: ' + JSON.stringify(net3));
  assert(net3['P东'] === 3000 + 300, '四人庄自摸 P东 收番符3000 + 本场300 = 3300，实际 ' + net3['P东']);
  assert(net3['P南'] === -1100 && net3['P西'] === -1100 && net3['P北'] === -1100,
    '三闲各 −1000−100 = −1100，实际 ' + JSON.stringify(net3));

  newGame();
  console.log('\n===== 场景4：三人·荣和·1本场 → 放铳者付 300N（荣和无自摸损，与4人同）=====');
  build(3); setHonbaN(1);
  document.getElementById('btn-tsumo-ron').click();
  document.getElementById('btn-settle-ron').click();
  // 校验结算金额弹窗的荣和本场提示：放铳者多付 300
  pickText('#pay-pick .p', 'P东').click();
  pickText('#recv-pick .p', 'P南').click();
  const ronHint = document.getElementById('settle-amount-honba').textContent;
  assert(ronHint.includes('+300 点'), '荣和本场提示放铳者多付 300: ' + ronHint);
  document.getElementById('settle-amount').value = '2000';
  document.getElementById('btn-settle-confirm').click();
  assert(document.getElementById('modal-result').classList.contains('show'), '荣和入账进入结果弹窗');
  const net4 = readNet();
  console.log('   net: ' + JSON.stringify(net4));
  assert(net4['P东'] === -(2000 + 300), '放铳者 P东 付番符2000 + 本场300(荣和无自摸损) = -2300，实际 ' + net4['P东']);
  assert(net4['P南'] === 2000 + 300, '赢家 P南 收 2000 + 300 = +2300，实际 ' + net4['P南']);
  assert(net4['P西'] === 0, '第三人 P西 不受影响 = 0，实际 ' + net4['P西']);

  function readPts() {
    const out = {};
    Array.from(document.querySelectorAll('#table-seats .seat')).forEach((s) => {
      out[s.querySelector('.name').textContent] = parseInt(s.querySelector('.pts').textContent, 10);
    });
    return out;
  }
  function objSum(o) { let s = 0; for (const k in o) s += o[k]; return s; }

  newGame();
  console.log('\n===== 场景5：三人·庄自摸·3本场 → 收600，且场上总分守恒(105000) =====');
  build(3); setHonbaN(3);
  const pre5 = readPts();
  startTsumo('P东');
  const hint5 = document.getElementById('tsumo-honba-hint').textContent;
  assert(hint5.includes('600 点') && hint5.includes('300 点'), '3本场自摸总额600/每家300: ' + hint5);
  tsumoSettle(2000, null, null);
  const post5 = readPts();
  const d5 = {}; for (const k in pre5) d5[k] = post5[k] - pre5[k];
  console.log('   delta: ' + JSON.stringify(d5) + '  场上总分和(守恒应=105000): ' + (objSum(pre5) + '→' + objSum(post5)));
  assert(d5['P东'] === 4000 + 600, '3本场庄自摸 P东 +4600，实际 ' + d5['P东']);
  assert(d5['P南'] === -2000 - 300 && d5['P西'] === -2000 - 300, '两闲各 −2300，实际 ' + d5['P南'] + '/' + d5['P西']);
  assert(objSum(post5) === 105000, '场上总分守恒：三人和仍 105000，实际 ' + objSum(post5));

  console.log('\n====================================');
  console.log('三人本场自摸损专项测试: ' + pass + ' 通过，' + fail + ' 失败');
  console.log('====================================');
  if (fail > 0) process.exit(1);
}
main();
