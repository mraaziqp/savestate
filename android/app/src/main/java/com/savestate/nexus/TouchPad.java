package com.savestate.nexus;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.view.MotionEvent;
import android.view.View;

import java.util.ArrayList;
import java.util.List;

/**
 * On-screen controls drawn over the game (GameActivity). Every touch is
 * re-read on each event (multi-touch: thumbs on the D-pad and a button at
 * once), turned into RetroPad bits (RETRO_DEVICE_ID_JOYPAD) and the left
 * stick, and handed to the listener when they change. The layout follows the
 * console: a Game Boy has a D-pad, A, B, Start and Select; a PSP adds the
 * four face buttons, L/R and the analog stick.
 */
public class TouchPad extends View {
    public interface Listener { void onPad(int buttons, int lx, int ly); }

    // RetroPad bits (libretro.h RETRO_DEVICE_ID_JOYPAD_*).
    static final int B = 0, Y = 1, SELECT = 2, START = 3, UP = 4, DOWN = 5, LEFT = 6, RIGHT = 7, A = 8, X = 9, L = 10, R = 11;

    private static class Btn {
        final int bit; final String label; float cx, cy, r; final boolean pill;
        Btn(int bit, String label, boolean pill) { this.bit = bit; this.label = label; this.pill = pill; }
    }

    private final List<Btn> buttons = new ArrayList<>();
    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint text = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final boolean stick;
    private float padX, padY, padR, stickX, stickY, stickR;
    private int pressed, lastButtons = -1, lastLx, lastLy, knobX, knobY;
    private Listener listener;
    private boolean visible = true;

    public TouchPad(Context c, String platform) {
        super(c);
        String p = platform == null ? "" : platform.toLowerCase();
        boolean handheldGb = p.equals("gb") || p.equals("gbc") || p.equals("nes");
        stick = p.equals("psp") || p.equals("ps1") || p.equals("n64");
        if (handheldGb) {
            buttons.add(new Btn(A, "A", false));
            buttons.add(new Btn(B, "B", false));
        } else {
            boolean ps = p.equals("psp") || p.equals("ps1") || p.equals("ps2");
            buttons.add(new Btn(X, ps ? "△" : "X", false));
            buttons.add(new Btn(A, ps ? "○" : "A", false));
            buttons.add(new Btn(B, ps ? "✕" : "B", false));
            buttons.add(new Btn(Y, ps ? "□" : "Y", false));
            buttons.add(new Btn(L, "L", true));
            buttons.add(new Btn(R, "R", true));
        }
        buttons.add(new Btn(SELECT, "SELECT", true));
        buttons.add(new Btn(START, "START", true));
        fill.setColor(Color.argb(70, 255, 255, 255));
        stroke.setStyle(Paint.Style.STROKE);
        stroke.setStrokeWidth(3);
        stroke.setColor(Color.argb(140, 255, 255, 255));
        text.setColor(Color.argb(200, 255, 255, 255));
        text.setTextAlign(Paint.Align.CENTER);
        text.setFakeBoldText(true);
    }

    public void setListener(Listener l) { listener = l; }

    /** Hidden while a controller is in use. */
    public void setShown(boolean v) { visible = v; invalidate(); }

    @Override
    protected void onSizeChanged(int w, int h, int ow, int oh) {
        float u = Math.min(w, h) / 10f;
        padR = u * 1.7f;
        padX = u * 2.3f;
        padY = h - u * 2.9f;
        stickR = u * 1.1f;
        stickX = u * 4.8f;
        stickY = h - u * 1.4f;
        float fx = w - u * 2.4f, fy = h - u * 2.9f, gap = u * 1.15f, br = u * 0.72f;
        for (Btn b : buttons) {
            switch (b.bit) {
                case X: b.cx = fx; b.cy = fy - gap; b.r = br; break;
                case A: b.cx = fx + gap; b.cy = fy; b.r = br; break;
                case B:
                    if (buttons.size() <= 4) { b.cx = fx - gap * 0.6f; b.cy = fy + gap * 0.5f; } else { b.cx = fx; b.cy = fy + gap; }
                    b.r = br; break;
                case Y: b.cx = fx - gap; b.cy = fy; b.r = br; break;
                case L: b.cx = u * 1.6f; b.cy = u * 1.0f; b.r = u * 0.7f; break;
                case R: b.cx = w - u * 1.6f; b.cy = u * 1.0f; b.r = u * 0.7f; break;
                case SELECT: b.cx = w / 2f - u * 1.3f; b.cy = h - u * 0.7f; b.r = u * 0.55f; break;
                case START: b.cx = w / 2f + u * 1.3f; b.cy = h - u * 0.7f; b.r = u * 0.55f; break;
            }
            if (buttons.size() <= 4 && b.bit == A) { b.cx = fx + gap * 0.6f; b.cy = fy - gap * 0.5f; }
        }
        text.setTextSize(u * 0.45f);
    }

    @Override
    protected void onDraw(Canvas c) {
        if (!visible) return;
        // D-pad.
        float a = padR / 3f;
        for (int[] d : new int[][] { { UP, 0, -1 }, { DOWN, 0, 1 }, { LEFT, -1, 0 }, { RIGHT, 1, 0 } }) {
            boolean on = (pressed & (1 << d[0])) != 0;
            fill.setAlpha(on ? 150 : 70);
            float cx = padX + d[1] * a * 2, cy = padY + d[2] * a * 2;
            c.drawRoundRect(new RectF(cx - a, cy - a, cx + a, cy + a), a / 3, a / 3, fill);
        }
        fill.setAlpha(70);
        c.drawRect(padX - a, padY - a, padX + a, padY + a, fill);
        if (stick) {
            c.drawCircle(stickX, stickY, stickR, stroke);
            fill.setAlpha(120);
            c.drawCircle(stickX + knobX * stickR / 32767f, stickY + knobY * stickR / 32767f, stickR * 0.45f, fill);
        }
        for (Btn b : buttons) {
            boolean on = (pressed & (1 << b.bit)) != 0;
            fill.setAlpha(on ? 160 : 70);
            if (b.pill) c.drawRoundRect(new RectF(b.cx - b.r * 1.3f, b.cy - b.r * 0.55f, b.cx + b.r * 1.3f, b.cy + b.r * 0.55f), b.r, b.r, fill);
            else c.drawCircle(b.cx, b.cy, b.r, fill);
            float th = text.getTextSize();
            text.setTextSize(b.pill ? th * 0.65f : th);
            c.drawText(b.label, b.cx, b.cy + text.getTextSize() / 3, text);
            text.setTextSize(th);
        }
    }

    @Override
    public boolean onTouchEvent(MotionEvent e) {
        if (!visible) return false;
        int bits = 0, lx = 0, ly = 0;
        int action = e.getActionMasked();
        for (int i = 0; i < e.getPointerCount(); i++) {
            if ((action == MotionEvent.ACTION_POINTER_UP || action == MotionEvent.ACTION_UP) && i == e.getActionIndex()) continue;
            if (action == MotionEvent.ACTION_CANCEL) continue;
            float x = e.getX(i), y = e.getY(i);
            // D-pad: eight directions from the angle, within 1.6x its radius.
            float dx = x - padX, dy = y - padY;
            if (dx * dx + dy * dy < padR * padR * 2.6f && Math.hypot(dx, dy) > padR * 0.2f) {
                double ang = Math.toDegrees(Math.atan2(dy, dx));
                if (ang > -67.5 && ang < 67.5) bits |= 1 << RIGHT;
                if (ang > 22.5 && ang < 157.5) bits |= 1 << DOWN;
                if (ang > 112.5 || ang < -112.5) bits |= 1 << LEFT;
                if (ang > -157.5 && ang < -22.5) bits |= 1 << UP;
                continue;
            }
            if (stick) {
                float sx = x - stickX, sy = y - stickY;
                if (sx * sx + sy * sy < stickR * stickR * 3f) {
                    lx = (int) Math.max(-32767, Math.min(32767, sx / stickR * 32767));
                    ly = (int) Math.max(-32767, Math.min(32767, sy / stickR * 32767));
                    continue;
                }
            }
            for (Btn b : buttons) {
                float bx = x - b.cx, by = y - b.cy, hit = b.r * (b.pill ? 1.6f : 1.25f);
                if (bx * bx + by * by < hit * hit) bits |= 1 << b.bit;
            }
        }
        knobX = lx; knobY = ly;
        if (bits != lastButtons || lx != lastLx || ly != lastLy) {
            lastButtons = bits; lastLx = lx; lastLy = ly;
            if (bits != pressed && bits > pressed) performHapticFeedback(android.view.HapticFeedbackConstants.VIRTUAL_KEY);
            pressed = bits;
            if (listener != null) listener.onPad(bits, lx, ly);
            invalidate();
        }
        return true;
    }
}
