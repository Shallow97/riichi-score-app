/* 房主端连接诊断（单次快照）。
 * 首次调用会劫持 window.WebSocket 记录实例，之后每次调用输出：
 *   visibility / Net 状态 / 最近若干 WebSocket 实例的 readyState 与存活时长
 * 用法：连续调用两次、中间用 Bash sleep 控制间隔（不要用页面内 setTimeout —— 息屏时会被节流）。
 */
(function () {
  if (!window.__socksPatched) {
    window.__socksPatched = true;
    window.__socks = [];
    var _W = window.WebSocket;
    function Patched(url, proto) {
      var s = (proto === undefined) ? new _W(url) : new _W(url, proto);
      try {
        s.__url = String(url);
        s.__born = Date.now();
        window.__socks.push(s);
        if (window.__socks.length > 16) window.__socks.shift();
      } catch (e) {}
      return s;
    }
    Patched.prototype = _W.prototype;
    window.WebSocket = Patched;
  }
  return JSON.stringify({
    t: new Date().toISOString().substr(11, 8),
    visibility: document.visibilityState,
    hidden: document.hidden,
    net: {
      inRoom: Net.isInRoom(),
      locked: Net.isLocked(),
      phase: Net.phase(),
      serverSeq: Net.serverSeq(),
      hostOffline: Net.isHostOffline()
    },
    sockCount: (window.__socks || []).length,
    socks: (window.__socks || []).slice(-8).map(function (s) {
      return { url: s.__url, rs: s.readyState, ageMs: Date.now() - s.__born };
    })
  });
})()
