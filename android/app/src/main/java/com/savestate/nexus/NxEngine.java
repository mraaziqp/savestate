package com.savestate.nexus;

import android.os.Build;
import android.view.Surface;

/**
 * SaveState Engine inside the app (Phase 7): libsavestate_engine.so runs a
 * libretro core and draws straight to a Surface (engine/engine/src/android).
 * One game at a time.
 */
public final class NxEngine {
    private static boolean loaded;
    private static String loadError = "";

    static {
        if (!is64BitArm()) {
            loadError = "This phone's processor isn't 64-bit ARM; games play in the emulator apps instead.";
        } else {
            try {
                System.loadLibrary("savestate_engine");
                loaded = true;
            } catch (Throwable t) {
                loadError = "The game engine didn't load: " + t.getMessage();
            }
        }
    }

    private NxEngine() {}

    static boolean is64BitArm() {
        for (String abi : Build.SUPPORTED_64_BIT_ABIS) if ("arm64-v8a".equals(abi)) return true;
        return false;
    }

    /** True when games can play inside the app on this phone. */
    public static boolean available() { return loaded && Build.VERSION.SDK_INT >= 26; }

    public static String unavailableReason() {
        if (Build.VERSION.SDK_INT < 26) return "Playing inside SaveState needs Android 8.0 or newer.";
        return loadError;
    }

    public static native void nativeStart(String core, String game, String systemDir, String saveDir, String cacheDir, Surface surface);
    public static native void nativeSurface(Surface surface);
    public static native void nativeInput(int port, int buttons, int lx, int ly, int rx, int ry);
    public static native void nativePause(boolean paused);
    public static native void nativeSaveState(String path);
    public static native void nativeLoadState(String path);
    public static native void nativeStop();
    public static native String nativeStatus();
}
