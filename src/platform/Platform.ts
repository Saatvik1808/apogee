/**
 * LEARNING NOTE: One codebase, two platforms
 *
 * The same TypeScript runs in a desktop browser and inside the Android app — a
 * Capacitor shell that hosts the game in the system WebView and bridges a few
 * native features to JavaScript. Instead of scattering "if Android" checks we
 * detect CAPABILITIES once (is the primary pointer a finger? is this the native
 * shell?) and expose a tiny service: haptic feedback, the hardware Back button,
 * and app pause/resume. Rendering, physics and UI stay 100 % shared.
 *
 * Mobile apps also have a LIFECYCLE the web mostly hides: the OS can background
 * the app at any moment (a phone call, the home button). A game must pause its
 * simulation and silence audio when that happens, or the player comes back to a
 * crashed rocket.
 *
 * Key concepts: feature detection vs. user-agent sniffing, platform abstraction,
 * app lifecycle, haptic feedback, back-stack navigation
 */
import { Capacitor } from '@capacitor/core';
import { App as NativeApp } from '@capacitor/app';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { SplashScreen } from '@capacitor/splash-screen';

export type HapticKind = 'tick' | 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error';

/** A Back-button handler returns true when it consumed the press. */
export type BackHandler = () => boolean;

export class Platform {
  /** Running inside the native Android shell. */
  readonly native: boolean;
  readonly android: boolean;
  /** Primary input is a touchscreen (phones, tablets). */
  readonly touchDevice: boolean;
  /** Touch controls wanted (device default, overridable in settings). */
  touch: boolean;
  haptics = true;
  private readonly backStack: BackHandler[] = [];
  private readonly pauseCbs: Array<() => void> = [];
  private readonly resumeCbs: Array<() => void> = [];
  private lastBack = 0;
  /** Shown when Back is pressed with nothing left to close. */
  onExitHint: (() => void) | null = null;

  constructor() {
    this.native = Capacitor.isNativePlatform();
    this.android = Capacitor.getPlatform() === 'android' || /Android/i.test(navigator.userAgent);
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    this.touchDevice = this.native || coarse;
    this.touch = this.touchDevice;
    const root = document.documentElement;
    root.classList.toggle('is-native', this.native);
    root.classList.toggle('is-android', this.android);
    this.applyTouchClass();

    if (this.native) {
      void NativeApp.addListener('backButton', () => this.back());
      void NativeApp.addListener('pause', () => this.firePause());
      void NativeApp.addListener('resume', () => this.fireResume());
    }
    document.addEventListener('visibilitychange', () => (document.hidden ? this.firePause() : this.fireResume()));
  }

  setTouch(on: boolean): void {
    this.touch = on;
    this.applyTouchClass();
  }

  private applyTouchClass(): void {
    document.documentElement.classList.toggle('is-touch', this.touch);
  }

  /** Hide the native launch screen once our own loading UI is on screen. */
  hideSplash(): void {
    if (this.native) void SplashScreen.hide({ fadeOutDuration: 250 }).catch(() => undefined);
  }

  haptic(kind: HapticKind): void {
    if (!this.haptics || !this.touchDevice) return;
    if (!this.native) {
      // Web fallback: the Vibration API (Android Chrome); silently absent elsewhere
      const ms = kind === 'tick' ? 6 : kind === 'light' ? 10 : kind === 'medium' ? 18 : kind === 'heavy' ? 35 : 25;
      if (typeof navigator.vibrate === 'function') navigator.vibrate(ms);
      return;
    }
    const p =
      kind === 'success'
        ? Haptics.notification({ type: NotificationType.Success })
        : kind === 'warning'
          ? Haptics.notification({ type: NotificationType.Warning })
          : kind === 'error'
            ? Haptics.notification({ type: NotificationType.Error })
            : kind === 'tick'
              ? Haptics.selectionChanged()
              : Haptics.impact({ style: kind === 'light' ? ImpactStyle.Light : kind === 'medium' ? ImpactStyle.Medium : ImpactStyle.Heavy });
    void p.catch(() => undefined);
  }

  /** Register a Back handler; the most recent one gets the first chance. Returns an unregister function. */
  pushBack(handler: BackHandler): () => void {
    this.backStack.push(handler);
    return () => {
      const i = this.backStack.lastIndexOf(handler);
      if (i >= 0) this.backStack.splice(i, 1);
    };
  }

  /** Dispatch a Back press (hardware button, or Escape on desktop). */
  back(): void {
    for (let i = this.backStack.length - 1; i >= 0; i--) {
      if (this.backStack[i]!()) return;
    }
    if (!this.native) return;
    // Nothing left to close: press twice within 2 s to leave the app
    const now = performance.now();
    if (now - this.lastBack < 2000) void NativeApp.exitApp();
    else {
      this.lastBack = now;
      this.onExitHint?.();
    }
  }

  onPause(cb: () => void): () => void {
    this.pauseCbs.push(cb);
    return () => {
      const i = this.pauseCbs.indexOf(cb);
      if (i >= 0) this.pauseCbs.splice(i, 1);
    };
  }

  onResume(cb: () => void): () => void {
    this.resumeCbs.push(cb);
    return () => {
      const i = this.resumeCbs.indexOf(cb);
      if (i >= 0) this.resumeCbs.splice(i, 1);
    };
  }

  private firePause(): void {
    for (const cb of [...this.pauseCbs]) cb();
  }

  private fireResume(): void {
    for (const cb of [...this.resumeCbs]) cb();
  }
}
