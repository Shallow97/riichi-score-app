/**
 * net-test.js — 前端 net.js 逻辑测试（无房间码·自动连接·操作权）
 * 前置：服务器已在 8765 运行（node serve.js）。运行：node tests/net-test.js
 */
const WebSocketImpl = require('ws');
global.WebSocket = WebSocketImpl;
let pass = 0, fail = 0;
function ok(name) { pass++; console.log('  ✓ ' + name); }
function bad(name, e) { fail++; console.log('  ✗ ' + name + ' — ' + (e && e.message)); }

const path = require('path');
const netPath = path.join(__dirname, '..', 'js', 'net.js');

// 每次 require 前设置全局 location 并清缓存（用 delete 清整个 require.cache 对应键）
function loadNet(search) {
  global.location = { protocol: 'http:', host: 'localhost:8765', search: search || '' };
  delete require.cache[netPath];
  return require(netPath);
}

function testHostAutoConnect(done) {
  console.log('\n== net.js: 房主自动连接 ==');
  const N = loadNet('?host=1');
  let gotRoom = false;
  N.onStatus((s) => {
    if (s.connected && !gotRoom) {
      gotRoom = true;
      ok('房主自动连接并被识别为房主 (host=' + N.isHost() + ')');
      N.leaveRoom();
      setTimeout(done, 200);
    }
  });
  N.init();
  setTimeout(() => { if (!gotRoom) { bad('房主自动连接超时 (online=' + N.isOnline() + ', inRoom=' + N.isInRoom() + ')'); done(); } }, 3000);
}

function testMemberFlow(done) {
  console.log('\n== net.js: 成员自动连接 + 操作权 ==');
  const hostWs = new WebSocketImpl('ws://localhost:8765/ws?host=1');
  let step = 0, seq = 0;
  hostWs.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'welcome' && m.role === 'host' && step === 0) {
      step = 1;
      seq = m.seq || 0;
      const N = loadNet('');
      let gotState = false;
      N.onState((state) => {
        if (!gotState) {
          gotState = true;
          ok('成员收到房主提交后的权威态');
          N.requestAction('小明', (err, granted) => {
            if (granted) {
              ok('成员申请操作权成功');
              N.releaseAction();
              ok('成员释放操作权');
            } else {
              bad('成员申请操作权失败: ' + err);
            }
            hostWs.close();
            setTimeout(done, 200);
          });
        }
      });
      N.init();
      // 全提交制：房主也走 commit（协议 v2）
      setTimeout(() => {
        hostWs.send(JSON.stringify({ type: 'commit', opId: 'net-test-1', baseSeq: seq, state: '{"room":"member1"}' }));
      }, 300);
      setTimeout(() => { if (!gotState) { bad('成员收状态超时'); hostWs.close(); done(); } }, 3000);
    }
  });
}

testHostAutoConnect(() => {
  testMemberFlow(() => {
    console.log('\n====================================');
    console.log('net.js 测试: ' + pass + ' 通过，' + fail + ' 失败');
    console.log('====================================');
    process.exit(fail === 0 ? 0 : 1);
  });
});
