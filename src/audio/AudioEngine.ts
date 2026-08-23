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
 * Signal chain: sources → per-sound gain → optional panner → a dry bus and,
 * for world ambience and impacts, a shared convolution reverb (generated
 * impulse response) → master compressor → destination. Weapon reports opt
 * out of the wet bus so they stay immediate instead of echoing in the room.
 */

export interface GunAudioSpec {
  bodyHz: number;
  crack: number;
  tail: number;
  gain: number;
  /**
   * Where the mechanical transient starts, Hz.
   *
   * This is the single most identifying part of a gunshot — the hammer, the
   * bolt and the case mouth, all inside the first fifteen milliseconds. Leaving
   * it fixed across the roster stamped the same 2.2 kHz tick on every weapon in
   * the game, and because the ear locks onto a sharp transient far harder than
   * onto a low body tone, that one shared layer was most of what a player
   * actually heard. Heavy actions belong an octave or more below light ones.
   */
  actionHz: number;
  /**
   * Centre of the noise crack at the instant of firing, Hz, and the frequency
   * it falls to as the report opens out.
   *
   * The sweep between them carries the calibre: a subsonic pistol round is a
   * narrow, quick fall, a rifle cartridge starts far brighter and drops much
   * further. Both ends were previously constants.
   */
  crackHz: number;
  crackFallHz: number;
  /** Corner of the low-pass on the body layer, Hz. Bigger bores stay darker. */
  bodyCutoffHz: number;
  /**
   * How much of the body's pitch is left by the end of its fall, 0..1.
   *
   * A short, heavy action slams to its floor; a light, high-strung one barely
   * moves. Fixing this at a third gave every weapon the same downward "thump"
   * under its own fundamental.
   */
  bodyDrop: number;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private dry!: GainNode;
  private wet!: GainNode;
  private compressor!: DynamicsCompressorNode;
  private reverb!: ConvolverNode;
  private roomFilter!: BiquadFilterNode;
  private roomPreDelay!: DelayNode;
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
    this.wet.gain.value = 0.3;
    this.roomFilter = this.ctx.createBiquadFilter();
    this.roomFilter.type = 'lowpass';
    this.roomFilter.frequency.value = 4600;
    this.roomFilter.Q.value = 0.35;
    this.roomPreDelay = this.ctx.createDelay(0.12);
    this.roomPreDelay.delayTime.value = 0.014;
    this.wet.connect(this.roomFilter).connect(this.roomPreDelay).connect(this.reverb);
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

  /** Creates a spatialised output; `withReverb` is false for dry weapon cues. */
  private out(
    position?: Vector3,
    refDistance = 4,
    maxDistance = 45,
    withReverb = true,
    reverbSend = 1,
  ): AudioNode {
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
      if (withReverb) {
        const send = ctx.createGain();
        send.gain.value = clamp(reverbSend, 0, 1);
        panner.connect(send).connect(this.wet);
      }
    } else {
      gain.connect(this.dry);
      if (withReverb) {
        const send = ctx.createGain();
        send.gain.value = clamp(reverbSend, 0, 1);
        gain.connect(send).connect(this.wet);
      }
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
   * Gunshot. Three layers: a short mechanical transient, a filtered noise crack
   * that carries the calibre, and a pitched body sweep for the low end.
   *
   * Every parameter of all three layers comes from the weapon's own spec. That
   * is the whole point: the layers used to share fixed frequencies — a 2.2 kHz
   * transient, a 3.4 kHz crack falling to 420 Hz, a 900 Hz corner on the body —
   * and only `bodyHz` and two envelope times varied. A shared transient and a
   * shared crack are two thirds of what the ear uses to tell one weapon from
   * another, so however far apart the fundamentals were set, every gun in the
   * game arrived wearing the same signature on top.
   */
  gunshot(spec: GunAudioSpec, position?: Vector3) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    // Keep the direct report dry and immediate, but give the room a restrained
    // copy. A fully wet gunshot smears automatic fire; no room send at all
    // makes a concrete interior feel like an anechoic test range.
    const out = this.out(position, 6, 70, true, 0.24) as GainNode;
    out.gain.value = spec.gain;

    // Layer 1: the action — hammer fall, bolt, case mouth.
    const click = ctx.createOscillator();
    click.type = 'square';
    const action = spec.actionHz * this.rng.range(0.9, 1.1);
    click.frequency.setValueAtTime(action, t);
    // The transient's own decay tracks its pitch: a heavy action rings down
    // slower as well as lower, and holding the ramp time fixed re-introduces a
    // shared rhythm underneath the pitch differences.
    const clickFall = 0.010 + 6.5 / spec.actionHz;
    click.frequency.exponentialRampToValueAtTime(action * 0.14, t + clickFall);
    const clickGain = ctx.createGain();
    clickGain.gain.setValueAtTime(0.62, t);
    clickGain.gain.exponentialRampToValueAtTime(0.001, t + clickFall * 1.5);
    // A square wave carries harmonics far above its fundamental, so a 600 Hz
    // action and a 3 kHz one still arrive at the ear with much the same
    // brightness — the pitch moves but the character does not. Rolling the
    // transient off in proportion to its own pitch is what turns a heavy bolt
    // into a dull clack and leaves a light slide crisp.
    const clickTone = ctx.createBiquadFilter();
    clickTone.type = 'lowpass';
    clickTone.frequency.value = action * 3.2;
    clickTone.Q.value = 0.9;
    click.connect(clickTone).connect(clickGain).connect(out);
    click.start(t);
    click.stop(t + clickFall * 2.2);

    // A short band-limited muzzle snap fills the first millisecond without
    // turning the action layer into a synthetic square-wave beep.
    const snap = this.noiseSource(0.055, this.rng.range(0.92, 1.08));
    const snapTone = ctx.createBiquadFilter();
    snapTone.type = 'bandpass';
    snapTone.Q.value = 2.2;
    snapTone.frequency.setValueAtTime(action * 1.7, t);
    snapTone.frequency.exponentialRampToValueAtTime(Math.max(260, action * 0.45), t + 0.035);
    const snapGain = ctx.createGain();
    snapGain.gain.setValueAtTime(0.0001, t);
    snapGain.gain.exponentialRampToValueAtTime(0.5, t + 0.0015);
    snapGain.gain.exponentialRampToValueAtTime(0.001, t + 0.042);
    snap.connect(snapTone).connect(snapGain).connect(out);
    snap.stop(t + 0.07);

    // Layer 2: the crack — bandpassed noise with a fast downward sweep.
    const noise = this.noiseSource(spec.tail + 0.2, this.rng.range(0.92, 1.1));
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    // Tight enough that `crackHz` actually decides the colour of the report. At
    // the old Q of 0.7 the passband spanned most of the audible range, so white
    // noise came out the far side still sounding like white noise and the
    // per-weapon centre frequency barely registered.
    bp.Q.value = 1.25;
    bp.frequency.setValueAtTime(spec.crackHz * this.rng.range(0.9, 1.15), t);
    bp.frequency.exponentialRampToValueAtTime(spec.crackFallHz, t + spec.crack * 3);
    const noiseGain = ctx.createGain();
    // The blast takes a couple of milliseconds to develop, and a bigger bore
    // takes longer. Starting it flat on the same sample as the action buried
    // the transient under broadband noise, which is exactly the layer that was
    // supposed to tell the weapons apart — with the lead in, the first thing
    // the ear gets is the action's own pitch.
    const attack = 0.0008 + spec.crack * 0.02;
    noiseGain.gain.setValueAtTime(0.0001, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.9, t + attack);
    noiseGain.gain.exponentialRampToValueAtTime(0.16, t + attack + spec.crack);
    noiseGain.gain.exponentialRampToValueAtTime(0.0008, t + spec.tail);
    noise.connect(bp).connect(noiseGain).connect(out);
    noise.stop(t + spec.tail + 0.1);

    // Layer 3: body. This is what makes a shotgun feel different from a pistol.
    const body = ctx.createOscillator();
    body.type = 'triangle';
    body.frequency.setValueAtTime(spec.bodyHz * this.rng.range(0.94, 1.06), t);
    // Longer-tailed weapons carry their body longer; the fall and the release
    // are both scaled off it rather than pinned at 0.16 / 0.22 s.
    const bodyFall = 0.10 + spec.tail * 0.14;
    body.frequency.exponentialRampToValueAtTime(spec.bodyHz * spec.bodyDrop, t + bodyFall);
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(0.85, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.001, t + bodyFall * 1.4);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = spec.bodyCutoffHz;
    body.connect(bodyGain).connect(lp).connect(out);
    body.start(t);
    body.stop(t + bodyFall * 1.8);
  }

  /**
   * Energy-weapon reports deliberately avoid the brass-and-propellant shape of
   * `gunshot`: plasma has a pressurised downward sweep, while the coil rifle
   * has a sharp electrical crack followed by a short unstable hum.
   */
  wonderShot(kind: 'plasma' | 'arc') {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = this.out(undefined, 4, 45, true, 0.14) as GainNode;
    out.gain.value = kind === 'plasma' ? 0.72 : 0.66;

    const body = ctx.createOscillator();
    body.type = kind === 'plasma' ? 'sawtooth' : 'square';
    const start = kind === 'plasma' ? 286 : 126;
    const end = kind === 'plasma' ? 72 : 520;
    body.frequency.setValueAtTime(start * this.rng.range(0.94, 1.06), t);
    if (kind === 'plasma') body.frequency.exponentialRampToValueAtTime(end, t + 0.18);
    else {
      body.frequency.exponentialRampToValueAtTime(690, t + 0.022);
      body.frequency.exponentialRampToValueAtTime(end, t + 0.16);
    }
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(kind === 'plasma' ? 0.58 : 0.44, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.001, t + (kind === 'plasma' ? 0.24 : 0.19));
    const bodyFilter = ctx.createBiquadFilter();
    bodyFilter.type = 'lowpass';
    bodyFilter.frequency.value = kind === 'plasma' ? 1450 : 2150;
    body.connect(bodyFilter).connect(bodyGain).connect(out);
    body.start(t);
    body.stop(t + 0.28);

    const noise = this.noiseSource(kind === 'plasma' ? 0.22 : 0.16, kind === 'plasma' ? 0.72 : 1.55);
    const filter = ctx.createBiquadFilter();
    filter.type = kind === 'plasma' ? 'bandpass' : 'highpass';
    filter.Q.value = kind === 'plasma' ? 1.2 : 0.7;
    filter.frequency.setValueAtTime(kind === 'plasma' ? 820 : 1850, t);
    filter.frequency.exponentialRampToValueAtTime(kind === 'plasma' ? 190 : 480, t + 0.16);
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(kind === 'plasma' ? 0.32 : 0.48, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    noise.connect(filter).connect(noiseGain).connect(out);
    noise.stop(t + 0.24);
  }

  dryFire() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = this.out(undefined, 4, 45, false) as GainNode;
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
    const out = this.out(undefined, 4, 45, false) as GainNode;
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
    const out = this.out(position, 4, 30, true, 0.72) as GainNode;
    out.gain.value = heavy ? 0.5 : 0.34;

    // The noise reads as wet spray; this low, short body is what tells the ear
    // that a heavy hit actually displaced mass instead of only making a hiss.
    const body = ctx.createOscillator();
    body.type = 'triangle';
    body.frequency.setValueAtTime(heavy ? 118 : 168, t);
    body.frequency.exponentialRampToValueAtTime(heavy ? 62 : 96, t + (heavy ? 0.18 : 0.11));
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(heavy ? 0.72 : 0.38, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.001, t + (heavy ? 0.25 : 0.16));
    const bodyTone = ctx.createBiquadFilter();
    bodyTone.type = 'lowpass';
    bodyTone.frequency.value = heavy ? 620 : 900;
    body.connect(bodyTone).connect(bodyGain).connect(out);
    body.start(t);
    body.stop(t + (heavy ? 0.28 : 0.19));

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
    const out = this.out(position, 4, 40, true, 0.9) as GainNode;
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
    // Deliberately noise only: a bare high sine tail here reads as a scoring
    // chime rather than a fragment, so impacts stay purely percussive.
  }

  footstep(running: boolean) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = this.out(undefined, 4, 45, true, 0.25) as GainNode;
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
    const out = this.out(position, 3, 18, true, 0.62) as GainNode;
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
    const out = this.out(undefined, 4, 45, true, 0.38) as GainNode;
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

    // The sweep establishes tension; the stepped motif makes the state change
    // legible when the player is already surrounded by gunfire and groans.
    this.arpeggio(
      rising ? [110, 138.6, 164.8, 220] : [220, 164.8, 138.6, 110],
      0.16,
      'triangle',
      rising ? 0.16 : 0.13,
    );
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
    this.ambientGain.gain.setTargetAtTime(0.16, t + clamp(seconds, 0.05, 5), 0.6);
  }

  setVolume(v: number) {
    this.masterVolume = clamp(v, 0, 1);
    if (this.master) this.master.gain.value = this.masterVolume;
  }
}
