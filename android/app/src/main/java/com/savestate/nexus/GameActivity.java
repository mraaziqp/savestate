package com.savestate.nexus;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * A game playing inside SaveState (Phase 7): full screen, sideways, the
 * engine drawing on a SurfaceView, on-screen controls over it (hidden while a
 * controller is used). The first time a console's core is needed it comes
 * from the SaveState host (our own builds, checked against their SHA-256) and
 * is kept in the app's files. Back opens the menu: resume, save, load, quit.
 *
 * Extras: origin, token, core (e.g. "ppsspp"), game (file path), title, platform.
 */
@SuppressWarnings("deprecation") // setSystemUiVisibility and onBackPressed: still the way on Android 8-12
public class GameActivity extends Activity implements SurfaceHolder.Callback {
    private SurfaceView surfaceView;
    private TouchPad pad;
    private TextView info;
    private ProgressBar bar;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private boolean prepared, started, surfaceReady, closing;
    private String corePath;
    private int touchBits, padBits, lx, ly, rx, ry, hatBits, triggerBits;
    private String lastMessage;
    private long lastReport;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        surfaceView = new SurfaceView(this);
        surfaceView.getHolder().addCallback(this);
        root.addView(surfaceView, new FrameLayout.LayoutParams(-1, -1));
        pad = new TouchPad(this, extra("platform"));
        pad.setListener((bits, x, y) -> { touchBits = bits; if (padBits == 0 && hatBits == 0) { lx = x; ly = y; } sendInput(); });
        root.addView(pad, new FrameLayout.LayoutParams(-1, -1));
        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(1000);
        FrameLayout.LayoutParams bp = new FrameLayout.LayoutParams(-1, -2, Gravity.CENTER);
        bp.leftMargin = bp.rightMargin = 120;
        root.addView(bar, bp);
        info = new TextView(this);
        info.setTextColor(Color.WHITE);
        info.setTextSize(16);
        info.setGravity(Gravity.CENTER);
        info.setPadding(40, 0, 40, 120);
        root.addView(info, new FrameLayout.LayoutParams(-1, -1, Gravity.CENTER));
        setContentView(root);
        hideBars();
        info.setText("Getting " + extra("title") + " ready…");
        if (!NxEngine.available()) { fail(NxEngine.unavailableReason()); return; }
        new Thread(this::prepare, "savestate-prepare").start();
    }

    private String extra(String k) {
        String v = getIntent().getStringExtra(k);
        return v == null ? "" : v;
    }

    private void hideBars() {
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    // ── Getting the core (and its system files) ──────────────────────────
    private void prepare() {
        try {
            String core = extra("core");
            if (!new File(extra("game")).canRead()) throw new Exception("The game file isn't readable on this phone: " + extra("game"));
            JSONObject m = new JSONObject(new String(get("/api/engine/android/cores"), "UTF-8"));
            JSONObject c = m.getJSONObject("cores").optJSONObject(core);
            if (c == null) throw new Exception("The host has no " + core + " core for phones yet.");
            File dir = new File(getFilesDir(), "cores");
            dir.mkdirs();
            File f = new File(dir, c.getString("file"));
            String want = c.getString("sha256");
            if (!f.exists() || !want.equalsIgnoreCase(sha256(f))) {
                status("Getting the " + core + " emulator (once)…");
                download("/api/engine/android/files/" + c.getString("file"), f, c.optLong("size"), want);
            }
            corePath = f.getAbsolutePath();
            JSONObject sys = m.optJSONObject("system");
            if (sys != null && sys.optJSONObject(core) != null) {
                JSONObject s = sys.getJSONObject(core);
                File marker = new File(systemDir(), "." + core + "-" + s.getString("sha256"));
                if (!marker.exists()) {
                    status("Getting " + core + "'s system files (once)…");
                    File zip = new File(getCacheDir(), s.getString("file"));
                    download("/api/engine/android/files/" + s.getString("file"), zip, s.optLong("size"), s.getString("sha256"));
                    unzip(zip, systemDir());
                    zip.delete();
                    marker.createNewFile();
                }
            }
            // The console's BIOS, on the host owner's own devices (the host lists
            // it only for them): fetched once, and again when the files change.
            JSONObject bios = m.optJSONObject("bios");
            if (bios != null && bios.optJSONObject(core) != null) {
                String stamp = bios.getJSONObject(core).getString("stamp");
                File marker = new File(systemDir(), "." + core + "-bios-" + stamp);
                if (!marker.exists()) {
                    status("Getting the console's BIOS from your PC (once)…");
                    File zip = new File(getCacheDir(), core + "-bios.zip");
                    download("/api/engine/android/bios/" + core, zip, 0, null);
                    unzip(zip, systemDir());
                    zip.delete();
                    marker.createNewFile();
                }
            }
            ui.post(() -> { prepared = true; bar.setVisibility(View.GONE); maybeStart(); });
        } catch (Exception e) {
            ui.post(() -> fail(e.getMessage() == null ? e.toString() : e.getMessage()));
        }
    }

    private File systemDir() { File d = new File(getFilesDir(), "system"); d.mkdirs(); return d; }

    private HttpURLConnection open(String path) throws Exception {
        HttpURLConnection h = (HttpURLConnection) new URL(extra("origin") + path).openConnection();
        h.setRequestProperty("Authorization", "Bearer " + extra("token"));
        h.setConnectTimeout(15000);
        h.setReadTimeout(60000);
        int code = h.getResponseCode();
        if (code == 401 || code == 403) throw new Exception("The host said no (sign in again in SaveState).");
        if (code != 200) throw new Exception("The host couldn't send it (error " + code + ").");
        return h;
    }

    private void post(String path, String json) {
        try {
            HttpURLConnection h = (HttpURLConnection) new URL(extra("origin") + path).openConnection();
            h.setRequestMethod("POST");
            h.setDoOutput(true);
            h.setRequestProperty("Authorization", "Bearer " + extra("token"));
            h.setRequestProperty("Content-Type", "application/json");
            h.setConnectTimeout(10000);
            h.setReadTimeout(10000);
            try (OutputStream out = h.getOutputStream()) { out.write(json.getBytes("UTF-8")); }
            h.getResponseCode();
            h.disconnect();
        } catch (Exception ignored) { /* a report is best effort */ }
    }

    private byte[] get(String path) throws Exception {
        HttpURLConnection h = open(path);
        try (InputStream in = h.getInputStream()) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[65536];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    private void download(String path, File to, long size, String sha) throws Exception {
        HttpURLConnection h = open(path);
        File part = new File(to.getPath() + ".part");
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        long got = 0;
        try (InputStream in = h.getInputStream(); OutputStream out = new FileOutputStream(part)) {
            byte[] buf = new byte[1 << 16];
            for (int n; (n = in.read(buf)) > 0; ) {
                out.write(buf, 0, n);
                md.update(buf, 0, n);
                got += n;
                final long g = got;
                if (size > 0) ui.post(() -> bar.setProgress((int) (g * 1000 / size)));
            }
        }
        // A BIOS set is packed per request, so it has no checksum to match (sha null).
        if (sha != null && !sha.equalsIgnoreCase(hex(md.digest()))) { part.delete(); throw new Exception("The download didn't match its checksum. Try again."); }
        if (to.exists()) to.delete();
        if (!part.renameTo(to)) throw new Exception("Couldn't keep the downloaded file.");
    }

    private static void unzip(File zip, File dest) throws Exception {
        String root = dest.getCanonicalPath() + File.separator;
        try (ZipInputStream z = new ZipInputStream(new java.io.FileInputStream(zip))) {
            byte[] buf = new byte[1 << 16];
            for (ZipEntry e; (e = z.getNextEntry()) != null; ) {
                // Windows-made zips use backslashes; never write outside dest.
                File out = new File(dest, e.getName().replace('\\', '/'));
                if (!out.getCanonicalPath().startsWith(root)) continue;
                if (e.isDirectory() || e.getName().endsWith("/") || e.getName().endsWith("\\")) { out.mkdirs(); continue; }
                out.getParentFile().mkdirs();
                try (OutputStream o = new FileOutputStream(out)) { for (int n; (n = z.read(buf)) > 0; ) o.write(buf, 0, n); }
            }
        }
    }

    private static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new java.io.FileInputStream(f)) {
            byte[] buf = new byte[1 << 16];
            for (int n; (n = in.read(buf)) > 0; ) md.update(buf, 0, n);
        }
        return hex(md.digest());
    }

    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }

    private void status(String s) { ui.post(() -> info.setText(s)); }

    private void fail(String why) {
        bar.setVisibility(View.GONE);
        pad.setVisibility(View.GONE);
        info.setText(why + "\n\nPress Back to return to SaveState.");
    }

    // ── Starting and running ─────────────────────────────────────────────
    private void maybeStart() {
        if (started || !prepared || !surfaceReady || closing) return;
        started = true;
        info.setText("");
        File saves = getExternalFilesDir("saves");
        File cache = new File(getCacheDir(), "engine");
        NxEngine.nativeStart(corePath, extra("game"), systemDir().getAbsolutePath(),
                (saves != null ? saves : new File(getFilesDir(), "saves")).getAbsolutePath(), cache.getAbsolutePath(), surfaceView.getHolder().getSurface());
        ui.postDelayed(this::poll, 1000);
    }

    private void poll() {
        if (closing) return;
        try {
            JSONObject s = new JSONObject(NxEngine.nativeStatus());
            String err = s.optString("error", "");
            if (!err.isEmpty() && !"null".equals(err)) { fail("The game stopped: " + err); return; }
            if (!s.optBoolean("running") && started) { finish(); return; }
            String msg = s.optString("message", "");
            if (!msg.isEmpty() && !"null".equals(msg) && !msg.equals(lastMessage)) { lastMessage = msg; Toast.makeText(this, msg, Toast.LENGTH_SHORT).show(); }
            // How the game runs (speed, frame time, sound), every 10 s: the host
            // keeps the latest per phone so problems can be seen without a cable.
            if (System.currentTimeMillis() - lastReport > 10000 && s.optDouble("fps", 0) > 0) {
                lastReport = System.currentTimeMillis();
                s.put("game", extra("title")).put("platform", extra("platform")).put("coreId", extra("core"))
                 .put("device", android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL).put("android", android.os.Build.VERSION.RELEASE);
                final String body = s.toString();
                new Thread(() -> post("/api/engine/android/report", body)).start();
            }
        } catch (Exception ignored) { /* next time */ }
        ui.postDelayed(this::poll, 500);
    }

    @Override public void surfaceCreated(SurfaceHolder h) {}

    @Override public void surfaceChanged(SurfaceHolder h, int format, int w, int hgt) {
        surfaceReady = true;
        if (started) NxEngine.nativeSurface(h.getSurface()); else maybeStart();
    }

    @Override public void surfaceDestroyed(SurfaceHolder h) {
        surfaceReady = false;
        if (started) NxEngine.nativeSurface(null);
    }

    @Override protected void onPause() { super.onPause(); if (started) NxEngine.nativePause(true); }

    @Override protected void onResume() { super.onResume(); hideBars(); if (started) NxEngine.nativePause(false); }

    @Override protected void onDestroy() {
        closing = true;
        if (started) NxEngine.nativeStop();
        super.onDestroy();
    }

    @Override public void onBackPressed() {
        if (!started) { super.onBackPressed(); return; }
        NxEngine.nativePause(true);
        File states = getExternalFilesDir("states");
        String name = new File(extra("game")).getName();
        String state = new File(states != null ? states : getFilesDir(), name + ".state").getAbsolutePath();
        new AlertDialog.Builder(this)
                .setTitle(extra("title"))
                .setItems(new CharSequence[] { "Resume", "Save state", "Load state", "Quit" }, (d, which) -> {
                    if (which == 1) NxEngine.nativeSaveState(state);
                    if (which == 2) NxEngine.nativeLoadState(state);
                    if (which == 3) { closing = true; NxEngine.nativeStop(); finish(); return; }
                    NxEngine.nativePause(false);
                    hideBars();
                })
                .setOnCancelListener(d -> { NxEngine.nativePause(false); hideBars(); })
                .show();
    }

    // ── Controllers ──────────────────────────────────────────────────────
    private void sendInput() {
        NxEngine.nativeInput(0, touchBits | padBits | hatBits | triggerBits, lx, ly, rx, ry);
    }

    private static int bitFor(int keyCode) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_BUTTON_A: return TouchPad.B;      // bottom face button
            case KeyEvent.KEYCODE_BUTTON_B: return TouchPad.A;      // right
            case KeyEvent.KEYCODE_BUTTON_X: return TouchPad.Y;      // left
            case KeyEvent.KEYCODE_BUTTON_Y: return TouchPad.X;      // top
            case KeyEvent.KEYCODE_BUTTON_L1: return TouchPad.L;
            case KeyEvent.KEYCODE_BUTTON_R1: return TouchPad.R;
            case KeyEvent.KEYCODE_BUTTON_L2: return 12;
            case KeyEvent.KEYCODE_BUTTON_R2: return 13;
            case KeyEvent.KEYCODE_BUTTON_THUMBL: return 14;
            case KeyEvent.KEYCODE_BUTTON_THUMBR: return 15;
            case KeyEvent.KEYCODE_BUTTON_START: return TouchPad.START;
            case KeyEvent.KEYCODE_BUTTON_SELECT: return TouchPad.SELECT;
            case KeyEvent.KEYCODE_DPAD_UP: return TouchPad.UP;
            case KeyEvent.KEYCODE_DPAD_DOWN: return TouchPad.DOWN;
            case KeyEvent.KEYCODE_DPAD_LEFT: return TouchPad.LEFT;
            case KeyEvent.KEYCODE_DPAD_RIGHT: return TouchPad.RIGHT;
            default: return -1;
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int bit = bitFor(e.getKeyCode());
        boolean fromPad = (e.getSource() & (InputDevice.SOURCE_GAMEPAD | InputDevice.SOURCE_JOYSTICK)) != 0;
        if (bit >= 0 && started && (fromPad || e.getKeyCode() >= KeyEvent.KEYCODE_DPAD_UP && e.getKeyCode() <= KeyEvent.KEYCODE_DPAD_RIGHT)) {
            if (e.getAction() == KeyEvent.ACTION_DOWN) padBits |= 1 << bit;
            else if (e.getAction() == KeyEvent.ACTION_UP) padBits &= ~(1 << bit);
            pad.setShown(false);
            sendInput();
            return true;
        }
        // The controller's Home/Guide or Mode opens the menu like Back.
        if (e.getKeyCode() == KeyEvent.KEYCODE_BUTTON_MODE && e.getAction() == KeyEvent.ACTION_UP) { onBackPressed(); return true; }
        return super.dispatchKeyEvent(e);
    }

    @Override
    public boolean dispatchGenericMotionEvent(MotionEvent e) {
        if (started && (e.getSource() & InputDevice.SOURCE_JOYSTICK) != 0 && e.getAction() == MotionEvent.ACTION_MOVE) {
            lx = axis(e, MotionEvent.AXIS_X);
            ly = axis(e, MotionEvent.AXIS_Y);
            rx = axis(e, MotionEvent.AXIS_Z);
            ry = axis(e, MotionEvent.AXIS_RZ);
            float hx = e.getAxisValue(MotionEvent.AXIS_HAT_X), hy = e.getAxisValue(MotionEvent.AXIS_HAT_Y);
            hatBits = (hx < -0.5f ? 1 << TouchPad.LEFT : 0) | (hx > 0.5f ? 1 << TouchPad.RIGHT : 0) | (hy < -0.5f ? 1 << TouchPad.UP : 0) | (hy > 0.5f ? 1 << TouchPad.DOWN : 0);
            float lt = Math.max(e.getAxisValue(MotionEvent.AXIS_LTRIGGER), e.getAxisValue(MotionEvent.AXIS_BRAKE));
            float rt = Math.max(e.getAxisValue(MotionEvent.AXIS_RTRIGGER), e.getAxisValue(MotionEvent.AXIS_GAS));
            triggerBits = (lt > 0.5f ? 1 << 12 : 0) | (rt > 0.5f ? 1 << 13 : 0);
            pad.setShown(false);
            sendInput();
            return true;
        }
        return super.dispatchGenericMotionEvent(e);
    }

    private static int axis(MotionEvent e, int a) {
        float v = e.getAxisValue(a);
        if (Math.abs(v) < 0.12f) v = 0; // dead zone
        return (int) Math.max(-32767, Math.min(32767, v * 32767));
    }

    @Override
    public boolean onTouchEvent(MotionEvent e) {
        // Touching the screen brings the on-screen controls back.
        pad.setShown(true);
        return super.onTouchEvent(e);
    }
}
