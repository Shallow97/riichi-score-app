package com.riichi.score;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * ServerService — 前台服务，承担房主手机的服务器职责。
 *
 * 作用：
 *  1. 持有 PARTIAL_WAKE_LOCK：锁屏后 CPU 仍运行（屏幕可关闭、省电），
 *     使 RiichiServer 在后台持续服务，房主手机无需保持亮屏。
 *  2. 持有 WifiLock：锁屏后 Wi-Fi 射频不休眠，TCP/WebSocket 连接不被断开。
 *     ⚠️ 只持 WakeLock 是不够的 —— 它仅保 CPU，息屏后系统仍可能让 Wi-Fi 进入
 *        省电/休眠状态，导致成员在房主锁屏时被踢下线。二者必须同时持有。
 *  3. 启动 / 停止内嵌的 RiichiServer（纯 Java HTTP+WebSocket，监听 8765）。
 *  4. 以"前台服务"形式运行，降低被系统回收的概率，并显示常驻通知。
 *
 * 前台服务 + PARTIAL_WAKE_LOCK + WifiLock 是本需求（"房主手机锁屏后服务器仍工作"）的关键。
 */
public class ServerService extends Service {

    public static final String ACTION_START = "com.riichi.score.START";
    public static final String ACTION_STOP  = "com.riichi.score.STOP";

    private static final String CHANNEL_ID = "riichi_server";
    private static final int NOTIF_ID = 1;

    private RiichiServer server;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        try {
            startForeground(NOTIF_ID, buildNotification());
        } catch (Exception e) {
            // 某些机型/状态下前台服务启动失败（如通知权限、厂商限制），
            // 捕获后服务仍可后台运行，避免崩溃。
            android.util.Log.e("RiichiScore", "startForeground 失败", e);
        }
        acquireWakeLock();
        acquireWifiLock();
        startServer();
        return START_STICKY; // 若被系统杀死，尽量重启
    }

    private void startServer() {
        if (server != null && server.isRunning()) return;
        // 权威态落盘到 filesDir：房主进程被杀/重启后仍能恢复分数与局数，成员重连回来接着打
        java.io.File stateFile = new java.io.File(getFilesDir(), "room_state.json");
        server = new RiichiServer(getAssets(), new RiichiServer.Listener() {
            @Override
            public void onStarted(String ip, int port) {
                // 服务已在本机 8765 启动；房主 WebView 加载 http://127.0.0.1:8765/?host=1
            }

            @Override
            public void onError(String message) {
            }

            @Override
            public void onMemberCount(int count) {
                updateNotification(count);
            }
        }, stateFile);
        server.start();
    }

    private void acquireWakeLock() {
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            // PARTIAL_WAKE_LOCK：仅保持 CPU 运行，屏幕可关闭 → 省电且不中断服务器
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "riichi:server");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
        }
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
            wakeLock = null;
        }
    }

    /**
     * 持有 Wi-Fi 锁：息屏后保持 Wi-Fi 射频工作，避免成员被踢下线。
     *
     * 模式选择：
     *  - API 29(Q)+ ：WIFI_MODE_FULL_LOW_LATENCY（HIGH_PERF 自 Q 起已废弃，这是官方替代）
     *  - API 29 以下：WIFI_MODE_FULL_HIGH_PERF
     * 两者语义一致：保持收音链路 + 高性能，代价是耗电增加，本场景可接受。
     */
    private void acquireWifiLock() {
        try {
            WifiManager wm = (WifiManager) getApplicationContext()
                    .getSystemService(Context.WIFI_SERVICE);
            if (wm == null) return;
            int mode = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
                    ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                    : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
            wifiLock = wm.createWifiLock(mode, "riichi:server-wifi");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
        } catch (Exception e) {
            // 部分机型/权限受限时获取失败：仅退化为"不保 Wi-Fi"，不影响服务器运行
            android.util.Log.e("RiichiScore", "Wi-Fi 锁获取失败", e);
            wifiLock = null;
        }
    }

    private void releaseWifiLock() {
        if (wifiLock != null && wifiLock.isHeld()) {
            wifiLock.release();
        }
        wifiLock = null;
    }

    private void createChannel() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "日麻计分服务器", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
    }

    private Notification buildNotification() {
        Intent i = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(
                this, 0, i, PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL_ID)
                .setContentTitle("日麻计分 · 服务器运行中")
                .setContentText("其他玩家输入本机 IP:8765 即可加入 · 锁屏后仍可继续服务")
                .setSmallIcon(android.R.drawable.ic_menu_manage)
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
    }

    private void updateNotification(int count) {
        try {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) {
                Notification n = new Notification.Builder(this, CHANNEL_ID)
                        .setContentTitle("日麻计分 · 服务器运行中")
                        .setContentText("已连接 " + count + " 台设备 · 输入本机 IP:8765 加入")
                        .setSmallIcon(android.R.drawable.ic_menu_manage)
                        .setOngoing(true)
                        .build();
                nm.notify(NOTIF_ID, n);
            }
        } catch (Exception ignored) {}
    }

    @Override
    public void onDestroy() {
        releaseWakeLock();
        releaseWifiLock();
        if (server != null) {
            server.stop();
            server = null;
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
