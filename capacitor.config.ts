/**
 * LEARNING NOTE: Capacitor — shipping a web game as a native Android app
 *
 * Capacitor wraps the built web game (the `webDir` folder) in a native Android
 * project. At run time a full-screen Android WebView — the same Chromium engine
 * as Chrome, with hardware-accelerated WebGL 2 — loads the game from the APK's
 * own assets over a virtual https://localhost origin, so everything works offline
 * and module workers, WebGL and localStorage behave exactly as on the web.
 * Plugins bridge the few things a web page can't do: haptics, the Back button,
 * the launch screen, app lifecycle events.
 *
 * Key concepts: hybrid apps, WebView, native bridges, app identity (applicationId)
 */
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.github.saatvik1808.apogee',
  appName: 'APOGEE',
  webDir: 'dist-android',
  backgroundColor: '#05070c',
  android: {
    backgroundColor: '#05070c',
    allowMixedContent: false,
    initialFocus: true,
  },
  plugins: {
    // Immersive full screen; cut-out insets arrive as --safe-area-inset-* CSS variables
    SystemBars: {
      hidden: true,
      style: 'DARK',
      insetsHandling: 'css',
      initialViewportFitValueHint: 'cover',
    },
    SplashScreen: {
      // The game hides it as soon as its own loading screen is up; the auto-hide
      // is a safety net so the launch screen can never get stuck
      launchAutoHide: true,
      launchShowDuration: 2500,
      backgroundColor: '#05070c',
      showSpinner: false,
      androidScaleType: 'CENTER_CROP',
    },
  },
};

export default config;
