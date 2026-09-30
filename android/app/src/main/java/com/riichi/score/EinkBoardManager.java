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
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.ParcelUuid;

import java.util.Collections;
import java.util.List;
import java.util.UUID;

/**
 * EinkBoardManager — 墨水屏场风盘原生 BLE 客户端（路线 A：APP 内直连推送）
 *
 * 协议 = tsl0922/EPD-nRF5（与 prototype/js/tagpush.js 逐行同源，另含 epd-noclock 扩展）：
 *  - Service  62750001-d828-918d-fb46-b6c11c675aec
 *  - EPD 特征 62750002-...（write + notify）
 *  - 版本特征 62750003-...（uint8，须 >= 0x16 才支持 WRITE_IMG=0x30）
 *  - 连接后第 1 条 notify = 设备自报配置；之后文本 "mtu=N"（rle=1 忽略，不压缩）；
 *    "ble=0/1" = 蓝牙常开状态回报（epd-noclock 扩展）
 *  - BLE_ALWAYS(0x25)+1字节 = 蓝牙常开设置（存设备 flash，断电有效）
 *  - 传图：INIT(0x01[,model]) → WRITE_IMG(0x30) 黑白面 → 红面 → REFRESH(0x05)
 *    非压缩标志位（固件 EPD_service.c 解析）：bit0=0 黑/1 红，bit1=1 首块，bit2=1 RLE
 *    → 黑面首块 0x02/后续 0x00，红面首块 0x03/后续 0x01
 *  - 黑白快刷（isFastMode）：INIT 带 model=0x01 → 透传 SEND_CMD(0x03)/SEND_DATA(0x04)
 *    写 PSR/CDI/LUT → 单张黑白面 → REFRESH（详见 PSR_BW 注释）
 *  - 位图 1bpp：byteWidth=ceil(w/8)、MSB 在前、1=白 0=黑（红面 0=红）；块数据 = mtu-2 字节
 *
 * 线程模型：所有 GATT 操作在专用 HandlerThread 上执行；渲染在工作线程；
 * 节流用主 Handler。对 JS 的状态回调统一走 Listener.onEvent(type, data)。
 */
public class EinkBoardManager {

    public interface Listener {
        /** type: scanning / scan / scan-done / connected / disconnected / log / ble / push-status */
        void onEvent(String type, String data);
    }

    public static final UUID SERVICE_UUID = UUID.fromString("62750001-d828-918d-fb46-b6c11c675aec");
    public static final UUID EPD_UUID     = UUID.fromString("62750002-d828-918d-fb46-b6c11c675aec");
    public static final UUID VER_UUID     = UUID.fromString("62750003-d828-918d-fb46-b6c11c675aec");
    private static final UUID CCCD       = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    private static final int CMD_INIT = 0x01, CMD_WRITE_IMG = 0x30, CMD_REFRESH = 0x05, CMD_BLE_ALWAYS = 0x25;
    private static final int CMD_SEND_CMD = 0x03, CMD_SEND_DATA = 0x04;   // 原始透传（寄存器写入用）
    private static final long THROTTLE_MS = 10_000;   // 自动推送节流
    private static final long SCAN_PERIOD_MS = 6_000; // 扫描时长
    private static final int MAX_RECONNECT = 5;

    /* 模型 ID（EPD_driver.h）：快刷用 BW 模型让固件按黑白初始化（PSR 0x1F/CDI 0x97） */
    private static final int MODEL_UC8176_420_BW = 0x01, MODEL_UC8176_420_BWR = 0x03;

    /* ---------------- 黑白快刷（3 色屏当黑白屏，15s → 2-3s，与 tagpush.js 同源） ----------------
     * 依据：EPD-nRF5 docs/README.md「bw.txt」LUT 组。序列：INIT(model=0x01) →
     * 透传写 PSR(0x3F)/CDI(0x97) + 5 张 LUT 寄存器 → 单张黑白面 → REFRESH。
     * ⚠️ BWR 面板 OTP 是三色慢波形，PSR bit5(LUT_SEL)=1 让 DRF 用寄存器 LUT；
     *    实机若快刷未生效或花屏，先调 PSR_BW 一个字节（0x3F↔0x1F），无损可回退。 */
    private static final int PSR_BW = 0x3F, CDI_BW = 0x97;
    private static final byte[] BW_LUTC  = {0x00,0x28,0x28,0x00,0x00,0x01, 0x60,0x32,0x32,0x00,0x00,0x02, 0x00,0x14,0x00,0x00,0x00,0x01, 0x00,0x32,0x32,0x00,0x00,0x01, 0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,0x28,0x00, 0x00,0x00};
    private static final byte[] BW_LUTWW = {0x50,0x28,0x32,0x00,0x00,0x01, (byte)0x90,0x32,0x00,0x00,0x00,0x02, 0x40,0x14,0x32,0x00,0x00,0x01, (byte)0xA0,0x32,0x00,0x00,0x00,0x01, 0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x28,0x00,0x00,0x00};
    private static final byte[] BW_LUTBW = {0x50,0x28,0x32,0x00,0x00,0x01, (byte)0x90,0x32,0x00,0x00,0x00,0x02, 0x40,0x14,0x32,0x00,0x00,0x01, (byte)0xA0,0x32,0x00,0x00,0x00,0x01, 0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x28,0x00,0x00,0x00};
    private static final byte[] BW_LUTWB = {(byte)0xA0,0x28,0x32,0x00,0x00,0x01, (byte)0x90,0x32,0x00,0x00,0x00,0x02, (byte)0x80,0x14,0x32,0x00,0x00,0x01, 0x50,0x32,0x00,0x00,0x00,0x01, 0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x28,0x00,0x00,0x00};
    private static final byte[] BW_LUTBB = {(byte)0xA0,0x28,0x32,0x00,0x00,0x01, 0x10,0x32,0x00,0x00,0x00,0x02, (byte)0x80,0x14,0x32,0x00,0x00,0x01, 0x50,0x32,0x00,0x00,0x00,0x01, 0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,(byte)0xFF,0x00,0x00,0x00};

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

    // 协议状态（与 tagpush.js st 对应）
    private int msgIndex = 0;
    private int mtu = 20;
    private int appVersion = 0x16;

    // 节流
    private String pendingData = null;
    private boolean throttleScheduled = false;
    private final Runnable throttleRunnable = new Runnable() {
        @Override public void run() {
            throttleScheduled = false;
            String d = pendingData;
            pendingData = null;
            if (d != null) doPush(d);
        }
    };

    // 推送任务（onCharacteristicWrite 回调驱动下一块）
    private static class PushJob {
        byte[][] chunks;   // 全部块（INIT/寄存器/图像，各含自身命令字节）
        boolean[] resp;    // 每块是否要回执（true=WRITE_TYPE_DEFAULT 等回调）
        int index = 0;
        volatile boolean cancelled = false;
    }
    private PushJob job;

    private boolean manualDisconnect = false;
    private int reconnectTries = 0;
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
    public void setPermissionOk() {
        permissionOk = true;
        emit("log", "蓝牙权限已授予");
        autoConnectSaved();
    }
    public boolean hasPermission() { return permissionOk; }

    private void emit(String type, String data) {
        if (listener != null) listener.onEvent(type, data);
    }
    private void log(String msg) { emit("log", msg); }

    // ============ 扫描 ============

    @SuppressLint("MissingPermission")
    public void startScan() {
        if (!permissionOk || adapter == null || !adapter.isEnabled()) {
            emit("log", "蓝牙不可用或权限未授予");
            emit("scan-done", "");
            return;
        }
        emit("scanning", "");
        ScanFilter filter = new ScanFilter.Builder()
                .setServiceUuid(new ParcelUuid(SERVICE_UUID)).build();
        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build();
        try {
            adapter.getBluetoothLeScanner().startScan(Collections.singletonList(filter), settings, scanCb);
        } catch (Exception e) {
            log("扫描启动失败: " + e.getMessage());
            emit("scan-done", "");
            return;
        }
        main.postDelayed(new Runnable() {
            @Override public void run() {
                try { adapter.getBluetoothLeScanner().stopScan(scanCb); } catch (Exception ignored) {}
                emit("scan-done", "");
            }
        }, SCAN_PERIOD_MS);
    }

    private final ScanCallback scanCb = new ScanCallback() {
        @Override public void onScanResult(int callbackType, ScanResult result) {
            BluetoothDevice dev = result.getDevice();
            String name = dev.getName() != null ? dev.getName() : "未知设备";
            emit("scan", "{\"name\":\"" + jsonEsc(name) + "\",\"addr\":\"" + dev.getAddress()
                    + "\",\"rssi\":" + result.getRssi() + "}");
        }
        @Override public void onScanFailed(int errorCode) {
            log("扫描失败 code=" + errorCode);
            emit("scan-done", "");
        }
    };

    // ============ 连接 ============

    /** 记住设备并连接 */
    @SuppressLint("MissingPermission")
    public void connect(String address) {
        if (!permissionOk || adapter == null) { log("蓝牙不可用"); return; }
        BluetoothDevice dev;
        try { dev = adapter.getRemoteDevice(address); } catch (Exception e) { log("地址无效"); return; }
        String name = dev.getName() != null ? dev.getName() : address;
        appContext.getSharedPreferences("eink", Context.MODE_PRIVATE)
                .edit().putString("device", address).apply();
        log("连接 " + name + " ...");
        connectGatt(dev, name);
    }

    /** 连记住的设备（有才连） */
    public void autoConnectSaved() {
        String addr = savedAddress();
        if (addr != null && (gatt == null || connectedName == null)) connect(addr);
    }

    public boolean hasSavedDevice() { return savedAddress() != null; }

    @SuppressLint("MissingPermission")
    private void connectGatt(BluetoothDevice dev, String name) {
        manualDisconnect = false;
        reconnectTries = 0;
        connectedName = name;
        try {
            gatt = dev.connectGatt(appContext, false, gattCb, BluetoothDevice.TRANSPORT_LE);
        } catch (Exception e) {
            log("连接失败: " + e.getMessage());
        }
    }

    public void disconnect() {
        manualDisconnect = true;
        connectedName = null;
        work.post(new Runnable() {
            @Override public void run() {
                if (gatt != null) { try { gatt.disconnect(); gatt.close(); } catch (Exception ignored) {} gatt = null; }
            }
        });
        emit("disconnected", "");
    }

    public boolean isConnected() { return gatt != null && connectedName != null; }
    public String connectedName() { return connectedName; }

    private final BluetoothGattCallback gattCb = new BluetoothGattCallback() {
        @Override public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                log("已连接，发现服务...");
                g.discoverServices();
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                epdChar = null;
                msgIndex = 0; mtu = 20;
                boolean wasConnected = connectedName != null;
                if (gatt != null) { try { g.close(); } catch (Exception ignored) {} gatt = null; }
                if (manualDisconnect) {
                    emit("disconnected", "");
                    return;
                }
                emit("disconnected", "");
                if (wasConnected && reconnectTries < MAX_RECONNECT) {
                    reconnectTries++;
                    log("蓝牙断开，自动重连 " + reconnectTries + "/" + MAX_RECONNECT + " ...");
                    main.postDelayed(new Runnable() {
                        @Override public void run() { autoConnectSaved(); }
                    }, 2000);
                }
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
                g.writeDescriptor(cccd);
            }
            g.requestMtu(247);
            // 写 INIT（tagpush.js doConnect 尾部行为）
            work.postDelayed(new Runnable() {
                @Override public void run() { writeCmd(CMD_INIT); }
            }, 300);
        }

        @Override public void onMtuChanged(BluetoothGatt g, int mtu, int status) {
            // 设备会在 notify 里发 mtu=N（以此为准），这里仅记录
        }

        @Override public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            PushJob j = job;
            if (j != null && c.getUuid().equals(EPD_UUID)) {
                j.index++;
                work.post(new Runnable() { @Override public void run() { pushNext(); } });
            }
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
            byte[] data = c.getValue();
            if (data == null || data.length == 0) return;
            if (msgIndex == 0) {
                // 设备自报配置（byte0-6 引脚 / byte7 驱动）
                StringBuilder pins = new StringBuilder();
                for (int i = 0; i < 7 && i < data.length; i++)
                    pins.append(String.format("%02x", data[i]));
                if (data.length > 10) pins.append(String.format("%02x", data[10]));
                log("设备配置: pins=" + pins + (data.length > 7
                        ? " driver=" + String.format("%02x", data[7]) : ""));
            } else {
                StringBuilder sb = new StringBuilder();
                for (byte b : data) sb.append((char) (b & 0xFF));
                String msg = sb.toString();
                if (msg.startsWith("mtu=") && msg.length() > 4) {
                    try { mtu = Integer.parseInt(msg.substring(4).replaceAll("[^0-9].*$", "")); } catch (Exception ignored) {}
                    log("MTU=" + mtu);
                } else if (msg.startsWith("ble=")) {
                    String on = msg.substring(4).trim();
                    emit("ble", "1".equals(on) ? "1" : "0");
                    log("蓝牙模式: " + ("1".equals(on) ? "常开" : "常关"));
                }
            }
            msgIndex++;
        }
    };

    // ============ 黑白快刷开关 ============

    /** 快刷模式（默认开，用户定：优先低延时；关闭=三色全刷约 15s） */
    public boolean isFastMode() {
        return appContext != null
                && appContext.getSharedPreferences("eink", Context.MODE_PRIVATE).getBoolean("fast", true);
    }

    public void setFastMode(boolean on) {
        appContext.getSharedPreferences("eink", Context.MODE_PRIVATE)
                .edit().putBoolean("fast", on).apply();
        log(on ? "快刷模式：开（黑白 2-3 秒，无红色）" : "快刷模式：关（三色全刷约 15 秒）");
    }

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
     * @param immediate true=立即推送（立即推送按钮）；false=走 10s 节流（自动推送）
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
        boolean fast = isFastMode();
        Bitmap bmp = EinkTagRenderer.render(d, fast);
        int chunkSize = Math.max(18, mtu - 2);
        java.util.List<byte[]> chunks = new java.util.ArrayList<>();
        java.util.List<Boolean> resp = new java.util.ArrayList<>();
        if (fast) {
            // 黑白快刷：INIT(BW 模型) → 寄存器(PSR/CDI/LUT) → 单张黑白面 → REFRESH
            byte[] mono = quantizeBW(bmp);
            chunks.add(new byte[]{(byte) CMD_INIT, (byte) MODEL_UC8176_420_BW}); resp.add(true);
            chunks.add(new byte[]{(byte) CMD_SEND_CMD, 0x00}); resp.add(true);
            chunks.add(new byte[]{(byte) CMD_SEND_DATA, (byte) PSR_BW}); resp.add(true);
            chunks.add(new byte[]{(byte) CMD_SEND_CMD, 0x50}); resp.add(true);
            chunks.add(new byte[]{(byte) CMD_SEND_DATA, (byte) CDI_BW}); resp.add(true);
            byte[][] luts = {BW_LUTC, BW_LUTWW, BW_LUTBW, BW_LUTWB, BW_LUTBB};
            for (int t = 0; t < luts.length; t++) {
                chunks.add(new byte[]{(byte) CMD_SEND_CMD, (byte) (0x20 + t)}); resp.add(true);
                for (int off = 0; off < luts[t].length; off += chunkSize) {
                    int len = Math.min(chunkSize, luts[t].length - off);
                    byte[] blk = new byte[1 + len];
                    blk[0] = (byte) CMD_SEND_DATA;   // 同一寄存器下连续 SEND_DATA 分块续写
                    System.arraycopy(luts[t], off, blk, 1, len);
                    chunks.add(blk); resp.add(true);
                }
            }
            addImageBlocks(chunks, resp, mono, chunkSize, false);
        } else {
            // 三色全刷：INIT 重置快刷残留的 PSR/LUT，两平面照旧
            byte[][] planes = quantize(bmp);
            chunks.add(new byte[]{(byte) CMD_INIT, (byte) MODEL_UC8176_420_BWR}); resp.add(true);
            addImageBlocks(chunks, resp, planes[0], chunkSize, false);
            addImageBlocks(chunks, resp, planes[1], chunkSize, true);
        }
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

    /** 黑白量化：单张 1bpp（红像素灰度 ~106-120 < 140，自然落黑） */
    private static byte[] quantizeBW(Bitmap bmp) {
        int w = bmp.getWidth(), h = bmp.getHeight();
        int byteWidth = (w + 7) / 8;
        int[] px = new int[w * h];
        bmp.getPixels(px, 0, w, 0, 0, w, h);
        byte[] mono = new byte[h * byteWidth];
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int c = px[y * w + x];
                int gray = (299 * ((c >> 16) & 0xFF) + 587 * ((c >> 8) & 0xFF) + 114 * (c & 0xFF)) / 1000;
                if (gray >= 140) mono[y * byteWidth + x / 8] |= (byte) (1 << (7 - (x % 8)));
            }
        }
        return mono;
    }

    /**
     * 图像面打包为 WRITE_IMG 块序列。标志位（固件 EPD_service.c 解析）：
     * bit0=0 黑面/1 红面，bit1=1 首块，bit2=1 RLE（我们不压缩，恒 0）。
     * ⚠️ 黑面首块 0x02/后续 0x00、红面首块 0x03/后续 0x01 ——
     * 不可用旧式 0x0F/0xFF（bit2=1 会被新版固件误判为 RLE 数据）。
     */
    private static void addImageBlocks(java.util.List<byte[]> out, java.util.List<Boolean> resp,
                                       byte[] data, int chunkSize, boolean red) {
        int firstFlag = red ? 0x03 : 0x02;
        int nextFlag = red ? 0x01 : 0x00;
        for (int off = 0, i = 0; off < data.length || i == 0; off += chunkSize, i++) {
            int len = Math.min(chunkSize, data.length - off);
            byte[] blk = new byte[1 + len];
            blk[0] = (byte) (off == 0 ? firstFlag : nextFlag);
            System.arraycopy(data, off, blk, 1, len);
            out.add(blk);
            resp.add(i % 50 == 49);   // 每 50 块要一次回执
            if (off >= data.length) break; // 空面（全红等极端）保护
        }
    }

    /** 逐块状态机：onCharacteristicWrite 回调驱动 */
    @SuppressLint("MissingPermission")
    private void pushNext() {
        PushJob j = job;
        if (j == null || j.cancelled) return;
        if (j.index >= j.chunks.length) {
            job = null;
            writeCmd(CMD_REFRESH);
            log("推送完成");
            emit("push-status", "done");
            return;
        }
        if (gatt == null || epdChar == null) { job = null; log("连接断开，推送中止"); return; }
        byte[] blk = j.chunks[j.index];
        epdChar.setValue(blk);
        epdChar.setWriteType(j.resp[j.index]
                ? BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT        // 控制块/每 50 块要回执
                : BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
        boolean ok = gatt.writeCharacteristic(epdChar);
        if (!ok) {
            // 写入排队失败：稍后重试当前块
            work.postDelayed(new Runnable() { @Override public void run() { pushNext(); } }, 50);
        }
        // NO_RESPONSE 写无回调保障：兜底定时推进（正常时 onCharacteristicWrite 先到并推进，
        // 本定时器发现 index 已推进则不做任何事）
        final int expect = j.index;
        work.postDelayed(new Runnable() {
            @Override public void run() {
                PushJob jj = job;
                if (jj != null && !jj.cancelled && jj.index == expect) {
                    jj.index++;
                    pushNext();
                }
            }
        }, 40);
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
}
