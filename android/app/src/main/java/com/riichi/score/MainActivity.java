package com.riichi.score;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.text.format.Formatter;
import android.view.View;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;

/**
 * 日麻计分 — Android 房主端（服务器 + WebView 壳）
 *
 * 架构（无房间码 · 单房间 · 全员协作）：
 *  1. 房主手机运行本 App，启动内嵌的 RiichiServer（纯 Java HTTP+WebSocket，监听 8765）。
 *  2. 本机 WebView 加载 http://127.0.0.1:8765/?host=1&lanip=xxx → 身份为房主(host)。
 *  3. 其他玩家浏览器访问 http://<房主IP>:8765/ → 身份为成员(member)，无需下载 App、无需房间码。
 *  4. 任意玩家可申请操作权执行"和牌结算 / 立直"，服务器仲裁互斥并广播。
 *  5. 主界面提供"加入他人对局"：输入房主手机显示的 IP，即在本 WebView 内跳转到
 *     http://<房主IP>:8765/ ，以成员身份加入（页面与 WebSocket 均由对方服务器提供）；
 *     按手机返回键即可回到本机房主界面。
 *  6. 主界面同时提供"扫码"：用摄像头扫描房主手机上的二维码（内容即上述访问地址），
 *     解码后走与手动输入完全相同的加入流程。取流由 WebView 内的 getUserMedia 完成，
 *     因此需要 CAMERA 运行时权限 + onPermissionRequest 放行 RESOURCE_VIDEO_CAPTURE。
 *  5. 前台服务 + PARTIAL_WAKE_LOCK：房主手机锁屏/息屏后服务器仍继续运行（不要求保持亮屏）。
 *
 * 使用方法：
 *  1. 在 Android Studio 中构建并安装本 APK。
 *  2. 打开 App → 自动启动服务器并加载本机页面。
 *  3. 界面上会显示房主手机的本机局域网 IP（供其他玩家输入）。
 *  4. 其他玩家用手机/电脑浏览器输入  http://<该IP>:8765  即可进入对局。
 */
public class MainActivity extends Activity {

    /** 服务器端口（与 RiichiServer 一致） */
    private static final int SERVER_PORT = 8765;

    /** 摄像头运行时权限请求码 */
    private static final int REQ_CAMERA = 1002;

    /** 场风盘蓝牙运行时权限请求码 */
    private static final int REQ_BT = 1003;

    private WebView webView;
    private ProgressBar progressBar;
    private boolean pageLoaded = false;

    /** 场风盘：授权结果回来后要执行的连接动作（null=无）："scan" | "connect" */
    private String pendingBtAction = null;

    /** WebView 发起的摄像头授权请求：等系统权限对话框有结果后再授予/拒绝 */
    private android.webkit.PermissionRequest pendingWebPermission;

    /** 服务器端口是否已就绪（由 waitForServerThenLoad 的端口探测置位） */
    private volatile boolean serverReady = false;

    /** 兜底：若前台服务未将服务器起来，由 Activity 进程内直接启动的实例 */
    private RiichiServer fallbackServer;

    /**
     * 房主 WebView 加载本机服务器页面。
     *  - ?host=1 标记识别房主身份
     *  - &lanip=<本机Wi-FiIP> 供前端显示"其他玩家访问地址"（避免显示成 127.0.0.1）
     */
    private String getServerUrl() {
        return "http://127.0.0.1:" + SERVER_PORT + "/?host=1&lanip=" + getLocalIpv4();
    }

    /**
     * 获取本机局域网 IPv4 地址（供其他玩家访问；失败回退 127.0.0.1）。
     *
     * 优先取 Wi-Fi（wlan/eth）接口或私有网段（192.168/10/172.16）的地址，避免在
     * "Wi-Fi 与蜂窝双开 / 默认走移动网络" 时误取到蜂窝 IP，也避免 WifiManager API
     * 在新系统失效返回 0 而回退到 127.0.0.1。
     */
    private String getLocalIpv4() {
        // 1) 遍历网络接口：先找 Wi-Fi/以太网接口的 IPv4
        String wifiIp = null;
        String privateIp = null;
        try {
            java.util.Enumeration<java.net.NetworkInterface> nis =
                    java.net.NetworkInterface.getNetworkInterfaces();
            while (nis.hasMoreElements()) {
                java.net.NetworkInterface ni = nis.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                String niName = ni.getName() == null ? "" : ni.getName().toLowerCase();
                java.util.Enumeration<java.net.InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    java.net.InetAddress ia = addrs.nextElement();
                    if (!(ia instanceof java.net.Inet4Address)) continue;
                    String ip = ia.getHostAddress();
                    if (ip == null) continue;
                    // Wi-Fi / 以太网 接口优先（wlan/eth/en），双开时不会误取到蜂窝 rmnet
                    if (niName.startsWith("wlan") || niName.startsWith("eth")
                            || niName.startsWith("en") || niName.startsWith("ap"))
                        wifiIp = ip;
                    // 兜底：任意私有网段地址
                    if (privateIp == null && (ip.startsWith("192.168.") || ip.startsWith("10.")
                            || ip.startsWith("172."))) privateIp = ip;
                }
            }
        } catch (Exception ignored) {}
        if (wifiIp != null) return wifiIp;
        if (privateIp != null) return privateIp;

        // 2) 兼容旧系统：退化为 WifiManager（尽力而为）
        try {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
            if (wm != null) {
                WifiInfo info = wm.getConnectionInfo();
                int ip = info.getIpAddress();
                if (ip != 0) {
                    return Formatter.formatIpAddress(ip);
                }
            }
        } catch (Exception ignored) {}

        return "127.0.0.1";
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webView);
        progressBar = findViewById(R.id.progressBar);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);                 // 网页原型需要 JS
        s.setDomStorageEnabled(true);                 // localStorage（历史/对局持久化）
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        // 扫码预览：<video> 播放 MediaStream 不应依赖用户手势，否则部分机型上会黑屏
        s.setMediaPlaybackRequiresUserGesture(false);

        // 场风盘蓝牙控制：JS ↔ 原生桥（页面通过 window.NativeBridge 调用）
        EinkBoardManager.getInstance().init(getApplicationContext(), einkListener);
        webView.addJavascriptInterface(new NativeBridge(), "NativeBridge");

        // WebView 需要支持 WebSocket（net.js 用它做联网同步）—— 系统 WebView 默认支持
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progressBar.setProgress(newProgress);
                progressBar.setVisibility(newProgress < 100 ? View.VISIBLE : View.GONE);
            }

            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage cm) {
                android.util.Log.d("WebViewJS", cm.message() + " [" + cm.lineNumber() + "]");
                return true;
            }

            /** 页面内 getUserMedia（扫码取流）会走到这里，交由本方法决定是否放行 */
            @Override
            public void onPermissionRequest(android.webkit.PermissionRequest request) {
                handleWebPermissionRequest(request);
            }
        });
        // 允许远程调试（用 chrome://inspect 可查看 WebView 内部）
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        // Android 13+ 请求通知权限（前台服务常驻通知用；被拒不影响核心功能）
        requestNotificationPermission();

        // 场风盘蓝牙权限（Android 12+ 运行时；被拒只影响推送，进控制页时会再请求）
        requestBlePermission();

        // 启动前台服务（内含 RiichiServer + 锁屏保活），并等待端口就绪后加载页面
        startServerService();
    }

    /** Android 13 (API 33)+ 请求 POST_NOTIFICATIONS 运行时权限 */
    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(
                    new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1001);
        }
    }

    /** 场风盘蓝牙：Android 12 (API 31)+ 需要 BLUETOOTH_CONNECT/SCAN 运行时权限 */
    private void requestBlePermission() {
        if (Build.VERSION.SDK_INT < 31) {
            EinkBoardManager.getInstance().setPermissionOk();
            return;
        }
        boolean connectOk = checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT)
                == PackageManager.PERMISSION_GRANTED;
        boolean scanOk = checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN)
                == PackageManager.PERMISSION_GRANTED;
        if (connectOk && scanOk) {
            EinkBoardManager.getInstance().setPermissionOk();
        } else {
            requestPermissions(new String[]{
                    Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN}, REQ_BT);
        }
    }

    /** 场风盘事件 → 转发到页面（window.EinkNative.onStatus） */
    private final EinkBoardManager.Listener einkListener = new EinkBoardManager.Listener() {
        @Override public void onEvent(String type, String data) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (webView == null) return;
                    String js = "window.EinkNative && EinkNative.onStatus("
                            + jq(type) + "," + jq(data == null ? "" : data) + ")";
                    webView.evaluateJavascript(js, null);
                }
            });
        }
        private String jq(String s) {
            return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"")
                    .replace("\n", "\\n").replace("\r", "\\r") + "\"";
        }
    };

    /** JS → 原生：场风盘蓝牙控制接口（方法运行在 WebView 桥线程，内部自行切线程） */
    private class NativeBridge {

        /** 连接：无权限先请求（结果回来后自动扫描）；有权限直接扫描出设备列表 */
        @android.webkit.JavascriptInterface
        public void einkConnect() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (Build.VERSION.SDK_INT >= 31
                            && (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED
                            || checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED)) {
                        pendingBtAction = "scan";
                        requestPermissions(new String[]{
                                Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN}, REQ_BT);
                        return;
                    }
                    EinkBoardManager.getInstance().setPermissionOk();
                    EinkBoardManager.getInstance().startScan();
                }
            });
        }

        /** 连接扫描列表中选中的设备（记住该设备，之后自动连） */
        @android.webkit.JavascriptInterface
        public void einkConnectAddr(String address) {
            EinkBoardManager.getInstance().connect(address);
        }

        @android.webkit.JavascriptInterface
        public void einkDisconnect() {
            EinkBoardManager.getInstance().disconnect();
        }

        /** 连接已记住的设备（进入控制页时调用） */
        @android.webkit.JavascriptInterface
        public void einkAutoConnect() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (Build.VERSION.SDK_INT >= 31
                            && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
                        pendingBtAction = "auto";
                        requestPermissions(new String[]{
                                Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN}, REQ_BT);
                        return;
                    }
                    EinkBoardManager.getInstance().setPermissionOk();
                }
            });
        }

        /** 蓝牙常开开关（epd-noclock 0x25） */
        @android.webkit.JavascriptInterface
        public void einkSetAlwaysOn(boolean on) {
            EinkBoardManager.getInstance().setBleAlwaysOn(on);
        }

        /** 黑白快刷开关（默认开；关闭=三色全刷） */
        @android.webkit.JavascriptInterface
        public void einkSetFastMode(boolean on) {
            EinkBoardManager.getInstance().setFastMode(on);
        }

        @android.webkit.JavascriptInterface
        public boolean einkIsFastMode() {
            return EinkBoardManager.getInstance().isFastMode();
        }

        /** 是否已记住设备 */
        @android.webkit.JavascriptInterface
        public boolean einkHasSaved() {
            return EinkBoardManager.getInstance().hasSavedDevice();
        }

        /** 单机兜底推送（WS 不可用时用；联网模式走 push-tag 消息） */
        @android.webkit.JavascriptInterface
        public void pushTag(String dataJson, boolean immediate) {
            EinkBoardManager.getInstance().requestPush(dataJson, immediate);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        // 场风盘蓝牙权限：授予后执行挂起的动作（扫描 / 自动连记住设备）
        if (requestCode == REQ_BT) {
            boolean granted = true;
            for (int r : grantResults) if (r != PackageManager.PERMISSION_GRANTED) granted = false;
            if (granted) {
                EinkBoardManager.getInstance().setPermissionOk();
                if ("scan".equals(pendingBtAction)) EinkBoardManager.getInstance().startScan();
            } else {
                einkListener.onEvent("log", "蓝牙权限被拒绝，无法连接场风盘");
            }
            pendingBtAction = null;
            return;
        }
        // 通知权限被拒也可用；无需特殊处理
        if (requestCode != REQ_CAMERA) return;
        boolean granted = grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        android.webkit.PermissionRequest req = pendingWebPermission;
        pendingWebPermission = null;
        if (req != null) {
            if (granted) {
                req.grant(new String[]{android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            } else {
                req.deny();   // 页面侧 getUserMedia 会 reject，前端自行提示
            }
        }
        // 被勾选"不再询问"后系统不会再弹框，此时指引用户去设置里开（页面里的提示不够显眼）
        if (!granted && !shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)) {
            new AlertDialog.Builder(this)
                    .setTitle("需要相机权限")
                    .setMessage("扫描二维码加入对局需要相机权限。\n\n"
                            + "可在「设置 → 应用 → 日麻计分 → 权限」中开启相机后重试；"
                            + "也可以直接在首页手动输入房主 IP 加入。")
                    .setPositiveButton("知道了", null)
                    .show();
        }
    }

    /**
     * 处理页面发起的权限请求：只放行摄像头（扫码需要），麦克风/定位等一律拒绝。
     * 系统 CAMERA 权限尚未授予时先弹出系统授权框，结果回到 onRequestPermissionsResult 再补授权。
     */
    private void handleWebPermissionRequest(final android.webkit.PermissionRequest request) {
        boolean wantsCamera = false;
        for (String r : request.getResources()) {
            if (android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) wantsCamera = true;
        }
        if (!wantsCamera) { request.deny(); return; }
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[]{android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            return;
        }
        pendingWebPermission = request;
        requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
    }

    /** 启动前台服务：内嵌服务器 + 锁屏保活（PARTIAL_WAKE_LOCK） */
    private void startServerService() {
        try {
            Intent intent = new Intent(this, ServerService.class);
            intent.setAction(ServerService.ACTION_START);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent);
            } else {
                startService(intent);
            }
        } catch (Exception e) {
            // 前台服务启动失败（如部分机型通知权限/厂商限制）也不至于闪退，
            // 服务器将退化为仅 WebView 端可用；房主页面仍能加载。
            android.util.Log.e("RiichiScore", "前台服务启动失败", e);
        }
        // 服务器在 Service 中异步监听端口，此处轮询等待其就绪后再加载页面，
        // 避免 WebView 抢跑导致 ERR_CONNECTION_REFUSED。
        waitForServerThenLoad();
    }

    /** 轮询等待 8765 端口就绪（最长约 10s），就绪后加载房主页面 */
    private void waitForServerThenLoad() {
        new Thread(() -> {
            long deadline = System.currentTimeMillis() + 10_000;
            while (System.currentTimeMillis() < deadline) {
                if (isPortOpen("127.0.0.1", SERVER_PORT)) {
                    serverReady = true;
                    break;
                }
                try { Thread.sleep(200); } catch (InterruptedException ignored) {}
            }
            if (!serverReady) {
                // 前台服务可能因厂商 ROM 限制未能启动，退化为在 Activity 进程内直接启动服务器
                startFallbackServer();
                // 给兜底服务器几秒时间监听端口
                long fallbackDeadline = System.currentTimeMillis() + 5_000;
                while (System.currentTimeMillis() < fallbackDeadline) {
                    if (isPortOpen("127.0.0.1", SERVER_PORT)) {
                        serverReady = true;
                        break;
                    }
                    try { Thread.sleep(200); } catch (InterruptedException ignored) {}
                }
            }
            boolean ready = serverReady;
            runOnUiThread(() -> {
                if (ready) {
                    loadPage();
                } else {
                    // 服务器确实无法启动：给出提示，可重试
                    progressBar.setVisibility(View.GONE);
                    new AlertDialog.Builder(MainActivity.this)
                            .setTitle("无法启动服务器")
                            .setMessage(
                                    "内嵌服务器未能启动。\n\n" +
                                    "可能原因：\n" +
                                    "1. 端口 8765 被其他程序占用\n" +
                                    "2. 系统权限限制\n\n" +
                                    "可点击「重试」再次尝试。")
                            .setPositiveButton("重试", (d, w) -> {
                                pageLoaded = false;
                                startServerService();
                            })
                            .setNegativeButton("关闭", null)
                            .show();
                }
            });
        }, "riichi-wait-server").start();
    }

    /** 兜底：在 Activity 进程内直接启动 RiichiServer（前台服务启动失败的备选） */
    private void startFallbackServer() {
        if (fallbackServer != null && fallbackServer.isRunning()) return;
        try {
            fallbackServer = new RiichiServer(getAssets(), new RiichiServer.Listener() {
                @Override public void onStarted(String ip, int port) {}
                @Override public void onError(String message) {
                    android.util.Log.e("RiichiScore", "兜底服务器错误: " + message);
                }
                @Override public void onMemberCount(int count) {}
            });
            fallbackServer.start();
        } catch (Exception e) {
            android.util.Log.e("RiichiScore", "兜底服务器启动失败", e);
        }
    }

    /** 尝试建立 TCP 连接探测端口是否可连 */
    private boolean isPortOpen(String host, int port) {
        try (java.net.Socket s = new java.net.Socket()) {
            s.connect(new java.net.InetSocketAddress(host, port), 300);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private void loadPage() {
        if (pageLoaded) return;
        pageLoaded = true;
        progressBar.setVisibility(View.VISIBLE);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setVisibility(View.GONE);
            }

            @Override
            public void onReceivedError(WebView view, int errorCode,
                                        String description, String failingUrl) {
                progressBar.setVisibility(View.GONE);
                // 区分两种情况：
                //  1) 通过首页"加入他人对局"跳到房主页面失败 → 房主不可达（IP 错/不同网络/房主退出）
                //  2) 本机页面加载失败 → 内嵌服务器没起来（端口占用/权限限制）
                if (isRemoteUrl(failingUrl)) {
                    new AlertDialog.Builder(MainActivity.this)
                            .setTitle("无法加入该对局")
                            .setMessage(
                                    "无法连接到房主：" + failingUrl + "\n\n" +
                                    "请确认：\n" +
                                    "1. IP 地址与房主手机上显示的完全一致\n" +
                                    "2. 两台设备连在同一个 Wi-Fi / 局域网\n" +
                                    "3. 房主端 App 正在运行且对局未结束\n\n" +
                                    "错误：" + description)
                            .setPositiveButton("重试", (d, w) -> view.loadUrl(failingUrl))
                            .setNegativeButton("返回本机", (d, w) -> {
                                pageLoaded = false;
                                loadPage();
                            })
                            .setOnCancelListener(d -> {
                                pageLoaded = false;
                                loadPage();
                            })
                            .show();
                    return;
                }
                // 本机服务器没起来时给出明确提示
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle("无法加载页面")
                        .setMessage(
                                "无法连接到本机服务器。\n\n" +
                                "可能原因：\n" +
                                "1. 端口 8765 被其他程序占用\n" +
                                "2. 系统权限限制\n\n" +
                                "错误：" + description)
                        .setPositiveButton("重试", (d, w) -> {
                            pageLoaded = false;
                            loadPage();
                        })
                        .setNegativeButton("关闭", null)
                        .show();
            }
        });
        webView.loadUrl(getServerUrl());
    }

    /** 失败地址是否指向"他人的房主页面"（而非本机服务器） */
    private boolean isRemoteUrl(String url) {
        if (url == null) return false;
        String u = url.toLowerCase();
        return !(u.contains("127.0.0.1") || u.contains("localhost"));
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) webView.onPause();
    }

    @Override
    protected void onDestroy() {
        if (fallbackServer != null) {
            fallbackServer.stop();
            fallbackServer = null;
        }
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}
