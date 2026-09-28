/**
 * rules.js — 日麻计分核心规则引擎（纯逻辑，与界面无关）
 *
 * 已确认规则实现（第一版）：
 * 1. 三人模式初始 35000 / 四人模式初始 25000
 * 2. 和牌结算：任何玩家可点，用于自己付分场景，选收分对象并手填应付分；多响可多次触发
 * 3. 自摸：三家各付各的，庄家付更多，由各人自行输入
 * 4. 立直：<1000 禁止；立直棒同步显示；和牌者收取供托（多响由放铳者逆时针第一个和牌者收取）；无人和牌则供托继承
 * 5. 流局：仅房主可点，分荒牌/其他；荒牌勾选听牌者，未听罚符总转移（三人2000/四人3000，听者平分收、未听者平分付），庄家听牌连庄否则换庄；其他流局无分换庄；流局立直者一律不收回棒（并入供托）
 * 6. 连庄/换庄：收分对象含庄家→连庄（本场+1），否则换庄；多响含庄家则连庄；最后一局庄家和牌且非全场最高分（并列最高也算非最高）→ 连庄继续（见 7）
 * 7. 半庄结束：a)本局结束有人<0击飞即结束 b)西入时南场最后局（四人南四/三人南三）无人击飞且最高分<阈值进西场（三人40000/四人30000），任一局有人≥阈值结束或西场最后局（四人西四/三人西三）结束 c)不开西入南场最后局无人击飞则南场最后局结束；0分不击飞。每场局数：四人4局、三人3局（轮转顺序三人为 东1-3→南1-3→西1-3，无北家故无第4局）
 *    最后一局连庄例外（用户口径 2026-09-28）：南场/西场最后局庄家和牌（含多响含庄）时——
 *    庄家结算后分数不是全场最高（与其他玩家并列最高也算"不是最高"）→ 不终局、连庄（局号不变、本场+1），该判定优先级高于西入"最高分≥阈值即结束"；庄家严格独占最高 → 照常结束。
 * 8. 分数校验强度1：本局增减总和不为0提示差额，允许房主强行推进
 * 9. 撤回：仅房主，可连续回退多局，整体回退
 * 10. 手动修正：仅房主，直接改某玩家分数，计入流水与校验
 */

const Rules = (() => {
  // 方向列表（顺时针）
  const WINDS = ['东', '南', '西', '北'];

  // 座位布局：按东南西北顺时针
  // 三人模式：东(庄)、南、西；北空位。三人日麻通常只坐东、南、西。
  const SEAT_WINDS_4 = ['东', '南', '西', '北'];
  const SEAT_WINDS_3 = ['东', '南', '西'];

  /**
   * 创建新对局初始状态
   * @param {number} mode 3 或 4
   * @param {object} opts { dealerName, westRule, multiRon }
   */
  function createGame(mode, opts) {
    const startPoints = mode === 3 ? 35000 : 25000;
    const seatWinds = mode === 3 ? SEAT_WINDS_3 : SEAT_WINDS_4;

    const players = seatWinds.map((wind) => ({
      seat: wind,          // 实际方位（线下物理座位，固定不变）
      wind: wind,          // 游戏内方位（动态，随换庄旋转；"东"即本局庄家）
      name: '',            // 用户名（由用户输入）
      points: startPoints, // 当前分数
      riichi: false,       // 本局是否立直
      riichiBars: 0,       // 该玩家累计未收回的立直棒数量（正常每局1根，流局不收回时累计）
      isConnected: true,
    }));

    return {
      mode,                // 3 或 4
      players,
      opts: {
        westRule: !!opts?.westRule,       // 是否开启西入
        multiRon: !!opts?.multiRon,       // 是否允许一炮多响
        dealerName: opts?.dealerName || seatWinds[0], // 起庄玩家（用户名）
      },
      dealerIndex: 0,      // 当前庄家在 players 中的索引
      round: { wind: '东', num: 1 },  // 当前局 东一局
      honba: 0,            // 本场数（连庄）
      kyotaku: 0,          // 供托点数（立直棒累计）
      gameWind: '东',      // 当前场风（东/南/西）
      over: false,         // 半庄是否结束
      endReason: '',       // 结束原因
      history: [],         // 每局的快照记录（用于撤回/历史）
      finished: false,     // 是否已作为"已完成对局"保存
    };
  }

  /** 由用户名找玩家索引 */
  function indexByName(game, name) {
    return game.players.findIndex((p) => p.name === name);
  }

  /** 获取当前庄家玩家 */
  function dealer(game) {
    return game.players[game.dealerIndex];
  }

  /** 下一家的索引（顺时针） */
  function nextIndex(game, i) {
    return (i + 1) % game.players.length;
  }

  /** 是否为东/庄风局（东一局～东四局） */
  function roundWind(game) {
    return game.round.wind;
  }

  /**
   * 立直操作（可撤销的开关式）
   * - 目标未立直：立直，扣1000点入供托
   * - 目标已立直：取消立直，退回1000点（供托-1000），供玩家纠正误触
   * @returns {{ok:boolean,msg:string,action:'riichi'|'cancel'}}
   */
  function doRiichi(game, playerName) {
    const p = indexByName(game, playerName);
    if (p < 0) return { ok: false, msg: '玩家不存在' };
    // 已立直 → 取消立直（供托-1000，退回玩家分数，立直棒-1）
    if (game.players[p].riichi) {
      game.players[p].riichi = false;
      game.players[p].points += 1000;
      game.players[p].riichiBars = Math.max(0, game.players[p].riichiBars - 1);
      game.kyotaku = Math.max(0, game.kyotaku - 1000);
      return { ok: true, action: 'cancel', msg: `${game.players[p].name} 取消立直，退回1000点` };
    }
    if (game.players[p].points < 1000) return { ok: false, msg: '分数不足1000点，无法立直' };
    // 执行：扣1000点入供托，标记立直
    game.players[p].points -= 1000;
    game.players[p].riichi = true;
    game.players[p].riichiBars += 1;
    game.kyotaku += 1000;
    return { ok: true, action: 'riichi', msg: `${game.players[p].name} 立直，支付1000点入供托` };
  }

  /**
   * 检查一局内的分数转移是否平衡（总和应为0）
   * @param {Array<{player:string, delta:number}>} transfers
   */
  function checkBalance(transfers) {
    const sum = transfers.reduce((s, t) => s + (t.delta || 0), 0);
    return { balanced: sum === 0, diff: sum };
  }

  /**
   * 应用一局的结果（分数转移 + 推进到下一局/结束判定）
   * 调用前应先结算好 transfers（delta 数组），并处理好 kyotaku 归属。
   *
   * @param {object} game
   * @param {object} result 本局结果
   *   result.transfers: [{player, delta}]
   *   result.kyotakuTo: 收供托的玩家名或 null(继承/无人收)
   *   result.type: 'ron'|'tsumo'|'ryukyoku'|'manual'
   *   result.tanyou: 荒牌流局时勾选的听牌者数组（用于换庄判定）
   * @returns {{ok, msg, endReason}}
   */
  function applyRoundResult(game, result) {
    if (game.over) return { ok: false, msg: '对局已结束' };

    // 1) 先快照当前状态到历史（用于撤回）。
    //    该快照同时承载本局已结算的"分数记录"（见下方 attachHandRecord），
    //    供对局主界面下方展示"本半庄已结算各局"。撤回会整体弹出此快照，记录随之消失，
    //    手动修正/修正局/修正本场/修正供托各自建的快照不携带该标记，故不会产生一条结算记录。
    pushSnapshot(game);
    const snap = game.history[game.history.length - 1];

    // 2) 应用分数转移
    for (const t of result.transfers) {
      const idx = indexByName(game, t.player);
      if (idx >= 0) game.players[idx].points += t.delta;
    }

    // 3) 供托归属
    if (result.kyotakuTo) {
      const idx = indexByName(game, result.kyotakuTo);
      if (idx >= 0) {
        game.players[idx].points += game.kyotaku;
      }
      game.kyotaku = 0;
      // 收取供托的人，其立直棒清零
      if (idx >= 0) game.players[idx].riichiBars = 0;
    }
    // 若无人收供托，供托继承到下一局（不清零）

    // 3.5) 本局结算完成：把"本局分数记录"附加到快照上（在快照/分数/供托均已反映后）。
    //      delta = 各玩家结算后分数 − 快照（本局开始结算前）分数，含本场加算与供托收入。
    //      仅供展示；不影响后续推进逻辑。流局等也算作一条已结算记录（可 delta 全为 0）。
    snap.hand = buildHandRecord(game, snap);

    // 4) 清空本局立直状态
    for (const p of game.players) p.riichi = false;

    // 5) 判定是否击飞（<0）→ 立即结束
    const busted = game.players.some((p) => p.points < 0);
    if (busted) {
      finishGame(game, `有玩家分数低于0（击飞）`);
      return { ok: true, msg: '本局结算完成，触发击飞，半庄结束', endReason: game.endReason };
    }

    // 6) 判定半庄结束（南四或西入）；最后一局庄家和牌的连庄例外在 checkRoundEnd 内判定
    const endInfo = checkRoundEnd(game, result);
    if (endInfo) {
      finishGame(game, endInfo.reason);
      return { ok: true, msg: '本局结算完成，半庄结束', endReason: game.endReason };
    }

    // 7) 未结束 → 推进到下一局（决定连庄/换庄）
    advanceRound(game, result);
    return { ok: true, msg: '本局结算完成，进入下一局' };
  }

  /**
   * 根据击飞之外的规则判断是否应结束半庄（此时尚未推进）
   * @param {object} game
   * @param {object} [result] 本局结果（用于"最后一局庄家和牌→连庄例外"判定）
   */
  function checkRoundEnd(game, result) {
    const r = game.round;
    // 西入结束阈值：三人模式 40000，四人模式 30000
    const westThreshold = (game.mode === 3) ? 40000 : 30000;
    // 每个场的局数（三人3局/四人4局）——最后局判定
    const perWind = roundsPerWind(game);
    // 最后一局：南场最后局（四人南四/三人南三）或西场最后局（四人西四/三人西三）
    const isLastRound = (r.wind === '南' || r.wind === '西') && r.num === perWind;

    // ---- 最后一局庄家和牌的连庄例外（用户口径）----
    // 庄家和牌（多响时任一赢家含庄家）且结算后分数不是全场最高
    // （与其他玩家并列最高也算"不是最高"，即只有严格独占最高才终局）
    // → 不终局、连庄。该判定优先级高于西入"最高分≥阈值即结束"。
    // 庄家唯一最高时不拦截，落入下方正常结束判定。
    if (isLastRound && result && (result.type === 'ron' || result.type === 'tsumo')) {
      const dealerPlayer = dealer(game);
      if ((result.winners || []).includes(dealerPlayer.name)) {
        const maxOthers = Math.max(...game.players
          .filter((p) => p !== dealerPlayer)
          .map((p) => p.points));
        if (dealerPlayer.points <= maxOthers) {
          return null; // 连庄：advanceRound 会保持庄家/局号并 +1 本场
        }
      }
    }

    // 南场最后局（四人：南四；三人：南三）——西入判定点
    if (r.wind === '南' && r.num === perWind) {
      // 不开西入 → 南场最后局结束
      if (!game.opts.westRule) {
        return { reason: `${game.mode === 3 ? '南三' : '南四'}局结束（未开启西入）` };
      }
      // 开西入：若最高分≥阈值 则结束（其实按规则，南场最后局无人击飞且最高分<阈值才进西场；≥阈值则直接结束）
      const maxP = Math.max(...game.players.map((p) => p.points));
      if (maxP >= westThreshold) {
        return { reason: `${game.mode === 3 ? '南三' : '南四'}局结束，最高分达到${westThreshold}` };
      }
      // 否则进西场，不在此结束
      return null;
    }
    if (r.wind === '西' && r.num === perWind) {
      return { reason: `${game.mode === 3 ? '西三' : '西四'}局结束（西入打到${game.mode === 3 ? '西三' : '西四'}）` };
    }
    // 西入中：任一局有人≥阈值 则结束
    if (r.wind === '西' && game.opts.westRule) {
      const maxP = Math.max(...game.players.map((p) => p.points));
      if (maxP >= westThreshold) {
        return { reason: `西入：${game.players[game.players.findIndex(p=>p.points===maxP)].name} 达到${westThreshold}分，半庄结束` };
      }
    }
    return null;
  }

  /** 结束对局 */
  function finishGame(game, reason) {
    game.over = true;
    game.endReason = reason;
  }

  /**
   * 推进到下一局（决定连庄/换庄、本场数、局数推进）
   */
  function advanceRound(game, result) {
    // 连庄条件：本局庄家（东）和牌，或（荒牌/其他）流局庄家听牌。
    // 本场数加算独立于连庄/换庄判定，见下方"本场数推进"。
    const dealerPlayer = dealer(game);
    let dealerWon = false;
    let isFlow = false; // 本局是否流局（流局无条件使本场 +1）

    if (result.type === 'ryukyoku') {
      // 流局：庄家听牌则连庄；否则换庄。流局本身（不论换庄与否）都使本场 +1。
      isFlow = true;
      dealerWon = (result.tanyou || []).includes(dealerPlayer.name);
    } else if (result.type === 'ron' || result.type === 'tsumo') {
      // 和牌：收分对象（赢家）是否含庄家。多响时任一含庄家即连庄
      const winners = result.winners || [];
      dealerWon = winners.includes(dealerPlayer.name);
    } else if (result.type === 'manual') {
      // 手动修正不推进局数
      return;
    }

    // ---- 本场数推进 ----
    // 规则：本场数只在"闲家和牌"时归零；流局（无论庄家是否听牌/是否换庄）或庄家
    // 和牌（连庄）时都 +1。即加算条件 = 流局 || 庄家得利；清零唯一条件 = 闲家和牌。
    if (isFlow || dealerWon) {
      game.honba += 1;
    } else {
      // 闲家和牌（换庄）：本场归 0
      game.honba = 0;
    }

    // ---- 庄家去留（连庄/换庄），与本场数推进解耦 ----
    if (!dealerWon) {
      // 换庄（闲家和牌，或流局庄家未听牌）：庄家顺时针下移，局号推进
      game.dealerIndex = nextIndex(game, game.dealerIndex);
      advanceRoundNumber(game);
      // 重新计算所有玩家的游戏内方位：庄家（dealerIndex）=东，下家=南，依次顺时针
      recalcWinds(game);
    }
    // dealerWon（连庄）：局号不变，仅上方已做本场 +1
  }

  /** 根据当前庄家重算各玩家的游戏内方位（庄=东，顺时针：东→南→西→北） */
  function recalcWinds(game) {
    const n = game.players.length;
    game.players.forEach((p, i) => {
      const offset = (i - game.dealerIndex + n) % n;
      p.wind = WINDS[offset]; // 庄家offset=0→东，下家offset=1→南，...
    });
  }

  /** 每个场的局数：四人模式4局（东1-4/南1-4/西1-4），三人模式3局（东1-3/南1-3/西1-3，无北家故无第4局） */
  function roundsPerWind(game) {
    return game.mode === 3 ? 3 : 4;
  }

  /** 推进局数（东一→东二→…→南一→…→西一） */
  function advanceRoundNumber(game) {
    const perWind = roundsPerWind(game);
    let num = game.round.num + 1;
    let wind = game.round.wind;
    if (num > perWind) {
      num = 1;
      if (wind === '东') wind = '南';
      else if (wind === '南') wind = '西';
      else wind = '东'; // 理论不会到，兜底
    }
    game.round = { wind, num };
    game.gameWind = wind;
  }

  /**
   * 手动修正分数（仅房主）
   * @returns {{ok,msg}}
   */
  function manualAdjust(game, playerName, delta) {
    if (game.over) return { ok: false, msg: '对局已结束' };
    const idx = indexByName(game, playerName);
    if (idx < 0) return { ok: false, msg: '玩家不存在' };
    pushSnapshot(game);
    game.players[idx].points += delta;
    return { ok: true, msg: `${playerName} 分数修正 ${delta>0?'+':''}${delta}` };
  }

  /**
   * 手动修正【所在局】——不改分数/本场/供托/立直，仅改局标签与随之联动的庄家与方位。
   * 规则：庄家 = 起庄玩家顺时针走「目标局在全半庄序列位次 mod 玩家人数」步。
   * 局推进只在换庄时发生，故局标签（wind,num）能唯一反推当前庄家；
   * 连庄只会累加本场数而不推进局号，不影响该映射。
   * 若对局当前处于已结束(over)状态（如误判击飞/西入结束），改局视为解除结束继续对局。
   * @returns {{ok:boolean,msg:string}}
   */
  function adjustRound(game, wind, num) {
    const perWind = roundsPerWind(game);
    if (!['东', '南', '西'].includes(wind) || num < 1 || num > perWind) {
      return { ok: false, msg: '非法的所在局' };
    }
    pushSnapshot(game);
    game.round = { wind, num };
    game.gameWind = wind;
    game.dealerIndex = dealerIndexForRound(game, wind, num);
    recalcWinds(game); // 按新庄家重排各家方位（庄=东，顺时针）
    if (game.over) { game.over = false; game.endReason = ''; } // 解除误判的结束
    return { ok: true, msg: `所在局已修正为 ${wind}${num}局` };
  }

  /**
   * 计算目标局(wind,num)应当担任庄家的玩家数组索引。
   * @private（对外导出供界面预览用）
   */
  function dealerIndexForRound(game, wind, num) {
    const windRank = { 东: 0, 南: 1, 西: 2 }[wind] ?? 0;
    const perWind = roundsPerWind(game);
    const startIdx = game.players.findIndex((p) => p.name === game.opts.dealerName);
    const base = startIdx < 0 ? 0 : startIdx;
    const steps = (windRank * perWind + (num - 1)) % game.players.length;
    return (base + steps) % game.players.length;
  }

  /**
   * 手动修正【本场数】——仅更新 honba，不影响任何玩家分数（守恒不破）。
   * @returns {{ok:boolean,msg:string}}
   */
  function setHonba(game, value) {
    const v = Math.max(0, Math.min(20, Math.floor(value) || 0));
    pushSnapshot(game);
    game.honba = v;
    return { ok: true, msg: `本场数已修正为 ${v} 本` };
  }

  /**
   * 手动修正【供托点数】——供托与各玩家分数之和恒定，故调整供托时，
   * 差额由指定玩家补缴（供托增加，该玩家扣分）或取回（供托减少，该玩家加分）。
   * @returns {{ok:boolean,msg:string}}
   */
  function adjustKyotaku(game, amount, payerName) {
    const pIdx = indexByName(game, payerName);
    if (pIdx < 0) return { ok: false, msg: '玩家不存在' };
    const target = Math.max(0, Math.min(20000, Math.floor(amount) || 0));
    const old = game.kyotaku;
    const diff = target - old; // 供托净增
    pushSnapshot(game);
    game.kyotaku = target;
    game.players[pIdx].points -= diff; // 增则补缴扣分；减则取回加分
    return {
      ok: true,
      msg: `供托已修正为 ${target} 点（${payerName} ${diff > 0 ? '补缴' : diff < 0 ? '取回' : '无变化'} ${Math.abs(diff)} 点）`,
    };
  }

  // ---------- 番符 → 点数计算（纯查询工具，供番符表弹窗使用） ----------
  // 满贯以上档位（番数 ≥5 时无条件套用，无视符数）：
  //   5=满贯、6~7=跳满、8~10=倍满、11~12=三倍满、13+=役满
  // 固定基本点 / 子荣和 / 子自摸(闲付·庄付) / 亲荣和 / 亲自摸(闲各付)
  const LIMIT_LOOKUP = [
    null,                                   // 占位（番0不存在）
    null, null, null, null,                 // 番1~4 走公式（占位）
    { name: '满贯', base: 2000, ko: 8000, tsumo: [2000, 4000], oyaKo: 12000, oyaTsumo: 4000 },
    { name: '跳满', base: 3000, ko: 12000, tsumo: [3000, 6000], oyaKo: 18000, oyaTsumo: 6000 },
    { name: '跳满', base: 3000, ko: 12000, tsumo: [3000, 6000], oyaKo: 18000, oyaTsumo: 6000 },
    { name: '倍满', base: 4000, ko: 16000, tsumo: [4000, 8000], oyaKo: 24000, oyaTsumo: 8000 },
    { name: '倍满', base: 4000, ko: 16000, tsumo: [4000, 8000], oyaKo: 24000, oyaTsumo: 8000 },
    { name: '倍满', base: 4000, ko: 16000, tsumo: [4000, 8000], oyaKo: 24000, oyaTsumo: 8000 },
    { name: '三倍满', base: 6000, ko: 24000, tsumo: [6000, 12000], oyaKo: 36000, oyaTsumo: 12000 },
    { name: '三倍满', base: 6000, ko: 24000, tsumo: [6000, 12000], oyaKo: 36000, oyaTsumo: 12000 },
    { name: '役满', base: 8000, ko: 32000, tsumo: [8000, 16000], oyaKo: 48000, oyaTsumo: 16000 },
  ];
  // 番≥14 视为役满档（兜底）
  for (let i = 14; i < 30; i++) LIMIT_LOOKUP[i] = LIMIT_LOOKUP[13];

  /** 向上取整到 100（荣和与自摸各支付项均采用此进位） */
  function ceil100(n) { return Math.ceil(n / 100) * 100; }

  /**
   * 计算番符 → 点数（不含本场加算/立直棒/供托，纯番符分）。
   * @param {number} han 番数（1~13+）
   * @param {number} fu  符数（20/25/30/…）
   * @param {'oya'|'ko'} seat 亲家(庄) 或 子家(闲)
   * @param {number} [playerCount=4] 场上人数（3=三人缺北 / 4=四人）。
   *        只影响**自摸总额与分摊说明**：三人缺北时"缺的那家"那份不取，
   *        故总额 = 实际付款家的应付额之和；每家应付额本身与人数无关。
   * @returns {{limit:string|null, ron:number|null, tsumo:number|null,
   *            tsumoKo:number|null, tsumoOya:number|null, tsumoNote:string}|{error:string}}
   *   ron: 荣和（和牌者所得）
   *   tsumo: 自摸和牌者所得总额（按 playerCount 计）
   *   tsumoKo: 自摸时"每位闲家(子)应付"（和牌者为亲家时即各家应付额）
   *   tsumoOya: 自摸时"庄家(亲)应付"；和牌者本身是庄家时为 null（无庄付项）
   *   tsumoNote: 自摸分摊说明（如 "闲各付 1000 / 庄付 2000（共 4000）"）
   */
  function calcScore(han, fu, seat, playerCount) {
    const h = Math.floor(han) || 0;
    if (h < 1) return { error: '番数至少为 1' };
    const f = Math.floor(fu) || 0;
    if (f < 20) return { error: '符数不合法' };

    // 人数只影响自摸：付分的闲家数 = 总人数 −自己 −(自己若是闲则再少一位庄家)
    const n = Math.max(3, Math.floor(playerCount) || 4);
    const koCnt = seat === 'oya' ? n - 1 : n - 2;
    const oyaCnt = seat === 'oya' ? 0 : 1;
    const n3Note = n === 3 ? ' · 三人缺北少收一份' : '';
    /** 自摸总额 = 各付款家应付额之和（三人缺北时缺的那份不取，即"自摸损"） */
    const sumTsumo = (ko, oya) => ko * koCnt + oya * oyaCnt;
    /** 自摸分摊说明，与 sumTsumo 同口径 */
    const noteTsumo = (ko, oya) => (seat === 'oya'
      ? `闲各付 ${ko}（共 ${sumTsumo(ko, 0)}）`
      : `闲各付 ${ko} / 庄付 ${oya}（共 ${sumTsumo(ko, oya)}）`) + n3Note;

    // 番≥5：直接套满贯以上档位
    if (h >= 5) {
      const L = LIMIT_LOOKUP[h] || LIMIT_LOOKUP[13];
      if (seat === 'oya') {
        return {
          limit: L.name,
          ron: L.oyaKo,
          tsumo: sumTsumo(L.oyaTsumo, 0),
          tsumoKo: L.oyaTsumo,
          tsumoOya: null,
          tsumoNote: noteTsumo(L.oyaTsumo, 0),
        };
      }
      return {
        limit: L.name,
        ron: L.ko,
        tsumo: sumTsumo(L.tsumo[0], L.tsumo[1]),
        tsumoKo: L.tsumo[0],
        tsumoOya: L.tsumo[1],
        tsumoNote: noteTsumo(L.tsumo[0], L.tsumo[1]),
      };
    }

    // 番 1~4：公式 base = fu × 2^(han+2)；base≥2000 封顶为满贯
    const base = f * Math.pow(2, h + 2);
    if (base >= 2000) {
      const L = LIMIT_LOOKUP[5]; // 满贯
      if (seat === 'oya') {
        return { limit: '满贯', ron: L.oyaKo, tsumo: sumTsumo(L.oyaTsumo, 0), tsumoKo: L.oyaTsumo, tsumoOya: null, tsumoNote: noteTsumo(L.oyaTsumo, 0) };
      }
      return { limit: '满贯', ron: L.ko, tsumo: sumTsumo(L.tsumo[0], L.tsumo[1]), tsumoKo: L.tsumo[0], tsumoOya: L.tsumo[1], tsumoNote: noteTsumo(L.tsumo[0], L.tsumo[1]) };
    }

    if (seat === 'oya') {
      // 亲家荣和 = 6N 进位；亲自摸 = 闲各付 2N 进位
      const ron = ceil100(base * 6);
      const perKo = ceil100(base * 2);
      return { limit: null, ron, tsumo: sumTsumo(perKo, 0), tsumoKo: perKo, tsumoOya: null, tsumoNote: noteTsumo(perKo, 0) };
    }
    // 子家荣和 = 4N 进位；子自摸 = 闲付 N、庄付 2N（各进位）
    const ron = ceil100(base * 4);
    const koPay = ceil100(base * 1);
    const oyaPay = ceil100(base * 2);
    return { limit: null, ron, tsumo: sumTsumo(koPay, oyaPay), tsumoKo: koPay, tsumoOya: oyaPay, tsumoNote: noteTsumo(koPay, oyaPay) };
  }

  /**
   * 撤回一局（仅房主，可连续多局）
   * @returns {{ok,msg}}
   */
  function undo(game) {
    if (game.over) {
      // 对局已结束后也可以撤回，回退到上一局继续
      game.over = false;
      game.endReason = '';
    }
    const snap = game.history.pop();
    if (!snap) return { ok: false, msg: '没有可撤回的记录了' };
    // 恢复快照
    game.players = snap.players.map((p) => ({ ...p }));
    game.dealerIndex = snap.dealerIndex;
    game.round = { ...snap.round };
    game.honba = snap.honba;
    game.kyotaku = snap.kyotaku;
    game.gameWind = snap.gameWind;
    return { ok: true, msg: `已撤回，回到${snap.round.wind}${snap.round.num}局之前` };
  }

  /** 在应用任何会改变全局状态的操作前，保存快照到 history */
  function pushSnapshot(game) {
    game.history.push({
      players: game.players.map((p) => ({ ...p })),
      dealerIndex: game.dealerIndex,
      round: { ...game.round },
      honba: game.honba,
      kyotaku: game.kyotaku,
      gameWind: game.gameWind,
      over: game.over,
    });
  }

  /**
   * 依据某局结算时的快照（本局开始结算前状态）与当前游戏状态，构建该局的分数字记录。
   * 在 applyRoundResult 完成分数转移与供托归属、且尚未推进局数前调用
   * （必须早于第 4 步「清空本局立直状态」，否则读不到本局立直标记）。
   * @param {object} snap 本局开始结算前 pushSnapshot 产生的快照
   * @returns {{round:string, honba:number, label:string,
   *            players:Array<{name:string, wind:string, pts:number, delta:number, riichi:boolean}>}}
   *   - round/honba/label：本局（快照时的）局号、本场数、展示标签（如「东一局·0本」）
   *   - players：各玩家结算后分数 pts 及本局净变化 delta（含本场加算与供托收入）
   *   - players[].riichi：本局是否立直（供 UI 显示立直小标记）
   *
   * delta 口径（用户 2026-09-11 确认）：
   *   不含立直的：delta = 结算后分数 − 快照分数
   *   但立直的 1000 点在 doRiichi() 时就已扣走，早于本快照，不落在上述差值里 →
   *   立直者若不补记就会显示 (0)。故对「本局立直」者再减 1000，使 delta 等于
   *   该玩家本局真实的分数变化（立直 -1000 记在立直那一局）。
   *   供托收入则记在收走它的那一局（可能晚于立直局，如流局继承后由下局和牌者收走），
   *   全半庄各局 delta 相加 + 留在池中的供托 = 0，仍守恒。
   */
  function buildHandRecord(game, snap) {
    const beforeMap = {};
    (snap.players || []).forEach((p) => { beforeMap[p.name] = p.points; });
    const honba = snap.honba || 0;
    const label = `${snap.round.wind}${snap.round.num}局·${honba}本`;
    return {
      round: { wind: snap.round.wind, num: snap.round.num },
      honba,
      label,
      players: game.players.map((p) => {
        const before = (beforeMap[p.name] != null) ? beforeMap[p.name] : p.points;
        const riichi = !!p.riichi;              // 本局立直（doRiichi 已扣 1000 入供托）
        const riichiPaid = riichi ? 1000 : 0;   // 补记这笔，否则立直者本局显示 (0)
        return {
          name: p.name, wind: p.wind, pts: p.points,
          delta: p.points - before - riichiPaid,
          riichi,
        };
      }),
    };
  }

  /** 序列化用于本地存储 */
  function serialize(game) {
    return JSON.stringify(game);
  }

  /** 反序列化 */
  function deserialize(str) {
    return JSON.parse(str);
  }

  return {
    WINDS,
    createGame,
    doRiichi,
    checkBalance,
    applyRoundResult,
    manualAdjust,
    adjustRound,
    dealerIndexForRound,
    roundsPerWind,
    setHonba,
    adjustKyotaku,
    calcScore,
    undo,
    serialize,
    deserialize,
    indexByName,
    dealer,
    nextIndex,
  };
})();

// 导出（浏览器环境挂到 window）
if (typeof window !== 'undefined') window.Rules = Rules;
if (typeof module !== 'undefined' && module.exports) module.exports = Rules;
