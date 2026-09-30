# 日麻计分 APP

日本麻将（立直麻将）对局计分器。**房主手机跑一个 App，其他玩家用浏览器输 IP 就能进来打**——不用装 App、不用房间码、不用联网到公网。

支持四人 / 三人（缺北）两种桌型，覆盖立直、本场、供托、多响、荒牌流局罚符等计分规则，并内置番符点数表可直接算分。

## 特点

- **零安装加入**：房主手机开热点或同一 Wi-Fi，其他人浏览器访问 `http://<房主手机IP>:8765` 即可加入
- **扫码加入**：房主显示二维码，其他玩家在 App 内扫码直接进房（离线解码，不依赖网络）
- **房主权威**：所有计分动作由手机内置服务器仲裁，各端只做渲染，天然防冲突
- **操作权互斥**：任意玩家可申请操作权执行和牌结算 / 立直，服务器串行裁决并广播
- **番符点数表联动**：和牌结算填分时可直接拉起点数表，座位按和牌者亲闲身份锁定，关闭自动回填
- **完整对局记录**：逐局 delta、历史详情、撤销（快照回滚）、手动修正

## 快速开始

### 房主（Android 手机）

```bash
# 构建 debug 包
cd android
gradle assembleDebug          # 或 ./gradlew assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
adb install -r app-debug.apk
```

打开 App → 自动启动内嵌服务器（端口 `8765`）并加载本机页面 → 选桌型开局。

### 其他玩家

浏览器打开 `http://<房主手机IP>:8765`；或在自己手机 App 首页点「扫码」扫房主二维码。

### 纯前端调试（单机、不起服务器）

直接用浏览器打开 `prototype/index.html` 即为单机模式。

## 目录结构

```
prototype/            前端原型（唯一开发源）
  index.html          单页应用骨架（4 个 .page + 27 个 #modal-*）
  css/style.css       全部样式（面向固定窄屏 ~393px）
  js/rules.js         计分核心：番符点数计算、本场/供托/罚符口径
  js/app.js           UI 主逻辑：渲染、弹窗流程、结算链路
  js/storage.js       对局持久化（localStorage）
  js/net.js           WebSocket 联机客户端
  js/qrcode.js        二维码生成（房主展示）
  js/jsqr.js          jsQR v1.4.0，离线二维码解码（扫码加入）
  tests/              24 个回归测试脚本
  tools/              真 Chrome（CDP）渲染截图脚本
  serve.js            本地静态服务（联机调试用）

android/              Android 壳工程
  app/src/main/java/com/riichi/score/
    MainActivity.java   WebView 壳 + 权限/摄像头放行
    RiichiServer.java   内嵌 HTTP + WebSocket 服务器（房主权威）
    ServerService.java  前台服务，保活
  app/src/main/assets/  前端资源副本（构建时使用）

design-preview/       设计稿与配色方案
.workbuddy/memory/    开发日志与长期约定（计分口径、踩坑记录）
```

> 资源是**两份**：`prototype/` 与 `android/app/src/main/assets/`。改完 prototype 必须同步到 assets 再打包，否则 APK 里还是旧代码。

## 架构

```
房主手机 (Android)
┌─────────────────────────────────────────┐
│  RiichiServer (Java, :8765)             │
│    - 静态资源 /  ├─ HTTP                 │
│    - 对局状态机   └─ WebSocket /ws       │
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
cd prototype/tests
NODE_PATH=<node_modules> node <脚本>.js
```

- 24 个脚本，覆盖计分口径、多响、本场/供托、流局罚符、联网协议、扫码、UI 流程等
- `net-test.js` 需要先起 `prototype/serve.js` 再单独跑
- `java-server-parity.js` 用于校验前端规则与 Java 服务器行为一致
- 跑之前确认 `8765` 端口没被占用，否则客户端会反复重连、进程不退出，容易被误判成"定时器泄漏"

### 渲染复核

纯 DOM 测试测不出层叠、置灰、布局回流这类问题。`prototype/tools/` 下有真 Chrome（CDP）按设备尺寸渲染截图的脚本，改 UI 后建议跑一遍出图核对。

### 打包

```bash
# 1) 同步资源（改了 prototype 就必须做）
cp prototype/index.html android/app/src/main/assets/
cp prototype/css/style.css android/app/src/main/assets/css/
cp prototype/js/app.js android/app/src/main/assets/js/
cp prototype/js/rules.js android/app/src/main/assets/js/

# 2) 打包
cd android && gradle assembleDebug --no-daemon
```

> 校验 APK 里是不是新代码，**不要看字节数**——同一套源码在不同打包方式下能差几十 KB。  
> 要比就比内嵌资源哈希：`unzip -p app-debug.apk assets/js/app.js | sha256sum`。

## 环境要求

|               |                                       |
| ------------- | ------------------------------------- |
| Android       | minSdk 24（Android 7.0+）/ targetSdk 34 |
| applicationId | `com.riichi.score`                    |
| 构建            | Gradle 8.2 + JDK 17                   |
| 服务器端口         | 8765（HTTP + WebSocket）                |
| 前端            | 无框架、无构建步骤，纯静态文件                       |
