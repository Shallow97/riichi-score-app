/**
 * storage.js — 本地持久化 + 历史记录 + 多端同步模拟层
 *
 * 说明：
 * - 所有数据存浏览器 localStorage，刷新/关闭/重启不丢。
 * - 原型阶段用 localStorage 模拟多端同步：每台设备是一个独立存储，
 *   通过"手动输入 IP + 导出/导入"或"共享房间码"模拟房主=服务器分发状态。
 * - 为未来 Android 局域网直连预留了明确接口（见 /api 注释），
 *   到时候只需替换 SyncAdapter 的实现为真实 WebSocket/TCP。
 */

const Storage = (() => {
  const KEY_ACTIVE = 'riichi_active_game';   // 当前未完成对局
  const KEY_FINISHED = 'riichi_finished';    // 已完成对局列表
  const KEY_PROFILE = 'riichi_profile';      // 本机用户资料

  /* ========== 本机资料 ========== */
  function getProfile() {
    try { return JSON.parse(localStorage.getItem(KEY_PROFILE)) || {}; }
    catch { return {}; }
  }
  function saveProfile(p) {
    localStorage.setItem(KEY_PROFILE, JSON.stringify(p));
  }

  /* ========== 当前对局 ========== */
  // 保存后的联网广播钩子（由 net.js 安装，实现"保存即广播"给房间成员）
  const hooks = { onSave: null };
  function saveActive(game) {
    const s = Rules.serialize(game);
    localStorage.setItem(KEY_ACTIVE, s);
    if (hooks.onSave) { try { hooks.onSave(s); } catch (e) {} }
  }
  function loadActive() {
    const s = localStorage.getItem(KEY_ACTIVE);
    if (!s) return null;
    try { return Rules.deserialize(s); }
    catch { return null; }
  }
  function clearActive() {
    localStorage.removeItem(KEY_ACTIVE);
  }

  /* ========== 已完成对局历史 ========== */
  function getFinishedList() {
    try { return JSON.parse(localStorage.getItem(KEY_FINISHED)) || []; }
    catch { return []; }
  }
  function saveFinishedList(list) {
    localStorage.setItem(KEY_FINISHED, JSON.stringify(list));
  }
  /** 对局结束时调用：把结果存入历史 */
  /** 删除一条已完成的对局记录（按 id），返回是否删除成功 */
  function deleteFinishedGame(id) {
    const list = getFinishedList();
    const idx = list.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    list.splice(idx, 1);
    saveFinishedList(list);
    return true;
  }

  function archiveGame(game) {
    const rec = {
      id: Date.now() + '_' + Math.floor(Math.random() * 9999),
      finishedAt: new Date().toISOString(),
      mode: game.mode,
      opts: { ...game.opts },
      players: game.players.map((p) => ({ ...p, riichi: false })),
      endReason: game.endReason,
      history: game.history,
    };
    const list = getFinishedList();
    list.unshift(rec);
    saveFinishedList(list);
    return rec; // 返回归档记录，供联网广播给成员端
  }

  /** 把房主广播来的已完成对局记录插入本机历史（按 id 去重，避免重复） */
  function receiveFinished(record) {
    if (!record || !record.id) return false;
    const list = getFinishedList();
    if (list.some((x) => x.id === record.id)) return false;
    list.unshift(record);
    saveFinishedList(list);
    return true;
  }

  /* =================================================================
   * 多端同步模拟适配层（SyncAdapter）
   * =================================================================
   * 原型阶段用 localStorage + 房间码 模拟局域网分发。
   * 真实版替换这些方法即可（例：sendState 用 WebSocket 广播给房主）。
   */
  const SyncAdapter = {
    /**
     * 保存当前用户在本局中的"座位/用户名"等元数据，供其他端模拟时合并。
     * 原型里，各端通过 localStorage 的"共享房间"key 感知同一局。
     */
    localRoomId: null,

    setLocalProfile(profile) {
      saveProfile(profile);
    },

    /**
     * 模拟：把本地状态"发布"到共享房间（原型用跨标签页的 localStorage 事件）。
     * 真实实现：向房主 WebSocket 发送状态。
     */
    broadcastState(game) {
      // 原型：写入一个"共享镜像"key，配合 storage 事件跨标签页同步。
      const sharedKey = 'riichi_room_' + SyncAdapter.localRoomId;
      try {
        localStorage.setItem(sharedKey, Rules.serialize(game));
        // 触发其他标签页的 storage 事件
      } catch (e) { /* ignore */ }
    },

    /** 从共享房间读取状态（模拟"从房主拉取"） */
    fetchSharedState(roomId) {
      const sharedKey = 'riichi_room_' + roomId;
      const s = localStorage.getItem(sharedKey);
      if (!s) return null;
      try { return Rules.deserialize(s); } catch { return null; }
    },
  };

  return {
    getProfile, saveProfile,
    saveActive, loadActive, clearActive,
    getFinishedList, saveFinishedList, archiveGame, deleteFinishedGame, receiveFinished,
    SyncAdapter,
    hooks,            // 暴露 onSave 钩子（net.js 安装广播）
  };
})();

if (typeof window !== 'undefined') window.Storage = Storage;
if (typeof module !== 'undefined' && module.exports) module.exports = Storage;
