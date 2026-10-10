package com.riichi.score;

import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;

/**
 * EinkTagRenderer — 场风盘 400×300 三色画面渲染（Java Canvas 版）
 *
 * 版式与 prototype/tag.html 定稿一致（用户 2026-09-30 定稿，勿随手改）：
 *  - 中央信息板 149×109 @(125.5,95.5)：局号 36px / 本场+场供 20px（超宽缩 18px，场供红字）
 *  - 四边按玩家静态座位 seat 绑定（开局定死）：四人 东下/南右/西上/北左（逆时针）；
 *    三人（座位东南西）东下/南右/西左，上方固定留空
 *  - 各边文字朝向自己座位（左右边旋转 90°）；风位 46px（"东"红色=庄家，随轮庄迁移）、
 *    分数 34px（负分红）；长边横排（风位左/分数右），短边上下堆叠居中
 *  - 立直显示区：立直棒白身黑框圆角 56×14 中心红点 r4.5（口径=p.riichi 宣言状态，勿用 riichiBars）
 *  - 颜色只用纯黑/纯红/纯白（墨水屏三色量化：灰度≥140 白 / r>160&&r>g&&r>b 红）
 *  - 画面处理链（用户指定参数，与参考上位机 https://breeze4dev.github.io/epd-noclock/ 一致）：
 *    对比度 1.2 → Floyd-Steinberg 抖动（强度 1.0，上位机档位 10，调色板取 Lab 最近的三色）
 *    → 再按上面的阈值转 1bpp 双平面。见 applyContrastAndDither()。
 */
public final class EinkTagRenderer {

    public static final int W = 400, H = 300;
    private static final int BLACK = Color.BLACK, WHITE = Color.WHITE, RED = Color.RED;

    /** 渲染所需的游戏状态（来自 push-tag 消息的 data，字段与 tag.html 渲染所需一致） */
    public static class TagData {
        public int mode = 4;
        public boolean over = false;
        public String endReason = "";
        public String roundWind = "东";
        public int roundNum = 1;
        public int honba = 0;
        public int kyotaku = 0;
        public String[] seats = new String[0];
        public String[] winds = new String[0];
        public int[] points = new int[0];
        public boolean[] riichi = new boolean[0];
    }

    // 边位映射见 edgeFor()：[x, y, w, h, angleDeg]

    private EinkTagRenderer() {}

    // ============ 极简 JSON 解析（字段路径固定，仅服务 push-tag 的 data） ============

    /** 从 push-tag 消息的 data JSON 解析 TagData；失败返回 null */
    public static TagData parse(String json) {
        if (json == null) return null;
        try {
            TagData d = new TagData();
            d.mode = (int) jsonNum(json, "mode", 4);
            d.over = jsonBool(json, "over");
            String er = jsonStr(json, "endReason");
            d.endReason = er == null ? "" : er;
            d.roundWind = jsonStr(json, "roundWind");
            if (d.roundWind == null) d.roundWind = "东";
            d.roundNum = (int) jsonNum(json, "roundNum", 1);
            d.honba = (int) jsonNum(json, "honba", 0);
            d.kyotaku = (int) jsonNum(json, "kyotaku", 0);
            // players 数组：截取 [ ... ] 后按对象逐个解析
            int pStart = json.indexOf("\"players\"");
            if (pStart < 0) return null;
            int arrStart = json.indexOf('[', pStart);
            int arrEnd = json.lastIndexOf(']');
            if (arrStart < 0 || arrEnd <= arrStart) return null;
            String arr = json.substring(arrStart + 1, arrEnd);
            java.util.List<String> objs = splitObjects(arr);
            int n = objs.size();
            d.seats = new String[n]; d.winds = new String[n];
            d.points = new int[n]; d.riichi = new boolean[n];
            for (int i = 0; i < n; i++) {
                String o = objs.get(i);
                d.seats[i] = jsonStr(o, "seat");
                d.winds[i] = jsonStr(o, "wind");
                d.points[i] = (int) jsonNum(o, "points", 0);
                d.riichi[i] = jsonBool(o, "riichi");
            }
            return d;
        } catch (Exception e) {
            android.util.Log.e("EinkTag", "parse 失败", e);
            return null;
        }
    }

    /** 把 "[ {...},{...} ]" 拆成对象字符串列表（花括号配对） */
    private static java.util.List<String> splitObjects(String arr) {
        java.util.List<String> out = new java.util.ArrayList<>();
        int depth = 0, start = -1;
        for (int i = 0; i < arr.length(); i++) {
            char c = arr.charAt(i);
            if (c == '{') { if (depth == 0) start = i; depth++; }
            else if (c == '}') { depth--; if (depth == 0 && start >= 0) { out.add(arr.substring(start, i + 1)); start = -1; } }
        }
        return out;
    }

    private static double jsonNum(String json, String key, double def) {
        String marker = "\"" + key + "\":";
        int idx = json.indexOf(marker);
        if (idx < 0) return def;
        idx += marker.length();
        int end = idx;
        while (end < json.length() && "+-0123456789.eE".indexOf(json.charAt(end)) >= 0) end++;
        try { return Double.parseDouble(json.substring(idx, end)); } catch (Exception e) { return def; }
    }

    private static boolean jsonBool(String json, String key) {
        String marker = "\"" + key + "\":";
        int idx = json.indexOf(marker);
        if (idx < 0) return false;
        return json.startsWith("true", idx + marker.length());
    }

    /** 字符串值解析（处理 \" 转义），找不到返回 null */
    private static String jsonStr(String json, String key) {
        String marker = "\"" + key + "\":";
        int idx = json.indexOf(marker);
        if (idx < 0) return null;
        idx += marker.length();
        if (idx >= json.length() || json.charAt(idx) != '"') return null;
        idx++;
        StringBuilder sb = new StringBuilder();
        while (idx < json.length()) {
            char c = json.charAt(idx);
            if (c == '\\' && idx + 1 < json.length()) {
                char n = json.charAt(idx + 1);
                if (n == 'n') sb.append('\n');
                else if (n == 'u' && idx + 5 < json.length()) {
                    try { sb.append((char) Integer.parseInt(json.substring(idx + 2, idx + 6), 16)); } catch (Exception ignored) {}
                    idx += 6; continue;
                } else sb.append(n);
                idx += 2;
            } else if (c == '"') break;
            else { sb.append(c); idx++; }
        }
        return sb.toString();
    }

    // ============ 画面处理：对比度 + Floyd-Steinberg 抖动（与参考上位机 s2.js 同源） ============

    private static final double CONTRAST = 1.2;         // 对比度
    private static final double DITHER_STRENGTH = 1.0;  // 抖动强度（参考站滑杆 0~5 步长 0.1，档位 10 = 1.0）
    /** 三色调色板：黑 / 白 / 红（与 JS 侧 THREE_COLOR_PALETTE 一致） */
    private static final int[][] PALETTE = {{0, 0, 0}, {255, 255, 255}, {255, 0, 0}};
    private static final double[][] PALETTE_LAB = new double[PALETTE.length][];
    static {
        for (int i = 0; i < PALETTE.length; i++) {
            PALETTE_LAB[i] = rgbToLab(PALETTE[i][0], PALETTE[i][1], PALETTE[i][2]);
        }
    }

    /** sRGB → CIE Lab（D65，与参考站 rgbToLab 完全一致） */
    private static double[] rgbToLab(double rr, double gg, double bb) {
        double r = rr / 255.0, g = gg / 255.0, b = bb / 255.0;
        r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
        g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
        b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;
        r *= 100; g *= 100; b *= 100;
        double x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 95.047;
        double y = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 100.0;
        double z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 108.883;
        x = x > 0.008856 ? Math.cbrt(x) : (7.787 * x) + (16.0 / 116);
        y = y > 0.008856 ? Math.cbrt(y) : (7.787 * y) + (16.0 / 116);
        z = z > 0.008856 ? Math.cbrt(z) : (7.787 * z) + (16.0 / 116);
        return new double[]{116 * y - 16, 500 * (x - y), 200 * (y - z)};
    }

    /** 加权 CIE76 距离（参考站 labDistance：0.2·ΔL² + 3·Δa² + 3·Δb²） */
    private static double labDistance(double[] p, double[] q) {
        double dl = p[0] - q[0], da = p[1] - q[1], db = p[2] - q[2];
        return Math.sqrt(0.2 * dl * dl + 3 * da * da + 3 * db * db);
    }

    /** 取调色板里 Lab 距离最近的颜色，返回下标 */
    private static int nearestPalette(double r, double g, double b) {
        double[] lab = rgbToLab(r, g, b);
        int best = 0;
        double bestD = Double.MAX_VALUE;
        for (int i = 0; i < PALETTE_LAB.length; i++) {
            double d = labDistance(lab, PALETTE_LAB[i]);
            if (d < bestD) { bestD = d; best = i; }
        }
        return best;
    }

    private static double clampRound(double v) {
        if (v < 0) return 0;
        if (v > 255) return 255;
        return Math.round(v);
    }

    private static void spread(double[] R, double[] G, double[] B, int i,
                               double er, double eg, double eb, double k) {
        R[i] = clampRound(R[i] + er * k);
        G[i] = clampRound(G[i] + eg * k);
        B[i] = clampRound(B[i] + eb * k);
    }

    /**
     * 对比度 1.2 + Floyd-Steinberg 抖动，返回吸附到三色调色板的新位图。
     * 与 JS 侧 floydSteinbergDither 逐行等价（误差按 7/16、3/16、5/16、1/16 扩散）。
     */
    public static android.graphics.Bitmap applyContrastAndDither(android.graphics.Bitmap src) {
        final int w = src.getWidth(), h = src.getHeight();
        final int[] px = new int[w * h];
        src.getPixels(px, 0, w, 0, 0, w, h);
        double[] R = new double[w * h], G = new double[w * h], B = new double[w * h];
        for (int i = 0; i < px.length; i++) {
            int c = px[i];
            R[i] = clampRound((((c >> 16) & 0xFF) - 128) * CONTRAST + 128);
            G[i] = clampRound((((c >> 8) & 0xFF) - 128) * CONTRAST + 128);
            B[i] = clampRound(((c & 0xFF) - 128) * CONTRAST + 128);
        }
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int i = y * w + x;
                int[] pal = PALETTE[nearestPalette(R[i], G[i], B[i])];
                double er = (R[i] - pal[0]) * DITHER_STRENGTH;
                double eg = (G[i] - pal[1]) * DITHER_STRENGTH;
                double eb = (B[i] - pal[2]) * DITHER_STRENGTH;
                if (x + 1 < w) spread(R, G, B, i + 1, er, eg, eb, 7.0 / 16);
                if (y + 1 < h) {
                    if (x > 0) spread(R, G, B, i + w - 1, er, eg, eb, 3.0 / 16);
                    spread(R, G, B, i + w, er, eg, eb, 5.0 / 16);
                    if (x + 1 < w) spread(R, G, B, i + w + 1, er, eg, eb, 1.0 / 16);
                }
            }
        }
        for (int i = 0; i < px.length; i++) {
            int[] pal = PALETTE[nearestPalette(R[i], G[i], B[i])];
            px[i] = 0xFF000000 | (pal[0] << 16) | (pal[1] << 8) | pal[2];
        }
        android.graphics.Bitmap out = android.graphics.Bitmap.createBitmap(w, h,
                android.graphics.Bitmap.Config.ARGB_8888);
        out.setPixels(px, 0, w, 0, 0, w, h);
        return out;
    }

    // ============ 渲染 ============

    /** 渲染 400×300 位图（纯黑/纯红/纯白） */
    public static android.graphics.Bitmap render(TagData d) {
        android.graphics.Bitmap bmp = android.graphics.Bitmap.createBitmap(W, H, android.graphics.Bitmap.Config.ARGB_8888);
        Canvas ctx = new Canvas(bmp);
        ctx.drawColor(WHITE);
        if (d == null) return bmp;

        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setTypeface(Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD));

        // 四边（按静态座位入座；三人局上方固定留空）
        int n = d.seats.length;
        for (int i = 0; i < n; i++) {
            float[] edge = edgeFor(d.mode, d.seats[i]);
            if (edge == null) continue;
            drawEdge(ctx, p, d, i, edge[0], edge[1], edge[2], edge[3], edge[4]);
        }

        // 中央信息板
        p.setColor(BLACK);
        p.setStrokeWidth(3);
        p.setStyle(Paint.Style.STROKE);
        ctx.drawRect(127, 97, 273, 203, p); // strokeRect(125.5,95.5,149,109)
        p.setStyle(Paint.Style.FILL);
        p.setTextAlign(Paint.Align.CENTER);
        if (d.over) {
            p.setTextSize(40);
            ctx.drawText("终局", 200, 152, p);
            p.setTextSize(18);
            p.setTypeface(Typeface.create(Typeface.SANS_SERIF, Typeface.NORMAL));
            String reason = d.endReason == null ? "" : d.endReason;
            if (reason.length() > 12) reason = reason.substring(0, 12);
            ctx.drawText(reason, 200, 186, p);
        } else {
            p.setTextSize(36);
            ctx.drawText(d.roundWind + d.roundNum + "局", 200, 148, p);
            String sHonba = d.honba + "本场";
            String sKyotaku = d.kyotaku > 0 ? ("场供" + d.kyotaku) : "";
            p.setTextSize(20);
            float w1 = p.measureText(sHonba);
            float w2 = sKyotaku.isEmpty() ? 0 : p.measureText(sKyotaku) + 14;
            if (w1 + w2 > 135) {
                p.setTextSize(18);
                w1 = p.measureText(sHonba);
                w2 = sKyotaku.isEmpty() ? 0 : p.measureText(sKyotaku) + 12;
            }
            float sx = 200 - (w1 + w2) / 2f;
            p.setTextAlign(Paint.Align.LEFT);
            p.setColor(BLACK);
            ctx.drawText(sHonba, sx, 184, p);
            if (!sKyotaku.isEmpty()) {
                p.setColor(RED);
                ctx.drawText(sKyotaku, sx + w1 + (p.getTextSize() == 20 ? 14 : 12), 184, p);
            }
        }
        return bmp;
    }

    /**
     * 测试图案（不依赖对局数据）：黑框 + 左上红块 + 右上黑块 + 「场风盘」/「测试图案」。
     * 版式与 tag.html 的 drawTestPattern() 一致，用于在设备上验证
     * 「蓝牙 → 位图 → 量化 → 分包 → 标志位 → 刷新」整条链路是否正常。
     */
    public static android.graphics.Bitmap testPattern() {
        android.graphics.Bitmap bmp = android.graphics.Bitmap.createBitmap(W, H, android.graphics.Bitmap.Config.ARGB_8888);
        Canvas ctx = new Canvas(bmp);
        ctx.drawColor(WHITE);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setTypeface(Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD));
        // 黑外框
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(6);
        p.setColor(BLACK);
        ctx.drawRect(3, 3, W - 3, H - 3, p);
        // 左上红块 / 右上黑块
        p.setStyle(Paint.Style.FILL);
        p.setColor(RED);
        ctx.drawRect(40, 40, 160, 130, p);
        p.setColor(BLACK);
        ctx.drawRect(240, 40, 360, 130, p);
        // 文字
        p.setTextAlign(Paint.Align.CENTER);
        p.setTextSize(44);
        p.setColor(BLACK);
        ctx.drawText("场风盘", W / 2f, 205, p);
        p.setTextSize(28);
        p.setColor(RED);
        ctx.drawText("测试图案 东1局", W / 2f, 252, p);
        return bmp;
    }

    /** 边位映射：[x, y, w, h, angleDeg]。四人 东下/南右/西上/北左；三人 东下/南右/西左（上留空） */
    private static float[] edgeFor(int mode, String seat) {
        if ("东".equals(seat)) return new float[]{0, 220, 400, 80, 0};
        if ("南".equals(seat)) return new float[]{280, 80, 120, 140, -90};
        if ("北".equals(seat)) return new float[]{0, 80, 120, 140, 90};
        if ("西".equals(seat)) return mode == 3 ? new float[]{0, 80, 120, 140, 90} : new float[]{0, 0, 400, 80, 180};
        return null;
    }

    /** 画一条边（本地坐标：translate 到中心 + rotate；L=阅读方向宽，H=竖直高） */
    private static void drawEdge(Canvas ctx, Paint p, TagData d, int idx,
                                 float rx, float ry, float rw, float rh, float angleDeg) {
        // ⚠️ 单位陷阱（2026-10-04 修复）：本方法收到的是【角度】（Canvas.rotate 收角度），
        //    而 tag.html 的 drawEdge 用的是【弧度】——那边的 `Math.abs(angle) > 2` 靠
        //    ±π/2≈1.57 判不出长边，所以是对的。把它照抄到角度制后 `Math.abs(-90) > 2` 恒真，
        //    左右两条 120×140 的短边被误判成"长边"横排，且 L/H 取反 ⇒ 风位与分数重叠。
        //    正确判据：阅读方向水平 ⇔ 旋转角是 180° 的整数倍。
        boolean wide = (angleDeg % 180f) == 0;
        float L = wide ? rw : rh, Hh = wide ? rh : rw;
        ctx.save();
        ctx.translate(rx + rw / 2f, ry + rh / 2f);
        ctx.rotate(angleDeg);
        p.setTextAlign(Paint.Align.LEFT);
        String wind = d.winds[idx] == null ? "" : d.winds[idx];
        String pts = fmt(d.points[idx]);
        int windSize = 46, scoreSize = 34;
        boolean dealer = "东".equals(wind);

        if (wide) {
            // 长边：风位左、分数右
            drawWind(ctx, p, wind, dealer, -L / 2f + 12, -Hh / 2f + windSize + 8, windSize, false);
            p.setColor(d.points[idx] < 0 ? RED : BLACK);
            p.setTextSize(scoreSize);
            if (p.measureText(pts) > L - 24) p.setTextSize(28);
            p.setTextAlign(Paint.Align.RIGHT);
            ctx.drawText(pts, L / 2f - 12, -Hh / 2f + scoreSize + 12, p);
            p.setTextAlign(Paint.Align.LEFT);
        } else {
            // 短边：风位与分数上下堆叠居中
            p.setTextAlign(Paint.Align.CENTER);
            drawWind(ctx, p, wind, dealer, 0, -Hh / 2f + windSize + 8, windSize, true);
            p.setColor(d.points[idx] < 0 ? RED : BLACK);
            p.setTextSize(scoreSize);
            if (p.measureText(pts) > L - 12) p.setTextSize(28);
            ctx.drawText(pts, 0, Hh / 2f - 26, p);
            p.setTextAlign(Paint.Align.LEFT);
        }
        // 立直显示区（口径 = 宣言状态 riichi）
        if (d.riichi[idx]) {
            float sw = 56, sh = 14, r = sh / 2f;
            float cy = Hh / 2f - (wide ? 20 : 8);
            p.setColor(WHITE);
            p.setStyle(Paint.Style.FILL);
            ctx.drawRoundRect(-sw / 2f, cy - sh / 2f, sw / 2f, cy + sh / 2f, r, r, p);
            p.setColor(BLACK);
            p.setStrokeWidth(2);
            p.setStyle(Paint.Style.STROKE);
            ctx.drawRoundRect(-sw / 2f, cy - sh / 2f, sw / 2f, cy + sh / 2f, r, r, p);
            p.setStyle(Paint.Style.FILL);
            p.setColor(RED);
            ctx.drawCircle(0, cy, 4.5f, p);
        }
        ctx.restore();
    }

    /** 风位大字：庄家（东）红字，其余黑字 */
    private static void drawWind(Canvas ctx, Paint p, String wind, boolean dealer,
                                 float x, float y, int size, boolean centered) {
        p.setTextSize(size);
        p.setColor(dealer ? RED : BLACK);
        ctx.drawText(wind, x, y, p);
    }

    private static String fmt(int v) {
        boolean neg = v < 0;
        String s = String.valueOf(Math.abs(v));
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            if (i > 0 && (s.length() - i) % 3 == 0) sb.append(',');
            sb.append(s.charAt(i));
        }
        return neg ? "-" + sb : sb.toString();
    }
}
