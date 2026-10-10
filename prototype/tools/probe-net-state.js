/* 真机 Net 状态快照（房主端） */
(function () {
  try {
    return JSON.stringify({
      url: location.href,
      href_host: location.search,
      isHost: Net.isHost(),
      hasJoined: Net.hasJoined(),
      inRoom: Net.isInRoom(),
      online: Net.isOnline(),
      phase: Net.phase(),
      locked: Net.isLocked(),
      hostOffline: Net.isHostOffline(),
      memberCount: Net.memberCount(),
      operatorName: Net.operatorName(),
      serverSeq: Net.serverSeq()
    });
  } catch (e) { return 'ERR ' + e.message; }
})()
