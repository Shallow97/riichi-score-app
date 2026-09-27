/**
 * end-kyotaku-guard-test.js — 回归测试：「结束并保存」遇到剩余供托时的拦截与修正引导
 *
 * 背景：半庄因流局等结束但场上仍有立直棒供托未归入玩家时，直接保存会产生
 *       各玩家总分对不上账(四人≠100000/三人≠105000)的历史记录。
 * 本测试验证 app.js 的拦截逻辑：
 *   1. 供托>0 时点「结束并保存」→ 打开"当前存在剩余供托"提示弹窗，不归档
 *   2. 点「关闭」→ 仅关闭弹窗，回到对局主界面，不结束对局
 *   3. 点「修正供托点」→ 进入现有"修正供托点"弹窗
 *   4. 把供托修正到0 → 回到对局主界面，供托归零
 *   5. 再次「结束并保存」→ 供托已为0，正常归档进入历史页
 *
 * 运行：NODE_PATH=<workspace>/node_modules node end-kyotaku-guard-test.js
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
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;

  const rulesCode = fs.readFileSync(path.join(ROOT, 'js/rules.js'), 'utf8');
  const storageCode = fs.readFileSync(path.join(ROOT, 'js/storage.js'), 'utf8');
  const appCode = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  window.eval(rulesCode);
  window.eval(storageCode);

  // —— 在 app 加载前，先构造"半庄已结束但场上仍有供托2000点"的四人局并存为活跃对局 ——
  // init() 会 loadActive 到内存并进入主界面；over=true 显示结束横幅。
  window.eval(`
    (function(){
      var g = Rules.createGame(4, { westRule: false, dealerName: 'P东' });
      g.players.forEach(function(p, i){ p.name = 'P' + p.wind; });
      g.players[0].points = 20000; g.players[1].points = 21000;
      g.players[2].points = 25000; g.players[3].points = 32000;
      g.players[3].riichiBars = 2;
      g.kyotaku = 2000;
      g.over = true;
      g.endReason = '南四局流局结束（未开启西入）';
      Storage.saveActive(g);
    })();
  `);
  // 从 Node 侧经 window.Storage 读取持久化状态进行预置校验（不依赖 window.eval 的返回值）
  const preset = window.Storage.loadActive();
  assert(!!preset && preset.over === true && preset.kyotaku === 2000, '预置活跃对局：over=true 且供托=2000');
  const presetSum = preset ? preset.players.reduce((s, p) => s + p.points, 0) + preset.kyotaku : 0;
  assert(presetSum === 100000, `预置守恒：玩家总分98000 + 供托2000 = 100000 (实得${presetSum})`);

  window.eval(appCode);
  document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

  const activeKey = 'riichi_active_game';
  const finishedKey = 'riichi_finished';
  const finishCount = () => {
    try { return JSON.parse(window.localStorage.getItem(finishedKey) || '[]').length; }
    catch (e) { return 0; }
  };

  console.log('\n== 进入对局主界面(半庄已结束) ==\n');
  assert(document.getElementById('page-main').classList.contains('active'), '加载活跃对局进入主界面');
  assert(document.getElementById('end-banner').style.display === 'block', '显示半庄结束横幅');
  assert(document.getElementById('center-kyotaku').textContent.includes('2000'), '桌面显示供托2000');

  console.log('\n== 场景A: 供托>0 时「结束并保存」应被拦截 ==\n');
  const histBefore = finishCount();
  document.getElementById('btn-end').click();
  assert(document.getElementById('modal-end').classList.contains('show'), '「结束对局」弹窗打开');
  document.getElementById('btn-end-confirm').click();
  assert(document.getElementById('modal-end-kyotaku').classList.contains('show'), '供托>0 时弹出「当前存在剩余供托」提示窗');
  assert(!document.getElementById('modal-end').classList.contains('show'), '提示窗出现时「结束对局」弹窗已关闭');
  assert(finishCount() === histBefore, '拦截时未写入历史(结束未被保存)');
  assert(window.localStorage.getItem(activeKey) !== null, '拦截时活跃对局仍保留');
  const warnText = document.getElementById('end-kyotaku-msg').textContent;
  assert(warnText.includes('2000') && warnText.includes('100000'), '提示文案含供托数与应达总分(四人100000)');

  console.log('\n== 场景B: 点「关闭」→ 回到对局界面，不结束 ==\n');
  document.getElementById('btn-end-kyotaku-close').click();
  assert(!document.getElementById('modal-end-kyotaku').classList.contains('show'), '点「关闭」后提示窗关闭');
  assert(document.getElementById('page-main').classList.contains('active'), '仍在对局主界面');
  assert(finishCount() === histBefore && window.localStorage.getItem(activeKey) !== null, '关闭后对局未结束、未归档');

  console.log('\n== 场景C: 点「修正供托点」→ 进入现有修正供托点功能 ==\n');
  document.getElementById('btn-end').click();
  document.getElementById('btn-end-confirm').click();
  assert(document.getElementById('modal-end-kyotaku').classList.contains('show'), '再次拦截出现提示窗');
  document.getElementById('btn-end-fix-kyotaku').click();
  assert(document.getElementById('modal-adjust-kyotaku').classList.contains('show'), '点「修正供托点」进入修正供托点弹窗');
  assert(!document.getElementById('modal-end-kyotaku').classList.contains('show'), '提示窗已关闭');
  assert(document.getElementById('adjust-kyotaku-value').value === '2000', '修正弹窗默认值=当前剩余供托2000');

  console.log('\n== 场景D: 修正供托到0(指定玩家取回) ==\n');
  const payerSel = document.getElementById('adjust-kyotaku-payer');
  const eastIdx = Array.from(payerSel.options).findIndex((o) => o.value === 'P东');
  assert(eastIdx >= 0, '修正供托下拉含 P东');
  payerSel.selectedIndex = eastIdx;
  document.getElementById('adjust-kyotaku-value').value = '0';
  document.getElementById('btn-kyotaku-confirm').click();
  assert(!document.getElementById('modal-adjust-kyotaku').classList.contains('show'), '确认修正后供托弹窗关闭');
  assert(document.getElementById('page-main').classList.contains('active'), '修正后回到对局主界面');
  assert(document.getElementById('center-kyotaku').textContent.includes('0'), '桌面供托归0');
  assert(finishCount() === histBefore && window.localStorage.getItem(activeKey) !== null, '修正供托本身不触发结束归档');

  console.log('\n== 场景E: 供托归0后「结束并保存」应正常归档 ==\n');
  document.getElementById('btn-end').click();
  assert(document.getElementById('modal-end').classList.contains('show'), '再次打开「结束对局」弹窗');
  assert(!document.getElementById('modal-end-kyotaku').classList.contains('show'), '供托已为0，不再弹剩余供托提示');
  document.getElementById('btn-end-confirm').click();
  assert(document.getElementById('page-history').classList.contains('active'), '供托归0后正常结束并跳转历史页');
  assert(finishCount() === histBefore + 1, '历史记录新增1条');
  assert(window.localStorage.getItem(activeKey) === null, '结束归档后活跃对局已清空');

  console.log('\n====================================');
  console.log('结束对局·剩余供托拦截测试: ' + pass + ' 通过，' + fail + ' 失败');
  console.log('====================================');
  dom.window.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
