package com.savestate.nexus;

import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.StatFs;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.MimeTypeMap;
import android.webkit.URLUtil;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * What the web app needs from Android that a WebView can't do by itself
 * (window.Capacitor.nativePromise("NxAndroid", method, options)):
 *
 *   download  saves a game (or BIOS) to Downloads/SaveState/<folder>/ with
 *             Android's download manager, so a 4 GB PS2 game keeps going with
 *             the screen off and shows in the notification shade.
 *   progress  how far a download is.
 *   open      hands a downloaded game to an emulator app on this phone
 *             (PPSSPP, NetherSX2, Dolphin...), or to whichever app opens it.
 *   apps      which of the given emulator apps are installed.
 *   saveData  saves a file the page made itself (a blob: download).
 *   orientation  "landscape" turns the screen sideways for a game (by the
 *             sensor, so either way up), even with auto-rotate off; "auto"
 *             gives it back to the phone's own setting.
 *
 * Plain links the page downloads (Export, a ROM's Download button) went
 * nowhere before: a Capacitor WebView ignores downloads unless told what to
 * do with them. MainActivity sends those to download() as well.
 */
@CapacitorPlugin(name = "NxAndroid")
public class NxAndroidPlugin extends Plugin {
    static final int VERSION = 5;

    private DownloadManager dm() {
        return (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
    }

    /**
     * The download id the page sent. Capacitor's getLong() returns its default
     * for a number that fits an int (org.json makes those Integers), and
     * download ids always do: every id arrived as -1, so a finished game never
     * opened ("isn't on this phone any more") and progress said "gone"
     * (2026-10-21).
     */
    private static long idOf(PluginCall call) {
        Object v = call.getData().opt("id");
        if (v instanceof Number) return ((Number) v).longValue();
        if (v instanceof String) {
            try { return Long.parseLong((String) v); } catch (NumberFormatException e) { /* below */ }
        }
        return -1;
    }

    /** Downloads/SaveState/<folder>/<fileName>, as download() names it. */
    private static File targetOf(String folder, String fileName) {
        String sub = "SaveState" + (folder.isEmpty() ? "" : "/" + folder);
        return new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), sub + "/" + fileName);
    }

    private static String safe(String s, String fallback) {
        String out = s == null ? "" : s.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        return out.isEmpty() ? fallback : out;
    }

    /** Starts a download into Downloads/SaveState/<folder>/; returns its id. */
    static long enqueue(Context ctx, String url, String folder, String fileName, String auth, String title) {
        String sub = "SaveState" + (folder == null || folder.isEmpty() ? "" : "/" + folder);
        File destDir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), sub);
        if (!destDir.exists()) destDir.mkdirs();
        File targetFile = new File(destDir, fileName);
        if (targetFile.exists() && targetFile.length() == 0) {
            targetFile.delete();
        }
        DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
        String cookies = CookieManager.getInstance().getCookie(url);
        if (cookies != null) req.addRequestHeader("Cookie", cookies);
        if (auth != null && !auth.isEmpty()) req.addRequestHeader("Authorization", "Bearer " + auth);
        req.setTitle(title != null && !title.isEmpty() ? title : fileName);
        req.setDescription("SaveState");
        req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        req.setAllowedOverMetered(true);
        req.setAllowedOverRoaming(false);
        req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, sub + "/" + fileName);
        DownloadManager dm = (DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE);
        return dm.enqueue(req);
    }

    @PluginMethod
    public void storageInfo(PluginCall call) {
        JSObject r = new JSObject();
        try {
            File path = Environment.getExternalStorageDirectory();
            StatFs stat = new StatFs(path.getPath());
            long availableBytes = stat.getAvailableBytes();
            long totalBytes = stat.getTotalBytes();
            r.put("freeBytes", availableBytes);
            r.put("totalBytes", totalBytes);
            r.put("freeMB", availableBytes / (1024 * 1024));
            r.put("totalMB", totalBytes / (1024 * 1024));
            r.put("freeGB", (double) availableBytes / (1024.0 * 1024.0 * 1024.0));
            r.put("totalGB", (double) totalBytes / (1024.0 * 1024.0 * 1024.0));
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Failed to retrieve storage info: " + e.getMessage());
        }
    }

    @PluginMethod
    public void pruneDownloads(PluginCall call) {
        JSObject r = new JSObject();
        int cleaned = 0;
        try {
            File base = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "SaveState");
            if (base.exists() && base.isDirectory()) {
                cleaned = purgeEmptyOrCorrupt(base);
            }
            r.put("cleaned", cleaned);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Failed to prune downloads: " + e.getMessage());
        }
    }

    private static int purgeEmptyOrCorrupt(File dir) {
        int count = 0;
        File[] files = dir.listFiles();
        if (files == null) return 0;
        for (File f : files) {
            if (f.isDirectory()) {
                count += purgeEmptyOrCorrupt(f);
            } else if (f.isFile() && f.length() == 0 && System.currentTimeMillis() - f.lastModified() > 3600_000L) {
                // Only left-overs: a download that has just started is an empty
                // file too, and deleting it broke that download.
                if (f.delete()) count++;
            }
        }
        return count;
    }

    /** Whether games can play inside SaveState on this phone (Phase 7): { available, reason }. */
    @PluginMethod
    public void engine(PluginCall call) {
        JSObject r = new JSObject();
        r.put("available", NxEngine.available());
        r.put("reason", NxEngine.available() ? "" : NxEngine.unavailableReason());
        call.resolve(r);
    }

    /**
     * Plays a game already in Downloads/SaveState/<folder>/<fileName> inside
     * SaveState (GameActivity) with SaveState's own core `core` from `origin`.
     */
    @PluginMethod
    public void play(PluginCall call) {
        if (!NxEngine.available()) { call.reject(NxEngine.unavailableReason()); return; }
        String folder = safe(call.getString("folder", ""), "");
        String fileName = safe(call.getString("fileName", ""), "");
        File game = targetOf(folder, fileName);
        if (fileName.isEmpty() || !game.exists()) { call.reject("The game isn't on this phone yet. Press Play to download it."); return; }
        android.app.Activity a = getActivity();
        if (a == null) { call.reject("SaveState isn't open."); return; }
        Intent i = new Intent(a, GameActivity.class);
        i.putExtra("origin", call.getString("origin", ""));
        i.putExtra("token", call.getString("token", ""));
        i.putExtra("core", call.getString("core", ""));
        i.putExtra("platform", call.getString("platform", ""));
        i.putExtra("title", call.getString("title", fileName));
        i.putExtra("game", game.getAbsolutePath());
        a.startActivity(i);
        JSObject r = new JSObject();
        r.put("opened", "engine");
        call.resolve(r);
    }

    @PluginMethod
    public void info(PluginCall call) {
        JSObject r = new JSObject();
        r.put("version", VERSION);
        call.resolve(r);
    }

    @PluginMethod
    public void orientation(PluginCall call) {
        String mode = call.getString("mode", "auto");
        android.app.Activity a = getActivity();
        if (a == null) { call.reject("No screen to turn."); return; }
        final int want = "landscape".equals(mode)
            ? android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            : android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
        a.runOnUiThread(() -> a.setRequestedOrientation(want));
        call.resolve();
    }

    @PluginMethod
    public void apps(PluginCall call) {
        JSArray list = call.getArray("packages", new JSArray());
        JSObject r = new JSObject();
        PackageManager pm = getContext().getPackageManager();
        try {
            for (int i = 0; i < list.length(); i++) {
                String pkg = list.getString(i);
                boolean have;
                try { pm.getPackageInfo(pkg, 0); have = true; } catch (PackageManager.NameNotFoundException e) { have = false; }
                r.put(pkg, have);
            }
        } catch (Exception e) { /* a bad entry: report the rest */ }
        call.resolve(r);
    }

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) { call.reject("No address to download from."); return; }
        String folder = safe(call.getString("folder", ""), "");
        String fileName = safe(call.getString("fileName", URLUtil.guessFileName(url, null, null)), "download");
        String sub = "SaveState" + (folder.isEmpty() ? "" : "/" + folder);
        File target = targetOf(folder, fileName);
        // Already here from an earlier Play: use that copy.
        long done = findDone(target);
        if (done >= 0) {
            JSObject r = new JSObject();
            r.put("id", done); r.put("done", true); r.put("path", "Downloads/" + sub + "/" + fileName);
            call.resolve(r);
            return;
        }
        try {
            long id = enqueue(getContext(), url, folder, fileName, call.getString("token", ""), call.getString("title", fileName));
            JSObject r = new JSObject();
            r.put("id", id); r.put("done", false); r.put("path", "Downloads/" + sub + "/" + fileName);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Couldn't start the download: " + e.getMessage());
        }
    }

    /** Where the download manager saved download `id`, or null. */
    private File fileOfDownload(long id) {
        if (id < 0) return null;
        try (Cursor c = dm().query(new DownloadManager.Query().setFilterById(id))) {
            if (c == null || !c.moveToFirst()) return null;
            String local = c.getString(c.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI));
            String p = local == null ? null : Uri.parse(local).getPath();
            return p == null ? null : new File(p);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * An address for a file that another app can look up and open once it's
     * granted read access: this app's FileProvider when the app can read the
     * file (it downloaded it), else the file's MediaStore entry in Downloads.
     */
    private static Uri shareable(Context ctx, File f) {
        if (f.canRead()) {
            try { return FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", f); } catch (Exception e) { /* below */ }
        }
        if (Build.VERSION.SDK_INT >= 29) {
            String root = Environment.getExternalStorageDirectory().getAbsolutePath() + "/";
            File dir = f.getParentFile();
            String parent = dir == null ? "" : dir.getAbsolutePath();
            if (parent.startsWith(root)) {
                String rel = parent.substring(root.length()) + "/";
                String[] cols = { MediaStore.MediaColumns._ID };
                try (Cursor c = ctx.getContentResolver().query(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cols,
                        MediaStore.MediaColumns.DISPLAY_NAME + "=? AND " + MediaStore.MediaColumns.RELATIVE_PATH + "=?",
                        new String[] { f.getName(), rel }, null)) {
                    if (c != null && c.moveToFirst()) return ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI, c.getLong(0));
                } catch (Exception e) { /* none */ }
            }
        }
        return null;
    }

    /** Whether Downloads/SaveState/<folder>/<fileName> is already on the phone: { id, done }. */
    @PluginMethod
    public void find(PluginCall call) {
        long id = findDone(targetOf(safe(call.getString("folder", ""), ""), safe(call.getString("fileName", ""), "download")));
        JSObject r = new JSObject();
        r.put("id", id);
        r.put("done", id >= 0);
        call.resolve(r);
    }

    /** A finished download of this exact file whose file is still there, or -1. */
    private long findDone(File target) {
        DownloadManager.Query q = new DownloadManager.Query().setFilterByStatus(DownloadManager.STATUS_SUCCESSFUL);
        try (Cursor c = dm().query(q)) {
            if (c == null) return -1;
            int idCol = c.getColumnIndex(DownloadManager.COLUMN_ID);
            int uriCol = c.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI);
            int sizeCol = c.getColumnIndex(DownloadManager.COLUMN_TOTAL_SIZE_BYTES);
            while (c.moveToNext()) {
                String local = c.getString(uriCol);
                if (local == null) continue;
                String p = Uri.parse(local).getPath();
                if (p != null && p.equals(target.getAbsolutePath()) && target.exists() && target.length() > 0
                        && (c.getLong(sizeCol) <= 0 || c.getLong(sizeCol) == target.length())) return c.getLong(idCol);
            }
        } catch (Exception e) { /* treat as not downloaded */ }
        return -1;
    }

    @PluginMethod
    public void progress(PluginCall call) {
        long id = idOf(call);
        JSObject r = new JSObject();
        try (Cursor c = dm().query(new DownloadManager.Query().setFilterById(id))) {
            if (c == null || !c.moveToFirst()) { r.put("status", "gone"); call.resolve(r); return; }
            int st = c.getInt(c.getColumnIndex(DownloadManager.COLUMN_STATUS));
            r.put("bytes", c.getLong(c.getColumnIndex(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)));
            r.put("total", c.getLong(c.getColumnIndex(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)));
            int reason = c.getInt(c.getColumnIndex(DownloadManager.COLUMN_REASON));
            r.put("reason", reason);
            r.put("status", st == DownloadManager.STATUS_SUCCESSFUL ? "done"
                    : st == DownloadManager.STATUS_FAILED ? "failed"
                    : st == DownloadManager.STATUS_PAUSED ? "paused"
                    : st == DownloadManager.STATUS_PENDING ? "waiting" : "running");
            if (st == DownloadManager.STATUS_FAILED) r.put("error", failure(reason));
            if (st == DownloadManager.STATUS_PAUSED) r.put("error", pause(reason));
        } catch (Exception e) {
            r.put("status", "gone");
        }
        call.resolve(r);
    }

    private static String failure(int reason) {
        switch (reason) {
            case DownloadManager.ERROR_INSUFFICIENT_SPACE: {
                try {
                    StatFs stat = new StatFs(Environment.getExternalStorageDirectory().getPath());
                    long free = stat.getAvailableBytes();
                    if (free > 1024L * 1024L * 1024L) {
                        return "Download paused: DownloadManager cache partition is full (" + (free / (1024 * 1024 * 1024)) + " GB free on disk). Clear old downloads or use browser download.";
                    }
                } catch (Exception e) {}
                return "This phone ran out of space.";
            }
            case DownloadManager.ERROR_DEVICE_NOT_FOUND: return "The phone's storage isn't available.";
            case DownloadManager.ERROR_HTTP_DATA_ERROR: return "The connection dropped. Try again.";
            case DownloadManager.ERROR_TOO_MANY_REDIRECTS: return "The server sent it somewhere else too many times.";
            case 401: case 403: return "The server said no (sign in again, or ask the host for game access).";
            case 404: return "The host can't find this game's file any more.";
            case 409: return "The host is still downloading this game. It plays once that finishes.";
            default: return reason >= 400 ? "The server couldn't send it (error " + reason + ")." : "The download stopped. Try again.";
        }
    }

    private static String pause(int reason) {
        switch (reason) {
            case DownloadManager.PAUSED_QUEUED_FOR_WIFI: return "Waiting for Wi-Fi (it's too big for mobile data by default).";
            case DownloadManager.PAUSED_WAITING_FOR_NETWORK: return "Waiting for a connection.";
            case DownloadManager.PAUSED_WAITING_TO_RETRY: return "The connection dropped; trying again.";
            default: return "Paused.";
        }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        long id = idOf(call);
        if (id >= 0) dm().remove(id);
        call.resolve();
    }

    /**
     * Opens a downloaded game. `app` picks how:
     *   "view"      ACTION_VIEW, in `pkg` when given (PPSSPP, Azahar, Flycast...)
     *   "bootPath"  the app's launcher with a "bootPath" extra (NetherSX2 / AetherSX2)
     *   "autostart" the app's launcher with "AutoStartFiles" (Dolphin)
     * When that app can't take it, the app is opened by itself so the game can
     * be picked from Downloads/SaveState; with no app at all, Android asks.
     */
    @PluginMethod
    public void open(PluginCall call) {
        long id = idOf(call);
        String pkg = call.getString("pkg", "");
        String mode = call.getString("mode", "view");
        Context ctx = getContext();
        String folder = safe(call.getString("folder", ""), "");
        String fileName = safe(call.getString("fileName", ""), "");
        // The game's file: Downloads/SaveState/<folder>/<name>, else wherever
        // the download manager put download `id`.
        File target = fileName.isEmpty() ? null : targetOf(folder, fileName);
        if (target == null || !target.exists()) target = fileOfDownload(id);
        // Emulators get an address they can read: the download manager's own
        // (content://downloads/all_downloads/N) can't be looked up by other
        // apps, so Dolphin said the file "does not exist" (2026-10-21).
        Uri uri = target != null && target.exists() ? shareable(ctx, target) : null;
        if (uri == null) {
            try { uri = dm().getUriForDownloadedFile(id); } catch (Exception e) { /* below */ }
        }
        // An id this phone no longer knows (a reinstall, a cleared download
        // list): the same file in Downloads/SaveState still plays.
        if (uri == null && !fileName.isEmpty()) {
            long byFile = findDone(targetOf(folder, fileName));
            if (byFile >= 0) {
                id = byFile;
                try { uri = dm().getUriForDownloadedFile(id); } catch (Exception e) { /* below */ }
            }
        }
        if (uri == null) {
            if (target != null && target.exists() && !pkg.isEmpty()) {
                // There, but not from this app's downloads (copied in by hand):
                // open the emulator so it can be chosen from that folder.
                Intent plain = ctx.getPackageManager().getLaunchIntentForPackage(pkg);
                if (plain != null) {
                    plain.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    try { ctx.startActivity(plain); JSObject r = new JSObject(); r.put("opened", "app"); call.resolve(r); return; } catch (Exception ignored) { /* below */ }
                }
            }
            call.reject("The downloaded game isn't on this phone any more. Press Play again to download it.");
            return;
        }
        String mime = null;
        if (target != null) {
            String ext = MimeTypeMap.getFileExtensionFromUrl(Uri.fromFile(target).toString());
            if (ext != null && !ext.isEmpty()) mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase());
        }
        if (mime == null || mime.isEmpty()) {
            try { mime = dm().getMimeTypeForDownloadedFile(id); } catch (Exception e) { /* below */ }
        }
        if (mime == null || mime.isEmpty()) mime = "application/octet-stream";
        PackageManager pm = ctx.getPackageManager();
        JSObject r = new JSObject();
        try {
            Intent i;
            if (!pkg.isEmpty() && !"view".equals(mode)) {
                i = pm.getLaunchIntentForPackage(pkg);
                if (i == null) throw new ActivityNotFoundException(pkg);
                if ("bootPath".equals(mode)) i.putExtra("bootPath", uri.toString());
                if ("autostart".equals(mode)) i.putExtra("AutoStartFiles", new String[] { uri.toString() });
            } else {
                i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(uri, mime);
                if (!pkg.isEmpty()) i.setPackage(pkg);
            }
            i.setClipData(ClipData.newRawUri("game", uri));
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            if (!pkg.isEmpty()) ctx.grantUriPermission(pkg, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if (pkg.isEmpty()) i = Intent.createChooser(i, "Play with").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            r.put("opened", pkg.isEmpty() ? "chooser" : "game");
            call.resolve(r);
        } catch (Exception first) {
            // The app is there but didn't take the file this way: open it by itself.
            Intent plain = pkg.isEmpty() ? null : pm.getLaunchIntentForPackage(pkg);
            if (plain != null) {
                plain.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try { ctx.startActivity(plain); r.put("opened", "app"); call.resolve(r); return; } catch (Exception ignored) { /* below */ }
            }
            call.reject(pkg.isEmpty() ? "No app on this phone opens this kind of game." : "That emulator isn't installed on this phone.");
        }
    }

    /** Saves base64 data (a file the page built) to Downloads/SaveState/. Chunked: first=true starts it. */
    @PluginMethod
    public void saveData(PluginCall call) {
        String name = safe(call.getString("fileName", "download"), "download");
        String data = call.getString("data", "");
        boolean first = Boolean.TRUE.equals(call.getBoolean("first", true));
        byte[] bytes = Base64.decode(data, Base64.DEFAULT);
        // Android 10 lets an app write into Downloads only through the download
        // manager; there it lands in the app's own Downloads folder instead.
        File[] places = {
            new File(new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "SaveState"), name),
            new File(getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), name),
        };
        String last = "";
        for (File out : places) {
            try {
                File dir = out.getParentFile();
                if (dir != null && !dir.exists()) dir.mkdirs();
                try (OutputStream os = new FileOutputStream(out, !first)) { os.write(bytes); }
                JSObject r = new JSObject();
                r.put("path", out.getAbsolutePath());
                call.resolve(r);
                return;
            } catch (Exception e) { last = e.getMessage(); }
        }
        call.reject("Couldn't save it on this phone: " + last);
    }
}
