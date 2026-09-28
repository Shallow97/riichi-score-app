/**
 * dealer-win-continue-test.js — 回归测试：最后一局庄家和牌的连庄例外（用户口径 2026-09-28）
 *
 * 规则口径（用户确认）：
 *   - 半庄最后一局（四人南四/三人南三，西入后含西三/西四）庄家和牌（含多响含庄）时：
 *     庄家结算后分数不是全场最高（与其他玩家并列最高也算"不是最高"）→ 不终局、连庄
 *     （局号不变、庄家不变、本场+1），该判定优先级高于西入"最高分≥阈值即结束"；
 *   - 庄家严格独占最高分 → 照常结束；
 *   - 闲家和牌/流局的现有终局行为不变。
 *
 * 运行：NODE_PATH=<workspace>/node_modules node dealer-win-continue-test.js
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

let Rules;

/** 建局后直接摆到目标局与目标分数（transfers 留空 = 传入的 points 即"结算后"分数） */
function makeGame(mode, opts, points, wind, num, honba) {
  const g = Rules.createGame(mode, opts);
  g.players.forEach((p, i) => { p.name = 'P' + i; p.points = points[i]; });
  g.round = { wind, num };
  g.gameWind = wind;
  g.honba = honba || 0;
  return g;
}
function ronResult(winners) {
  return { type: 'ron', winners, transfers: [], kyotakuTo: null };
}
function tsumoResult(winners) {
  return { type: 'tsumo', winners, transfers: [], kyotakuTo: null };
}

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

  console.log('\n== ① 四人·南四·未开西入·庄家和牌·非最高 → 连庄 ==\n');
  {
    // P0=庄(32000) < P1(33000)：庄荣和+3000 已体现在分数里
    const g = makeGame(4, { westRule: false, dealerName: 'P0' }, [32000, 33000, 25000, 25000], '南', 4, 2);
    Rules.applyRoundResult(g, ronResult(['P0']));
    assert(g.over === false, '不终局');
    assert(g.dealerIndex === 0, '庄家不变(仍P0)');
    assert(g.round.wind === '南' && g.round.num === 4, '局号仍南四');
    assert(g.honba === 3, `本场 2→3（庄家和牌+1），实际 ${g.honba}`);
    assert(!!g.endReason === false || !g.over, '无结束原因（未结束）');
  }

  console.log('\n== ② 四人·南四·庄家自摸·平分最高 → 连庄（平分=不是最高） ==\n');
  {
    const g = makeGame(4, { westRule: false, dealerName: 'P0' }, [33000, 33000, 25000, 25000], '南', 4, 0);
    Rules.applyRoundResult(g, tsumoResult(['P0']));
    assert(g.over === false, '平分不算最高 → 不终局');
    assert(g.dealerIndex === 0 && g.round.num === 4, '连庄：庄家/局号不变');
    assert(g.honba === 1, `本场 0→1，实际 ${g.honba}`);
  }

  console.log('\n== ③ 四人·南四·庄家和牌·唯一最高 → 照常结束 ==\n');
  {
    const g = makeGame(4, { westRule: false, dealerName: 'P0' }, [34000, 30000, 25000, 25000], '南', 4, 2);
    Rules.applyRoundResult(g, ronResult(['P0']));
    assert(g.over === true, '庄家独占最高 → 终局');
    assert((g.endReason || '').includes('南四'), `结束原因含南四，实际：${g.endReason}`);
  }

  console.log('\n== ④ 四人·南四·开西入·庄家和牌·非最高且最高分≥30000 → 连庄优先 ==\n');
  {
    // 旧逻辑：maxP=31000≥30000 → 终局；新口径：庄家和牌且非最高 → 连庄优先
    const g = makeGame(4, { westRule: true, dealerName: 'P0' }, [29000, 31000, 25000, 25000], '南', 4, 0);
    Rules.applyRoundResult(g, ronResult(['P0']));
    assert(g.over === false, '连庄优先于西入阈值终局');
    assert(g.round.wind === '南' && g.round.num === 4, '局号仍南四（未进西场）');
    assert(g.dealerIndex === 0, '庄家不变');
  }

  console.log('\n== ⑤ 四人·西四（西入后最后局）·庄家和牌·非最高 → 连庄 ==\n');
  {
    const g = makeGame(4, { westRule: true, dealerName: 'P0' }, [28000, 32000, 25000, 25000], '西', 4, 1);
    Rules.applyRoundResult(g, ronResult(['P0']));
    assert(g.over === false, '西四庄家和牌非最高 → 不终局');
    assert(g.round.wind === '西' && g.round.num === 4, '局号仍西四');
    assert(g.honba === 2, `本场 1→2，实际 ${g.honba}`);
  }

  console.log('\n== ⑥ 三人·南三·庄家和牌·非最高 → 连庄 ==\n');
  {
    const g = makeGame(3, { westRule: false, dealerName: 'P0' }, [35000, 36000, 34000], '南', 3, 0);
    Rules.applyRoundResult(g, tsumoResult(['P0']));
    assert(g.over === false, '三人南三庄家和牌非最高 → 不终局');
    assert(g.round.wind === '南' && g.round.num === 3, '局号仍南三');
  }
  {
    const g = makeGame(3, { westRule: false, dealerName: 'P0' }, [40000, 36000, 34000], '南', 3, 0);
    Rules.applyRoundResult(g, ronResult(['P0']));
    assert(g.over === true, '三人南三庄家独占最高 → 终局');
  }

  console.log('\n== ⑦ 多响含庄家（庄非最高） → 连庄 ==\n');
  {
    const g = makeGame(4, { westRule: false, multiRon: true, dealerName: 'P0' }, [30000, 33000, 31000, 25000], '南', 4, 0);
    Rules.applyRoundResult(g, ronResult(['P0', 'P2']));
    assert(g.over === false, '多响任一赢家含庄即按庄家和牌判定 → 非最高 → 连庄');
    assert(g.dealerIndex === 0 && g.round.num === 4, '庄家/局号不变');
  }

  console.log('\n== ⑧ 回归：闲家和牌南四 → 照常结束（现状不变） ==\n');
  {
    const g = makeGame(4, { westRule: false, dealerName: 'P0' }, [30000, 34000, 25000, 25000], '南', 4, 0);
    Rules.applyRoundResult(g, ronResult(['P1']));
    assert(g.over === true, '闲家和牌最后一局 → 照常终局');
    assert(g.dealerIndex === 0 && g.round.num === 4, '终局后不推进（庄家/局号保持结算时状态）');
  }

  console.log('\n== ⑨ 回归：流局南四庄听 → 照常结束（现状不变） ==\n');
  {
    const g = makeGame(4, { westRule: false, dealerName: 'P0' }, [28000, 32000, 25000, 25000], '南', 4, 0);
    Rules.applyRoundResult(g, { type: 'ryukyoku', winners: [], transfers: [], kyotakuTo: null, tanyou: ['P0'] });
    assert(g.over === true, '流局（含庄听）最后一局 → 照常终局（新规则不覆盖流局）');
  }

  console.log('\n== ⑩ 回归：中间局庄家和牌非最高 → 正常连庄（不误伤） ==\n');
  {
    const g = makeGame(4, { westRule: false, dealerName: 'P0' }, [26000, 33000, 25000, 25000], '东', 3, 0);
    Rules.applyRoundResult(g, ronResult(['P0']));
    assert(g.over === false && g.round.wind === '东' && g.round.num === 3, '东三庄家和牌 → 正常连庄');
    assert(g.honba === 1, `本场 0→1，实际 ${g.honba}`);
  }

  console.log('\n====================================');
  console.log('最后一局庄家和牌连庄例外测试: ' + pass + ' 通过，' + fail + ' 失败');
  console.log('====================================');
  dom.window.close();
  process.exit(fail === 0 ? 0 : 1);
}

main();
