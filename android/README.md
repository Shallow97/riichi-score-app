# 日麻计分 — Android 房主端（服务器 + WebView 壳）

这是**房主手机端 App**：内置一个纯 Java 的 HTTP + WebSocket 服务器（`RiichiServer`），
其他玩家**无需下载 App、无需房间码**，直接用手机/电脑浏览器输入房主手机 IP 即可进入对局。

- 房主手机运行本 App → 自动启动内嵌服务器并加载本机页面。
- 其他玩家浏览器访问 `http://<房主手机IP>:8765` → 直接加入，作为成员。
- 任意玩家可申请操作权执行**和牌结算 / 立直**，服务器仲裁互斥并广播。
- 流局 / 修正 / 撤回 / 结束对局仍仅限房主。
- **前台服务 + 锁屏保活**：房主手机息屏/锁屏后服务器仍继续运行，无需保持亮屏。

---

## 一、运行方式（新用法）

1. 在 **Android Studio** 中打开本目录（`android/`），构建并安装 APK 到房主手机。
2. 房主打开 App → 自动启动服务器（监听 8765）并加载本机页面。
3. App 界面会显示房主手机的本机局域网 IP（如 `192.168.1.50`）。
4. 其他玩家用手机/电脑浏览器打开 `http://192.168.1.50:8765` → 无需房间码，直接进入。
5. 成员输入自己的名字，即可申请操作权参与结算/立直。

> 提示：请确保房主手机和其他玩家在同一 Wi-Fi 局域网；若无法连入，检查手机防火墙/路由器是否放行 8765 端口。

## 二、电脑版（prototype）保留

电脑版仍然可用，用法与手机端完全一致：

```bash
cd prototype
node serve.js     # 监听 8765，无房间码·操作权互斥
```

此时电脑就是"房主服务器"，其他玩家浏览器访问 `http://<电脑IP>:8765` 即可加入。
若你想用电脑当服务器而手机只当成员，就开电脑版；若想用房主手机当服务器，就用 Android App。

## 三、构建安装包

用 **Android Studio** 打开本目录（`android/`），等待 Gradle 同步完成后：

- **Build → Build Bundle(s) / APK(s) → Build APK(s)**
- 生成的 APK 在 `app/build/outputs/apk/debug/` 下
- 拷贝到手机安装即可（需允许"安装未知来源应用"）

## 四、关键实现

| 组件 | 作用 |
|------|------|
| `RiichiServer.java` | 纯 Java 内嵌 HTTP + WebSocket 服务器（零第三方依赖），监听 8765，单房间 · 操作权互斥 |
| `ServerService.java` | 前台服务 + `PARTIAL_WAKE_LOCK`，锁屏/息屏后 CPU 仍运行，服务器不中断 |
| `MainActivity.java` | 启动服务器服务 + WebView 加载 `http://127.0.0.1:8765/?host=1&lanip=本机IP`（房主身份），并注入本机 Wi-Fi IP 供前端显示"其他玩家访问地址" |
| `assets/` | 打包的网页资源（index.html + js/css），与 prototype 保持一致 |

### 权限（AndroidManifest.xml）
- `INTERNET` / `ACCESS_NETWORK_STATE`：联网
- `WAKE_LOCK`：锁屏保活
- `FOREGROUND_SERVICE`：Android 8.0+ 前台服务
- `POST_NOTIFICATIONS`：显示常驻"服务器运行中"通知
- `usesCleartextTraffic="true"`：允许 http:// 与 ws:// 明文流量

---

## 工程结构

```
android/
└── app/src/main/
    ├── AndroidManifest.xml          (权限 + 服务声明)
    ├── java/com/riichi/score/
    │   ├── RiichiServer.java        (内嵌 Java HTTP+WebSocket 服务器)
    │   ├── ServerService.java       (前台服务 + 锁屏保活)
    │   └── MainActivity.java        (壳 Activity，启动服务 + WebView)
    └── assets/                      (网页资源，来自 prototype)
```

## 说明

- 内嵌服务器为**单房间**模型：房主手机就是唯一服务器，房主 App 退出则对局解散。
- 前端规则引擎（`rules.js`）在所有端运行，操作者在本地执行规则后通过广播提交权威态。
- 若修改了 `prototype` 下的网页，需把 `index.html`、`js/`、`css/` 重新复制到 `assets/`。
