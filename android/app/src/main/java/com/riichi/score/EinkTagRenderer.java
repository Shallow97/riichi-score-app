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

    // ============ 渲染 ============

    /** 渲染 400×300 位图（纯黑/纯红/纯白）。bwMode=true 时无红色：庄家反白块、其余红元素转黑 */
    public static android.graphics.Bitmap render(TagData d, boolean bwMode) {
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
            drawEdge(ctx, p, d, i, bwMode, edge[0], edge[1], edge[2], edge[3], edge[4]);
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
                p.setColor(bwMode ? BLACK : RED);
                ctx.drawText(sKyotaku, sx + w1 + (p.getTextSize() == 20 ? 14 : 12), 184, p);
            }
        }
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
    private static void drawEdge(Canvas ctx, Paint p, TagData d, int idx, boolean bw,
                                 float rx, float ry, float rw, float rh, float angleDeg) {
        boolean wide = (angleDeg == 0 || Math.abs(angleDeg) > 2);
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
            drawWind(ctx, p, wind, dealer, bw, -L / 2f + 12, -Hh / 2f + windSize + 8, windSize, false);
            p.setColor(d.points[idx] < 0 && !bw ? RED : BLACK);
            p.setTextSize(scoreSize);
            if (p.measureText(pts) > L - 24) p.setTextSize(28);
            p.setTextAlign(Paint.Align.RIGHT);
            ctx.drawText(pts, L / 2f - 12, -Hh / 2f + scoreSize + 12, p);
            p.setTextAlign(Paint.Align.LEFT);
        } else {
            // 短边：风位与分数上下堆叠居中
            p.setTextAlign(Paint.Align.CENTER);
            drawWind(ctx, p, wind, dealer, bw, 0, -Hh / 2f + windSize + 8, windSize, true);
            p.setColor(d.points[idx] < 0 && !bw ? RED : BLACK);
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
            p.setColor(bw ? BLACK : RED);   // 快刷模式中心点黑（红通道不显）
            ctx.drawCircle(0, cy, 4.5f, p);
        }
        ctx.restore();
    }

    /** 风位大字：三色=庄家红字；黑白快刷=庄家反白块（黑底白字） */
    private static void drawWind(Canvas ctx, Paint p, String wind, boolean dealer, boolean bw,
                                 float x, float y, int size, boolean centered) {
        p.setTextSize(size);
        if (dealer && bw) {
            float tw = p.measureText(wind);
            float left = centered ? -tw / 2f - 7 : x - 7;
            p.setColor(BLACK);
            p.setStyle(Paint.Style.FILL);
            ctx.drawRect(left, y - size + 6, left + tw + 14, y + 14, p);
            p.setColor(WHITE);
        } else {
            p.setColor(dealer ? RED : BLACK);
        }
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
