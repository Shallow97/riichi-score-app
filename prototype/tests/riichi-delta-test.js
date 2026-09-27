/**
 * riichi-delta-test.js — 回归：立直扣的 1000 点必须计入「立直那一局」的分数变化
 *
 * 背景（用户 2026-09-11 反馈）：
 *   A 立直、B 放铳给 C 满贯，A 的逐局变化却显示 (0)，实际应为 (-1000)。
 *   根因：buildHandRecord 的 delta = 结算后分数 − 快照分数，而快照是 applyRoundResult
 *   一进门才拍的，此时立直的 1000 早已入供托池，落在快照之前 → 差值里没有它。
 *
 * 口径（用户确认）：
 *   - 立直 -1000 记在「立直的那一局」；供托被收走时 +1000 记在「收走的那一局」（现有行为）。
 *   - 因此跨局相加仍守恒：各局 delta 之和 + 留在池里的供托 = 0。
 *   - 三处显示同步：结算结果弹窗、半庄分数记录、历史详情逐局记录。
 *   - 只对新对局生效；老对局的 hand 记录没有 riichi 字段 → 原样显示（无标记、不补记）。
 *   - 记录里给立直者加一个迷你立直棒小标记。
 *
 * 运行：NODE_PATH=<workspace>/node_modules node riichi-delta-test.js
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

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const { document } = window;

function newGame3(prefix) {
  document.getElementById('btn-goto-history').click();
  document.getElementById('btn-new-game-history').click();
  document.getElementById('mode-3').click();
  document.getElementById('btn-next-setup').click();
  document.querySelectorAll('.setup-name').forEach((inp) => { inp.value = prefix + inp.dataset.wind; });
  document.getElementById('btn-create-game').click();
}
function pick(sel, wind) {
  return Array.from(document.querySelectorAll(sel)).find((p) => p.textContent.includes(wind));
}
/** 立直（点一次即立直） */
function riichi(wind) {
  document.getElementById('btn-riichi').click();
  pick('#riichi-pick .p', wind).click();
}
/** 荣和：payer 放铳给 recv 付 amt（amt 不含本场加算） */
function settleRon(payer, recv, amt) {
  document.getElementById('btn-tsumo-ron').click();
  document.getElementById('btn-settle-ron').click();
  pick('#pay-pick .p', payer).click();
  pick('#recv-pick .p', recv).click();
  document.getElementById('settle-amount').value = String(amt);
  document.getElementById('btn-settle-confirm').click();
}
/** 读结算结果弹窗的净变化 */
function readPopupNet() {
  const net = {};
  document.querySelectorAll('#result-players .list-item').forEach((it) => {
    const m = it.textContent.replace(/\s+/g, ' ').match(/([^：\s]+)：(-?\d+)点 \(([+-]?\d+)\)/);
    if (m) net[m[1]] = parseInt(m[3], 10);
  });
  return net;
}
/** 读「半庄分数记录」（最新在前），返回 [{label, players:[{name,pts,delta,cls,riichi}]}] */
function readLog() {
  return Array.from(document.querySelectorAll('#round-log-body .rl-hand')).map((h) => ({
    label: h.querySelector('.rl-hand-label').textContent,
    players: Array.from(h.querySelectorAll('.rl-player')).map((sp) => ({
      name: sp.querySelector('.rl-player-name').textContent,
      pts: parseInt(sp.querySelector('.rl-player-pts').textContent.replace(/[^0-9-]/g, ''), 10),
      delta: parseInt(sp.querySelector('.rl-player-delta').textContent.replace(/[()]/g, ''), 10),
      cls: sp.querySelector('.rl-player-delta').className.replace('rl-player-delta ', ''),
      riichi: !!sp.querySelector('.rl-player-riichi'),
    })),
  }));
}
function logPlayer(rec, name) {
  return rec.players.find((p) => p.name === name);
}
function sumDeltas(rec) {
  return rec.players.reduce((s, p) => s + p.delta, 0);
}

function main() {
  window.eval(fs.readFileSync(path.join(ROOT, 'js/rules.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/storage.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8'));
  document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

  // ==================================================================
  console.log('\n== 1: 用户报告的场景 —— P东立直、P南放铳给P西满贯8000 ==\n');
  // ==================================================================
  newGame3('P');
  riichi('P东');
  assert(document.getElementById('center-kyotaku').textContent.includes('1000'), '立直后供托=1000');
  settleRon('P南', 'P西', 8000);
  document.getElementById('btn-result-close').click();

  const log1 = readLog();
  assert(log1.length === 1, '半庄分数记录出现 1 条（实际=' + log1.length + '）');
  const h1 = log1[0];
  const P东 = logPlayer(h1, 'P东'), P南 = logPlayer(h1, 'P南'), P西 = logPlayer(h1, 'P西');
  assert(P东.delta === -1000 && P东.cls === 'down', 'P东(立直、未和牌) 变化 = -1000 且红(down)：实际 ' + P东.delta + '/' + P东.cls);
  assert(P东.pts === 34000, 'P东结束分 34000：实际 ' + P东.pts);
  assert(P南.delta === -8000 && P南.cls === 'down', 'P南(放铳) 变化 = -8000：实际 ' + P南.delta);
  assert(P西.delta === 9000 && P西.cls === 'up', 'P西(和牌8000+供托1000) 变化 = +9000：实际 ' + P西.delta);
  assert(P西.pts === 44000, 'P西结束分 44000：实际 ' + P西.pts);
  assert(sumDeltas(h1) === 0, '本局 delta 之和 = 0（立直款与供托收入在本局内配平）：实际 ' + sumDeltas(h1));

  console.log('\n  -- 立直小标记 --');
  assert(P东.riichi === true, '立直者 P东 名字后带立直小标记');
  assert(P南.riichi === false && P西.riichi === false, '未立直者无标记');
  assert(document.querySelectorAll('#round-log-body .rl-player-riichi').length === 1, '全表仅 1 个立直标记');
  assert(P东.pts === 34000 && h1.players.map((p) => p.name).join() === 'P东,P南,P西', '记录仍按 players 顺序列出三家');

  console.log('\n  -- 结算结果弹窗同步 --');
  // 弹窗已在上面读不到（已关闭），重跑一次同类场景校验
  newGame3('Q');
  riichi('Q东');
  settleRon('Q南', 'Q西', 8000);
  const net2 = readPopupNet();
  assert(net2['Q东'] === -1000, '弹窗中 Q东(立直) 显示 -1000：实际 ' + net2['Q东']);
  assert(net2['Q南'] === -8000, '弹窗中 Q南(放铳) 显示 -8000：实际 ' + net2['Q南']);
  assert(net2['Q西'] === 9000, '弹窗中 Q西 显示 +9000：实际 ' + net2['Q西']);
  assert(Object.values(net2).reduce((a, b) => a + b, 0) === 0, '弹窗 delta 之和 = 0：实际 ' + Object.values(net2).reduce((a, b) => a + b, 0));
  document.getElementById('btn-result-close').click();

  // ==================================================================
  console.log('\n== 2: 立直者自己荣和收走供托 → -1000 与 +1000 相抵 ==\n');
  // ==================================================================
  newGame3('R');
  riichi('R东');                                    // 35000 → 34000，池 1000
  settleRon('R南', 'R东', 1000);                    // 荣和1000 + 供托1000 归 R东
  document.getElementById('btn-result-close').click();
  const h2 = readLog()[0];
  const R东 = logPlayer(h2, 'R东');
  assert(R东.delta === 1000, 'R东 本局净变化 = +1000（荣和1000 + 供托1000 − 立直1000）：实际 ' + R东.delta);
  assert(R东.pts === 36000, 'R东 结束分 36000：实际 ' + R东.pts);
  assert(R东.riichi === true, 'R东 仍带立直小标记（-1000 是立直款，非误记）');
  assert(sumDeltas(h2) === 0, '本局 delta 之和 = 0：实际 ' + sumDeltas(h2));

  // ==================================================================
  console.log('\n== 3: 立直后流局（供托继承）→ 立直款留在立直局，池子由下局和牌者收 ==\n');
  // ==================================================================
  newGame3('S');
  riichi('S东');                                    // 池 1000
  document.getElementById('btn-flow').click();
  document.getElementById('flow-other').click();    // 其他流局：无分转移，供托继承
  const netFlow = readPopupNet();
  assert(netFlow['S东'] === -1000, '其他流局弹窗里 S东(立直) 显示 -1000：实际 ' + netFlow['S东']);
  assert(netFlow['S南'] === 0 && netFlow['S西'] === 0, '其他流局未涉者显示 0');
  document.getElementById('btn-result-close').click();
  const flowRec = readLog()[0];
  assert(flowRec.label === '东1局·0本', '流局也作为一条记录（' + flowRec.label + '）');
  assert(logPlayer(flowRec, 'S东').delta === -1000, '流局记录里 S东 = -1000：实际 ' + logPlayer(flowRec, 'S东').delta);
  assert(sumDeltas(flowRec) === -1000, '流局记录 delta 之和 = -1000（这1000还在供托池里）：实际 ' + sumDeltas(flowRec));
  assert(document.getElementById('center-kyotaku').textContent.includes('1000'), '供托继承，池里仍 1000');

  settleRon('S南', 'S西', 2000);                    // 下局：和牌者收走池中 1000
  const netNext = readPopupNet();
  // 注意：流局使本场 +1（东2局·1本），故和牌者另收本场加算 300×1（放铳者付）
  assert(netNext['S西'] === 3300, '下局 S西 = +3300（荣和2000 + 继承来的供托1000 + 本场300）：实际 ' + netNext['S西']);
  assert(netNext['S南'] === -2300, '下局 S南(放铳) = -(2000+300本场)：实际 ' + netNext['S南']);
  document.getElementById('btn-result-close').click();
  const log3 = readLog();
  assert(log3.length === 2, '半庄分数记录共 2 条：实际 ' + log3.length);
  assert(log3[0].label === '东2局·1本', '第 2 条为 东2局·1本（流局 +1 本）：实际 ' + log3[0].label);
  const totalAll = log3.reduce((s, r) => s + sumDeltas(r), 0);
  assert(totalAll === 0, '两条记录 delta 跨局相加 = 0（立直局 -1000 与收取局 +1000 配平）：实际 ' + totalAll);

  // ==================================================================
  console.log('\n== 4: 荒牌流局 + 立直：未听罚符与立直款叠加 ==\n');
  // ==================================================================
  newGame3('T');
  riichi('T东');                                    // 池 1000
  document.getElementById('btn-flow').click();
  document.getElementById('flow-koei').click();
  pick('#tanyou-pick .p', 'T东').click();           // T东 听牌
  pick('#tanyou-pick .p', 'T西').click();           // T西 听牌，T南 未听
  document.getElementById('btn-koei-confirm').click();
  const netKoei = readPopupNet();
  // 总转移 2000（三人）：2 听各 +1000，1 未听 -2000；T东 再扣立直 1000
  assert(netKoei['T东'] === 0, 'T东 = 0（听牌+1000 − 立直1000）：实际 ' + netKoei['T东']);
  assert(netKoei['T西'] === 1000, 'T西 = +1000（听牌）：实际 ' + netKoei['T西']);
  assert(netKoei['T南'] === -2000, 'T南 = -2000（未听）：实际 ' + netKoei['T南']);
  document.getElementById('btn-result-close').click();
  const h4 = readLog()[0];
  assert(logPlayer(h4, 'T东').delta === 0, '荒牌流局记录里 T东 = 0（听牌+1000 与立直-1000 相抵）：实际 ' + logPlayer(h4, 'T东').delta);
  assert(logPlayer(h4, 'T东').riichi === true, '荒牌流局记录里 T东 带立直标记');
  assert(sumDeltas(h4) === -1000, '本局 delta 之和 = -1000（立直款入池）：实际 ' + sumDeltas(h4));

  // ==================================================================
  console.log('\n== 5: 历史详情逐局记录同步（收入历史后仍带 -1000 与标记） ==\n');
  // ==================================================================
  newGame3('U');
  riichi('U东');
  settleRon('U南', 'U西', 8000);
  document.getElementById('btn-result-close').click();
  document.getElementById('btn-end').click();
  document.getElementById('btn-end-confirm').click();
  assert(document.getElementById('page-history').classList.contains('active'), '结束对局进入历史页');
  document.querySelectorAll('#history-list .list-item')[0].click();
  assert(document.getElementById('modal-detail').classList.contains('show'), '打开对局详情');
  const detailHand = document.querySelectorAll('#detail-body .rl-hand')[0];
  const dU东 = Array.from(detailHand.querySelectorAll('.rl-player-name')).find((e) => e.textContent === 'U东').parentElement;
  assert(dU东.querySelector('.rl-player-delta').textContent === '(-1000)', '详情里 U东 为 (-1000)：实际 ' + dU东.querySelector('.rl-player-delta').textContent);
  assert(dU东.querySelector('.rl-player-delta').classList.contains('down'), '详情里 U东 的 delta 为红色 down');
  assert(dU东.querySelector('.rl-player-riichi') !== null, '详情里 U东 带立直小标记');
  const dU西 = Array.from(detailHand.querySelectorAll('.rl-player-name')).find((e) => e.textContent === 'U西').parentElement;
  assert(dU西.querySelector('.rl-player-delta').textContent === '(+9000)', '详情里 U西 为 (+9000)：实际 ' + dU西.querySelector('.rl-player-delta').textContent);
  assert(dU西.querySelector('.rl-player-riichi') === null, '详情里未立直的 U西 无标记');
  document.querySelector('#modal-detail .close-x').click();

  // ==================================================================
  console.log('\n== 6: 老对局兼容 —— 无 riichi 字段的 hand 记录原样显示 ==\n');
  // ==================================================================
  window.localStorage.setItem('riichi_finished', JSON.stringify([{
    id: 'legacy_riichi', finishedAt: '2026-09-01T00:00:00Z', mode: 3,
    endReason: '南三局结束（未开启西入）',
    players: [
      { seat: '东', wind: '东', name: 'A', points: 42000, riichi: false },
      { seat: '南', wind: '南', name: 'B', points: 36000, riichi: false },
      { seat: '西', wind: '西', name: 'C', points: 27000, riichi: false },
    ],
    // 模拟改动前生成的记录：players 里没有 riichi 字段
    history: [{
      hand: {
        round: { wind: '东', num: 1 }, honba: 0, label: '东1局·0本',
        players: [
          { name: 'A', wind: '东', pts: 42000, delta: -1000 },
          { name: 'B', wind: '南', pts: 36000, delta: -8000 },
          { name: 'C', wind: '西', pts: 27000, delta: 9000 },
        ],
      },
    }],
  }]));
  document.getElementById('btn-new-game-history').click();
  document.getElementById('btn-goto-history').click();
  document.querySelectorAll('#history-list .list-item')[0].click();
  const legacyHand = document.querySelectorAll('#detail-body .rl-hand')[0];
  assert(legacyHand !== undefined, '老记录仍能渲染逐局行');
  const legacyA = Array.from(legacyHand.querySelectorAll('.rl-player-name')).find((e) => e.textContent === 'A').parentElement;
  assert(legacyA.querySelector('.rl-player-delta').textContent === '(-1000)', '老记录 delta 原样显示 (-1000)：实际 ' + legacyA.querySelector('.rl-player-delta').textContent);
  assert(legacyHand.querySelectorAll('.rl-player-riichi').length === 0, '老记录无 riichi 字段 → 不显示立直标记');
  document.querySelector('#modal-detail .close-x').click();

  console.log('\n====================================');
  console.log('测试通过: ' + pass + '，失败: ' + fail);
  console.log('====================================');
  process.exit(fail > 0 ? 1 : 0);
}

try { main(); }
catch (e) { console.error('测试异常:', e); process.exit(1); }
