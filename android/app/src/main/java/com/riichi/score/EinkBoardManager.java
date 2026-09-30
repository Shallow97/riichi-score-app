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
 *  - 传图：INIT(0x01) → WRITE_IMG(0x30) 黑白面 → 红面 → REFRESH(0x05)
 *    无 RLE 标志位：黑白首块 0x0F / 后续 0xFF，红面首块 0x00 / 后续 0xF0
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
    private static final long THROTTLE_MS = 10_000;   // 自动推送节流
    private static final long SCAN_PERIOD_MS = 6_000; // 扫描时长
    private static final int MAX_RECONNECT = 5;

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
        byte[][] chunks;   // 全部块（含标志字节）
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
        Bitmap bmp = EinkTagRenderer.render(d);
        byte[][] planes = quantize(bmp);
        PushJob j = new PushJob();
        j.chunks = buildChunks(planes[0], planes[1]);
        job = j;
        emit("push-status", "start");
        writeCmd(CMD_INIT);
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

    /** 两面打包为 WRITE_IMG 块序列：每块 = [标志字节, 数据...]，块数据 = mtu-2 字节 */
    private byte[][] buildChunks(byte[] bw, byte[] red) {
        int chunkSize = Math.max(18, mtu - 2);
        java.util.List<byte[]> out = new java.util.ArrayList<>();
        for (int plane = 0; plane < 2; plane++) {
            byte[] data = plane == 0 ? bw : red;
            int firstFlag = plane == 0 ? 0x0F : 0x00;   // 黑白首块 0x0F / 红面首块 0x00
            int nextFlag = plane == 0 ? 0xFF : 0xF0;    // 后续 0xFF / 0xF0
            for (int off = 0, i = 0; off < data.length || i == 0; off += chunkSize, i++) {
                int len = Math.min(chunkSize, data.length - off);
                byte[] blk = new byte[1 + len];
                blk[0] = (byte) (off == 0 ? firstFlag : nextFlag);
                System.arraycopy(data, off, blk, 1, len);
                out.add(blk);
                if (off >= data.length) break; // 空面（全红等极端）保护
            }
        }
        return out.toArray(new byte[0][]);
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
        epdChar.setWriteType(j.index % 50 == 49
                ? BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT        // 每 50 块要一次回执
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
