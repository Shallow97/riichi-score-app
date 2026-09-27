package com.riichi.score;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * ServerService — 前台服务，承担房主手机的服务器职责。
 *
 * 作用：
 *  1. 持有 PARTIAL_WAKE_LOCK：锁屏后 CPU 仍运行（屏幕可关闭、省电），
 *     使 RiichiServer 在后台持续服务，房主手机无需保持亮屏。
 *  2. 启动 / 停止内嵌的 RiichiServer（纯 Java HTTP+WebSocket，监听 8765）。
 *  3. 以"前台服务"形式运行，降低被系统回收的概率，并显示常驻通知。
 *
 * 前台服务 + PARTIAL_WAKE_LOCK 是本需求（"房主手机锁屏后服务器仍工作"）的关键。
 */
public class ServerService extends Service {

    public static final String ACTION_START = "com.riichi.score.START";
    public static final String ACTION_STOP  = "com.riichi.score.STOP";

    private static final String CHANNEL_ID = "riichi_server";
    private static final int NOTIF_ID = 1;

    private RiichiServer server;
    private PowerManager.WakeLock wakeLock;

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
        startServer();
        return START_STICKY; // 若被系统杀死，尽量重启
    }

    private void startServer() {
        if (server != null && server.isRunning()) return;
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
        });
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
