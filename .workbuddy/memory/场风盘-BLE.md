# 场风盘墨水屏（BLE）· 专题笔记

> 从 `MEMORY.md` 拆出（2026-10-05，为给注入体积腾空间）。**动墨水屏相关代码前必读本文件。**
> 过程/实测细节见日期日志 `2026-10-03.md` / `2026-10-04.md`。

## 硬件与固件
- 4.2″ 三色 400×300（UC8176，驱动字节 **0x03**）；设备名 `NRF_EPD_2`、MAC `<你的设备MAC>`
- 🔴 **USB 口只充电不通信**；通信全靠 BLE + 机身按键
- 🔴 **默认蓝牙关**（长按机身按键→灯亮 = 已开）
- 🔴 **LED 常亮不闪 ≈ 卡在刷屏流程**
- 🔴 **黑白快刷已彻底删除（用户要求）**：改 PSR/CDI/LUT 会把屏刷白并令固件失联（只能拆电池）。**勿再引入**

## 协议（= tsl0922/EPD-nRF5）
参考实现：`https://breeze4dev.github.io/epd-noclock/`（源码 `.workbuddy/tmp/epd-ref/`，主逻辑 `s6.js`）

- 流程：`INIT(0x01)` → 等 notify `mtu=N` → `WRITE_IMG(0x30)` 黑白面 → 红面 → `REFRESH(0x05)`；连上先 INIT 再 sleep 500ms
- 每包 = `[0x30, 标志位, 数据…]`，块大小 = `mtu-2`
- 标志位（`EPD_service.c:216-219`）：bit0=1 红/0 黑、bit1=1 首块、bit2=1 数据是 RLE ⇒
  **黑面首块 `0x02` / 续块 `0x00`，红面首块 `0x03` / 续块 `0x01`**；我们发原始数据 ⇒ bit2 恒 0
  ⚠️ 旧 `0x0F/0xFF/0xF0` **已废弃**（`0x0F & 1 = 1` 会被判成红面）
- 回执默认每 50 块一次（末块必带）；`setAckInterval(1)` ⇒ 每块都带
- 画面链：对比度 1.2 → Floyd-Steinberg 抖动（最近色按加权 Lab 0.2/3/3）→ 量化（灰度≥140 白；`r>160 && r>g && r>b` 红）；位图 1bpp、MSB 在前、1=白 0=黑（红面 0=红）
- 设备实测：`driver=0x03`、`mtu=244 rle=1`；引脚串 `1413060504030207`；配置包 byte7=`model_id`、byte11=`display_mode`

## 🔴 推图铁律
- **原生推图必须带 `0x30`**：只发 `[标志位, 数据…]` 时固件按首字节当命令分发 ⇒ 黑面首块→`CLEAR`、续块→`SET_PINS`、红面→`INIT`/`SEND_CMD`（带参 `epd_init` 会落盘改 model_id）⇒ 画面一字节没进显存，症状＝"能连上但推什么都无反应"（清屏却正常）
- **INIT 一律裸发**：固件参数长度 >1 → `epd_init(p_data[1])` 会落盘改型号。`epd_init()` 内部含复位+上电 ⇒ **"没上电"不是刷不动的原因**
- 驱动表：`0x01`=4.2″黑白 / `0x03`=4.2″三色 / `0x07`=7.5″三色
- **CCCD 必须校验写成功**：`g.writeDescriptor()` 返回值曾被忽略且无兜底 ⇒ 排队失败无任何回调，`mtu=N rle=1`/配置包全收不到。现：看返回值 + 4 次退避重试（1.5/3/5/8s）+ API33 `onCharacteristicChanged(g,c,value)` 重载
- ⚠️ **别假定第一条 notify 是二进制配置包**：本固件首包是文本 `spiflash=…`；判据用"首字节是否可打印"（`d[0] < 0x20`），别用 `idx==0 && !isText`
- ⚠️ **`REFRESH` 必须查返回值**（原先丢掉 ⇒ 失败也报"推送完成"）
- ⚠️ **不能靠推图耗时判断刷新是否生效**：推图 1144ms 而三色全刷约 15s，write response 不等 `drv->refresh()` 跑完，只能看屏
- ✅ **链路已验证通**（Web Bluetooth）：清屏→全白、测试图案→正确显示；画面产出与设备诊断逐项一致

## 🛠 自检 / 诊断
- 「面板自检（清屏）」`TagPush.clearPanel()` → `CLEAR(0x02)`：不经位图/RLE/标志位，切开"屏不响应" vs "数据错"
- 「推送测试图案」（无需对局）、「逐块回执」、「推图诊断」面板、`#eink-log` 留屏；原生侧（page-eink）同款卡片
- `TagPush` 导出：`setLog/setStatus/onDiag/setReadOnly/setAckInterval`
- ⚠️ **`tag.html` 推送硬前置：必须收到对局 WS `state`**（`currentGame` 非空）；`listenState` 走 `location.host` ⇒ PC `serve.js` 与手机内嵌 server 是两个实例，对局在手机、页面在电脑时点按钮没反应。`tag.html` 未进 assets
- 🛠 「修复引脚配置」`#btn-eink-fixpins` → `SET_PINS(0x00)`，载荷 `[14,13,06,05,04,03,02,07,0]`（幂等）

## 推送触发与节流
- 触发点：立直宣言/取消、局结算、流局结算 → `notifyTagPush(false)`（走节流）；「立即推送」→ `notifyTagPush(true)`（不受限）
- 🔴 **节流只在原生侧 `EinkBoardManager.THROTTLE_MS`**（2026-10-04 用户要求 10s→**1s**），JS 侧无第二道。语义＝合并窗口内连发、只推最后一版
- ⚠️ 三色全刷 ~15s 是硬件开销，端到端仍有十几秒

## 扫描
- 🔴 **绝不能按 Service UUID 过滤**：固件 advdata 只有 Flags + 名字，服务 UUID 在 **scan response** ⇒ `setServiceUuid` 会滤光全部设备。现为 `startScan(null,…)` + 回调软命中（含 UUID 或名字带 `EPD` → `hit:true`）
- 🔴 **`BLUETOOTH_SCAN` 带 `neverForLocation` 时，系统按"是否持有 `ACCESS_FINE_LOCATION`"决定是否过滤含位置信息的广播**；缺位置权限的典型表现＝"扫到一堆设备却独缺目标"。已声明 + 运行时申请
- 🔴 **判别铁律：同一时刻小程序能扫到、本 App 扫不到 ⇒ 系统层权限过滤**，不是"设备没广播"。国产 ROM（MIUI/HyperOS）**关闭「定位服务」时 BLE 扫描启动成功但零回调**，表现相同 —— 排查第一嫌疑
- ⚠️ 四坑：① `getBluetoothLeScanner()` 可能返 null ② 每次广播都回调，须按地址去重 ③ 无 BLUETOOTH_CONNECT 时用 `ScanRecord.getDeviceName()` ④ `scan-done` 分「一个都没扫到／扫到 N 个但 0 个像场风盘／发现场风盘」三种提示
- ⚠️ **结果绝不能"同地址只上报一次"**：advdata 与 scan response 是两个包，首个回调可能没名字；`add(addr)` 后 return 会丢掉带名字的后续回调 ⇒ 列表全无名且永不命中。现为"首次上报 + 更好名字时补报"，页面按地址 **upsert**
- 🛟 兜底：「直接连接地址」输入 MAC 直连（`NativeBridge.einkConnectAddr`），绕开扫描
- **蓝牙诊断**：页面「蓝牙诊断」→ `diagnose()` 输出 系统/三项权限/适配器/扫描器/**定位服务开关**/已配对设备数/上次扫描广播数；**扫描零结果自动 `stopScan()`**。固件 1s/次广播，`APP_ADV_TIMEOUT=120s`
- ⚠️ **既有缺陷（未修）**：`MainActivity.requestBlePermission()` 的 `SDK_INT < 31` 分支直接返回，**从不申请 `ACCESS_FINE_LOCATION`** ⇒ Android 11 及以下必然扫不到

## 原生连接状态机（真机取证后定稿，勿回退）
- 🔴 **「扫描独缺场风盘」的真因是 App 自己占着设备**（无限重连 + 建连期间 LE 扫描被暂停），**不是**设备不广播。判据：logcat `on_create_connection_timeout` + `HCI_ERR_HOST_TIMEOUT`，每次 connect 到该行正好 ~30s
- 🔴 **扫描前必须收掉「连接中」那一路**：`setPermissionOk(boolean allowAutoConnect)`，扫描/权限路径传 `false`
- 🔴 **`reconnectTries` 只在「手动连接」和「真正连上」时清零**；写在 `connectGatt()` 里会让 `MAX_RECONNECT` 失效成无限死循环
- 🔴 **`emit("connected")` 在 `onServicesDiscovered`**（特征+CCCD 就绪处），不在 `STATE_CONNECTED`
- ⚠️ 一次失败回调**两次** `DISCONNECTED` → `retiredGatt` 闸去重，旧 gatt 回调要 `g != gatt` 忽略；⚠️ 顺序**先 `disconnected` 再 `connect-fail`**
- 事件集：`scanning/scan/scan-done/connecting/connected/disconnected/connect-fail/connect-giveup/log/ble/push-status`
- 扫描列表**按权重排序**：命中(0)→有名字(1)→无名(2)；`connected` **不清空日志**
- ⚠️ **`app.js` 是 IIFE**：`showPage`/`einkLog`/`buildQrPngBase64` 等**不是全局**。CDP 走真实 UI（`window.showMode()`）或喂 `window.EinkNative.onStatus(type,data)`

## 四边版式（勿改）
- 四人：东下 `[0,220,400,80,0]` / 南右 `[280,80,120,140,-90]` / 西上 `[0,0,400,80,180]` / 北左 `[0,80,120,140,90]`；三人西改左边、上方留空
- 长边(400×80)风位左+分数右横排；短边(120×140)风位在上、分数在下（基线 `-Hh/2+46+8` / `Hh/2-26`），立直棒 `cy = Hh/2 - (长边?20:8)`
- 🔴 **`wide` 判据必须用语义**：`drawEdge()` 是 `tag.html` 的 Java 移植，母本阈值里的 `angle` 是**弧度**、Java 传**角度** ⇒ 阈值恒真 ⇒ 南北短边横排文字重叠。修法 `boolean wide = (angleDeg % 180f) == 0`。教训：跨端移植先确认量纲
- 复核：`tools/check-tag-edge-layout.js`、`tests/tag-edge-geometry-test.js`

## 首页「推送二维码到场风盘」（2026-10-05）
- `#btn-push-qr` 在 `#net-room-qr` 内 → 无二维码（非房主/未联网）时随卡片隐藏；仅已连场风盘时可点，否则置灰
- 连接态 `einkConnected` 由 `EinkNative.onStatus('connected'/'disconnected'/'connecting'/'connect-fail')` 维护；进首页调 `refreshEinkConnected()` → `NativeBridge.einkIsConnected()`
- 内容 = `currentJoinUrl`（`http://<房主IP>:8765/`）；`buildQrPngBase64()` 用 qrcode.js 按模块整数倍画进 400×300 白底（静默区 4 模块）→ PNG base64 → `NativeBridge.einkPushQr`
- 原生 `EinkBoardManager.pushQrPng(b64)`：Base64→Bitmap（不足 400×300 则缩放）→`pushBitmap`；**不做对比度/抖动**（纯黑白，抖动只添噪点），并先清掉挂着的自动推送节流
- 一次性推送；之后立直/结算的自动推送照常刷回分数画面（用户已确认可接受）。测试 `tests/push-qr-test.js`
