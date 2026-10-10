# 日麻计分 APP · Riichi Score App

日本麻将（立直麻将）对局计分器。**房主手机跑一个 App，其他玩家用浏览器输 IP 就能进来打**——不用装 App、不用房间码、不用连公网服务器。

支持四人 / 三人（缺北）两种桌型，覆盖立直、本场、供托、多响、荒牌流局罚符等计分规则，并内置番符点数表可直接算分。可选配对 BLE 墨水屏"场风盘"，把局面推到桌面上。

## 特点

- **零安装加入**：房主手机开热点或同一 Wi-Fi，其他人浏览器访问 `http://<房主手机IP>:8765` 即可加入
- **扫码加入**：房主显示二维码，其他玩家扫码直接进房（离线解码，不依赖网络）
- **房主权威**：所有计分动作由手机内置服务器仲裁，各端只做渲染，天然防冲突
- **操作权互斥**：任意玩家可申请操作权执行和牌结算 / 立直，服务器串行裁决并广播
- **番符点数表联动**：和牌结算填分时可直接拉起点数表，座位按和牌者亲闲身份锁定，关闭自动回填
- **完整对局记录**：逐局 delta、历史详情、撤销（快照回滚）、手动修正
- **墨水屏场风盘（可选）**：通过 BLE 把当前局面推送到 4.2″ 三色墨水屏，纯离线、不依赖云端

## 快速开始

### 环境要求

| 项目 | 版本 |
| --- | --- |
| Android | minSdk 24（Android 7.0+）/ targetSdk 34 |
| 构建 | Gradle 8.2 + JDK 17 |
| Node.js | ≥ 18（仅调试 / 跑测试需要） |
| 端口 | `8765`（HTTP + WebSocket） |

### 房主（Android 手机）

```bash
# 设置 Android SDK 路径（每台机器一次）
echo "sdk.dir=/path/to/Android/Sdk" > android/local.properties

# 构建 debug 包
cd android
./gradlew assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

打开 App → 自动启动内嵌服务器（端口 `8765`）并加载本机页面 → 选桌型开局。

### 其他玩家

浏览器打开 `http://<房主手机IP>:8765`；或在自己手机 App 首页点「扫码」扫房主二维码。

### 纯前端调试（单机、不起服务器）

直接用浏览器打开 `prototype/index.html` 即为单机模式。

### 桌面快速起服务（联机调试）

```bash
cd prototype
npm install          # 装 ws（jsdom 为测试依赖）
npm start            # 等价于 node serve.js
```

Windows 下也可双击仓库根目录的 `服务器开关.bat` 一键开关服务器（需 Node.js 在 PATH，或先 `set NODE=<node.exe 路径>`）。

## 目录结构

```
prototype/                  前端（唯一开发源）
  index.html                单页应用骨架（5 个 .page + 26 个 #modal-*）
  tag.html                  场风盘渲染页（独立页，供墨水屏预览）
  css/style.css             全部样式（面向固定窄屏 ~393px）
  js/rules.js               计分核心：番符点数计算、本场/供托/罚符口径
  js/app.js                 UI 主逻辑：渲染、弹窗流程、结算链路
  js/storage.js             对局持久化（localStorage）
  js/net.js                 WebSocket 联机客户端
  js/tagpush.js             场风盘推图（Web Bluetooth）
  js/qrcode.js              二维码生成（房主展示）
  js/jsqr.js                jsQR v1.4.0，离线二维码解码（扫码加入）
  tests/                    30 个回归测试脚本 + run-all.js 运行器
  tools/                    真 Chrome（CDP）渲染截图与调试探针
  serve.js                  本地静态服务（联机调试用）
  package.json

android/                    Android 壳工程
  app/src/main/java/com/riichi/score/
    MainActivity.java         WebView 壳 + 权限/摄像头放行
    RiichiServer.java         内嵌 HTTP + WebSocket 服务器（房主权威）
    ServerService.java        前台服务，保活
    EinkBoardManager.java     BLE 场风盘管理（扫描/连接/推图）
    EinkTagRenderer.java      墨水屏版式渲染（Java 侧）
  app/src/main/assets/        前端资源副本（构建时使用）

design-preview/             设计稿与配色方案
```

> **资源是两份**：`prototype/` 与 `android/app/src/main/assets/`。改完 prototype 必须同步到 assets 再打包，否则 APK 里还是旧代码。
>
> ```bash
> cp prototype/index.html   android/app/src/main/assets/
> cp prototype/tag.html     android/app/src/main/assets/
> cp prototype/css/style.css android/app/src/main/assets/css/
> cp prototype/js/*.js      android/app/src/main/assets/js/
> ```

## 架构

```
房主手机 (Android)
┌─────────────────────────────────────────┐
│  RiichiServer (Java, :8765)             │
│    - 静态资源  ├─ HTTP                  │
│    - 对局状态机 └─ WebSocket /ws        │
│    - 动作仲裁、操作权互斥、广播            │
└───────────────┬─────────────────────────┘
                │ 同一局域网
      ┌─────────┼─────────┬─────────┐
      ▼         ▼         ▼         ▼
   WebView    浏览器     浏览器     浏览器
   (房主)     (成员)     (成员)     (成员)
```

- 服务器把房主也当成一个普通连接，**不搞特例**；所以"申请操作权"这套在单机和联机下走同一条路径
- 成员页面的 `localStorage` 按 origin 隔离，房主与成员的数据互不污染
- 回房主本机用 `goBack` 即可，不需要重新建立连接

### 墨水屏场风盘（可选）

场风盘是独立硬件，通过 **BLE** 与房主手机通信，把当前局面渲染到 4.2″ 三色墨水屏上。

- 通信不依赖路由器，USB 仅用于充电
- 推送由 App 内 `EinkBoardManager` 节流触发（立直宣言/取消、局结算、流局结算）
- 预览渲染：`prototype/tag.html?demo=1`（无需硬件）

> 若要接自己的硬件，需自行适配 `EinkBoardManager` 的 BLE 协议与 `EinkTagRenderer` 的版式。

## 计分口径（关键约定）

以下为本项目固定口径，改代码时请勿"顺手修正"：

- **守恒**：场上总分 = 各玩家分数之和 + 供托池。四人局 100000，三人局 105000
- **本场费**：荣和由放铳者一人付 `300N`；自摸每家付 `100N`
  （三人缺北时自摸收 `200N`、由 2 家各付 `100N`）
- **本场推进**：仅闲家和牌时归零；流局或庄家和牌则 `+1`
- **荒牌流局未听罚符**：总转移**固定**三人 2000 / 四人 3000（听者平分收、未听平分付），
  注意是总额而不是"每人 × 人数"
- **多响**：供托与本场加算归「放铳者逆时针方向的第一个赢家」
- **逐局 delta**：立直 `-1000` 记在立直那一局，供托 `+N×1000` 记在收走那一局；
  任意跨局区间内，delta 之和 + 池中余额 = 0
- **番数符数**：1~4 番 `base = 符 × 2^(番+2)`，≥2000 封顶满贯，**不采用切上满贯**
- **自摸分摊**：`calcScore` 返回分类金额（每位闲家应付 / 庄家应付）与总额；
  回填一律用分类值，总额会随人数变化

## 开发

### 跑测试

```bash
cd prototype
npm install
npm test                # 20 个脚本，不含需要本地服务的 net 系列
npm test -- --server    # 连同 net 系列一起跑（会自动拉起 serve.js）
```

- 30 个脚本，覆盖计分口径、多响、本场/供托、流局罚符、联网协议、扫码、UI 流程等
- `net-test.js` 等 10 个脚本需要本地 `8765` 服务，默认跳过以免进程卡死
- `java-server-parity.js` 用于校验前端规则与 Java 服务器行为一致
- 跑之前确认 `8765` 端口没被占用，否则客户端会反复重连、进程不退出，容易被误判成"定时器泄漏"

### 渲染复核

纯 DOM 测试测不出层叠、置灰、布局回流这类问题。`prototype/tools/` 下有真 Chrome（CDP）按设备尺寸渲染截图的脚本，改 UI 后建议跑一遍出图核对。前置：先起无头 Chrome 并打开对应页面。

## 已知限制

- 服务器只监听局域网，**公网跨网段不可用**
- 房主手机需保持前台服务存活；系统省电策略激进时可能被回收
- 墨水屏推送依赖 Web Bluetooth，仅在安全上下文（`https` 或 `localhost`）可用
- 计分口径按常见日麻规则实现，**未实现连庄/立直棒等全部竞技规则**，不同赛事规则可能不同

## 贡献

欢迎提交 Issue 和 PR。改动计分逻辑前请先读上面「计分口径」，并跑通 `npm test`；涉及 UI 的改动建议补一条 `tests/` 断言。

## 许可证

[MIT](LICENSE) © Shallow97
