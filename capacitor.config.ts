import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Android TV / Fire TV packaging.
 *
 * This is a THIN CLIENT, not a bundled copy of the app. server.url points at
 * the live host, so the TV always runs the current build and a fix does not
 * require re-sideloading an APK onto every box.
 *
 * The bundled webDir still matters: it is what the WebView shows if the host
 * is unreachable, instead of a blank screen.
 *
 * NEXUS_APK_URL overrides the target at build time, so the same script can
 * produce a LAN build (http://192.168.x.x:3000) for a box that should not
 * depend on the tunnel.
 */
const target = process.env.NEXUS_APK_URL ?? 'https://savestate.co.za';

const config: CapacitorConfig = {
  appId: 'com.savestate.nexus',
  appName: 'NexusEmu',
  webDir: 'dist',
  android: {
    // The TV UI paints its own dark ground; allowing mixed content would let a
    // plain-http LAN build load, which is the point of NEXUS_APK_URL.
    allowMixedContent: true,
    backgroundColor: '#0b0d10',
  },
  server: {
    url: target,
    cleartext: target.startsWith('http://'),
    // Without this the WebView treats the remote origin as foreign and drops
    // localStorage between launches, losing the session token and the theme.
    androidScheme: target.startsWith('http://') ? 'http' : 'https',
  },
  plugins: {
    CapacitorHttp: { enabled: true },
  },
};

export default config;
