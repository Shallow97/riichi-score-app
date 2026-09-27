/**
 * honba-advance-test.js — 回归测试：本场数(honba)的加算与清零推进口径
 *
 * 规则口径（经权威资料核实 + 用户确认）：
 *   - 本场数只在「闲家和牌」时归零；
 *   - 流局（无论庄家是否听牌/是否换庄）或「庄家和牌（连庄）」都使本场 +1。
 *   - 即加算条件 = 流局 || 庄家得利；清零唯一条件 = 闲家和牌。
 *
 * 历史 bug：旧实现把「本场是否+1」绑定在「是否连庄」上，导致
 *   「流局且庄家未听牌（换庄）」与「其他流局」本场被错误清零。
 *
 * 运行：NODE_PATH=<workspace>/node_modules node honba-advance-test.js
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
function newGame(seedHonba) {
  const g = Rules.createGame(4, { multiRon: false, dealerName: 'P0' });
  g.players.forEach((p, i) => { p.name = 'P' + i; }); // P0=庄(东,dealerIndex0)
  g.honba = seedHonba || 0;
  return g;
}
/** 荣和：某玩家(收分人)和牌。winnerIsDealer=true 表示庄家赢 */
function ronResult(winnerName, honbaDealerWon) {
  return {
    type: 'ron',
    winners: [winnerName],
    transfers: [], kyotakuTo: null, kyotakuAmount: 0,
  };
}
function flowResult(tanyouArr) {
  return { type: 'ryukyoku', winners: [], transfers: [], kyotakuTo: null, tanyou: tanyouArr || [] };
}

let Rules;
function main() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const window = dom.window;
  const document = window.document;
  window.eval(fs.readFileSync(path.join(ROOT, 'js/rules.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/storage.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8'));
  Rules = window.Rules;
  document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

  console.log('\n== ① 庄家和牌(连庄) → 本场+1，局号不变 ==\n');
  {
    const g = newGame(0); // 东一 0本
    Rules.applyRoundResult(g, ronResult('P0'));
    assert(g.honba === 1, `庄家赢后本场 0→1，实际 ${g.honba}`);
    assert(g.dealerIndex === 0, '庄家不变(仍是P0)');
    assert(g.round.wind === '东' && g.round.num === 1, '局号仍东一');
  }
  {
    const g = newGame(3); // 东一 3本连庄中
    Rules.applyRoundResult(g, ronResult('P0'));
    assert(g.honba === 4, `庄家再赢本场 3→4，实际 ${g.honba}`);
  }

  console.log('\n== ② 闲家和牌(换庄) → 本场归0，局号推进 ==\n');
  {
    const g = newGame(3); // 东一 3本
    Rules.applyRoundResult(g, ronResult('P1')); // 闲家P1和牌
    assert(g.honba === 0, `闲家和牌本场 3→0，实际 ${g.honba}`);
    assert(g.dealerIndex === 1, '庄家顺时针下移(P0→P1)');
    assert(g.round.wind === '东' && g.round.num === 2, '局号推进到东二');
  }

  console.log('\n== ③ 荒牌流局·庄家听牌(连庄) → 本场+1 ==\n');
  {
    const g = newGame(0);
    Rules.applyRoundResult(g, flowResult(['P0', 'P2'])); // 庄听
    assert(g.honba === 1, `流局庄听本场 0→1，实际 ${g.honba}`);
    assert(g.dealerIndex === 0, '庄家连庄不变(P0)');
    assert(g.round.wind === '东' && g.round.num === 1, '局号仍东一');
  }

  console.log('\n== ④ 荒牌流局·庄家未听(换庄) → 本场仍+1（关键修正） ==\n');
  {
    const g = newGame(0);
    Rules.applyRoundResult(g, flowResult(['P1'])); // 庄P0未听、P1听
    assert(g.honba === 1, `流局庄未听本场 0→1(旧代码错为0)，实际 ${g.honba}`);
    assert(g.dealerIndex === 1, '庄家换庄下移(P0→P1)');
    assert(g.round.wind === '东' && g.round.num === 2, '局号推进到东二');
  }

  console.log('\n== ⑤ 其他流局(无听牌,tanyou空) → 本场+1（用户确认） ==\n');
  {
    const g = newGame(2); // 东一 2本
    Rules.applyRoundResult(g, flowResult([])); // 无人听牌 → 换庄但本场仍+1
    assert(g.honba === 3, `其他流局本场 2→3(旧代码错为0)，实际 ${g.honba}`);
    assert(g.dealerIndex === 1, '庄家换庄下移(P0→P1)');
    assert(g.round.wind === '东' && g.round.num === 2, '局号推进到东二');
  }

  console.log('\n== ⑥ 手动修正(type=manual) → 本场与局均不推进 ==\n');
  {
    const g = newGame(2);
    Rules.applyRoundResult(g, { type: 'manual', winners: [], transfers: [], kyotakuTo: null });
    assert(g.honba === 2, `manual 后本场仍 2，实际 ${g.honba}`);
    assert(g.dealerIndex === 0 && g.round.num === 1, '局不推进仍东一');
  }

  console.log('\n== ⑦ 三人模式(庄自摸) → 本场+1 ==\n');
  {
    const g3 = Rules.createGame(3, { multiRon: false, dealerName: 'P0' });
    g3.players.forEach((p, i) => { p.name = 'P' + i; });
    g3.honba = 1;
    Rules.applyRoundResult(g3, { type: 'tsumo', winners: ['P0'], transfers: [], kyotakuTo: null });
    assert(g3.honba === 2, `三人局庄自摸本场 1→2，实际 ${g3.honba}`);
    assert(g3.dealerIndex === 0, '三人局庄连庄不变');
  }

  console.log('\n====================================');
  console.log('本场数加算/清零推进测试: ' + pass + ' 通过，' + fail + ' 失败');
  console.log('====================================');
  dom.window.close();
  process.exit(fail === 0 ? 0 : 1);
}

main();
