/**
 * operator-release-test.js — 端到端验证「关闭结算/立直流程弹窗 → 自动释放操作权」
 *
 * 现象2修复：某玩家点开"和牌结算/立直"弹窗占用操作权后，若通过关闭按钮(×)/点空白
 * 返回主界面而不真正完成结算，操作权也必须自动释放，否则他人只能等其刷新页面。
 *
 * 用 jsdom 加载真实 app.js，注入"持权中的成员" mock Net（amOperator=true、isInRoom=true），
 * 验证：
 *   1. 点「和牌结算」→ 打开 modal-settle-type，持权期间不自动释放
 *   2. 点弹窗关闭按钮 × → 弹窗关闭，且自动调用 Net.releaseAction()（操作权已释放）
 *   3. 点「立直」打开选人弹窗，点 × 关闭同样自动释放
 *
 * 运行：NODE_PATH=<workspace>/node_modules node tests/operator-release-test.js
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

  // 预置一局（进行中，未结束），使按钮可用
  const game = window.Rules.createGame(4, { westRule: false });
  game.players.forEach((p, i) => { p.name = 'P' + p.wind; });
  window.Storage.saveActive(game);

  // 成员身份且当前正持有操作权（模拟已成功申请操作权的结算者）
  let released = 0;
  window.Net = {
    init() {}, install() {},
    isHost() { return false; },
    isInRoom() { return true; },
    isOnline() { return true; },
    amOperator() { return this.__op !== false; },
    operatorName() { return this.__op === false ? null : 'P东'; },
    memberName() { return 'P东'; },
    memberCount() { return 3; },
    setName() {},
    requestAction() {},
    releaseAction() { released++; this.__op = false; },
    leaveRoom() {},
    onState() {}, onStatus() {}, onOperator() {}, onGameEnd() {}, endGame() {},
  };
  window.Net.__op = true; // 持权中

  window.eval(appCode);
  document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  await wait(10);

  assert(document.getElementById('page-main').classList.contains('active'), '进入对局主界面');

  // 1) 点「和牌结算」→ 打开类型选择弹窗（持权期间正常打开）
  document.getElementById('btn-tsumo-ron').click();
  assert(document.getElementById('modal-settle-type').classList.contains('show'), '点「和牌结算」打开类型选择弹窗');
  await wait(10);
  assert(released === 0, '弹窗打开期间不自动释放操作权（仍持有）');

  // 2) 点弹窗右上角 × 关闭（不结算）→ 自动释放操作权
  const closeX = document.getElementById('modal-settle-type').querySelector('.close-x');
  assert(!!closeX, '结算类型弹窗含关闭按钮 ×');
  closeX.click();
  assert(!document.getElementById('modal-settle-type').classList.contains('show'), '点 × 后弹窗关闭，返回主界面');
  await wait(30); // 等 closeModal 的微任务(释放判定)执行
  assert(released >= 1, '关闭弹窗未完成结算 → 自动调用 releaseAction（操作权释放）');

  // 3) 立直弹窗同样：打开后点 × 关闭 → 释放
  released = 0;
  window.Net.__op = true;
  document.getElementById('btn-riichi').click();
  assert(document.getElementById('modal-riichi').classList.contains('show'), '点「立直」打开选人弹窗');
  await wait(10);
  assert(released === 0, '立直弹窗打开期间不释放');
  const riichiClose = document.getElementById('modal-riichi').querySelector('.close-x');
  riichiClose.click();
  await wait(30);
  assert(released >= 1, '关闭立直弹窗 → 自动释放操作权');
  // （"释放后他人可接手"已由 java-server-parity 用例5 覆盖：房主释放后成员申请成功）

  console.log('\n====================================');
  console.log('关闭弹窗自动释放操作权测试: ' + pass + ' 通过，' + fail + ' 失败');
  console.log('====================================');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
