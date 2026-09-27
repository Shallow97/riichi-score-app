# MEMORY.md · 日麻计分APP

## 架构
- `D:\日麻计分APP`；中文路径，gradle.properties 需 `android.overridePathCheck=true`
- 房主手机跑 APK（内嵌 RiichiServer.java，端口 8765）；WebView 载 `http://127.0.0.1:8765/?host=1&lanip=<IP>`，WS 走 `/ws`；房主权威
- 静态 SPA：index.html + css/style.css + js/{rules,storage,net,qrcode,jsqr,app}.js
- ⚠️ **资源双份**：`prototype/` 与 `android/app/src/main/assets/`，改 prototype 后必须 cp 到 assets 再 assembleDebug
- **加入他人对局**：输入房主 IP → WebView 导航到 `http://<IP>:8765/`，复用成员链路（协议零改动，localStorage 按 origin 隔离），返回键 goBack 回本机
- **扫码加入**（2026-09-27）：房主二维码内容 = 成员访问地址；点 `#btn-scan-qr` 开 `#modal-scanqr`，`js/jsqr.js`(jsQR v1.4.0 离线) 逐帧解码 → 复用 `joinRemoteRoom`。Android 需 CAMERA + `onPermissionRequest` 放行 `RESOURCE_VIDEO_CAPTURE` + `setMediaPlaybackRequiresUserGesture(false)`。⚠️ 只有 `http://127.0.0.1` 是安全上下文（跳到房主页面后 `mediaDevices` 不存在）。取流 `ideal 1280x720`（真机确实给 720x1280、解码 45ms/帧），`SCAN_MAX_EDGE=1280`，自适应节拍；鲁棒性矩阵脚本在技能 `webview-camera-scan/scripts/`（实测 480×640 12/14 → 720×1280 13/14，可扫距离拉远 1.5×）
- `window.JoinRoom{normalize,join,probe,parseScan,startScan,stopScan,setNavigate}`

## 工具链
- JDK `D:/tools/jdk-17.0.2`（必须 export）；SDK `C:/Users/Administrator/AppData/Local/Android/Sdk`；`GRADLE_USER_HOME=D:/tools/gradle-home`；`android/` 下 `D:/tools/gradle-8.2/bin/gradle.bat assembleDebug --no-daemon` → cp 到根 `日麻计分APP-debug.apk`
- adb 绝对路径（不在 PATH）；包名 `com.riichi.score`；`install -r` 同签名可覆盖；校验内嵌资源 `unzip -p <apk> assets/js/app.js | sha256sum`
- ⚠️ **别拿 APK 字节数当信号**：同一套源码，增量打包与 `gradle clean assembleDebug` 出来的体积**可以差几十 KB**（实测同一内容：增量 181,973 / clean 165,804 / 更早 209,532），差异**全在非条目开销**（zip 结构 / 签名块 / 对齐填充），`unzip -v` 的条目名+原始大小+压缩大小**完全一致**。
  判断 APK 是否"内容正确"要**比条目**，不是比总字节：`unzip -v <apk> | awk 'NF>=8 && $8!="Name"'` 归一化后 diff；或直接比对内嵌资源哈希。
  **交付用 clean 出来的包**（更小、无累积打包开销）；用户若问"为什么体积变了"，先做条目 diff 再回答。
- **装完 APK 的验证链**（一条命令串起来，adb server 会被回收）：`install -r` → `dumpsys package com.riichi.score | grep lastUpdateTime`（确认是刚装的）→ `monkey -p com.riichi.score -c android.intent.category.LAUNCHER 1` + `pidof`（确认不闪退）→ 技能脚本 `cdp-eval.js` 直查真机 DOM（元素/`getComputedStyle` 是否为新版）
- 测试：`cd prototype/tests && NODE_PATH="C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules" "C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-2/node.exe" <脚本>.js`
  ⚠️ **跑测试前确认 8765 没被 serve.js 占用**：否则 net.js 连上 `ws://127.0.0.1:8765/ws`，重连定时器让 node 跑完不退出（`timeout` 返 124），易误判为定时器泄漏
- **真机 CDP**：APP 已开 `setWebContentsDebuggingEnabled`。`adb shell cat /proc/net/unix | grep -o "@webview_devtools_remote_[0-9]*"` → `adb forward tcp:9222 localabstract:<sock>` → node+`ws`(`prototype/node_modules`) 发 `Runtime.evaluate`
  ⚠️ adb 每条命令后 server 被回收 → forward 失效：**socket/forward/CDP 必须写在同一条 Bash 命令**
  ⚠️ `input tap` 在 WebView 内不可靠（改用 CDP 注入）；但系统权限框只能用 tap，且该 tap 会穿透到 WebView
- **真浏览器**（jsdom 无布局/canvas）：`cd prototype && node serve.js`（须后台任务方式起，`(cmd &)` 会被杀）→ chrome（`/c/Program Files/Google/Chrome/Application/chrome.exe`）无头或 CDP（`--remote-debugging-port=9333 --user-data-dir=D:/_x`）
  ⚠️ curl 必须 `--noproxy '*'`；Git Bash 不可写 `/tmp`、`/dev/null`（exit 23）→ 输出写 `D:/`；`--window-size=393` 无头下最小 512px（不回流只裁图），准图用 CDP
  ⚠️ **截"单机 UI"时千万别同时起 serve.js**：页面会被 8765 的 WS 接管成"成员"角色，`btn-create-game` 变异步（toast「对局由房主建立，请等待房主操作」），步骤脚本全乱 → 直接开 `file:///D:/日麻计分APP/prototype/index.html` 即单机，最省事。CDP 截图脚本模板：`prototype/tools/shot-settle-calc.js`（Emulation 393×852 dsf2 + `Page.captureScreenshot`）
- 手机：小米14 HyperOS/Android14 `aed9c8e9`；HyperOS 上 `pm revoke CAMERA` 无效

## 关键坑
- Android14 闪退：targetSdk34 + `foregroundServiceType="dataSync"` 须同声明 `FOREGROUND_SERVICE_DATA_SYNC`
- readHttpRequest 缺 `lineBuf.write(c)` → method/path=null，CSS/JS/WS 全失效
- 局域网 IP 勿用 `WifiManager.getIpAddress()`（双开/蜂窝返 0）→ NetworkInterface 遍历，优先 `wlan/eth/en/ap`
- 首次扫码授权那一记 tap 会穿透遮罩关掉扫码窗 → `modal-scanqr` 在 `!scanStream` 时忽略"点空白关闭"
- ⚠️ **`.btn + .btn { margin-top:10px }` 在 flex 行里会害人**：行内相邻的两个 `.btn` 都会吃到这个外边距，
  `align-items:stretch` 下容器交叉尺寸 = max(固有高 + margin)，于是**后一个按钮被顶下 10px 且比前一个矮 10px**
  （表现为"两个按钮一高一矮、顶边不齐"）。已踩两次：`.action-grid`（style.css:509 注释）、`.net-joinroom-row`。
  行内多按钮一律显式 `margin-top: 0` + 统一 `display/align-items/justify-content/padding`（扫码这类带图标的，
  只额外给 `gap`，其余盒模型与邻按钮完全一致）。**不要靠 `padding` 撑高——靠内容居中撑高才稳。**

## 版本管理（GitHub，2026-09-28 建立）
- 远端 **`https://github.com/Shallow97/riichi-score-app`（私有）**，分支 `main`，首提交 `aaa899e`（90 文件 / 2.92 MB）
- 身份：仓库级 `user.name=Shallow97`、`user.email=Shallow97@users.noreply.github.com`
- ⚠️ **对 github.com 必须走 Clash `127.0.0.1:7897`**：沙箱内被沙箱代理拦（CONNECT 502，只放行 `api.github.com`）；沙箱外直连时通时断（多 IP 轮询）。
  仓库级已设 `http.proxy`/`https.proxy`，另加 `-c http.version=HTTP/1.1`（直连时曾报 `Empty reply from server`）
- 凭据：GCM（PortableGit 自带 2.9.0）已 `github login` 账号 Shallow97 → Windows 凭据管理器；`credential.helper=helper-selector` 自动取到，**不要**把 token 写进 remote URL
- ⚠️ **GCM 的授权流程必须在沙箱外跑**（.NET 代理解析优先系统设置，不吃 `HTTPS_PROXY` 覆盖）；`--device --no-ui` 无 TTY 时静默挂住，用 `--browser`
- 入库范围：`.apk`／`node_modules/`／`android/**/build/`／`.workbuddy/{tmp,scratch}/` 已忽略；**保留** `.workbuddy/memory/` 与 `design-preview/`
- 核对远端内容别用"文件总数"（tree 节点会多算）：`GET /git/trees/main?recursive=1` 后**过滤 `type=="blob"`** 再与 `git ls-files` diff

## 计分口径（用户规定，勿改）
- 守恒：场上总分 = 玩家分和 + 供托池（四人 100000 / 三人 105000）
- 本场费：荣和一人付 `300N`；自摸每家付 `100N`（三人缺北自摸损：收 200N、2 家各付 100N）
- 本场推进：仅闲家和牌归零，流局或庄家和 +1（`advanceRound` 用 `isFlow` 解耦）
- 荒牌流局未听罚符：总转移固定 **三人 2000 / 四人 3000**（听者平分收、未听平分付），勿写成 ×人数；`notenBappuTotal()` 驱动三处文案
- 多响：供托与本场加算归「放铳者逆时针第一个赢家」`pickKyotakuReceiver`
- 逐局 delta：立直 -1000 记在立直局、供托 +N×1000 记在收走局（跨局相加+池中余额=0）；`delta=结算后分−快照分−(本局立直?1000:0)`，**必须在 applyRoundResult 第 4 步清立直状态前读 `p.riichi`**；老记录无该字段则原样显示

## 其它模块
- 手动修正（均 pushSnapshot 可撤）：`adjustRound`（含 `dealerIndexForRound` 反推庄家）、`adjustKyotaku`、`setHonba`
- 操作权：服务器把 host 当普通 ClientConn；net.js `iAmOperator` 恒 false，联网统一 request-action；`OP_MODALS` 全关 → 微任务 releaseAction
- 自摸：填单位应付额程序复制（`.tsumo-koha`/`.tsumo-oya`，三人缺北 koha 只 1 闲），两段式 amounts→review
- `Rules.calcScore(han, fu, seat, playerCount=4)`：番 1~4 `base=fu*2^(han+2)`，≥2000 封满贯，**不开切上满贯**。返回 `ron` / `tsumoKo`(每位闲家应付) / `tsumoOya`(庄家应付，亲自摸为 null) / `tsumo`(总额) / `tsumoNote`。
  ⚠️ **回填一律用 `tsumoKo`/`tsumoOya` 分类值，勿用 `tsumo` 总额**；`tsumo` 按第 4 参人数折（三缺北"缺的那家"那份不取 → 闲自摸 ko×1+oya、庄自摸 ko×2），不传参默认四人（向后兼容）。app.js 的 `updateCalc`/`onCalcClosed` 都传 `game.players.length`
- ⚠️ **结算有两条互不相干的弹窗链**（加功能必须两条都改，只改一条 = 界面上"按钮不存在"）：
  - 荣和：`modal-settle-type`→`pay`→`recv`→`amount`（单值 `#settle-amount`，放铳者付）
  - 自摸：`modal-tsumo`(选自摸者)→`tsumo-amounts`(分类填额)→`tsumo-review`(核对入账)
- **番符表联动**（2026-09-27）：`#btn-settle-calc` / `#btn-tsumo-calc` → `openCalcLinked(seat,name,wind,mode)` → 打开 `#modal-calc`；座位按 `isDealerByName(和牌者)` 锁 oya/ko，`calcLink={seat,receiverName,mode:'ron'|'tsumo'}` 非空即锁定，关闭时 `onCalcClosed()` 按 mode 回填（ron→`#settle-amount`；tsumo→`.tsumo-shared` 或 `.tsumo-koha`+`.tsumo-oya`）。⚠️ 番符表**叠层不切换**（`modal-calc` 不在 `OP_MODALS`，切换会误释放操作权）；⚠️ `#modal-calc` 需 `z-index:150`（两个填额弹窗 DOM 都比它靠后，同为 100 会压住它）；座位身份用 `isDealerByName` 推导，勿读 `wind`（连庄/局数旋转下 wind 会变）
- `prototype/tools/shot-{settle,tsumo}-calc.js`：真 Chrome CDP 393×852 截图骨架，改别的界面时复制后替换中间 `ev(...)` 步骤
- view-lock 只改渲染 class；`bindAll` 有 `__appBound` 幂等守卫

## UI 约束
- 面向固定窄屏 ~393px（无 `@media`）；index.html 4 `.page`（mode/setup/main/history）+ **27** 个 `#modal-*`
- ⚠️ 改版真正成本是 tests/ 上千处 DOM 断言（唯 `view-lock-test.js` 读 style.css 的 `.modal-view .view-actions .btn`）→ 不改 class 名/HTML 结构则全绿
- 视觉稿/三方案在 `design-preview/`
