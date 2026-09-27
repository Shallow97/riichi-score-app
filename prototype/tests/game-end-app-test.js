/**
 * game-end-app-test.js — 端到端验证「房主结束对局 → 成员端同步结束并跳转历史页」
 *
 * 用 jsdom 加载真实的 storage.js + app.js，注入一个最小 mock 的 window.Net，
 * 触发 onGameEnd 回调，验证成员端行为：
 *   1. 收到归档记录 → 插入本机历史（按 id 去重）
 *   2. game 置空、清空当前对局
 *   3. 跳转到对局历史页并渲染
 *   4. 重复收到同 id 记录 → 不重复插入
 *
 * 运行：NODE_PATH=<workspace>/node_modules node tests/game-end-app-test.js
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

  const rulesCode = fs.readFileSync(path.join(ROOT, 'js/rules.js'), 'utf8');
  const storageCode = fs.readFileSync(path.join(ROOT, 'js/storage.js'), 'utf8');
  const appCode = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  window.eval(rulesCode);
  window.eval(storageCode);
  const { document } = window;

  // 模拟成员端已在进行一局（localStorage 存有活跃对局）
  const game = window.Rules.createGame(4, { westRule: true });
  window.Storage.saveActive(game);

  // —— 最小 mock Net（成员身份）——
  const gameEndListeners = [];
  window.Net = {
    init() {},
    install() {},
    isHost() { return false; },
    isInRoom() { return true; },
    isOnline() { return true; },
    amOperator() { return false; },
    operatorName() { return null; },
    memberName() { return '玩家'; },
    memberCount() { return 2; },
    setName() {},
    requestAction() {},
    releaseAction() {},
    leaveRoom() {},
    onState() {},
    onStatus() {},
    onOperator() {},
    onGameEnd(fn) { gameEndListeners.push(fn); },
    endGame() {},
  };

  window.eval(appCode);
  document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

  // init() 里 loadActive 命中 → 进入主界面
  assert(document.getElementById('page-main').classList.contains('active'), '成员端初始进入对局主界面');

  // 构造房主广播的归档记录（序列化字符串，与线上协议一致）
  const rec = {
    id: 'game_end_1',
    finishedAt: new Date().toISOString(),
    mode: 4,
    opts: { westRule: true },
    players: [{ wind: '东', name: 'P东', points: 30000 }, { wind: '南', name: 'P南', points: 26000 }, { wind: '西', name: 'P西', points: 23000 }, { wind: '北', name: 'P北', points: 21000 }],
    endReason: '南四局结束',
    history: [],
  };

  // 触发 onGameEnd（模拟收到房主 game-end 消息）
  gameEndListeners[0](rec);

  assert(!document.getElementById('page-main').classList.contains('active'), '收到 game-end 后退出对局主界面');
  assert(document.getElementById('page-history').classList.contains('active'), '收到 game-end 后跳转到对局历史页');
  assert(window.Storage.loadActive() === null, '成员端清空当前活跃对局');

  // 历史列表应包含广播来的记录
  const list = window.Storage.getFinishedList();
  assert(list.length === 1 && list[0].id === 'game_end_1', '成员端历史插入房主归档记录');
  assert(document.getElementById('history-list').innerHTML.includes('南四局结束'), '历史页渲染出该记录');

  // 重复收到同 id → 不重复插入（去重）
  gameEndListeners[0](rec);
  const list2 = window.Storage.getFinishedList();
  assert(list2.length === 1, '重复收到同 id 记录不重复插入（按 id 去重）');

  console.log('\n====================================');
  console.log('房主结束对局→成员同步跳转历史测试: ' + pass + ' 通过，' + fail + ' 失败');
  console.log('====================================');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
