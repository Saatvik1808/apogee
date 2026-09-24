/**
 * LEARNING NOTE: Procedural sound with the Web Audio API
 *
 * Web Audio is a graph: sources (oscillators, noise buffers) → processors
 * (filters, gains, compressors, convolution reverb) → the speakers. Everything
 * here is SYNTHESISED — no audio files:
 *
 *  • Rocket roar = brown noise (energy concentrated in the lows) through a low-pass
 *    filter whose cutoff and gain follow thrust. A second high-passed noise layer,
 *    amplitude-modulated by random bursts, gives the characteristic "crackle" of
 *    supersonic exhaust. In vacuum there is no air to carry sound, so we muffle
 *    everything to a low structure-borne rumble.
 *  • Wind = band-passed noise scaled by dynamic pressure q = ½ρv².
 *  • Music = slow chords from detuned oscillators through a generated reverb
 *    impulse response (exponentially decaying noise).
 *  • Callouts use the browser's speech synthesis.
 *
 * Browsers only allow audio after a user gesture, so the context resumes on the
 * first click/key press.
 *
 * Key concepts: audio graphs, noise colours, filters, envelopes, convolution
 * reverb, autoplay policies
 */

export interface AudioSettings {
  master: number;
  sfx: number;
  music: number;
  voice: boolean;
}

function noiseBuffer(ctx: AudioContext, seconds: number, brown: boolean): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      } else d[i] = w;
    }
  }
  return buf;
}

function impulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  private reverb!: ConvolverNode;
  private brown!: AudioBuffer;
  private white!: AudioBuffer;
  // engine layers
  private roarGain!: GainNode;
  private roarFilter!: BiquadFilterNode;
  private crackleGain!: GainNode;
  private crackleFilter!: BiquadFilterNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private musicTimer = 0;
  private musicStep = 0;
  private crackleEnv = 0;
  readonly settings: AudioSettings = { master: 0.8, sfx: 0.9, music: 0.45, voice: true };
  private musicIntensity = 1;
  private lastSpoken = new Map<string, number>();

  /** App sent to the background: stop all sound (and the audio thread). */
  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  }

  /** App back in the foreground. */
  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** Must be called from a user gesture. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master = ctx.createGain();
    this.master.gain.value = this.settings.master;
    this.master.connect(comp).connect(ctx.destination);
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.settings.sfx;
    this.sfxBus.connect(this.master);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.settings.music;
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = impulse(ctx, 5, 2.6);
    const wet = ctx.createGain();
    wet.gain.value = 0.9;
    this.musicBus.connect(this.reverb).connect(wet).connect(this.master);
    const dry = ctx.createGain();
    dry.gain.value = 0.25;
    this.musicBus.connect(dry).connect(this.master);
    this.brown = noiseBuffer(ctx, 4, true);
    this.white = noiseBuffer(ctx, 2, false);

    // Engine roar
    const roarSrc = ctx.createBufferSource();
    roarSrc.buffer = this.brown;
    roarSrc.loop = true;
    this.roarFilter = ctx.createBiquadFilter();
    this.roarFilter.type = 'lowpass';
    this.roarFilter.frequency.value = 300;
    this.roarFilter.Q.value = 0.6;
    this.roarGain = ctx.createGain();
    this.roarGain.gain.value = 0;
    roarSrc.connect(this.roarFilter).connect(this.roarGain).connect(this.sfxBus);
    roarSrc.start();
    // Crackle
    const crSrc = ctx.createBufferSource();
    crSrc.buffer = this.white;
    crSrc.loop = true;
    this.crackleFilter = ctx.createBiquadFilter();
    this.crackleFilter.type = 'bandpass';
    this.crackleFilter.frequency.value = 900;
    this.crackleFilter.Q.value = 0.8;
    this.crackleGain = ctx.createGain();
    this.crackleGain.gain.value = 0;
    crSrc.connect(this.crackleFilter).connect(this.crackleGain).connect(this.sfxBus);
    crSrc.start();
    // Wind
    const wSrc = ctx.createBufferSource();
    wSrc.buffer = this.white;
    wSrc.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 400;
    this.windFilter.Q.value = 1.2;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    wSrc.connect(this.windFilter).connect(this.windGain).connect(this.sfxBus);
    wSrc.start();
  }

  applySettings(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.settings.master, t, 0.1);
    this.sfxBus.gain.setTargetAtTime(this.settings.sfx, t, 0.1);
    this.musicBus.gain.setTargetAtTime(this.settings.music * this.musicIntensity, t, 0.5);
  }

  /** Music loudness multiplier (quieter during launch). */
  setMusicIntensity(v: number): void {
    this.musicIntensity = v;
    if (this.ctx) this.musicBus.gain.setTargetAtTime(this.settings.music * v, this.ctx.currentTime, 1.5);
  }

  /**
   * Continuous engine/wind sound.
   * @param thrustN current total thrust (N)
   * @param airFactor 0 in vacuum … 1 at sea level
   * @param q dynamic pressure (Pa)
   * @param distance camera distance to the engines (m)
   * @param solid fraction of thrust from solid motors (crackle)
   */
  updateFlight(thrustN: number, airFactor: number, q: number, distance: number, solid: number, dt: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const loud = Math.min(1, Math.log10(1 + thrustN / 1e4) / 3.4);
    const att = 1 / (1 + Math.max(0, distance - 30) / 400);
    const vac = 1 - airFactor;
    const roar = thrustN > 0 ? loud * (0.25 + 0.75 * airFactor) * (0.35 + 0.65 * att) : 0;
    this.roarGain.gain.setTargetAtTime(roar * 0.9, t, 0.08);
    this.roarFilter.frequency.setTargetAtTime(120 + 900 * airFactor * att * loud + 80 * vac, t, 0.1);
    // Crackle bursts
    this.crackleEnv = Math.max(0, this.crackleEnv - dt * 12);
    if (Math.random() < dt * (20 + 40 * solid)) this.crackleEnv = 0.4 + Math.random() * 0.6;
    const cr = thrustN > 0 ? loud * airFactor * att * (0.25 + 0.5 * solid) * this.crackleEnv : 0;
    this.crackleGain.gain.setTargetAtTime(cr * 0.5, t, 0.015);
    // Wind
    const w = Math.min(1, Math.sqrt(q / 40_000));
    this.windGain.gain.setTargetAtTime(w * 0.35, t, 0.2);
    this.windFilter.frequency.setTargetAtTime(250 + 1500 * w, t, 0.3);
  }

  silenceFlight(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.roarGain.gain.setTargetAtTime(0, t, 0.2);
    this.crackleGain.gain.setTargetAtTime(0, t, 0.1);
    this.windGain.gain.setTargetAtTime(0, t, 0.3);
  }

  private burst(freq: number, q: number, dur: number, gain: number, type: BiquadFilterType = 'lowpass', sweepTo?: number, delay = 0): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo !== undefined) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.sfxBus);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  private tone(freq: number, dur: number, gain: number, type: OscillatorType = 'sine', slideTo?: number, delay = 0): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.sfxBus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  stageSep(inAir: boolean): void {
    this.burst(inAir ? 1800 : 600, 0.7, 0.35, inAir ? 0.8 : 0.4, 'bandpass', 200);
    this.tone(70, 0.5, 0.7, 'sine', 35);
    this.burst(4000, 2, 0.08, 0.3, 'highpass');
  }

  explosion(big: boolean): void {
    this.burst(2500, 0.5, big ? 3.2 : 1.6, 1.0, 'lowpass', 60);
    this.tone(55, big ? 2.2 : 1.2, 0.9, 'sine', 25);
  }

  thud(): void {
    this.tone(60, 0.35, 0.6, 'sine', 30);
    this.burst(500, 1, 0.25, 0.4, 'lowpass', 100);
  }

  splash(): void {
    this.burst(1200, 0.6, 1.4, 0.7, 'lowpass', 150);
    this.burst(3000, 0.8, 0.5, 0.35, 'bandpass', 800);
    this.tone(50, 0.5, 0.5, 'sine', 30);
  }

  /**
   * Sonic boom: the classic double "boom-boom" — the bow shock and the tail
   * shock arrive ~0.1 s apart. Quieter and duller with distance, like thunder.
   */
  sonicBoom(distance: number): void {
    const att = 1 / (1 + Math.max(0, distance - 200) / 3000);
    const g = 0.9 * att;
    const cut = 300 + 1500 * att;
    this.burst(cut, 0.6, 0.35, g, 'lowpass', 60);
    this.tone(48, 0.4, 0.8 * att, 'sine', 28);
    this.burst(cut, 0.6, 0.35, g * 0.8, 'lowpass', 60, 0.11);
    this.tone(44, 0.4, 0.6 * att, 'sine', 26, 0.11);
  }

  private alarmTimer = 0;

  /** Master alarm: repeating two-tone warble while `on`. Call every frame. */
  updateAlarm(on: boolean, dt: number): void {
    if (!on) {
      this.alarmTimer = 0;
      return;
    }
    this.alarmTimer -= dt;
    if (this.alarmTimer > 0) return;
    this.alarmTimer = 0.75;
    this.tone(880, 0.16, 0.22, 'triangle');
    this.tone(660, 0.18, 0.22, 'triangle', undefined, 0.18);
  }

  chute(): void {
    this.burst(900, 0.6, 1.2, 0.5, 'bandpass', 300);
  }

  click(): void {
    this.tone(1400, 0.05, 0.15, 'triangle');
  }

  beep(high = false): void {
    this.tone(high ? 1320 : 880, 0.12, 0.2, 'square');
  }

  /** Quindar tone: 2,525 Hz keys a transmission on, 2,475 Hz keys it off (Apollo). */
  quindar(start: boolean): void {
    this.tone(start ? 2525 : 2475, 0.25, 0.07, 'sine');
  }

  ignition(): void {
    this.burst(300, 0.7, 1.4, 0.8, 'lowpass', 1400);
  }

  /** Ambient generative music; call every frame. */
  updateMusic(dt: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.musicTimer -= dt;
    if (this.musicTimer > 0) return;
    this.musicTimer = 7.5;
    // D dorian-ish progression voiced as open, airy chords
    const chords = [
      [146.83, 220.0, 329.63, 440.0, 523.25],
      [116.54, 233.08, 293.66, 349.23, 466.16],
      [174.61, 261.63, 329.63, 392.0, 523.25],
      [130.81, 196.0, 293.66, 392.0, 493.88],
    ];
    const ch = chords[this.musicStep++ % chords.length]!;
    const t = ctx.currentTime;
    for (const f of ch) {
      for (const det of [-4, 3]) {
        const o = ctx.createOscillator();
        o.type = det < 0 ? 'sine' : 'triangle';
        o.frequency.value = f;
        o.detune.value = det;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 1200;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.028, t + 2.5);
        g.gain.linearRampToValueAtTime(0.02, t + 6);
        g.gain.linearRampToValueAtTime(0, t + 9.5);
        o.connect(lp).connect(g).connect(this.musicBus);
        o.start(t);
        o.stop(t + 10);
      }
    }
    // Occasional high "star" note
    if (Math.random() < 0.6) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = ch[Math.floor(Math.random() * ch.length)]! * 4;
      const g = ctx.createGain();
      const s = t + 1 + Math.random() * 4;
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(0.012, s + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 3.5);
      o.connect(g).connect(this.musicBus);
      o.start(s);
      o.stop(s + 4);
    }
  }

  /** Mission-control style callout (rate-limited per phrase). */
  say(text: string, key = text, minGap = 30): void {
    if (!this.settings.voice || typeof speechSynthesis === 'undefined') return;
    const now = performance.now() / 1000;
    const last = this.lastSpoken.get(key) ?? -1e9;
    if (now - last < minGap) return;
    this.lastSpoken.set(key, now);
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02;
    u.pitch = 0.9;
    u.volume = Math.min(1, this.settings.master * 0.9);
    const voices = speechSynthesis.getVoices();
    const v = voices.find((x) => /en[-_]US/i.test(x.lang) && /male|daniel|alex|fred|google us/i.test(x.name)) ?? voices.find((x) => /^en/i.test(x.lang));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  }

  cancelSpeech(): void {
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  }

  /** A new flight starts: every call-out may be spoken again ("Liftoff!" after a quick revert). */
  resetCallouts(): void {
    this.lastSpoken.clear();
  }
}
