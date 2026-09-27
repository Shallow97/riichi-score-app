package com.riichi.score;

import android.content.res.AssetManager;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArraySet;

/**
 * RiichiServer — 内嵌 HTTP + WebSocket 服务器（纯 Java，零第三方依赖）
 *
 * 模型：单房间 + 操作权互斥（全员协作）
 *  - 房主手机启动本服务器，监听 8765。
 *  - 房主 WebView 访问 http://127.0.0.1:8765/?host=1 → 识别为房主(host)。
 *  - 其他玩家浏览器访问 http://<房主IP>:8765/ → 识别为成员(member)。
 *  - 所有端加载同一套网页(index.html + js/css)，行为一致，只是身份不同。
 *  - 任意玩家可"申请操作权"执行结算/立直，服务器仲裁互斥并广播。
 *  - 流局/修正/撤回/结束仍仅房主（前端 isHost 判断）。
 *
 * 无房间码：单房间模型，所有连接进同一个房间，无需输入房间码。
 */
public class RiichiServer {

    public interface Listener {
        void onStarted(String ip, int port);
        void onError(String message);
        void onMemberCount(int count); // 成员数（含房主），用于 UI
    }

    private static final int PORT = 8765;
    private final AssetManager assets;
    private final Listener listener;
    private ServerSocket serverSocket;
    private volatile boolean running = false;
    private Thread acceptThread;

    // 单房间状态
    private final Room room = new Room();

    private static class Room {
        volatile ClientConn host = null;              // 房主连接
        final Set<ClientConn> members = new CopyOnWriteArraySet<>(); // 成员连接（不含房主）
        volatile String state = null;                 // 权威状态（序列化）
        volatile ClientConn operator = null;          // 当前操作者
    }

    public RiichiServer(AssetManager assets, Listener listener) {
        this.assets = assets;
        this.listener = listener;
    }

    public synchronized void start() {
        if (running) return;
        running = true;
        acceptThread = new Thread(() -> {
            try {
                serverSocket = new ServerSocket(PORT);
                // 通知启动成功（监听任意网卡）
                if (listener != null) listener.onStarted(getLocalIp(), PORT);
                while (running) {
                    Socket socket = serverSocket.accept();
                    handleClient(socket);
                }
            } catch (IOException e) {
                if (running && listener != null) listener.onError(e.getMessage());
            }
        }, "riichi-server-accept");
        acceptThread.start();
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

    // 显示给房主的 IP（供其他玩家输入）
    private String getLocalIp() {
        try {
            java.util.Enumeration<java.net.NetworkInterface> nis =
                    java.net.NetworkInterface.getNetworkInterfaces();
            while (nis.hasMoreElements()) {
                java.net.NetworkInterface ni = nis.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                java.util.Enumeration<java.net.InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    java.net.InetAddress ia = addrs.nextElement();
                    if (ia instanceof java.net.Inet4Address) return ia.getHostAddress();
                }
            }
        } catch (Exception ignored) {}
        return "127.0.0.1";
    }

    // ================================================================
    // 客户端连接处理
    // ================================================================
    private void handleClient(Socket socket) {
        new Thread(() -> {
            try {
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
                    wsLoop(in, conn);
                    onDisconnected(conn);
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
        if (conn.isHost) {
            // 若有旧房主（重连），先清理
            if (room.host != null && room.host != conn) {
                room.members.remove(room.host);
                try { room.host.close(); } catch (Exception ignored) {}
            }
            room.host = conn;
            send(conn, "{\"type\":\"room-created\",\"code\":\"HOST\",\"isHost\":true}");
        } else {
            room.members.add(conn);
            send(conn, "{\"type\":\"joined\",\"isHost\":false,\"state\":\"" + safeState(room.state) + "\",\"operator\":" + operatorJson() + "}");
        }
        notifyMemberCount();
    }

    private void onDisconnected(ClientConn conn) {
        boolean changed = false;
        if (conn == room.host) {
            room.host = null;
            // 房主离开：通知所有成员房间解散
            for (ClientConn m : room.members) send(m, "{\"type\":\"host-left\"}");
            room.members.clear();
            room.operator = null;
            changed = true;
        } else if (room.members.remove(conn)) {
            changed = true;
            if (room.operator == conn) { room.operator = null; broadcastOperator(); }
        }
        if (changed) notifyMemberCount();
    }

    private void notifyMemberCount() {
        int count = getMemberCount();
        if (listener != null) listener.onMemberCount(count);
        // 广播给房主
        if (room.host != null) send(room.host, "{\"type\":\"member-count\",\"count\":" + (count - 1) + "}");
    }

    private void broadcastOperator() {
        String name = room.operator != null ? room.operator.name : null;
        String json = "{\"type\":\"operator-change\",\"name\":" + (name != null ? "\"" + escapeJson(name) + "\"" : "null") + "}";
        for (ClientConn m : room.members) send(m, json);
        if (room.host != null) send(room.host, json);
    }

    // ================================================================
    // WebSocket 消息循环
    // ================================================================
    private void wsLoop(InputStream in, ClientConn conn) throws IOException {
        while (running) {
            Frame frame = readFrame(in);
            if (frame == null) break;
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
                if (conn == room.host && name != null) {
                    // 房主名用于操作权显示
                }
                break;
            }
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
            case "host-state": {
                // 房主 或 当前操作者 可提交权威态
                if (conn == room.host || room.operator == conn) {
                    String state = jsonStr(raw, "state");
                    if (state != null) {
                        room.state = state;
                        String json = "{\"type\":\"state\",\"state\":\"" + escapeJson(state) + "\"}";
                        // 广播给所有成员 + 房主（跳过提交者自己，避免无意义回显）
                        for (ClientConn m : room.members) if (m != conn) send(m, json);
                        if (room.host != null && room.host != conn) send(room.host, json);
                    }
                }
                break;
            }
            case "game-end": {
                // 房主结束对局：把归档记录（序列化字符串）广播给所有成员，成员据此同步结束并跳转历史页
                if (conn == room.host) {
                    String record = jsonStr(raw, "record");
                    String json = "{\"type\":\"game-end\",\"record\":" + (record != null ? "\"" + escapeJson(record) + "\"" : "null") + "}";
                    for (ClientConn m : room.members) send(m, json);
                }
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
        byte[] payload;
    }

    private static final int OP_TEXT = 0x1;
    private static final int OP_CLOSE = 0x8;

    private Frame readFrame(InputStream in) throws IOException {
        int b1 = in.read();
        if (b1 == -1) return null;
        int fin = (b1 >> 7) & 1;
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
        byte[] payload = text.getBytes(StandardCharsets.UTF_8);
        OutputStream out = conn.out;
        try {
            synchronized (out) {
                out.write(0x81); // FIN + text
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
        final OutputStream out;
        final boolean isHost;
        volatile String name = null;
        ClientConn(Socket s, OutputStream out, boolean isHost) {
            this.out = out;
            this.isHost = isHost;
        }
        void close() {
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

    private String operatorJson() {
        if (room.operator == null) return "null";
        String name = room.operator.name;
        return name != null ? "\"" + escapeJson(name) + "\"" : "null";
    }

    private String safeState(String s) {
        return s == null ? "" : escapeJson(s);
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
