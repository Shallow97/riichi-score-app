# MEMORY.md · 日麻计分APP

> 硬事实速查（**索引层**）。过程细节见日期日志（最新 `2026-10-10.md`）。
> ⚠️ 本文件有注入体积上限，只放"每次都要知道"的；深度内容在专题文件里（见下）。
> 只记已拍板结论，勿重新提议。

## 📂 专题文件（按需再读）
- `.workbuddy/memory/场风盘-BLE.md` —— 墨水屏协议/推图铁律/扫描/连接状态机/四边版式/**首页推送二维码**。**动墨水屏代码前必读**
- `.workbuddy/memory/联网同步与工具链.md` —— 协议 v2、操作权、结算弹窗链；构建/adb/CDP/测试命令
- 早期日志（2026-09 ~ 2026-10-04）已归档到 `.workbuddy/archive-memory-2026-10-10/`，**不入库**；结论已并入本文件与专题文件

## 架构
- 房主手机跑 APK（内嵌 `RiichiServer.java`，:8765）；WebView 载 `http://127.0.0.1:8765/?host=1&lanip=<IP>`，WS `/ws`
- ⚠️ WS 服务端三处同源，改一处必同步另两处：`prototype/js/net.js`、`prototype/serve.js`、`android/.../RiichiServer.java`
- ⚠️ **资源双份**：`prototype/` ↔ `android/app/src/main/assets/`（APK 只认 `assets/js/*`）。改完 cp 到 assets、`diff -q`、再 assembleDebug
- 加入他人对局：输入房主 IP → 导航 `http://<IP>:8765/`；返回键 goBack
- 扫码：`#btn-scan-qr` → `#modal-scanqr` + `js/jsqr.js` → `joinRemoteRoom`；需 CAMERA 权限 + 放行 `RESOURCE_VIDEO_CAPTURE` + `setMediaPlaybackRequiresUserGesture(false)`。⚠️ 只有 `http://127.0.0.1` 是安全上下文
- SPA 模块：`rules/storage/net/qrcode/jsqr/sfx/tagpush/app`；独立页 `tag.html`；`window.JoinRoom{...}`
- 中文路径 → `gradle.properties` 需 `android.overridePathCheck=true`

## 场风盘墨水屏 · 只需记住这几条（其余见专题）
- 4.2″ 三色 400×300（UC8176，驱动 **0x03**）；名 `NRF_EPD_2`、MAC `<你的设备MAC>`
- 🔴 **USB 只充电不通信**；通信靠 BLE + 机身按键；**默认蓝牙关**（长按按键→灯亮=开）；**LED 常亮不闪 ≈ 卡在刷屏**
- 🔴 **黑白快刷已彻底删除（用户要求）**：改 PSR/CDI/LUT 会刷白屏 + 固件失联。**勿再引入**
- 🔴 **推图每包必须带 `0x30`**（只发标志位会被固件当命令 ⇒ 引脚被写坏/画面不进显存）
- 🔴 **INIT 一律裸发**（带参会落盘改型号）；`epd_init()` 内含复位+上电 ⇒ "没上电"不是刷不动的原因
- 🔴 **扫描绝不能按 Service UUID 过滤**（UUID 在 scan response，会被滤光）；三个 🔴 判别法则见专题
- 🔴 **`app.js` 是 IIFE**：`showPage`/`einkLog`/`buildQrPngBase64` 等**不是全局**
- 推送节流：`EinkBoardManager.THROTTLE_MS`（现 **1s**），只在原生侧；触发点＝立直宣言/取消、局结算、流局结算；「立即推送」不受限
- 首页「推送二维码到场风盘」：`#btn-push-qr` 在 `#net-room-qr` 内（无二维码随卡片隐藏），仅已连场风盘可点；推 `http://<房主IP>:8765/` 的二维码

## 计分口径（用户规定，勿改）
- 守恒：总分 = 玩家分和 + 供托池（四人 100000 / 三人 105000）
- 本场费：荣和一人付 `300N`；自摸每家付 `100N`（三人缺北自摸损：收 200N、2 家各付 100N）
- 本场推进：仅闲家和归零，流局或庄家和 +1（`advanceRound` 用 `isFlow` 解耦）
- **最后一局连庄例外**：南/西场最后局庄家和（多响含庄），结算后庄家**不是全场最高（平分也算）** → 不终局、连庄（局号不变、本场+1），**优先于西入"≥阈值即结束"**。实现：`checkRoundEnd` 开头拦截（`dealer.points <= maxOthers` 返 null）。测试 `dealer-win-continue-test.js`
- 荒牌流局未听罚符：总转移固定 **三人 2000 / 四人 3000**（听者平分收、未听平分付），勿写成 ×人数；`notenBappuTotal()` 驱动三处文案
- 多响：供托+本场加算归「放铳者逆时针第一个赢家」`pickKyotakuReceiver`
- 逐局 delta：`delta=结算后分−快照分−(本局立直?1000:0)`，**必须在 applyRoundResult 第 4 步清立直状态前读 `p.riichi`**；老记录无此字段则原样显示
- `Rules.calcScore(han,fu,seat,playerCount=4)`：番 1~4 `base=fu*2^(han+2)`，≥2000 封满贯，**不开切上满贯**；返回 `ron`/`tsumoKo`/`tsumoOya`(亲自摸 null)/`tsumo`/`tsumoNote`。⚠️ **回填只用 `tsumoKo`/`tsumoOya`**

## 关键坑
- Android14 闪退：targetSdk34 + `foregroundServiceType="dataSync"` 须同声明 `FOREGROUND_SERVICE_DATA_SYNC`
- 局域网 IP 勿用 `WifiManager.getIpAddress()` → NetworkInterface 遍历，优先 `wlan/eth/en/ap`
- ⚠️ `.btn + .btn{margin-top:10px}` 在 flex 行里害人 → 行内多按钮显式 `margin-top:0`
- ⚠️ Bash 里 `VAR=xxx && "$VAR" …` 会报 `sandbox-center cmd decisionRecord` → **写全路径直呼**

## UI 约束
- 固定窄屏 ~393px（无 `@media`）；**5** 个 `.page`（mode/setup/main/history/eink）+ **26** 个 `#modal-*`；⚠️ 改版成本主要是 tests/ 上千处 DOM 断言（唯 `view-lock-test.js` 读 style.css）→ 不动 class/HTML 结构则全绿
- 外观：圆角 10/14/20px；字重≤700；`--text-dim #5F6E76`、`--gold #8F6B12`、`--danger-text #C13E2E`；按钮=描边环+轻投影（按压 scale .98）；`#toast` 在**底部**；`.btn:disabled{opacity:.45}`
- 组件色**已全部 token 化** → 改主题只动 `:root`
- 弹窗动画：只有"从主界面新开"播 overlayIn/modalIn（`.12s`）；链内推进/叠层加 `.instant`（判据=150ms 内关过弹窗或已有弹窗开着）；`prefers-reduced-motion` 全禁
- 座位卡 pts 22px tabular-nums 为第一焦点、wind 14px、局号 16px；close-x 44px 热区；**东风位即庄家，不加庄家徽标**
- 四角按钮用线性 SVG；**#btn-help「？」保留汉字字形**（translateX 5px 是滑块校准，勿动）；`#btn-tsumo-ron` 绿、`#btn-end` 幽灵描边深红
- 空态 `.empty-state`/`.empty-riichi .er-bar`；round-log 空态文案**必须保留「尚无已结算的对局」**
- 视觉稿 `design-preview/`；复核 `tools/shot-visual-opt.js`（勿起 serve.js）、`tools/check-device-visual.js`；**夜间主题用户已拍板不考虑，勿再提议**

## 版本管理（GitHub）
- `https://github.com/Shallow97/riichi-score-app`，分支 `main`（默认）与 `eink-board`（墨水屏开发分支）；仓库级 `user.name=Shallow97`
- ⚠️ github.com 走 Clash `127.0.0.1:7897`（沙箱内被拦 502）；已设仓库级 proxy + `http.version=HTTP/1.1`
- 凭据：GCM（Shallow97）→ Windows 凭据管理器；**勿把 token 写进 remote URL**；GCM 授权须**沙箱外**
- ⚠️ **系统级 git 里的 `helper-selector` 会导致推送弹窗**（2026-10-10 已从 `D:/workbuddy/resources/vendor/PortableGit/etc/gitconfig` 移除）。
  凭据链只剩用户级 GCM。**WorkBuddy 升级可能把它带回来**，届时用 `git config --system --unset-all credential.helper` 再清。
- **开源状态（2026-10-10）**：MIT 许可 + README 已改写为公开版；已剔除硬编码本机路径、真实 MAC、内网 IP。
  仓库同时保留 `prototype/` 与 `assets/` 两份前端资源（开源可复现打包），改动仍需同步两份。

## 测试与构建命令
- **构建 APK（工具链不在 PATH，必须显式指定全路径）**：
  ```bash
  export JAVA_HOME="D:/tools/jdk-17.0.2"        # 另有 D:/Android Studio/jbr/bin/java.exe
  export GRADLE_USER_HOME="D:/tools/gradle-home"
  /d/tools/gradle-8.2/bin/gradle assembleDebug --no-daemon
  ```
  ⚠️ `android/` 下**没有 `gradlew`**（只有 wrapper properties），且 `java`/`gradle` 都不在 PATH，
  必须按上面写全路径直呼（否则触发沙箱 `decisionRecord` 报错）。SDK 在 `C:/Users/Administrator/AppData/Local/Android/Sdk`。
- 跑测试：`cd prototype && npm test`（20 个脚本，无需服务器）；`npm test -- --server` 连 net 系列一起跑（自动起 serve.js）
- ⚠️ 测试需 `jsdom`（devDep）+ `ws`（dep），本机 jsdom 在受管 workspace，跑测试前设
  `NODE_PATH=C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules`
- ⚠️ `tests/run-all.js` 用异步 `spawn` 而非 `spawnSync`：本机 cmd.exe 在沙箱下会 `EBUSY`，`shell:true` 走不通
- 打包后校验：`unzip -p app-debug.apk assets/js/app.js | sha256sum` 对比 `prototype/js/app.js`（**别看字节数**）
- dex 时间戳显示 `1981-01-01` 是 Android 构建常态；大量 `UP-TO-DATE` 通常也是对的（核对中国 class 编译时间）
