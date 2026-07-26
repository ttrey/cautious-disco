import { Vector3 } from 'three';
import { Rng, clamp } from '../util/math';

/**
 * Audio.
 *
 * Every sound is synthesised at runtime through the Web Audio graph. There is
 * no sample library available to this build, and shipping silence was not an
 * option — the brief lists sound design as mandatory. Synthesis also means each
 * shot is subtly different rather than the same wav retriggering, which is
 * what stops sustained automatic fire turning into a machine-gun buzz.
 *
 * Signal chain: sources → per-sound gain → optional panner → a shared
 * convolution reverb (generated impulse response) and a dry bus → master
 * compressor → destination. The compressor matters: without it, a shotgun and
 * six zombies at once clip hard.
 */

export interface GunAudioSpec {
  bodyHz: number;
  crack: number;
  tail: number;
  gain: number;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private dry!: GainNode;
  private wet!: GainNode;
  private compressor!: DynamicsCompressorNode;
  private reverb!: ConvolverNode;
  private noiseBuffer!: AudioBuffer;

  private listenerPos = new Vector3();
  private listenerForward = new Vector3(0, 0, -1);

  private readonly rng = new Rng(0x50a7d1);
  private ambientGain: GainNode | null = null;
  private started = false;

  masterVolume = 0.8;

  /** Must be called from a user gesture — browsers refuse to start audio otherwise. */
  start() {
    if (this.started) return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.started = true;

    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -18;
    this.compressor.knee.value = 22;
    this.compressor.ratio.value = 9;
    this.compressor.attack.value = 0.002;
    this.compressor.release.value = 0.16;
    this.compressor.connect(this.ctx.destination);

    this.master = this.ctx.createGain();
    this.master.gain.value = this.masterVolume;
    this.master.connect(this.compressor);

    this.dry = this.ctx.createGain();
    this.dry.gain.value = 1;
    this.dry.connect(this.master);

    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = this.buildImpulse(2.4, 2.6);
    this.wet = this.ctx.createGain();
    this.wet.gain.value = 0.34;
    this.wet.connect(this.reverb);
    this.reverb.connect(this.master);

    this.noiseBuffer = this.buildNoise(2);
    this.startAmbience();
  }

  resume() {
    if (this.ctx?.state === 'suspended') void this.ctx.resume();
  }

  get ready() {
    return this.ctx !== null;
  }

  setListener(position: Vector3, forward: Vector3) {
    this.listenerPos.copy(position);
    this.listenerForward.copy(forward);
    const listener = this.ctx?.listener;
    if (!listener) return;
    if (listener.positionX) {
      const t = this.ctx!.currentTime;
      listener.positionX.setTargetAtTime(position.x, t, 0.02);
      listener.positionY.setTargetAtTime(position.y, t, 0.02);
      listener.positionZ.setTargetAtTime(position.z, t, 0.02);
      listener.forwardX.setTargetAtTime(forward.x, t, 0.02);
      listener.forwardY.setTargetAtTime(forward.y, t, 0.02);
      listener.forwardZ.setTargetAtTime(forward.z, t, 0.02);
      listener.upX.value = 0;
      listener.upY.value = 1;
      listener.upZ.value = 0;
    }
  }

  /* --- Buffers ------------------------------------------------------- */

  /**
   * Generates a room impulse response: exponentially decaying noise with a
   * few early reflections. A concrete warehouse is mostly late diffusion, so
   * the decay is long and the pre-delay short.
   */
  private buildImpulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        const t = i / length;
        data[i] = (this.rng.next() * 2 - 1) * Math.pow(1 - t, decay);
      }
      // Early reflections give the space a size.
      for (const [delayMs, amp] of [[11, 0.5], [23, 0.34], [37, 0.26], [61, 0.18]] as [number, number][]) {
        const idx = Math.floor((delayMs / 1000) * ctx.sampleRate) + ch * 7;
        if (idx < length) data[idx] += amp * (this.rng.next() * 2 - 1);
      }
    }
    return buffer;
  }

  private buildNoise(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = this.rng.next() * 2 - 1;
    return buffer;
  }

  /* --- Routing helpers ----------------------------------------------- */

  /** Creates the output node for a sound, spatialised if a position is given. */
  private out(position?: Vector3, refDistance = 4, maxDistance = 45): AudioNode {
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    if (position) {
      const panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = refDistance;
      panner.maxDistance = maxDistance;
      panner.rolloffFactor = 1.15;
      panner.positionX.value = position.x;
      panner.positionY.value = position.y;
      panner.positionZ.value = position.z;
      gain.connect(panner);
      panner.connect(this.dry);
      panner.connect(this.wet);
    } else {
      gain.connect(this.dry);
      gain.connect(this.wet);
    }
    return gain;
  }

  private noiseSource(duration: number, playbackRate = 1): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.playbackRate.value = playbackRate;
    src.start(this.ctx!.currentTime, this.rng.next() * 1.5, duration + 0.05);
    return src;
  }

  /* --- Sounds --------------------------------------------------------- */

  /**
   * Gunshot. Three layers: a very short click transient, a filtered noise crack
   * that carries the calibre, and a pitched body sweep for the low end.
   */
  gunshot(spec: GunAudioSpec, position?: Vector3) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = this.out(position, 6, 70) as GainNode;
    out.gain.value = spec.gain;

    // Layer 1: transient click.
    const click = ctx.createOscillator();
    click.type = 'square';
    click.frequency.setValueAtTime(2200 * this.rng.range(0.9, 1.1), t);
    click.frequency.exponentialRampToValueAtTime(320, t + 0.014);
    const clickGain = ctx.createGain();
    clickGain.gain.setValueAtTime(0.5, t);
    clickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
    click.connect(clickGain).connect(out);
    click.start(t);
    click.stop(t + 0.03);

    // Layer 2: the crack — bandpassed noise with a fast downward sweep.
    const noise = this.noiseSource(spec.tail + 0.2, this.rng.range(0.92, 1.1));
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.7;
    bp.frequency.setValueAtTime(3400 * this.rng.range(0.9, 1.15), t);
    bp.frequency.exponentialRampToValueAtTime(420, t + spec.crack * 3);
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.9, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.16, t + spec.crack);
    noiseGain.gain.exponentialRampToValueAtTime(0.0008, t + spec.tail);
    noise.connect(bp).connect(noiseGain).connect(out);
    noise.stop(t + spec.tail + 0.1);

    // Layer 3: body. This is what makes a shotgun feel different from a pistol.
    const body = ctx.createOscillator();
    body.type = 'triangle';
    body.frequency.setValueAtTime(spec.bodyHz * this.rng.range(0.94, 1.06), t);
    body.frequency.exponentialRampToValueAtTime(spec.bodyHz * 0.32, t + 0.16);
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(0.85, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    body.connect(bodyGain).connect(lp).connect(out);
    body.start(t);
    body.stop(t + 0.28);
  }

  dryFire() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = this.out() as GainNode;
    out.gain.value = 0.32;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1400, t);
    osc.frequency.exponentialRampToValueAtTime(180, t + 0.03);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + 0.06);
  }

  /** Mechanical click, used for magazine release, seating and bolt release. */
  mechanical(pitch = 1, level = 0.32, sharpness = 0.02) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = this.out() as GainNode;
    out.gain.value = level;

    const noise = this.noiseSource(0.14, pitch);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 3.4;
    bp.frequency.setValueAtTime(1800 * pitch, t);
    bp.frequency.exponentialRampToValueAtTime(600 * pitch, t + sharpness * 3);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + sharpness * 4);
    noise.connect(bp).connect(g).connect(out);
    noise.stop(t + 0.16);
  }

  /** Shell casing bouncing on concrete. */
  shellDrop(position?: Vector3) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const base = ctx.currentTime + this.rng.range(0.24, 0.42);
    const out = this.out(position, 3, 16) as GainNode;
    out.gain.value = 0.16;
    for (let i = 0; i < 3; i++) {
      const t = base + i * this.rng.range(0.05, 0.11);
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = this.rng.range(2600, 4600);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.5 / (i + 1), t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
      osc.connect(g).connect(out);
      osc.start(t);
      osc.stop(t + 0.1);
    }
  }

  /**
   * Zombie vocalisation. A detuned pair of saws through a moving formant
   * filter, plus a breath layer — crude vocal-tract modelling, but it lands
   * somewhere between a groan and a rattle rather than sounding like a synth.
   */
  groan(position: Vector3, aggression = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = this.out(position, 3, 30) as GainNode;
    out.gain.value = 0.3 + aggression * 0.35;

    const duration = this.rng.range(0.6, 1.5) * (1 - aggression * 0.35);
    const root = this.rng.range(62, 108) * (1 + aggression * 0.35);

    for (let i = 0; i < 2; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(root * (i === 0 ? 1 : 1.014), t);
      osc.frequency.linearRampToValueAtTime(root * this.rng.range(0.72, 1.25), t + duration);

      // Two formants sweeping is what makes it read as a throat.
      const f1 = ctx.createBiquadFilter();
      f1.type = 'bandpass';
      f1.Q.value = 5;
      f1.frequency.setValueAtTime(this.rng.range(320, 520), t);
      f1.frequency.linearRampToValueAtTime(this.rng.range(240, 700), t + duration);

      const f2 = ctx.createBiquadFilter();
      f2.type = 'bandpass';
      f2.Q.value = 7;
      f2.frequency.setValueAtTime(this.rng.range(900, 1500), t);
      f2.frequency.linearRampToValueAtTime(this.rng.range(700, 1900), t + duration);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + duration * 0.22);
      g.gain.exponentialRampToValueAtTime(0.0001, t + duration);

      osc.connect(f1).connect(f2).connect(g).connect(out);
      osc.start(t);
      osc.stop(t + duration + 0.05);
    }

    // Breath.
    const breath = this.noiseSource(duration);
    const bf = ctx.createBiquadFilter();
    bf.type = 'bandpass';
    bf.Q.value = 1.1;
    bf.frequency.value = this.rng.range(700, 1400);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, t);
    bg.gain.exponentialRampToValueAtTime(0.22, t + duration * 0.3);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    breath.connect(bf).connect(bg).connect(out);
    breath.stop(t + duration + 0.05);
  }

  /** Wet impact when a round lands on a body. */
  fleshHit(position: Vector3, heavy = false) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = this.out(position, 4, 30) as GainNode;
    out.gain.value = heavy ? 0.5 : 0.34;

    const noise = this.noiseSource(0.2, this.rng.range(0.7, 1.1));
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(heavy ? 1400 : 2400, t);
    lp.frequency.exponentialRampToValueAtTime(180, t + 0.14);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + (heavy ? 0.22 : 0.13));
    noise.connect(lp).connect(g).connect(out);
    noise.stop(t + 0.25);
  }

  /** Bullet striking masonry. */
  ricochet(position: Vector3) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = this.out(position, 4, 40) as GainNode;
    out.gain.value = 0.2;

    const noise = this.noiseSource(0.16, this.rng.range(0.9, 1.3));
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1400;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.8, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
    noise.connect(hp).connect(g).connect(out);
    noise.stop(t + 0.2);

    // Occasional whine as the fragment departs.
    if (this.rng.chance(0.35)) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(this.rng.range(1800, 3200), t);
      osc.frequency.exponentialRampToValueAtTime(this.rng.range(500, 900), t + 0.3);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.18, t);
      og.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
      osc.connect(og).connect(out);
      osc.start(t);
      osc.stop(t + 0.34);
    }
  }

  footstep(running: boolean) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = this.out() as GainNode;
    out.gain.value = running ? 0.16 : 0.1;
    const noise = this.noiseSource(0.12, this.rng.range(0.8, 1.2));
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(this.rng.range(700, 1300), t);
    bp.frequency.exponentialRampToValueAtTime(240, t + 0.07);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.7, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    noise.connect(bp).connect(g).connect(out);
    noise.stop(t + 0.14);
  }

  /** Hammering a plank back onto a barrier. */
  hammer(position: Vector3) {
    this.mechanical(0.55, 0.4, 0.03);
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = this.out(position, 3, 18) as GainNode;
    out.gain.value = 0.34;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(this.rng.range(160, 240), t);
    osc.frequency.exponentialRampToValueAtTime(70, t + 0.1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.6, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + 0.15);
  }

  /** Player took damage. */
  playerHurt() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = this.out() as GainNode;
    out.gain.value = 0.5;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(58, t + 0.4);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.6, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    osc.connect(lp).connect(g).connect(out);
    osc.start(t);
    osc.stop(t + 0.5);
  }

  /** Purchase confirmation. */
  purchase() {
    this.arpeggio([523.25, 659.25, 783.99], 0.09, 'triangle', 0.22);
  }

  deny() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = this.out() as GainNode;
    out.gain.value = 0.22;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.setValueAtTime(160, t + 0.08);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  /** Perk jingle — a short, bright motif per perk. */
  perkJingle(seed: number) {
    const scale = [523.25, 587.33, 659.25, 783.99, 880, 1046.5];
    const rng = new Rng(seed * 8191);
    const notes = [0, 2, 4, 5].map((i) => scale[(i + rng.int(0, 2)) % scale.length]);
    this.arpeggio(notes, 0.13, 'triangle', 0.3);
  }

  /** Round start / end stinger. */
  stinger(rising: boolean) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = this.out() as GainNode;
    out.gain.value = 0.42;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const from = rising ? 55 : 180;
    const to = rising ? 180 : 48;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + 1.4);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(300, t);
    lp.frequency.exponentialRampToValueAtTime(rising ? 2600 : 200, t + 1.4);
    lp.Q.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.6, t + 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.7);
    osc.connect(lp).connect(g).connect(out);
    osc.start(t);
    osc.stop(t + 1.8);

    // A struck metal hit on the downbeat.
    const bell = ctx.createOscillator();
    bell.type = 'triangle';
    bell.frequency.value = rising ? 92 : 68;
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.7, t);
    bg.gain.exponentialRampToValueAtTime(0.001, t + 2.2);
    bell.connect(bg).connect(out);
    bell.start(t);
    bell.stop(t + 2.3);
  }

  private arpeggio(freqs: number[], step: number, type: OscillatorType, level: number) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const out = this.out() as GainNode;
    out.gain.value = level;
    freqs.forEach((f, i) => {
      const t = ctx.currentTime + i * step;
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.001, t + step * 2.4);
      osc.connect(g).connect(out);
      osc.start(t);
      osc.stop(t + step * 2.6);
    });
  }

  /**
   * Continuous ambience: a low wind bed plus a slow, detuned drone. Runs for
   * the whole session and is ducked during round transitions.
   */
  private startAmbience() {
    const ctx = this.ctx!;
    this.ambientGain = ctx.createGain();
    this.ambientGain.gain.value = 0.16;
    this.ambientGain.connect(this.master);

    const wind = this.ctx!.createBufferSource();
    wind.buffer = this.noiseBuffer;
    wind.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 260;
    windFilter.Q.value = 0.6;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.5;
    wind.connect(windFilter).connect(windGain).connect(this.ambientGain);
    wind.start();

    // Slow LFO on the filter so the wind breathes.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 120;
    lfo.connect(lfoGain).connect(windFilter.frequency);
    lfo.start();

    for (const [freq, detune] of [[41.2, 0], [41.2, 7], [61.7, -5]] as [number, number][]) {
      const drone = ctx.createOscillator();
      drone.type = 'sawtooth';
      drone.frequency.value = freq;
      drone.detune.value = detune;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 180;
      const g = ctx.createGain();
      g.gain.value = 0.1;
      drone.connect(lp).connect(g).connect(this.ambientGain);
      drone.start();
    }
  }

  /** Ducks ambience, e.g. under a round-start stinger. */
  duckAmbience(amount: number, seconds: number) {
    if (!this.ctx || !this.ambientGain) return;
    const t = this.ctx.currentTime;
    const target = 0.16 * clamp(1 - amount, 0, 1);
    this.ambientGain.gain.cancelScheduledValues(t);
    this.ambientGain.gain.setTargetAtTime(target, t, 0.1);
    this.ambientGain.gain.setTargetAtTime(0.16, t + seconds, 0.6);
  }

  setVolume(v: number) {
    this.masterVolume = clamp(v, 0, 1);
    if (this.master) this.master.gain.value = this.masterVolume;
  }
}
