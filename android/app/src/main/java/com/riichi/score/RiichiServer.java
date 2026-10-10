package com.riichi.score;

import android.content.res.AssetManager;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArraySet;

/**
 * RiichiServer — 内嵌 HTTP + WebSocket 服务器（纯 Java，零第三方依赖）
 *
 * ⚠️ 本文件必须与 prototype/serve.js **逐条同步**：两者是同一份协议的两个实现
 *    （电脑端跑 serve.js，手机房主端跑本文件）。协议不一致会让电脑端联机行为与真机不同，
 *    也会让 tests/java-server-parity.js 的镜像服务器失真。
 *
 * 模型：单房间 + 操作权互斥（全员协作）+ 全提交制
 *  - 房主手机启动本服务器，监听 8765。
 *  - 房主 WebView 访问 http://127.0.0.1:8765/?host=1 → 识别为房主(host)。
 *  - 其他玩家浏览器访问 http://<房主IP>:8765/ → 识别为成员(member)。
 *  - **服务器是唯一账本**：任何端（含房主）的变更都要 commit 上行，服务器校验 baseSeq、
 *    幂等去重后落库并广播，客户端收到 ack 才渲染/持久化。
 *  - 房主链路断开：**保留房间**（成员可继续结算），只广播 host-offline。
 *  - 双向心跳（20s 服务端 ping / 客户端 10s ping）+ 读空闲看门狗：手机息屏/换网造成的
 *    半开连接既不报错也不关闭，只能靠心跳发现并清理（否则操作权槽位会被死连接占死）。
 *  - 权威态落盘：进程被杀/重启后能恢复分数与局数，成员重连回来接着打。
 *
 * 消息协议（WebSocket JSON）v2：
 *  客户端→服务器：
 *    {type:'set-name', name}
 *    {type:'request-action', name}
 *    {type:'release-action'}
 *    {type:'commit', opId, baseSeq, state}
 *    {type:'game-end', record}
 *    {type:'ping', ts} / {type:'pong', ts}
 *    {type:'leave-room'}
 *    {type:'push-tag', immediate, data}
 *  服务器→客户端：
 *    {type:'welcome', role, state, seq, operator, hostOnline, hostSeen, members?}
 *                                        // members 只下发给房主（成员端不感知设备数）
 *    {type:'state', state, seq}
 *    {type:'ack', opId, seq} / {type:'conflict', opId, seq, state, reason}
 *    {type:'game-end', record}
 *    {type:'action-granted'} / {type:'action-denied', by} / {type:'operator-change', name}
 *    {type:'member-count', count}       // 只发给房主
 *    {type:'host-offline'} / {type:'host-online'}
 *    {type:'ping', ts} / {type:'pong', ts}
 */
public class RiichiServer {

    public interface Listener {
        void onStarted(String ip, int port);
        void onError(String message);
        void onMemberCount(int count); // 成员数（含房主），用于 UI
    }

    private static final int PORT = 8765;

    // —— 心跳参数（与 serve.js 保持一致）——
    private static final long HB_INTERVAL_MS = 20000;  // 服务器每 20s 向所有连接发 ping
    private static final long HB_CHECK_MS = 5000;      // 死链检查周期
    // 超过这么久没收到任何消息 → 断定为死链并断开（顺带释放它占着的操作权）。
    // 取 75s（≈3 个 ping 周期）：手机后台/息屏会把网页定时器降频到分钟级，
    // 余量太小会把"活着但被降频"的客户端误杀。
    // ⚠️ 只对成员生效；房主连接豁免（见 startHeartbeat 里的说明）。
    private static final long HB_TIMEOUT_MS = 75000;
    // 操作权租约：持有者超过这么久没有任何上行消息 → 释放操作权（**不 close 连接**）。
    // 房主连接豁免了死链看门狗，页面被系统挂起（锁屏 / 切后台）时链路仍是活的、
    // 只是客户端再也发不出消息 —— 不回收就会把槽位永久占死，全桌结算/立直按钮一直灰着。
    // 取值依据同 serve.js（45s：可见时每 10s 有一次上行，息屏后心跳拉长到 75s 以上）。
    private static final long OP_LEASE_MS = 45000;
    private static final int OP_LOG_MAX = 128;         // 幂等去重保留的最近提交编号条数

    private final AssetManager assets;
    private final Listener listener;
    /** 权威态落盘文件（可空：为空则不持久化）。由 ServerService / MainActivity 传入 filesDir 下的文件。 */
    private final File stateFile;
    private ServerSocket serverSocket;
    private volatile boolean running = false;
    private Thread acceptThread;
    private Thread heartbeatThread;

    // 单房间状态
    private final Room room = new Room();

    /**
     * 房间生命周期互斥锁。Java 端"一个连接一个线程"，而"新连接取代旧房主"（onConnected）
     * 与"旧连接断开清理"（onDisconnected，跑在旧连接自己的线程里）是两个线程，
     * 必须互斥，否则会交错出两种事故：
     *   1. 旧房主的 onDisconnected 抢在 room.host = 新连接 之前执行 → 把 room.host 清成
     *      null 并广播 host-offline，成员横幅凭空闪一下（随后又收到 host-online）；
     *   2. 更糟：若交错顺序相反，还可能让新上任的房主被误判成"已断开"，房间失去房主。
     * 注意锁序：只允许 roomLock → this（persistState 是 synchronized 方法），
     * start()/stop() 只持 this、不再取 roomLock，故不会成环。
     */
    private final Object roomLock = new Object();

    private static class Room {
        volatile ClientConn host = null;              // 房主连接
        final Set<ClientConn> members = new CopyOnWriteArraySet<>(); // 成员连接（不含房主）
        volatile String state = null;                 // 权威状态（序列化）
        volatile long seq = 0;                        // 权威态版本号（每次成功提交 +1）
        volatile ClientConn operator = null;          // 当前操作者
        volatile boolean hostSeen = false;            // 本房间是否曾有过房主（区分"房主离开/房主还没进来"）
        // 幂等去重：opId → 该次提交后的 seq。回执丢失后客户端重发不会重复入账。
        final LinkedHashMap<String, Long> opLog = new LinkedHashMap<>();
    }

    public RiichiServer(AssetManager assets, Listener listener) {
        this(assets, listener, null);
    }

    public RiichiServer(AssetManager assets, Listener listener, File stateFile) {
        this.assets = assets;
        this.listener = listener;
        this.stateFile = stateFile;
    }

    public synchronized void start() {
        if (running) return;
        running = true;
        loadPersistedState();
        acceptThread = new Thread(() -> {
            try {
                serverSocket = new ServerSocket(PORT);
                // 通知启动成功（监听任意网卡）
                if (listener != null) listener.onStarted(getLocalIp(), PORT);
                // 端口就绪后再恢复落盘的房间状态：先起来的客户端一连接就能看到
                while (running) {
                    Socket socket = serverSocket.accept();
                    handleClient(socket);
                }
            } catch (IOException e) {
                if (running && listener != null) listener.onError(e.getMessage());
            }
        }, "riichi-server-accept");
        acceptThread.start();
        startHeartbeat();
    }

    public synchronized void stop() {
        running = false;
        try { if (serverSocket != null) serverSocket.close(); } catch (IOException ignored) {}
        room.host = null;
        room.members.clear();
        room.operator = null;
    }

    public boolean isRunning() { return running; }
    public int getPort() { return PORT; }
    public int getMemberCount() { return (room.host != null ? 1 : 0) + room.members.size(); }

    // ================================================================
    // 权威态落盘 / 恢复
    // ================================================================
    private void loadPersistedState() {
        if (stateFile == null || !stateFile.exists()) return;
        try {
            byte[] b = java.nio.file.Files.readAllBytes(stateFile.toPath());
            String json = new String(b, StandardCharsets.UTF_8);
            long s = jsonNum(json, "seq");
            String st = jsonStr(json, "state");
            room.seq = s > 0 ? s : 0;
            room.state = (st == null || st.isEmpty()) ? null : st;
            android.util.Log.d("RiichiServer", "恢复房间状态 seq=" + room.seq
                    + " stateLen=" + (room.state == null ? 0 : room.state.length()));
        } catch (Exception e) {
            android.util.Log.e("RiichiServer", "恢复房间状态失败", e);
        }
    }

    /** 落盘（先写 .tmp 再改名，避免掉电写坏文件）。每次成功提交/结束后调用，文件很小。 */
    private synchronized void persistState() {
        if (stateFile == null) return;
        try {
            String json = "{\"seq\":" + room.seq + ",\"state\":"
                    + (room.state != null ? "\"" + escapeJson(room.state) + "\"" : "null") + "}";
            File tmp = new File(stateFile.getAbsolutePath() + ".tmp");
            try (FileOutputStream fo = new FileOutputStream(tmp)) {
                fo.write(json.getBytes(StandardCharsets.UTF_8));
                fo.flush();
            }
            if (!tmp.renameTo(stateFile)) {
                java.nio.file.Files.move(tmp.toPath(), stateFile.toPath(),
                        java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (Exception e) {
            android.util.Log.e("RiichiServer", "落盘房间状态失败", e);
        }
    }

    // 显示给房主的 IP（供其他玩家输入）。
    // 必须与 MainActivity.getLocalIpv4() 口径一致：优先 wlan/eth/en/ap 接口，
    // 否则双开网络（Wi-Fi + 蜂窝）或存在虚拟网卡时会给出其他手机连不上的地址。
    private String getLocalIp() {
        try {
            String wifi = null;
            String priv = null;
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
                    if (niName.startsWith("wlan") || niName.startsWith("eth")
                            || niName.startsWith("en") || niName.startsWith("ap")) wifi = ip;
                    if (priv == null && (ip.startsWith("192.168.") || ip.startsWith("10.")
                            || ip.startsWith("172."))) priv = ip;
                }
            }
            if (wifi != null) return wifi;
            if (priv != null) return priv;
        } catch (Exception ignored) {}
        return "127.0.0.1";
    }

    // ================================================================
    // 心跳：周期 ping + 读空闲看门狗
    // ================================================================
    private void startHeartbeat() {
        heartbeatThread = new Thread(() -> {
            long lastPing = 0;
            long lastCheck = 0;
            while (running) {
                try { Thread.sleep(1000); } catch (InterruptedException e) { break; }
                long now = System.currentTimeMillis();
                if (now - lastPing >= HB_INTERVAL_MS) {
                    lastPing = now;
                    String ping = "{\"type\":\"ping\",\"ts\":" + now + "}";
                    for (ClientConn c : allConns()) send(c, ping);
                }
                if (now - lastCheck >= HB_CHECK_MS) {
                    lastCheck = now;
                    for (ClientConn c : allConns()) {
                        // ⚠️ 房主连接豁免应用层空闲看门狗：房主页面就跑在服务器本机
                        //（127.0.0.1 回环）。手机锁屏 / 切后台时 WebView 会挂起页面的
                        // 任务投递，页面既收不到 ping、也回不出 pong，但 TCP 链路本身
                        // 是活的 —— 真断开（WebView 销毁 / 进程退出）会让阻塞 read 返回
                        // -1，走 onDisconnected 立即清理，不需要靠超时兜底。
                        // 若照常判死，房主一锁屏就被踢下线，而且隐藏中的页面连
                        // "我已掉线"都察觉不到（真机实测：整段锁屏期间成员一直看到房主离线）。
                        if (c == room.host) continue;
                        // 半开连接：TCP 不会报错也不会关闭，只能靠"久久没收到任何消息"判定
                        if (now - c.lastSeen > HB_TIMEOUT_MS) {
                            android.util.Log.d("RiichiServer", "心跳超时，断开连接 host=" + c.isHost);
                            c.close();
                        }
                    }
                    // 操作权租约：持有者长时间无任何上行消息 → 释放槽位（不 close 连接）。
                    // 房主连接被系统挂起（锁屏/后台）时不会走 onDisconnected，只能靠这里回收。
                    // 安全：换人必然伴随一条 request-action，其 lastSeen 刚刷新，不会误清新槽位。
                    ClientConn op = room.operator;
                    if (op != null && now - op.lastSeen > OP_LEASE_MS && room.operator == op) {
                        android.util.Log.d("RiichiServer", "操作权租约到期，释放槽位");
                        room.operator = null;
                        broadcastOperator();
                    }
                }
            }
        }, "riichi-heartbeat");
        heartbeatThread.start();
    }

    private java.util.List<ClientConn> allConns() {
        java.util.List<ClientConn> list = new java.util.ArrayList<>();
        ClientConn h = room.host;
        if (h != null) list.add(h);
        list.addAll(room.members);
        return list;
    }

    // ================================================================
    // 客户端连接处理
    // ================================================================
    private void handleClient(Socket socket) {
        new Thread(() -> {
            try {
                // 读超时为 0（阻塞读）：帧解析必须拿到完整一帧，中途超时会破坏协议。
                // 断线检测改由心跳看门狗负责（见 startHeartbeat），它 close 掉连接后
                // 阻塞的 read 会抛异常，从而走到 onDisconnected 完成清理。
                socket.setSoTimeout(0);
                InputStream in = new BufferedInputStream(socket.getInputStream());
                OutputStream out = socket.getOutputStream();
                // 读取 HTTP 请求头
                HttpRequest req = readHttpRequest(in);
                android.util.Log.d("RiichiServer", "收到请求 method=" + req.method + " path=" + req.path + " ws=" + req.isWebSocket());
                boolean isHost = req.isHost();
                if (req.isWebSocket()) {
                    // WebSocket 握手
                    String accept = wsAccept(req.getHeader("Sec-WebSocket-Key"));
                    out.write(("HTTP/1.1 101 Switching Protocols\r\n" +
                            "Upgrade: websocket\r\n" +
                            "Connection: Upgrade\r\n" +
                            "Sec-WebSocket-Accept: " + accept + "\r\n\r\n")
                            .getBytes(StandardCharsets.UTF_8));
                    out.flush();
                    ClientConn conn = new ClientConn(socket, out, isHost);
                    onConnected(conn);
                    try {
                        wsLoop(in, conn);
                    } finally {
                        onDisconnected(conn);
                    }
                } else {
                    // 普通 HTTP 请求（静态资源）
                    serveStatic(req.getPath(), out);
                }
            } catch (IOException ignored) {
            } finally {
                try { socket.close(); } catch (IOException ignored) {}
            }
        }, "riichi-client").start();
    }

    // ================================================================
    // 连接生命周期
    // ================================================================
    private void onConnected(ClientConn conn) {
        ClientConn prevHostToClose = null;
        synchronized (roomLock) {
            if (conn.isHost) {
                // 若有旧房主（页面刷新/重连），先摘掉它的槽位
                ClientConn prev = room.host;
                boolean clearedOperator = false;
                if (prev != null && prev != conn) {
                    room.members.remove(prev);
                    // 换房主时必须一并释放旧连接持有的操作权：
                    // 旧版只换 room.host，槽位仍指向死连接 → 成员申请操作权被永久拒绝。
                    if (room.operator == prev) { room.operator = null; clearedOperator = true; }
                    prevHostToClose = prev;   // 实际关闭放到锁外（见下）
                }
                boolean wasOffline = (room.host == null);
                room.host = conn;
                room.hostSeen = true;
                sendWelcome(conn, true);
                if (wasOffline) {
                    for (ClientConn m : room.members) send(m, "{\"type\":\"host-online\"}");
                }
                // 释放了槽位必须广播出去：否则成员端 operatorName() 仍是旧名字，
                // 结算/立直按钮会一直灰着（判定条件是「无人占权 或 本机持权」）。
                if (wasOffline || clearedOperator) broadcastOperator();
            } else {
                room.members.add(conn);
                sendWelcome(conn, false);
            }
            notifyMemberCount();
        }
        // 关闭旧连接放到锁外，且此时 room.host 已指向新连接：
        // 旧连接的 onDisconnected 无论何时跑，都会因 conn != room.host 而只做成员侧幂等清理，
        // 既不会把刚上任的新房主清成 null，也不会多播一次 host-offline。
        if (prevHostToClose != null) prevHostToClose.close();
    }

    /** 对新连接全量下发：角色 + 权威态 + 版本号 + 当前操作者。房主重连也走这条（旧版 room-created 不带 state）。 */
    private void sendWelcome(ClientConn conn, boolean isHost) {
        StringBuilder sb = new StringBuilder(256);
        sb.append("{\"type\":\"welcome\",\"role\":\"").append(isHost ? "host" : "member").append("\"");
        sb.append(",\"state\":").append(room.state != null ? "\"" + escapeJson(room.state) + "\"" : "null");
        sb.append(",\"seq\":").append(room.seq);
        sb.append(",\"operator\":").append(operatorJson());
        sb.append(",\"hostOnline\":").append(room.host != null);
        sb.append(",\"hostSeen\":").append(room.hostSeen);
        // 设备数只下发给房主：成员端不感知也不展示全屋设备数（B 项）
        if (isHost) sb.append(",\"members\":").append(getMemberCount());
        sb.append("}");
        send(conn, sb.toString());
    }

    /**
     * 连接清理（幂等）。房主断开时**不**解散房间（成员可继续结算），只广播 host-offline。
     */
    private void onDisconnected(ClientConn conn) {
        synchronized (roomLock) {
            if (conn.cleaned) return;
            conn.cleaned = true;
            if (conn == room.host) {
                room.host = null;
                boolean wasOperator = (room.operator == conn);
                if (wasOperator) room.operator = null;
                for (ClientConn m : room.members) send(m, "{\"type\":\"host-offline\"}");
                if (wasOperator) broadcastOperator();
                notifyMemberCount();
                return;
            }
            if (room.members.remove(conn)) {
                if (room.operator == conn) { room.operator = null; broadcastOperator(); }
                notifyMemberCount();
            }
        }
    }

    /**
     * 设备数变更通知。⚠️ **只发给房主**：成员端不感知也不展示全屋设备数（B 项），
     * 旧版注释写"广播"但实际只 send(room.host)，曾因此让人误以为成员端也应该收到。
     */
    private void notifyMemberCount() {
        int count = getMemberCount();
        if (listener != null) listener.onMemberCount(count);
        if (room.host != null) send(room.host, "{\"type\":\"member-count\",\"count\":" + (count - 1) + "}");
    }

    private void broadcastOperator() {
        String name = room.operator != null ? room.operator.name : null;
        String json = "{\"type\":\"operator-change\",\"name\":" + (name != null ? "\"" + escapeJson(name) + "\"" : "null") + "}";
        for (ClientConn m : room.members) send(m, json);
        if (room.host != null) send(room.host, json);
    }

    /** 把最新权威态广播给"除提交者之外"的所有端 */
    private void broadcastStateExcept(ClientConn except) {
        String json = "{\"type\":\"state\",\"state\":"
                + (room.state != null ? "\"" + escapeJson(room.state) + "\"" : "null")
                + ",\"seq\":" + room.seq + "}";
        for (ClientConn m : room.members) if (m != except) send(m, json);
        if (room.host != null && room.host != except) send(room.host, json);
    }

    // ================================================================
    // WebSocket 消息循环
    // ================================================================
    private void wsLoop(InputStream in, ClientConn conn) throws IOException {
        while (running) {
            Frame frame = readFrame(in);
            if (frame == null) break;                 // 连接结束（EOF / close 帧）
            conn.lastSeen = System.currentTimeMillis();  // 任何一帧都算"活着"（含 pong）
            if (frame.opcode == OP_PING) {            // 协议级 ping → 回 pong（浏览器不会主动发，防御性）
                sendFrame(conn, OP_PONG, frame.payload);
                continue;
            }
            if (frame.opcode == OP_PONG) continue;
            if (frame.opcode != OP_TEXT) continue;    // 二进制帧忽略
            String text = new String(frame.payload, StandardCharsets.UTF_8);
            handleMessage(conn, text);
        }
    }

    private void handleMessage(ClientConn conn, String raw) {
        String type = jsonStr(raw, "type");
        if (type == null) return;
        switch (type) {
            case "set-name": {
                String name = jsonStr(raw, "name");
                conn.name = name;
                break;
            }
            case "ping": {
                long ts = jsonNum(raw, "ts");
                send(conn, ts >= 0 ? "{\"type\":\"pong\",\"ts\":" + ts + "}" : "{\"type\":\"pong\"}");
                break;
            }
            case "pong":
                break;   // lastSeen 已在 wsLoop 更新
            case "request-action": {
                if (room.operator != null && room.operator != conn) {
                    String by = room.operator.name != null ? room.operator.name : "其他玩家";
                    send(conn, "{\"type\":\"action-denied\",\"by\":\"" + escapeJson(by) + "\"}");
                } else {
                    room.operator = conn;
                    String name = jsonStr(raw, "name");
                    if (name != null) conn.name = name;
                    send(conn, "{\"type\":\"action-granted\"}");
                    broadcastOperator();
                }
                break;
            }
            case "release-action": {
                if (room.operator == conn) {
                    room.operator = null;
                    broadcastOperator();
                }
                break;
            }
            case "commit": {
                String opId = jsonStr(raw, "opId");
                // 只有房主或当前操作者能提交
                if (conn != room.host && room.operator != conn) {
                    send(conn, "{\"type\":\"conflict\",\"opId\":" + jsonStrOrNull(opId)
                            + ",\"seq\":" + room.seq + ",\"state\":"
                            + (room.state != null ? "\"" + escapeJson(room.state) + "\"" : "null")
                            + ",\"reason\":\"denied\"}");
                    break;
                }
                // 幂等：同一 opId 重复提交只回 ack，不重复入账
                if (opId != null) {
                    Long prev;
                    synchronized (room.opLog) { prev = room.opLog.get(opId); }
                    if (prev != null) {
                        send(conn, "{\"type\":\"ack\",\"opId\":\"" + escapeJson(opId) + "\",\"seq\":" + prev + "}");
                        break;
                    }
                }
                long baseSeq = jsonNum(raw, "baseSeq");
                if (baseSeq < 0) baseSeq = room.seq;
                if (baseSeq != room.seq) {
                    send(conn, "{\"type\":\"conflict\",\"opId\":" + jsonStrOrNull(opId)
                            + ",\"seq\":" + room.seq + ",\"state\":"
                            + (room.state != null ? "\"" + escapeJson(room.state) + "\"" : "null")
                            + ",\"reason\":\"stale\"}");
                    break;
                }
                String state = jsonStr(raw, "state");
                room.state = state;
                room.seq += 1;
                if (opId != null) {
                    synchronized (room.opLog) {
                        room.opLog.put(opId, room.seq);
                        while (room.opLog.size() > OP_LOG_MAX) {
                            java.util.Iterator<String> it = room.opLog.keySet().iterator();
                            if (it.hasNext()) { it.next(); it.remove(); }
                        }
                    }
                }
                persistState();
                send(conn, "{\"type\":\"ack\",\"opId\":" + jsonStrOrNull(opId) + ",\"seq\":" + room.seq + "}");
                broadcastStateExcept(conn);
                break;
            }
            case "game-end": {
                // 房主结束对局：把归档记录（序列化字符串）广播给所有成员，成员据此同步结束并跳转历史页。
                // 同时清空权威态（对局已归档，之后加入的成员不应再看到这局）。
                if (conn == room.host) {
                    String record = jsonStr(raw, "record");
                    String json = "{\"type\":\"game-end\",\"record\":" + (record != null ? "\"" + escapeJson(record) + "\"" : "null") + "}";
                    for (ClientConn m : room.members) send(m, json);
                    room.state = null;
                    room.seq += 1;
                    persistState();
                    broadcastStateExcept(null);
                }
                break;
            }
            case "push-tag": {
                // 场风盘蓝牙推送请求：JS 在立直宣言/取消、局结算后发出（含渲染所需精简 data）。
                // 立即推送（immediate=true，立即推送按钮）与自动推送（1s 节流在 EinkBoardManager 内合并）。
                // 数据有效性由 EinkTagRenderer.parse 兜底，任何连接发的都处理（成员操作也触发推送）。
                String data = extractJsonObject(raw, "data");
                if (data != null) {
                    boolean immediate = "true".equals(jsonStr(raw, "immediate"));
                    EinkBoardManager.getInstance().requestPush(data, immediate);
                }
                break;
            }
            case "leave-room": {
                onDisconnected(conn);
                break;
            }
            default:
                break;
        }
    }

    // ================================================================
    // HTTP 静态服务
    // ================================================================
    private void serveStatic(String path, OutputStream out) throws IOException {
        if (path == null || path.isEmpty() || path.equals("/")) path = "/index.html";
        android.util.Log.d("RiichiServer", "serveStatic: " + path);
        if (path.contains("..")) { out.write(("HTTP/1.1 403 Forbidden\r\nContent-Length: 3\r\n\r\n403").getBytes()); out.flush(); return; }
        String assetPath = (path.startsWith("/") ? path.substring(1) : path);
        String contentType = contentTypeFor(assetPath);
        byte[] body;
        try (InputStream is = assets.open(assetPath)) {
            body = readAll(is);
        } catch (IOException e) {
            android.util.Log.e("RiichiServer", "assets.open 失败: " + assetPath, e);
            out.write(("HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\n404:" + assetPath).getBytes(StandardCharsets.UTF_8));
            out.flush();
            return;
        }
        android.util.Log.d("RiichiServer", "200 " + assetPath + " len=" + body.length + " ct=" + contentType);
        out.write(("HTTP/1.1 200 OK\r\n" +
                "Content-Type: " + contentType + "\r\n" +
                "Content-Length: " + body.length + "\r\n" +
                "Cache-Control: no-cache\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    private String contentTypeFor(String p) {
        if (p.endsWith(".html")) return "text/html; charset=utf-8";
        if (p.endsWith(".css")) return "text/css; charset=utf-8";
        if (p.endsWith(".js")) return "application/javascript; charset=utf-8";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".ico")) return "image/x-icon";
        return "text/plain";
    }

    // ================================================================
    // HTTP 请求解析
    // ================================================================
    private static class HttpRequest {
        String method, path;
        Map<String, String> headers = new ConcurrentHashMap<>();

        boolean isWebSocket() {
            String up = headers.get("upgrade");
            String con = headers.get("connection");
            return up != null && up.toLowerCase().contains("websocket");
        }

        boolean isHost() {
            return path != null && path.contains("host=1");
        }

        String getHeader(String k) { return headers.get(k.toLowerCase()); }
        String getPath() { return path != null ? path.split("\\?")[0] : "/"; }
    }

    private HttpRequest readHttpRequest(InputStream in) throws IOException {
        HttpRequest req = new HttpRequest();
        ByteArrayOutputStream lineBuf = new ByteArrayOutputStream();
        int prev = -1, c;
        boolean firstLine = true;
        while ((c = in.read()) != -1) {
            if (prev == '\r' && c == '\n') {
                // 一行结束：读取行缓冲并解析
                String line = new String(lineBuf.toByteArray(), StandardCharsets.UTF_8).trim();
                lineBuf.reset();
                if (line.isEmpty()) break; // 头部结束（空行）
                if (firstLine) {
                    firstLine = false;
                    String[] parts = line.split(" ");
                    if (parts.length >= 2) { req.method = parts[0]; req.path = parts[1]; }
                } else {
                    int ci = line.indexOf(':');
                    if (ci > 0) req.headers.put(line.substring(0, ci).trim().toLowerCase(), line.substring(ci + 1).trim());
                }
                prev = -1; // 复位，避免把下一字节误判
            } else {
                // 把非 \r、非 \n 的普通字节写入行缓冲
                if (c != '\r' && c != '\n') lineBuf.write(c);
                prev = c;
            }
        }
        return req;
    }

    // ================================================================
    // WebSocket 帧
    // ================================================================
    private static class Frame {
        int opcode;
        byte[] payload;
    }

    private static final int OP_TEXT = 0x1;
    private static final int OP_PING = 0x9;
    private static final int OP_PONG = 0xA;
    private static final int OP_CLOSE = 0x8;

    private Frame readFrame(InputStream in) throws IOException {
        int b1 = in.read();
        if (b1 == -1) return null;
        int opcode = b1 & 0x0F;
        int b2 = in.read();
        if (b2 == -1) return null;
        boolean masked = (b2 & 0x80) != 0;
        long len = b2 & 0x7F;
        if (len == 126) {
            len = ((long) in.read() << 8) | in.read();
        } else if (len == 127) {
            len = 0;
            for (int i = 0; i < 8; i++) len = (len << 8) | in.read();
        }
        byte[] maskKey = new byte[4];
        if (masked) { readFully(in, maskKey); }
        byte[] payload = new byte[(int) len];
        readFully(in, payload);
        if (masked) {
            for (int i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
        }
        if (opcode == OP_CLOSE) return null; // 关闭
        Frame f = new Frame();
        f.opcode = opcode;
        f.payload = payload;
        return f;
    }

    private void readFully(InputStream in, byte[] buf) throws IOException {
        int off = 0;
        while (off < buf.length) {
            int n = in.read(buf, off, buf.length - off);
            if (n == -1) throw new IOException("EOF");
            off += n;
        }
    }

    private void send(ClientConn conn, String text) {
        if (conn == null) return;
        sendFrame(conn, OP_TEXT, text.getBytes(StandardCharsets.UTF_8));
    }

    private void sendFrame(ClientConn conn, int opcode, byte[] payload) {
        if (conn == null) return;
        OutputStream out = conn.out;
        try {
            synchronized (out) {
                out.write(0x80 | opcode); // FIN + opcode
                int len = payload.length;
                if (len < 126) {
                    out.write(len);
                } else if (len < 65536) {
                    out.write(126);
                    out.write((len >> 8) & 0xFF);
                    out.write(len & 0xFF);
                } else {
                    out.write(127);
                    for (int i = 7; i >= 0; i--) out.write((int) ((len >> (8 * i)) & 0xFF));
                }
                out.write(payload);
                out.flush();
            }
        } catch (IOException ignored) {}
    }

    private String wsAccept(String key) {
        try {
            String s = key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
            MessageDigest md = MessageDigest.getInstance("SHA-1");
            byte[] hash = md.digest(s.getBytes(StandardCharsets.UTF_8));
            // 用 android.util.Base64（API 24+ 可用），避免 java.util.Base64（API 26+ 才支持）
            return android.util.Base64.encodeToString(hash, android.util.Base64.NO_WRAP);
        } catch (Exception e) {
            return "";
        }
    }

    // ================================================================
    // 连接对象
    // ================================================================
    private static class ClientConn {
        final Socket socket;
        final OutputStream out;
        final boolean isHost;
        volatile String name = null;
        volatile long lastSeen = System.currentTimeMillis();
        volatile boolean cleaned = false;
        ClientConn(Socket s, OutputStream out, boolean isHost) {
            this.socket = s;
            this.out = out;
            this.isHost = isHost;
        }
        /** 关闭连接：关 socket 会让阻塞中的 read 抛异常，从而走到 onDisconnected 完成清理 */
        void close() {
            try { socket.close(); } catch (IOException ignored) {}
            try { out.close(); } catch (IOException ignored) {}
        }
    }

    // ================================================================
    // 工具
    // ================================================================
    private byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) != -1) bos.write(buf, 0, n);
        return bos.toByteArray();
    }

    private String jsonStr(String json, String key) {
        String marker = "\"" + key + "\":";
        int idx = json.indexOf(marker);
        if (idx < 0) return null;
        idx += marker.length();
        if (idx >= json.length()) return null;
        char c = json.charAt(idx);
        if (c == '"') {
            int end = idx + 1;
            StringBuilder sb = new StringBuilder();
            while (end < json.length()) {
                char ch = json.charAt(end);
                if (ch == '\\' && end + 1 < json.length()) { sb.append(json.charAt(end + 1)); end += 2; }
                else if (ch == '"') break;
                else { sb.append(ch); end++; }
            }
            return sb.toString();
        } else if (c == 'n') { // null
            return null;
        } else {
            int end = idx;
            while (end < json.length() && json.charAt(end) != ',' && json.charAt(end) != '}') end++;
            return json.substring(idx, end).trim();
        }
    }

    /** 取数字字段；不是数字时返回 -1。 */
    private long jsonNum(String json, String key) {
        String marker = "\"" + key + "\":";
        int idx = json.indexOf(marker);
        if (idx < 0) return -1;
        idx += marker.length();
        int end = idx;
        while (end < json.length()) {
            char c = json.charAt(end);
            if ((c >= '0' && c <= '9') || c == '-') end++;
            else break;
        }
        if (end == idx) return -1;
        try { return Long.parseLong(json.substring(idx, end)); } catch (Exception e) { return -1; }
    }

    /** 可空字符串字段的 JSON 字面量（null 安全） */
    private String jsonStrOrNull(String s) {
        return s != null ? "\"" + escapeJson(s) + "\"" : "null";
    }

    /** 提取顶层 "key":{...} 的对象子串（花括号配对；对象含嵌套时安全），找不到返回 null */
    private static String extractJsonObject(String json, String key) {
        String marker = "\"" + key + "\":";
        int start = json.indexOf(marker);
        if (start < 0) return null;
        start += marker.length();
        int open = json.indexOf('{', start);
        if (open < 0) return null;
        int depth = 0;
        boolean inStr = false;
        for (int i = open; i < json.length(); i++) {
            char c = json.charAt(i);
            if (inStr) {
                if (c == '\\') i++;
                else if (c == '"') inStr = false;
            } else if (c == '"') inStr = true;
            else if (c == '{') depth++;
            else if (c == '}') {
                depth--;
                if (depth == 0) return json.substring(open, i + 1);
            }
        }
        return null;
    }

    private String operatorJson() {
        if (room.operator == null) return "null";
        String name = room.operator.name;
        return name != null ? "\"" + escapeJson(name) + "\"" : "null";
    }

    private String escapeJson(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder();
        for (char c : s.toCharArray()) {
            if (c == '"') sb.append("\\\"");
            else if (c == '\\') sb.append("\\\\");
            else if (c == '\n') sb.append("\\n");
            else if (c == '\r') sb.append("\\r");
            else if (c == '\t') sb.append("\\t");
            else if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
            else sb.append(c);
        }
        return sb.toString();
    }
}
