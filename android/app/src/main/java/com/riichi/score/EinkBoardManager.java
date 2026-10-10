package com.riichi.score;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.location.LocationManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.ParcelUuid;

import java.util.List;
import java.util.UUID;

/**
 * EinkBoardManager — 墨水屏场风盘原生 BLE 客户端（路线 A：APP 内直连推送）
 *
 * 推图方式对齐参考上位机 https://breeze4dev.github.io/epd-noclock/（epd-noclock，
 * 支持无时钟固件的分支），与 prototype/js/tagpush.js 逐行同源：
 *  - Service  62750001-d828-918d-fb46-b6c11c675aec
 *  - EPD 特征 62750002-...（write + notify）
 *  - 版本特征 62750003-...（uint8，须 >= 0x16 才支持 WRITE_IMG=0x30）
 *  - 连接后第 1 条 notify = 设备自报配置；之后文本 "mtu=N"（可带 rle=1）；
 *    "ble=0/1" = 蓝牙常开状态回报（epd-noclock 扩展）
 *  - BLE_ALWAYS(0x25)+1字节 = 蓝牙常开设置（存设备 flash，断电有效）
 *  - 推图：裸 INIT(0x01，不带驱动字节：按设备 flash 已存 model_id 初始化)
 *          → 等设备上报 mtu → WRITE_IMG(0x30) 黑白面 → 红面 → REFRESH(0x05)
 *    ⚠️ INIT 一律裸发：固件 EPD_service.c 的 EPD_CMD_INIT 只要参数长度>1 就用它做
 *       epd_init，与 flash 中 model_id 不同即 epd_config_write() 永久落盘 ——
 *       参考站推图也是裸 INIT（s6.js:1248），带驱动字节只出现在它的「设置引脚/驱动」按钮。
 *    自检：CLEAR(0x02) = 固件内部「复位+上电+双平面填白+全屏刷新」，不经我们的位图/标志位。
 *    标志位两套编码（按设备是否支持 RLE 选，与参考站一致）：
 *      支持 RLE：bit0=0 黑/1 红，bit1=1 首块，bit2=1 本块 RLE
 *      不支持 RLE（v1.6 口径）：黑白首块 0x0F/后续 0xFF，红面首块 0x00/后续 0xF0
 *    回执：每 50 块要一次带响应写入，最后一块必带
 *  - 画面参数（用户指定，与价签同步助手 / 参考站一致）：面板 4.2寸三色 UC8176 400×300、
 *    引脚 1413060504030207（设备已存，推图流程不写）、抖动 Floyd-Steinberg、抖动强度 1.0
 *    （上位机档位 10）、对比度 1.2、MTU 244、确认间隔 50
 *  - 位图 1bpp：byteWidth=ceil(w/8)、MSB 在前、1=白 0=黑（红面 0=红）；块数据 = mtu-2 字节
 *
 * ⚠️ 已删除黑白快刷（改 PSR/CDI/LUT 寄存器走快刷波形）：实测会把屏刷成白屏、
 *    并让固件卡在刷屏流程里失联，只能拆机断电。推图一律走上面的标准三色流程。
 *
 * 线程模型：所有 GATT 操作在专用 HandlerThread 上执行；渲染在工作线程；
 * 节流用主 Handler。对 JS 的状态回调统一走 Listener.onEvent(type, data)。
 */
public class EinkBoardManager {

    public interface Listener {
        /** type: scanning / scan / scan-done / connecting / connected / disconnected /
         *        connect-fail / connect-giveup / log / ble / push-status */
        void onEvent(String type, String data);
    }

    public static final UUID SERVICE_UUID = UUID.fromString("62750001-d828-918d-fb46-b6c11c675aec");
    public static final UUID EPD_UUID     = UUID.fromString("62750002-d828-918d-fb46-b6c11c675aec");
    public static final UUID VER_UUID     = UUID.fromString("62750003-d828-918d-fb46-b6c11c675aec");
    private static final UUID CCCD       = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    private static final int CMD_INIT = 0x01, CMD_CLEAR = 0x02, CMD_WRITE_IMG = 0x30,
            CMD_REFRESH = 0x05, CMD_BLE_ALWAYS = 0x25, CMD_SET_PINS = 0x00;

    /**
     * 本场风盘（4.2″ 三色 UC8176 400×300）在设备 flash 里的引脚串，格式与参考站一致：
     * bytes[0..6]（mosi/sclk/cs/dc/rst/busy/bs）+ bytes[10]（en_pin）。
     * 只用于**比对与修复**，正常推图流程绝不写它。
     */
    private static final String EXPECTED_PINS = "1413060504030207";
    /** 修复引脚时回写的 8 字节引脚串（= EXPECTED_PINS 的字节形式） */
    private static final byte[] PIN_PAYLOAD = {
            0x14, 0x13, 0x06, 0x05, 0x04, 0x03, 0x02, 0x07
    };
    /** 修复引脚时附带的 keypin（参考站取自设备自报的 struct byte8） */
    private static final byte DEFAULT_KEYPIN = 0x00;
    private static final long THROTTLE_MS = 1_000;    // 自动推送节流窗口（结算/立直后仅合并 1s 内的连发，尽快开刷）
    private static final long SCAN_PERIOD_MS = 30_000; // 扫描时长。设备广播间隔约 1s，但系统服务会周期性占用它
                                                       // （占用期间不广播），窗口越长越可能撞上空闲期；可手动提前停止
    private static final int MAX_RECONNECT = 5;
    private static final int MTU_DEFAULT = 244;       // 设备回报 mtu=244；拿不到回报时用同值
    private static final int ACK_INTERVAL = 50;       // 确认间隔：每 N 块要一次回执（末块必带）
    private static final long MTU_WAIT_MS = 5_000;    // 等设备上报 MTU 的上限
    /** 驱动/模型 ID：4.2寸 三色 UC8176（用户指定面板，EPD_driver.h） */
    private static final int DRIVER_UC8176_420_BWR = 0x03;

    /** ATT 载荷上限：已收到设备回报就用回报值，否则用 244（与 requestMtu(247) 对应） */
    private int attPayloadMtu() { return mtuReported > 0 ? mtuReported : MTU_DEFAULT; }

    /** 等设备上报 "mtu=N" 再分包；拿不到回报就按 244 兜底（调用方须在工作线程） */
    private void waitMtuReported() {
        long t0 = System.currentTimeMillis();
        while (mtuReported <= 0 && System.currentTimeMillis() - t0 < MTU_WAIT_MS) {
            try { Thread.sleep(50); } catch (InterruptedException e) { break; }
        }
        if (mtuReported <= 0) mtuReported = MTU_DEFAULT;
    }

    private static volatile EinkBoardManager sInstance;

    public static EinkBoardManager getInstance() {
        if (sInstance == null) synchronized (EinkBoardManager.class) {
            if (sInstance == null) sInstance = new EinkBoardManager();
        }
        return sInstance;
    }

    private final Handler main = new Handler();
    private HandlerThread workThread;
    private Handler work;
    private Context appContext;
    private Listener listener;
    private volatile boolean permissionOk = false; // MainActivity 授权后置位

    private BluetoothAdapter adapter;
    private volatile BluetoothGatt gatt;
    private BluetoothGattCharacteristic epdChar;
    private volatile String connectedName = null;
    /** CCCD 是否真的写成功（设备自报配置 / mtu / ble= 都靠它） */
    private volatile boolean notifyOn = false;

    // 协议状态（与 tagpush.js st 对应）
    private int msgIndex = 0;
    private int mtuReported = 0;   // 设备上报的 ATT 载荷上限（唯一可信来源，0 = 未上报）
    private boolean rleSupport = false;
    private int appVersion = 0x16;
    /** 设备自报的引脚串 / 驱动字节（连上后由第一条 notify 填充） */
    private volatile String devPins = "", devDriver = "";
    /** 上一次推图实际发出的块数（留痕：不用看屏也能判断"到底推了没有"） */
    private int lastBwBlocks = 0, lastRedBlocks = 0;

    // 节流
    private String pendingData = null;
    private boolean throttleScheduled = false;
    private final Runnable throttleRunnable = new Runnable() {
        @Override public void run() {
            throttleScheduled = false;
            final String d = pendingData;
            pendingData = null;
            // 渲染 + 等 MTU 都是阻塞操作，放到工作线程，勿占主线程
            if (d != null) work.post(new Runnable() { @Override public void run() { doPush(d); } });
        }
    };

    // 推送任务（onCharacteristicWrite 回调驱动下一块）
    private static class PushJob {
        byte[][] chunks;          // 全部块（INIT/图像，各含自身命令字节）
        boolean[] resp;           // 每块是否要回执（true=WRITE_TYPE_DEFAULT 等回调）
        volatile int index = 0;
        volatile int pendingIdx = -1;   // 当前在途块的序号（-1 = 无）
        volatile boolean pendingResp = false; // 在途块是否要回执
        volatile boolean cancelled = false;
    }
    private PushJob job;

    private boolean manualDisconnect = false;
    private int reconnectTries = 0;
    /** 连接是否已真正建立（把"连接中"和"已连通"区分开的唯一判据） */
    private volatile boolean linked = false;
    /**
     * 已经处理过/被替换掉的 GATT 客户端。
     * Android 对**同一次**连接失败会回调两次 DISCONNECTED（实测 status=147 紧接 status=8），
     * 不加这道闸，一次失败会被记成两次重试，重试上限也就提前耗尽。
     */
    private volatile BluetoothGatt retiredGatt = null;
    /** 自动重连的延时任务句柄（disconnect 时要能取消，否则断开后还会再连一次） */
    private Runnable reconnectRunnable = null;
    private String savedAddress() {
        SharedPreferences sp = appContext.getSharedPreferences("eink", Context.MODE_PRIVATE);
        return sp.getString("device", null);
    }

    private EinkBoardManager() {
        workThread = new HandlerThread("eink-ble");
        workThread.start();
        work = new Handler(workThread.getLooper());
    }

    public void init(Context context, Listener l) {
        appContext = context.getApplicationContext();
        listener = l;
        BluetoothManager bm = (BluetoothManager) appContext.getSystemService(Context.BLUETOOTH_SERVICE);
        adapter = bm == null ? null : bm.getAdapter();
    }

    /** MainActivity 在运行时权限授予后调用；随后自动尝试连记住的设备 */
    public void setPermissionOk() { setPermissionOk(true); }

    /**
     * @param allowAutoConnect true 时顺带尝试连「记住的设备」。
     *        ⚠️ **扫描路径必须传 false**：Android 发起直连期间控制器会暂停 LE 扫描，
     *        一按「扫描」就同时发起直连，扫描结果的完整性与可信度都被破坏
     *        （真机实测：扫描只收到 15 个广播且每次都独缺目标设备）。
     */
    public void setPermissionOk(boolean allowAutoConnect) {
        permissionOk = true;
        emit("log", "蓝牙权限已授予");
        if (allowAutoConnect) autoConnectSaved();
    }
    public boolean hasPermission() { return permissionOk; }

    private void emit(String type, String data) {
        if (listener != null) listener.onEvent(type, data);
    }
    private void log(String msg) { emit("log", msg); }

    // ============ 扫描 ============

    /** 本次扫描已上报过的地址（同一设备每次广播都会回调，必须去重） */
    private final java.util.Set<String> scanSeen = new java.util.HashSet<>();
    /** 地址 → 已上报的名字（用于判断后续回调是否带来了更完整的名字，见 onScanResult 注释） */
    private final java.util.Map<String, String> scanName = new java.util.HashMap<>();
    /** 已计入"命中"的地址（同一设备会多次回调，避免重复计数） */
    private final java.util.Set<String> scanHitAddrs = new java.util.HashSet<>();
    private volatile boolean scanning = false;

    /**
     * 扫描 BLE 设备。
     *
     * ⚠️ 这里**故意不使用 ScanFilter 按 Service UUID 过滤**（曾经就是这么写的，结果"扫描完成，
     * 未发现场风盘设备"）。原因：本固件把服务 UUID 放在 **scan response** 里 ——
     * `main.c advertising_init()` 中 advdata 只有 Flags + 完整名字，而
     * `init.srdata.uuids_complete` / `scanrsp.uuids_complete` 才是 PUT 服务 UUID 的地方。
     * 部分 ROM 的 `ScanFilter.setServiceUuid` 只匹配 advertising data、不合并 scan response，
     * 于是过滤器把所有广播都滤掉，表现就是"一个设备都发现不了"，而同一台设备用微信小程序
     * （通常不带包过滤）却能正常连上。
     *
     * 现在的做法：扫全部设备 → 在回调里做"软命中"标注（广播里带本服务 UUID，或名字像 EPD 设备），
     * 命中项在页面上排前并高亮，但**所有设备都会列出来**，用户可以手动挑。
     */
    @SuppressLint("MissingPermission")
    public void startScan() {
        if (!permissionOk) {
            emit("log", "蓝牙权限未授予（请在系统设置里允许「附近的设备」权限后重试）");
            emit("scan-done", "");
            return;
        }
        if (adapter == null) {
            emit("log", "本机没有蓝牙适配器");
            emit("scan-done", "");
            return;
        }
        if (!adapter.isEnabled()) {
            emit("log", "系统蓝牙未开启，请先在系统设置里打开蓝牙");
            emit("scan-done", "");
            return;
        }
        android.bluetooth.le.BluetoothLeScanner scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) {
            // 权限不足 / 蓝牙正在关闭 / 系统扫描服务不可用时会返回 null（旧代码直接裸调用，只会 NPE 成一句无信息量的报错）
            emit("log", "无法获取 BLE 扫描器（请确认「附近的设备」权限已开启，或重启蓝牙后重试）");
            emit("scan-done", "");
            return;
        }
        emit("scanning", "");
        // ⚠️ 扫描前必须先把「连接中」的那一路收掉：Android 一边建连一边扫描时，
        //    控制器会把 LE 扫描暂停（真机日志 `stop_scan: Scanning already stopped`），
        //    扫描结果就会残缺 —— 实测正是"每次都独缺目标设备"。
        //    已真正连上的（linked）不动，那种情况下设备本来也不广播。
        if (!linked) {
            if (reconnectRunnable != null) { main.removeCallbacks(reconnectRunnable); reconnectRunnable = null; }
            stopPendingGatt();
        }
        scanSeen.clear();
        scanName.clear();
        scanHitAddrs.clear();
        scanning = true;
        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
                .build();
        try {
            scanner.startScan(null, settings, scanCb);   // null = 不过滤，扫全部
        } catch (Exception e) {
            scanning = false;
            log("扫描启动失败: " + e.getClass().getSimpleName()
                    + (e.getMessage() == null ? "" : " " + e.getMessage()));
            emit("scan-done", "");
            return;
        }
        main.postDelayed(new Runnable() {
            @Override public void run() { stopScan(); }
        }, SCAN_PERIOD_MS);
    }

    /** 停止扫描并结束本次扫描（scan-done 带发现设备数，页面据此区分"没扫到设备"和"扫到的都不是场风盘"） */
    @SuppressLint("MissingPermission")
    public void stopScan() {
        if (!scanning) return;
        scanning = false;
        try {
            android.bluetooth.le.BluetoothLeScanner sc =
                    adapter == null ? null : adapter.getBluetoothLeScanner();
            if (sc != null) sc.stopScan(scanCb);
        } catch (Exception ignored) {}
        // 零结果时直接自动跑一次完整诊断（省一轮来回）：国产 ROM 关闭「定位服务」时
        // BLE 扫描会启动成功但一个回调都不返回，表现与"设备没广播"完全一样
        if (scanSeen.isEmpty()) {
            log("本次扫描零结果，自动输出蓝牙状态：");
            diagnose();
        } else {
            // 地址清单是判断"系统到底有没有把这个设备交给 App"的唯一依据：
            // 小程序能扫到而 App 扫不到时，要么清单里根本没有它（系统层过滤/权限不足），
            // 要么它在、却标着（无名设备）（scan response 里的名字没被合并进来）。
            log("本次收到 " + scanSeen.size() + " 个广播，地址尾号：" + addrList());
            if (scanHitAddrs.isEmpty()) {
                log("以上没有场风盘。若清单里出现 24:6B 却仍显示（无名设备）→ 名字字段没解析出来；"
                        + "若清单里根本没有它 → 系统层没把该设备的广播交给本 App。");
                log("两种情况都可用下方「直接连接地址」输入设备 MAC 绕过扫描（MAC 可在微信小程序里看到）。");
            }
        }
        emit("scan-done", String.valueOf(scanSeen.size()));
    }

    /** 已收到广播的地址尾号清单（只留后 5 位，避免日志里出现完整 MAC） */
    private String addrList() {
        StringBuilder sb = new StringBuilder();
        int i = 0;
        for (String a : scanSeen) {
            if (i > 0) sb.append(", ");
            sb.append(a.length() >= 5 ? a.substring(a.length() - 5) : a);
            if (++i >= 24) { sb.append(" …"); break; }
        }
        return sb.toString();
    }

    // ============ 蓝牙诊断 ============

    /** 一键输出影响 BLE 扫描的全部前提条件（页面「蓝牙诊断」按钮） */
    public void diagnose() {
        log("=== 蓝牙诊断 ===");
        log("系统: Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ") / "
                + Build.MANUFACTURER + " " + Build.MODEL);
        log("权限: 附近设备(SCAN)=" + permText(android.Manifest.permission.BLUETOOTH_SCAN)
                + ", 蓝牙连接(CONNECT)=" + permText(android.Manifest.permission.BLUETOOTH_CONNECT)
                + ", 定位=" + permText(android.Manifest.permission.ACCESS_FINE_LOCATION));
        log("蓝牙: 适配器=" + (adapter == null ? "无" : "有")
                + ", 开关=" + (adapter != null && adapter.isEnabled() ? "开" : "关")
                + ", 权限已就绪=" + permissionOk);
        if (adapter != null) {
            String n = null;
            try { n = adapter.getName(); } catch (Exception ignored) {}
            log("本机蓝牙名: " + (n == null ? "（读不到）" : n));
        }
        log("BLE 扫描器: " + (scannerAvailable() ? "可用" : "不可用（getBluetoothLeScanner() 返回 null）"));
        String loc = locationServiceText();
        log("定位服务: " + loc + ("已关闭".equals(loc)
                ? "  ← 国产 ROM 关闭定位时 BLE 扫描启动成功但零回调，请打开定位后重扫" : ""));
        log("已配对设备: " + bondedSummary());
        log("上次扫描: 收到广播 " + scanSeen.size() + " 个，其中场风盘 " + scanHitAddrs.size() + " 个");
        log("================");
    }

    private String permText(String p) {
        if (appContext == null) return "未知";
        try {
            return appContext.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED
                    ? "已授予" : "未授予";
        } catch (Exception e) { return "未知"; }
    }

    private boolean scannerAvailable() {
        try { return adapter != null && adapter.getBluetoothLeScanner() != null; }
        catch (Exception e) { return false; }
    }

    /** 系统定位服务开关。国产 ROM（MIUI/HyperOS 等）关闭定位时 BLE 扫描不返回任何结果 */
    private String locationServiceText() {
        try {
            LocationManager lm = (LocationManager) appContext.getSystemService(Context.LOCATION_SERVICE);
            if (lm == null) return "未知";
            if (Build.VERSION.SDK_INT >= 28) return lm.isLocationEnabled() ? "已开启" : "已关闭";
            return (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)
                    || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) ? "已开启" : "已关闭";
        } catch (Exception e) { return "未知"; }
    }

    /**
     * 已配对设备明细。
     *
     * 这是**绕过扫描的一条备用路径**：BLE 设备通常无需配对，但万一场风盘曾被系统配对过，
     * 地址就留在系统里，可以直接 connect(address) 而不依赖广播 —— 在"设备不广播"
     * （被小程序占用连接 / 广播超时 / 蓝牙键没按）时，这是唯一能不走扫描的突破口。
     */
    @SuppressLint("MissingPermission")
    private String bondedSummary() {
        try {
            java.util.Set<BluetoothDevice> s = adapter == null ? null : adapter.getBondedDevices();
            if (s == null) return "读不到（无权限或蓝牙不可用）";
            if (s.isEmpty()) return "0 个（BLE 设备通常不需要配对，0 个属正常）";
            StringBuilder sb = new StringBuilder(s.size() + " 个 → ");
            int i = 0;
            for (BluetoothDevice d : s) {
                if (i > 0) sb.append(" | ");
                String n = null, addr = null;
                try { n = d.getName(); } catch (Exception ignored) {}
                try { addr = d.getAddress(); } catch (Exception ignored) {}
                sb.append(n == null || n.isEmpty() ? "（无名）" : n);
                if (addr != null) sb.append('[').append(addr.substring(Math.max(0, addr.length() - 5))).append(']');
                if (n != null && n.toUpperCase(java.util.Locale.ROOT).indexOf("EPD") >= 0) sb.append(" ← 疑似场风盘");
                if (++i >= 12) { sb.append(" …"); break; }
            }
            return sb.toString();
        } catch (Exception e) { return "读不到"; }
    }

    private final ScanCallback scanCb = new ScanCallback() {
        @SuppressLint("MissingPermission")
        @Override public void onScanResult(int callbackType, ScanResult result) {
            BluetoothDevice dev = result.getDevice();
            if (dev == null) return;
            String addr = dev.getAddress();
            if (addr == null) return;

            boolean firstSeen = !scanSeen.contains(addr);
            String prevName = scanName.get(addr);

            boolean hit = false;
            String name = null;
            int recLen = -1;
            android.bluetooth.le.ScanRecord rec = result.getScanRecord();
            if (rec != null) {
                byte[] raw = rec.getBytes();
                recLen = raw == null ? 0 : raw.length;
                name = rec.getDeviceName();
                java.util.List<ParcelUuid> uuids = rec.getServiceUuids();
                if (uuids != null) for (ParcelUuid u : uuids) {
                    if (SERVICE_UUID.equals(u.getUuid())) { hit = true; break; }
                }
            }
            if (name == null || name.isEmpty()) {
                try { name = dev.getName(); } catch (Exception ignored) {}
            }
            boolean realName = name != null && !name.isEmpty();
            // 名字兜底命中：固件广播名是 "NRF_EPD_<地址后两字节>"（main.c DEVICE_NAME），
            // 价签/时钟分支可能带 EPD 字样；即使名字对不上，设备也仍在列表里可选
            if (!hit && realName
                    && name.toUpperCase(java.util.Locale.ROOT).indexOf("EPD") >= 0) hit = true;

            // ⚠️ **绝不能"同地址只上报一次"**（这里踩过，症状是"扫描列表里全是无名设备且找不到场风盘"）。
            //    BLE 的 advertising data 与 scan response 是**两个独立的包**，系统会分别（或合并后）回调：
            //    本固件把**服务 UUID 放在 scan response**，而首个回调常常只有短包 —— 此时
            //    `rec.getDeviceName()` 返回 null。旧写法在首个回调就 `scanSeen.add(addr)` 并 return，
            //    把随后那个**带名字的回调全部丢弃** ⇒ 设备永远显示"（无名设备）"、也永远不命中。
            //    现在：首次上报；之后仅当"拿到了比上次更好的名字"时补报一次，由页面按地址覆盖更新。
            boolean nameUpgraded = realName && (prevName == null || prevName.isEmpty());
            if (!firstSeen && !nameUpgraded) return;

            scanSeen.add(addr);
            scanName.put(addr, realName ? name : "");
            if (hit) scanHitAddrs.add(addr);

            emit("scan", "{\"name\":\"" + jsonEsc(realName ? name : "（无名设备）")
                    + "\",\"addr\":\"" + addr
                    + "\",\"rssi\":" + result.getRssi()
                    + ",\"hit\":" + hit
                    + ",\"recLen\":" + recLen + "}");
        }
        @Override public void onScanFailed(int errorCode) {
            scanning = false;
            log("扫描失败 code=" + errorCode + "（" + scanErrText(errorCode) + "）");
            emit("scan-done", "");
        }
    };

    private static String scanErrText(int code) {
        switch (code) {
            case 1: return "已有扫描在进行";
            case 2: return "扫描注册失败，可重启蓝牙后重试";
            case 3: return "系统内部错误";
            case 4: return "本机不支持该扫描特性";
            case 5: return "硬件资源不足，请稍后重试";
            case 6: return "扫描过于频繁，请稍后重试";
            default: return "未知原因";
        }
    }

    /**
     * GATT 断开/连接失败的 status 翻译。
     *
     * 这块是"直连点了没反应"的关键：系统超时是 **30 秒**，期间页面上什么都不变，
     * 用户只会觉得按钮坏了。把 status 翻成人话并回报，才知道究竟是哪种失败。
     * 147 / 8 是实测（小米 HyperOS + nRF 墨水屏）连不上时最常见的两个值。
     */
    private static String gattErrText(int status) {
        switch (status) {
            case 8:   return "连接超时（HCI 超时：设备没在广播、已休眠或已被别的设备连着）";
            case 19:  return "设备主动断开（GATT_CONN_TERMINATE_PEER_USER）";
            case 22:  return "本机主动断开（GATT_CONN_TERMINATE_LOCAL_HOST）";
            case 34:  return "链路层超时（LMP TIMEOUT，信号弱或设备已移出范围）";
            case 62:  return "连接建立失败（GATT_CONN_FAIL_ESTABLISH）";
            case 133: return "GATT 错误（通用 133：设备拒绝/链路异常，可重启蓝牙后重试）";
            case 137: return "连接被系统取消（GATT_CONN_CANCEL）";
            case 147: return "连接建立超时 —— 30 秒内设备没有响应。"
                           + "多半是设备没在广播（需按设备蓝牙键 / 已开蓝牙常开）、"
                           + "或已被微信小程序等别的中心占用";
            default:  return "未知错误码 " + status;
        }
    }

    // ============ 连接 ============

    /** 用户显式发起的连接（扫描列表点选 / 「直连」按钮 / 连记住的设备）—— 重试计数归零 */
    public void connect(String address) { connectInternal(address, true); }

    /** 连记住的设备（有才连）—— 自动路径，保留重试计数，避免"归零后无限重试" */
    public void autoConnectSaved() {
        String addr = savedAddress();
        if (addr == null || gatt != null) return;   // 已在连接/已连上，不重复发起
        connectInternal(addr, false);
    }

    public boolean hasSavedDevice() { return savedAddress() != null; }

    @SuppressLint("MissingPermission")
    private void connectInternal(String address, boolean manual) {
        if (!permissionOk || adapter == null) {
            log("蓝牙不可用（权限未授予或本机无蓝牙适配器）");
            emit("connect-fail", "蓝牙不可用");
            return;
        }
        BluetoothDevice dev;
        try { dev = adapter.getRemoteDevice(address); } catch (Exception e) {
            log("地址无效：" + address);
            emit("connect-fail", "地址无效");
            return;
        }
        String name = address;
        try {
            String n = dev.getName();       // 无 BLUETOOTH_CONNECT 权限时会抛，必须兜住
            if (n != null && !n.isEmpty()) name = n;
        } catch (Exception ignored) {}
        appContext.getSharedPreferences("eink", Context.MODE_PRIVATE)
                .edit().putString("device", address).apply();
        // 手动连接：重试计数从头开始。⚠️ 这一句以前写在 connectGatt() 里，
        // 而自动重连也要经过 connectGatt() ⇒ 计数每次被清零，MAX_RECONNECT 形同虚设，
        // 表现就是「每 32 秒连一次、永远连不上、日志刷几百行」的死循环。
        if (manual) reconnectTries = 0;
        manualDisconnect = false;
        stopPendingGatt();          // 关掉上一路未完成的连接，避免并发多路 GATT 客户端
        log("连接 " + name + " ...（最长等 30 秒，系统超时前无响应即失败）");
        emit("connecting", name);
        connectGatt(dev, name);
    }

    @SuppressLint("MissingPermission")
    private void connectGatt(BluetoothDevice dev, String name) {
        connectedName = name;
        try {
            BluetoothGatt g = dev.connectGatt(appContext, false, gattCb, BluetoothDevice.TRANSPORT_LE);
            if (g == null) {
                log("连接启动失败（connectGatt 返回 null）");
                emit("connect-fail", "连接启动失败");
                return;
            }
            gatt = g;
        } catch (Exception e) {
            String m = e.getClass().getSimpleName() + (e.getMessage() == null ? "" : " " + e.getMessage());
            log("连接失败: " + m);
            emit("connect-fail", "连接异常");
        }
    }

    /** 丢弃当前 GATT 客户端（置空字段后 close；旧对象的回调会被 onConnectionStateChange 忽略） */
    @SuppressLint("MissingPermission")
    private void stopPendingGatt() {
        BluetoothGatt old = gatt;
        gatt = null;
        linked = false;
        notifyOn = false;
        retiredGatt = old;
        if (old != null) {
            try { old.disconnect(); } catch (Exception ignored) {}
            try { old.close(); } catch (Exception ignored) {}
        }
    }

    /**
     * CCCD 写入兜底重试：`writeDescriptor()` 排队失败时不会有任何回调，
     * 表现为"连上了但设备一条回报都收不到"。最多重试 4 次（间隔 1.5s / 3s / 5s / 8s）。
     * 成功（onDescriptorWrite 置位 notifyOn）即停。
     */
    @SuppressLint("MissingPermission")
    private void retryCccd(final BluetoothGatt g, final BluetoothGattDescriptor cccd, final int attempt) {
        if (attempt >= 4) return;
        final long[] delays = {1500, 3000, 5000, 8000};
        main.postDelayed(new Runnable() {
            @Override public void run() {
                if (notifyOn || gatt == null || g != gatt) return;   // 已成功 / 已换连接
                boolean queued;
                try { queued = g.writeDescriptor(cccd); } catch (Exception e) { queued = false; }
                if (queued) log("CCCD 重试写入已排队（第 " + (attempt + 1) + " 次）");
                retryCccd(g, cccd, attempt + 1);
            }
        }, delays[attempt]);
    }

    public void disconnect() {
        manualDisconnect = true;
        connectedName = null;
        reconnectTries = 0;
        // ⚠️ 必须判空：Handler.removeCallbacks(null) 会命中所有 callback==null 的消息（同步屏障等），
        //    不是"什么都不做"
        if (reconnectRunnable != null) main.removeCallbacks(reconnectRunnable);
        work.post(new Runnable() {
            @Override public void run() { stopPendingGatt(); }
        });
        emit("disconnected", "");
    }

    /** 「真的连上了」—— 仅连接建立后为 true。连接中 gatt 已非 null，不能用它当判据 */
    public boolean isConnected() { return gatt != null && linked; }
    public String connectedName() { return connectedName; }

    private final BluetoothGattCallback gattCb = new BluetoothGattCallback() {
        @Override public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            // 已被替换 / 已处理过的旧连接的回调一律忽略（旧对象会清掉新连接的字段并误报断开）
            if (g == retiredGatt) return;
            if (gatt != null && g != gatt) return;
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                linked = true;
                reconnectTries = 0;          // 真正连上了才清零
                log("已连接，发现服务...");
                g.discoverServices();
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                retiredGatt = g;
                epdChar = null;
                msgIndex = 0; mtuReported = 0; rleSupport = false;
                boolean wasLinked = linked;
                linked = false;
                if (gatt != null && gatt == g) { try { g.close(); } catch (Exception ignored) {} }
                if (gatt == g) gatt = null;
                // 顺序要紧：先报「断开」（页面回到"未连接"），再报失败原因 ——
                // 反过来的话失败原因会被随后的 disconnected 覆盖掉，又变成"什么都看不到"
                emit("disconnected", "");
                if (status != 0) {
                    // 以前这里把 status 整个丢掉 —— 用户只看到"无反应"，看不到是超时还是被拒
                    String why = gattErrText(status);
                    log("连接失败：status=" + status + "（" + why + "）");
                    emit("connect-fail", why);
                }
                if (manualDisconnect) return;
                // 重试上限必须真的生效：以前 connectGatt() 每次把计数清零 ⇒ 无限循环
                if (reconnectTries >= MAX_RECONNECT) {
                    log("已尝试 " + MAX_RECONNECT + " 次仍未连上，停止自动重连。"
                            + "请确认设备已按蓝牙键（或已开「蓝牙常开」）后重新点「扫描并连接场风盘」或「直连」。");
                    emit("connect-giveup", "");
                    return;
                }
                reconnectTries++;
                log((wasLinked ? "蓝牙断开，自动重连 " : "连接未成功，重试 ")
                        + reconnectTries + "/" + MAX_RECONNECT + " ...");
                if (reconnectRunnable != null) main.removeCallbacks(reconnectRunnable);
                reconnectRunnable = new Runnable() {
                    @Override public void run() { autoConnectSaved(); }
                };
                main.postDelayed(reconnectRunnable, 2000);
            }
        }

        @Override public void onServicesDiscovered(BluetoothGatt g, int status) {
            if (status != BluetoothGatt.GATT_SUCCESS) { log("发现服务失败"); return; }
            android.bluetooth.BluetoothGattService svc = g.getService(SERVICE_UUID);
            if (svc == null) { log("未找到场风盘服务（不是 EPD-nRF5 设备？）"); return; }
            epdChar = svc.getCharacteristic(EPD_UUID);
            if (epdChar == null) { log("未找到 EPD 特征"); return; }
            BluetoothGattCharacteristic ver = svc.getCharacteristic(VER_UUID);
            if (ver != null) {
                byte[] v = ver.getValue();
                if (v != null && v.length > 0) appVersion = v[0] & 0xFF;
                else g.readCharacteristic(ver);
            }
            if (appVersion < 0x16) {
                log("固件版本过低（0x" + Integer.toHexString(appVersion)
                        + "），不支持 WRITE_IMG，请先 OTA 升级");
                return;
            }
            g.setCharacteristicNotification(epdChar, true);
            BluetoothGattDescriptor cccd = epdChar.getDescriptor(CCCD);
            if (cccd != null) {
                cccd.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                boolean queued = g.writeDescriptor(cccd);
                // writeDescriptor 返回 false = 请求根本没排上队，且**不会有任何回调** ——
                // 以前这里不看返回值、也没有兜底，结果通知永远建不起来，
                // 设备自报的「配置 / mtu=N rle=1 / ble=」一条都收不到（实测日志里
                // 连"设备通知已启用"都不出现）。这里必须留痕 + 兜底重排队。
                if (!queued) {
                    log("CCCD 写入请求未排队，稍后自动重试（设备回报可能延迟）");
                    retryCccd(g, cccd, 0);
                }
            } else {
                // 以前这里是静默的：通知没建起来 ⇒ 设备的 mtu=N / ble= 回报一条都收不到，
                // 而且每次推图都要白等 MTU_WAIT_MS（5 秒）才落到 244 兜底。
                log("未找到 CCCD 描述符：设备回报（mtu / 蓝牙常开）将收不到，MTU 按 244 兜底");
            }
            g.requestMtu(247);
            // ⚠️ 这里以前**从不回报「已连接」**：建连 + 发现服务都成功了，页面却一直停在
            //    "正在连接…"，「断开连接」不出现、「面板自检 / 推测试图案」永远 disabled ——
            //    用户看到的就是"连上了也没反应"。真正可用的时刻是特征与通知都就绪的这一刻。
            emit("connected", connectedName == null ? "场风盘" : connectedName);
            log("连接就绪（服务/特征/通知已建立，可以推送）");
            // 连接后的热身 INIT（裸发）：按设备 flash 里已存的 model_id 复位/上电。
            // 绝不带驱动字节 —— 带参 INIT 会把型号永久写进设备 flash。
            work.postDelayed(new Runnable() {
                @Override public void run() { writeCmd(CMD_INIT); }
            }, 300);
        }

        @Override public void onMtuChanged(BluetoothGatt g, int mtu, int status) {
            // 设备会在 notify 里发 mtu=N（以此为准），这里仅记录
        }

        /** CCCD 写入结果留痕：通知没启用时，设备后续的 mtu=N / ble= 回报会静默丢失 */
        @Override public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, int status) {
            if (d == null || !CCCD.equals(d.getUuid())) return;
            notifyOn = (status == BluetoothGatt.GATT_SUCCESS);
            log(notifyOn
                    ? "设备通知已启用（等待设备回报配置 / mtu / 蓝牙常开状态）"
                    : "设备通知启用失败 status=" + status + "（设备回报会收不到）");
        }

        @Override public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            PushJob j = job;
            if (j == null || !c.getUuid().equals(EPD_UUID)) return;
            // 只有「带响应」块由回调推进；无响应块由 pushNext 的兜底定时器推进。
            // （旧实现两条路径都无条件推进 —— 回调稍慢于 40ms 就双重推进，静默漏块）
            if (!j.pendingResp || j.pendingIdx != j.index) return;
            j.index++;
            work.post(new Runnable() { @Override public void run() { pushNext(); } });
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
            onNotify(c == null ? null : c.getValue());
        }

        /** API 33+ 的新回调重载：只覆写旧版在部分 ROM 上会收不到（表现为"永远没有回报"） */
        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value) {
            onNotify(value);
        }

        /** 通知统一入口（两个重载都汇到这里） */
        private void onNotify(byte[] data) {
            if (data == null || data.length == 0) return;
            int idx = msgIndex++;
            if (idx < 3) log("◀ 回报#" + idx + "（" + data.length + "B）：" + hexOf(data));
            if (idx == 0) {
                // 设备自报配置（与参考站 handleNotify 一致）：
                //   byte0-6 = 引脚 mosi/sclk/cs/dc/rst/busy/bs，byte7 = 驱动 model_id，
                //   byte8 = keypin，byte10 = en_pin。参考站把它拼成"引脚串"填进 UI：
                //   bytes[0..6] + bytes[10] —— 即 1413060504030207 这 8 个字节的来历。
                //   注意 idx==0 一定是二进制配置包，不能用文本方式解码。
                if (isBinaryConfig(data)) {
                    StringBuilder pins = new StringBuilder();
                    for (int i = 0; i < 7 && i < data.length; i++)
                        pins.append(String.format("%02x", data[i]));
                    if (data.length > 10) pins.append(String.format("%02x", data[10]));
                    devPins = pins.toString();
                    devDriver = data.length > 7 ? String.format("%02x", data[7]) : "";
                    log("设备配置: pins=" + devPins + " driver=" + devDriver);
                    if (!EXPECTED_PINS.equals(devPins)) {
                        log("⚠️ 引脚配置与预期（" + EXPECTED_PINS + "）不一致 —— "
                                + "若显示异常，点「修复引脚配置」回写");
                    }
                    emit("devcfg", devPins + "|" + devDriver);
                    return;
                }
            }
            StringBuilder sb = new StringBuilder();
            for (byte b : data) sb.append((char) (b & 0xFF));
            String msg = sb.toString();
            if (msg.startsWith("mtu=") && msg.length() > 4) {
                try {
                    int n = Integer.parseInt(msg.substring(4).replaceAll("[^0-9].*$", ""));
                    if (n >= 20) mtuReported = n;
                } catch (Exception ignored) {}
                if (msg.contains("rle=1")) rleSupport = true;
                log("MTU=" + attPayloadMtu() + (rleSupport ? " (RLE 支持)" : ""));
            } else if (msg.startsWith("ble=")) {
                String on = msg.substring(4).trim();
                emit("ble", "1".equals(on) ? "1" : "0");
                log("蓝牙模式: " + ("1".equals(on) ? "常开" : "常关"));
            }
        }

        /** 设备配置包判据：首字节是引脚号（不是可打印字符）即视为二进制配置 */
        private boolean isBinaryConfig(byte[] d) {
            return d.length >= 8 && (d[0] & 0xFF) < 0x20;
        }
    };

    // ============ 蓝牙常开（epd-noclock 0x25） ============

    public void setBleAlwaysOn(final boolean on) {
        if (!isConnected()) { log("未连接，无法设置"); return; }
        work.post(new Runnable() {
            @Override public void run() { writeCmd(CMD_BLE_ALWAYS, new byte[]{(byte) (on ? 1 : 0)}); }
        });
        log(on ? "已发送：蓝牙常开（断电后仍广播）" : "已发送：蓝牙常关（上电广播5分钟，之后需长按按键）");
    }

    // ============ 推送（节流入口） ============

    /**
     * 请求推送当前状态到墨水屏。
     * @param immediate true=立即推送（立即推送按钮）；false=走 1s 节流（自动推送）
     */
    public void requestPush(String tagDataJson, boolean immediate) {
        if (immediate) {
            main.removeCallbacks(throttleRunnable);
            throttleScheduled = false;
            pendingData = null;
            final String d = tagDataJson;
            work.post(new Runnable() { @Override public void run() { doPush(d); } });
        } else {
            pendingData = tagDataJson;
            if (!throttleScheduled) {
                throttleScheduled = true;
                main.postDelayed(throttleRunnable, THROTTLE_MS);
            }
        }
    }

    private void doPush(String tagDataJson) {
        if (!isConnected() || epdChar == null) {
            log("蓝牙未连接，跳过推送");
            emit("push-status", "skipped");
            return;
        }
        if (job != null) { emit("push-status", "busy"); return; } // 上一次还在推
        EinkTagRenderer.TagData d = EinkTagRenderer.parse(tagDataJson);
        if (d == null) { log("推送数据解析失败"); return; }
        // 画面处理：对比度 1.2 → Floyd-Steinberg 抖动（强度 1.0）→ 三色双平面
        Bitmap bmp = EinkTagRenderer.applyContrastAndDither(EinkTagRenderer.render(d));
        pushBitmap(bmp);
    }

    /**
     * 面板自检：清屏（固件 CLEAR = 复位 + 上电 + 两平面填白 + 全屏刷新）。
     * 完全不经过我们的位图 / 压缩 / 标志位编码，用于把「屏不响应」和「画面数据错」切开 ——
     * 与 tag.html 的「面板自检（清屏）」是同一件事。
     */
    public void clearPanel() {
        if (!isConnected() || epdChar == null) {
            log("蓝牙未连接，无法自检");
            emit("push-status", "skipped");
            return;
        }
        work.post(new Runnable() {
            @Override public void run() {
                boolean ok = writeCmd(CMD_CLEAR);
                log(ok ? "已发清屏自检（CLEAR），约 15 秒后屏应变全白"
                       : "清屏指令写入失败（屏不会变化）");
                emit("push-status", ok ? "clear-sent" : "clear-fail");
            }
        });
    }

    /** 测试图案推送：不依赖对局数据（黑框 + 左上红块 + 右上黑块 + 「场风盘」） */
    public void pushTestPattern() {
        if (!isConnected() || epdChar == null) {
            log("蓝牙未连接，无法推送测试图案");
            emit("push-status", "skipped");
            return;
        }
        work.post(new Runnable() {
            @Override public void run() {
                if (job != null) { emit("push-status", "busy"); return; }
                Bitmap bmp = EinkTagRenderer.applyContrastAndDither(EinkTagRenderer.testPattern());
                pushBitmap(bmp);
            }
        });
    }

    /**
     * 二维码推图：JS 侧用 qrcode.js 画好 400×300 白底 PNG（base64）→ 原样推屏。
     *
     * 与对局画面（doPush）的区别：**不做对比度/抖动** —— 二维码本身就是纯黑白，
     * Floyd-Steinberg 抖动只会在边缘撒噪点、反而更难扫。走 pushBitmap 的三色量化
     * 已足够（灰度 >=140 归白、其余归黑，纯色输入不受影响）。
     * 立即推送语义：先清掉挂着的自动推送节流，避免刚推完二维码又被分数画面盖掉。
     */
    public void pushQrPng(final String base64Png) {
        if (!isConnected() || epdChar == null) {
            log("蓝牙未连接，跳过二维码推送");
            emit("push-status", "skipped");
            return;
        }
        main.removeCallbacks(throttleRunnable);
        throttleScheduled = false;
        pendingData = null;
        work.post(new Runnable() {
            @Override public void run() {
                if (job != null) { emit("push-status", "busy"); return; }
                try {
                    byte[] raw = android.util.Base64.decode(base64Png, android.util.Base64.DEFAULT);
                    Bitmap bmp = android.graphics.BitmapFactory.decodeByteArray(raw, 0, raw.length);
                    if (bmp == null) {
                        log("二维码图片解码失败，已放弃推送");
                        emit("push-status", "skipped");
                        return;
                    }
                    if (bmp.getWidth() != EinkTagRenderer.W || bmp.getHeight() != EinkTagRenderer.H) {
                        Bitmap scaled = Bitmap.createScaledBitmap(bmp, EinkTagRenderer.W, EinkTagRenderer.H, false);
                        if (scaled != bmp) bmp.recycle();
                        bmp = scaled;
                    }
                    pushBitmap(bmp);
                } catch (Throwable t) {
                    log("二维码推送异常：" + t);
                    emit("push-status", "skipped");
                }
            }
        });
    }

    /** 位图 → 分包 → 逐块推送（调用方须在工作线程） */
    private void pushBitmap(Bitmap bmp) {
        if (job != null) { emit("push-status", "busy"); return; }
        if (gatt == null || epdChar == null) { log("连接断开，推送中止"); emit("push-status", "skipped"); return; }
        // 等设备上报 MTU 再分包（与参考站 ensureImageMtuReady 一致）
        waitMtuReported();
        int chunkSize = Math.max(1, attPayloadMtu() - 2);

        java.util.List<byte[]> chunks = new java.util.ArrayList<>();
        java.util.List<Boolean> resp = new java.util.ArrayList<>();
        // 裸 INIT：按设备 flash 里已存的 model_id 复位，不改写型号
        chunks.add(new byte[]{(byte) CMD_INIT}); resp.add(true);
        byte[][] planes = quantize(bmp);
        lastBwBlocks = 0; lastRedBlocks = 0;
        addImageBlocks(chunks, resp, planes[0], chunkSize, false);
        addImageBlocks(chunks, resp, planes[1], chunkSize, true);
        log("开始推送 " + bmp.getWidth() + "×" + bmp.getHeight() + "（块 " + chunkSize
                + "B，MTU " + attPayloadMtu() + "，黑白 " + lastBwBlocks + " 块 / 红 "
                + lastRedBlocks + " 块，共 " + chunks.size() + " 包）");

        PushJob j = new PushJob();
        j.chunks = chunks.toArray(new byte[0][]);
        j.resp = new boolean[resp.size()];
        for (int i = 0; i < resp.size(); i++) j.resp[i] = resp.get(i);
        job = j;
        emit("push-status", "start");
        work.post(new Runnable() { @Override public void run() { pushNext(); } });
    }

    /** 三色量化 → [黑白面, 红面] 两张 1bpp（1=白/非红 0=黑/红，MSB 在前，行序） */
    private static byte[][] quantize(Bitmap bmp) {
        int w = bmp.getWidth(), h = bmp.getHeight();
        int byteWidth = (w + 7) / 8;
        int[] px = new int[w * h];
        bmp.getPixels(px, 0, w, 0, 0, w, h);
        byte[] bw = new byte[h * byteWidth];
        byte[] red = new byte[h * byteWidth];
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int c = px[y * w + x];
                int r = (c >> 16) & 0xFF, g = (c >> 8) & 0xFF, b = c & 0xFF;
                int gray = (299 * r + 587 * g + 114 * b) / 1000;
                int bi = y * byteWidth + x / 8;
                int bit = 7 - (x % 8);
                if (gray >= 140) bw[bi] |= (byte) (1 << bit);
                if (!(r > 160 && r > g && r > b)) red[bi] |= (byte) (1 << bit);
            }
        }
        return new byte[][]{bw, red};
    }

    /**
     * 图像面打包为 WRITE_IMG 块序列。
     *
     * 🔴 每块的**第 1 字节必须是命令字节 `WRITE_IMG(0x30)`**，第 2 字节才是标志位，
     *    之后才是数据 —— 参考站 writeImage 与网页版 tagpush.js 都是
     *    `pkt = [0x30, flag, ...chunk]`。以前这里只写了 `[flag, ...chunk]`，于是：
     *      · 黑面首块标志 0x02 → 固件当成 CLEAR，顺带调 drv->init()
     *      · 黑面后续 / 红面首块标志 0x00 → 固件当成 **SET_PINS**，用位图字节写引脚配置！
     *        （这是"引脚被写成 ffffffffffffff07"的真凶，详见 EPD_service.c 的
     *          EPD_CMD_SET_PINS：p_data[1..7] → mosi..bs，length>8 时 p_data[8] → en_pin）
     *      · 红面后续标志 0x01/0x03 → 被当成 INIT / SEND_COMMAND，还带参 epd_init(位图字节)
     *    即整条数据一个字节都没进显存 —— 这才是"能连上但推任何图都没反应"的根因。
     *
     * 标志位编码（EPD_service.c:216-219 为准）：
     *    bit0 = 1 红面 / 0 黑面；bit1 = 1 首块 / 0 续块；bit2 = 1 载荷是 RLE 压缩流
     *    → 黑面首块 0x02 / 续块 0x00，红面首块 0x03 / 续块 0x01（我们发原始数据，bit2 恒 0）
     *    ⚠️ 不再按 rleSupport 切"v1.6 旧编码"：0x0F/0xFF 在现固件下 bit0=1 会被判成红面，
     *       而且 pushBitmap 已经用 appVersion>=0x16 把老固件挡在门外了。
     * 回执：每 ACK_INTERVAL 块要一次，最后一块必带。
     */
    private void addImageBlocks(java.util.List<byte[]> out, java.util.List<Boolean> resp,
                                byte[] data, int chunkSize, boolean red) {
        final int firstFlag = red ? 0x03 : 0x02;
        final int nextFlag = red ? 0x01 : 0x00;
        int total = Math.max(1, (data.length + chunkSize - 1) / chunkSize);
        for (int i = 0; i < total; i++) {
            int off = i * chunkSize;
            int len = Math.min(chunkSize, Math.max(0, data.length - off));
            // 2 = 命令字节 0x30 + 标志位字节（chunkSize 已按 mtu-2 预留了这两个字节）
            byte[] blk = new byte[2 + len];
            blk[0] = (byte) CMD_WRITE_IMG;
            blk[1] = (byte) (i == 0 ? firstFlag : nextFlag);
            if (len > 0) System.arraycopy(data, off, blk, 2, len);
            out.add(blk);
            if (red) lastRedBlocks++; else lastBwBlocks++;
            // 每 50 块要一次回执 + 末块必带（与参考站 needAck 一致）
            resp.add(i % ACK_INTERVAL == ACK_INTERVAL - 1 || i == total - 1);
        }
    }

    /** 逐块状态机：onCharacteristicWrite 回调驱动 */
    @SuppressLint("MissingPermission")
    private void pushNext() {
        PushJob j = job;
        if (j == null || j.cancelled) return;
        if (j.index >= j.chunks.length) {
            job = null;
            // ⚠️ 以前这里丢掉 REFRESH 的返回值，写失败也报「推送完成」——
            //    诊断时无论出什么错都看着是绿的。现在必须上报结果。
            boolean ok = writeCmd(CMD_REFRESH);
            if (ok) {
                log("推送完成（黑白 " + lastBwBlocks + " 块 / 红 " + lastRedBlocks
                        + " 块，已发刷新，约 15 秒后画面更新）");
                emit("push-status", "done");
            } else {
                log("刷新指令写入失败 —— 画面不会变化");
                emit("push-status", "refresh-fail");
            }
            return;
        }
        if (gatt == null || epdChar == null) { job = null; log("连接断开，推送中止"); return; }
        final int idx = j.index;
        final boolean needResp = j.resp[idx];
        j.pendingIdx = idx;
        j.pendingResp = needResp;
        byte[] blk = j.chunks[idx];
        epdChar.setValue(blk);
        epdChar.setWriteType(needResp
                ? BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT        // 控制块/每 50 块要回执
                : BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
        boolean ok = gatt.writeCharacteristic(epdChar);
        if (!ok) {
            // 写入排队失败：本块根本没发出去 → 必须重试同一块。
            // 旧实现这里还会让 40ms 兜底定时器推进 index，等于静默漏掉一整块。
            work.postDelayed(new Runnable() { @Override public void run() { pushNext(); } }, 50);
            return;
        }
        // 只有「无响应写」才需要兜底定时器推进（它没有回调保障）。
        if (!needResp) {
            work.postDelayed(new Runnable() {
                @Override public void run() {
                    PushJob jj = job;
                    if (jj != null && !jj.cancelled && !jj.pendingResp && jj.pendingIdx == idx
                            && jj.index == idx) {
                        jj.index++;
                        pushNext();
                    }
                }
            }, 40);
        }
    }

    @SuppressLint("MissingPermission")
    private boolean writeCmd(int cmd) { return writeCmd(cmd, null); }

    @SuppressLint("MissingPermission")
    private boolean writeCmd(int cmd, byte[] data) {
        if (gatt == null || epdChar == null) return false;
        byte[] payload = data == null ? new byte[]{(byte) cmd}
                : new byte[1 + data.length];
        payload[0] = (byte) cmd;
        if (data != null) System.arraycopy(data, 0, payload, 1, data.length);
        epdChar.setValue(payload);
        epdChar.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
        return gatt.writeCharacteristic(epdChar);
    }

    private static String jsonEsc(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private static String hexOf(byte[] d) {
        StringBuilder sb = new StringBuilder();
        for (byte b : d) sb.append(String.format("%02x", b & 0xFF));
        return sb.toString();
    }

    /** 设备自报的引脚串（未连接 / 未收到配置包时为空） */
    public String devicePins() { return devPins; }

    /**
     * 修复引脚：回写引脚配置。
     *
     * 🔴 只在引脚被写坏时用。协议的 SET_PINS(0x00) 载荷 = 7 个引脚 + en_pin(+ keypin)，
     *    这正是"引脚串"的字节形式；按参考站 setPinsPayload 的拼法发出。
     *    正常情况下永远不该走这里 —— 推图流程只发 0x01/0x02/0x05/0x30/0x25。
     */
    public void repairPins() {
        if (!isConnected()) { log("未连接，无法修复引脚"); return; }
        final byte[] payload = new byte[PIN_PAYLOAD.length + 1];
        System.arraycopy(PIN_PAYLOAD, 0, payload, 0, PIN_PAYLOAD.length);
        payload[PIN_PAYLOAD.length] = DEFAULT_KEYPIN;
        work.post(new Runnable() {
            @Override public void run() {
                boolean ok = writeCmd(CMD_SET_PINS, payload);
                log(ok ? ("已回写引脚配置：" + EXPECTED_PINS + "（断开重连后可在日志看到设备自报值）")
                       : "引脚配置写入失败（连接已断？）");
                if (ok) {
                    emit("pins-fixed", EXPECTED_PINS);
                    // 回写后 GPIO 会被固件重新加载，稍后再发一次裸 INIT 让面板重新上电
                    work.postDelayed(new Runnable() {
                        @Override public void run() { writeCmd(CMD_INIT); }
                    }, 500);
                }
            }
        });
    }
}
