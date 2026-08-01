import { PerspectiveCamera, Scene, Texture, Vector3 } from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { STARTING_WEAPON, WEAPONS, WeaponDef } from './WeaponDefs';
import { ViewModel } from './ViewModel';
import { Input } from '../core/Input';
import { Physics } from '../core/Physics';
import { Effects } from '../core/Effects';
import { ZombieDamageEvent, ZombieManager } from '../zombies/ZombieManager';
import { AudioEngine } from '../audio/AudioEngine';
import { Rng, clamp, damp, lerp } from '../util/math';

/**
 * Weapon inventory and firing.
 *
 * Holds two slots (classic Zombies rules), tracks per-slot ammo and upgrade
 * state, and resolves shots: a world raycast establishes how far the round can
 * travel, then the horde is tested inside that distance so bullets can never
 * pass through walls.
 */

export interface WeaponSlot {
  def: WeaponDef;
  magazine: number;
  reserve: number;
  packed: boolean;
}

export interface ShotFeedback {
  hits: number;
  headshots: number;
  kills: number;
  pointsEarned: number;
}

const _origin = new Vector3();
const _dir = new Vector3();
const _spread = new Vector3();
const _end = new Vector3();
const _muzzle = new Vector3();
const _right = new Vector3();
const _up = new Vector3(0, 1, 0);

/** Points model, mirroring the classic economy. */
/**
 * The economy. Exported because co-op has to pay a kill out from the host,
 * which is a different code path arriving at the same number — and a second
 * copy of these three values is a bug waiting for the day one of them is
 * tuned.
 */
export const POINTS_HIT = 10;
export const POINTS_KILL = 60;
export const POINTS_HEADSHOT_KILL = 100;

/**
 * Field-of-view pull-in applied to the world camera while looking through an
 * optic. Deliberately small: the tube supplies the magnification.
 */
const OPTIC_HOST_ZOOM = 1.1;

export class WeaponSystem {
  readonly slots: WeaponSlot[] = [];
  activeIndex = 0;

  private readonly viewModel: ViewModel;
  private fireCooldown = 0;
  private reloadTimer = 0;
  private reloading = false;
  private reloadWasEmpty = false;
  private pumpTimer = 0;
  private shotIndex = 0;
  private swapTimer = 0;
  private pendingSwap = -1;
  private readonly rng = new Rng(0x9f1e);

  /**
   * Base fields of view, captured on the first update.
   *
   * Aiming has to actually magnify or a telescopic sight is decoration: the
   * scope was drawn, its eye relief was tuned, and looking through it showed
   * the target at exactly the size it was without it. Only the *world* camera
   * narrows — the viewmodel keeps its own field so the weapon and the optic
   * around the sight picture stay the size the player's hands put them, which
   * is what makes the magnification read as happening inside the tube.
   */
  private baseFov = 0;

  /** Set by perks. */
  reloadSpeedMultiplier = 1;
  fireRateMultiplier = 1;
  spreadMultiplier = 1;
  recoilMultiplier = 1;

  onPointsEarned?: (points: number, reason: 'hit' | 'kill' | 'headshot') => void;
  onHitmarker?: (kill: boolean, headshot: boolean) => void;

  constructor(
    viewScene: Scene,
    private readonly input: Input,
    private readonly physics: Physics,
    private readonly zombies: ZombieManager,
    private readonly effects: Effects,
    private readonly audio: AudioEngine,
    /**
     * The player's own capsule. The camera sits inside it, so every shot would
     * otherwise report a world hit at zero distance — walls in front of your
     * face, and no round ever reaching a zombie.
     */
    private readonly playerCollider: RAPIER.Collider,
  ) {
    this.viewModel = new ViewModel(viewScene);
    this.reset();
  }

  reset() {
    this.slots.length = 0;
    const def = WEAPONS[STARTING_WEAPON];
    this.slots.push({ def, magazine: def.magSize, reserve: def.reserveAmmo, packed: false });
    this.activeIndex = 0;
    this.reloading = false;
    this.reloadTimer = 0;
    this.fireCooldown = 0;
    this.viewModel.equip(def);
  }

  get active(): WeaponSlot {
    return this.slots[this.activeIndex];
  }

  get isReloading() {
    return this.reloading;
  }

  /**
   * Rounds fired this session, ever-increasing.
   *
   * Sent in the player snapshot as a counter rather than a "firing" flag, so a
   * teammate's rifle plays the right number of shots however the packets
   * arrived. See the note on events in `RemotePlayer`.
   */
  get shotsFired() {
    return this.shotIndex;
  }

  /** 0..1 through the current reload, for a teammate's reload animation. */
  get reloadProgress() {
    if (!this.reloading) return 0;
    const total = this.active.def.reloadTime / this.reloadSpeedMultiplier;
    return total > 0 ? clamp(1 - this.reloadTimer / total, 0, 1) : 0;
  }

  get ammoFull() {
    const s = this.active;
    return s.magazine >= this.magSize(s) && s.reserve >= s.def.maxReserve;
  }

  private magSize(slot: WeaponSlot) {
    return Math.round(slot.def.magSize * (slot.packed ? slot.def.packMagMultiplier : 1));
  }

  private damage(slot: WeaponSlot) {
    return slot.def.damage * (slot.packed ? slot.def.packDamageMultiplier : 1);
  }

  displayName(slot = this.active) {
    return slot.packed ? slot.def.packName : slot.def.name;
  }

  /** Buys a weapon: adds a slot, or refills if already carried. */
  buyWeapon(id: string) {
    const def = WEAPONS[id];
    const existing = this.slots.find((s) => s.def.id === id);
    if (existing) {
      existing.magazine = this.magSize(existing);
      existing.reserve = existing.def.maxReserve;
      return;
    }
    const slot: WeaponSlot = {
      def,
      magazine: def.magSize,
      reserve: def.reserveAmmo,
      packed: false,
    };
    if (this.slots.length < 2) {
      this.slots.push(slot);
      this.switchTo(this.slots.length - 1);
    } else {
      // Replace the weapon in hand, as the originals do.
      this.slots[this.activeIndex] = slot;
      this.viewModel.equip(def);
      this.swapTimer = def.swapTime;
      this.reloading = false;
    }
  }

  refillAmmo() {
    const s = this.active;
    s.magazine = this.magSize(s);
    s.reserve = s.def.maxReserve;
  }

  /** Applies the Pack-a-Punch upgrade to the weapon in hand. */
  packActive() {
    const s = this.active;
    if (s.packed) return false;
    s.packed = true;
    s.magazine = this.magSize(s);
    s.reserve = s.def.maxReserve;
    return true;
  }

  get canPack() {
    return !this.active.packed;
  }

  switchTo(index: number) {
    if (index === this.activeIndex || index < 0 || index >= this.slots.length) return;
    this.pendingSwap = index;
    this.swapTimer = this.active.def.swapTime * 0.45;
    this.reloading = false;
    this.viewModel.cancelReload();
  }

  private beginReload() {
    const s = this.active;
    const capacity = this.magSize(s);
    if (this.reloading || s.magazine >= capacity || s.reserve <= 0) return;

    this.reloading = true;
    this.reloadWasEmpty = s.magazine === 0;

    if (s.def.shellReload) {
      this.reloadTimer = s.def.reloadTime / this.reloadSpeedMultiplier;
      this.viewModel.startShellInsert(this.reloadTimer);
    } else {
      const extra = this.reloadWasEmpty ? s.def.emptyReloadExtra : 0;
      this.reloadTimer = (s.def.reloadTime + extra) / this.reloadSpeedMultiplier;
      this.viewModel.startReload(this.reloadTimer, this.reloadWasEmpty);
      this.audio.mechanical(1.1, 0.3);
    }
  }

  private finishReloadStep() {
    const s = this.active;
    const capacity = this.magSize(s);

    if (s.def.shellReload) {
      // One shell at a time, so the player can break off and fire.
      const need = Math.min(1, capacity - s.magazine, s.reserve);
      s.magazine += need;
      s.reserve -= need;
      this.audio.mechanical(0.8, 0.3, 0.03);
      if (s.magazine < capacity && s.reserve > 0) {
        this.reloadTimer = s.def.reloadTime / this.reloadSpeedMultiplier;
        this.viewModel.startShellInsert(this.reloadTimer);
        return;
      }
      // Final pump.
      this.audio.mechanical(0.55, 0.36, 0.04);
    } else {
      const need = Math.min(capacity - s.magazine, s.reserve);
      s.magazine += need;
      s.reserve -= need;
      this.audio.mechanical(0.7, 0.34, 0.03);
      if (this.reloadWasEmpty) this.audio.mechanical(0.5, 0.32, 0.045);
    }
    this.reloading = false;
  }

  /** Current cone half-angle in radians, given stance and motion. */
  private spreadRadians(moveIntensity: number, crouching: boolean): number {
    const def = this.active.def;
    let degrees = def.spread;
    degrees *= 1 + moveIntensity * (def.movementSpread - 1) * 0.6;
    degrees *= 1 - this.viewModel.adsBlend * (1 - def.adsSpreadMultiplier);
    degrees *= this.spreadMultiplier;
    if (crouching) degrees *= 0.72;
    return (degrees * Math.PI) / 180;
  }

  private fire(camera: PerspectiveCamera, moveIntensity: number, crouching: boolean) {
    const slot = this.active;
    const def = slot.def;

    if (slot.magazine <= 0) {
      this.audio.dryFire();
      this.fireCooldown = 0.28;
      this.beginReload();
      return;
    }

    slot.magazine--;
    this.shotIndex++;
    this.fireCooldown = 60 / (def.rpm * this.fireRateMultiplier);

    camera.getWorldPosition(_origin);
    camera.getWorldDirection(_dir);
    _right.crossVectors(_dir, _up).normalize();
    // Tracers are drawn from the muzzle, not the eye — a round that leaves the
    // bridge of your nose reads as a bug even when the hit is correct.
    this.viewModel.muzzleWorld(camera, _muzzle);

    const cone = this.spreadRadians(moveIntensity, crouching);
    let hits = 0;
    let headshots = 0;
    let kills = 0;
    let points = 0;

    const registerEvents = (events: ZombieDamageEvent[]) => {
      for (const e of events) {
        hits++;
        if (e.headshot) headshots++;
        if (e.killed) {
          kills++;
          points += e.headshot ? POINTS_HEADSHOT_KILL : POINTS_KILL;
        } else {
          points += POINTS_HIT;
        }
        this.audio.fleshHit(e.point, e.killed);
      }
    };

    for (let pellet = 0; pellet < def.pellets; pellet++) {
      // Sample the cone with a square-root radius so pellets are distributed
      // evenly over the disc rather than clustering at the centre.
      const angle = this.rng.range(0, Math.PI * 2);
      const radius = Math.sqrt(this.rng.next()) * cone;
      _spread
        .copy(_dir)
        .addScaledVector(_right, Math.cos(angle) * radius)
        .addScaledVector(_up, Math.sin(angle) * radius)
        .normalize();

      // World geometry first: it clips how far the round can reach.
      const worldHit = this.physics.raycast(_origin, _spread, def.range, this.playerCollider);
      const maxDist = worldHit ? worldHit.distance : def.range;

      const events = this.zombies.fireRay(
        _origin,
        _spread,
        maxDist,
        this.damage(slot) * this.falloff(maxDist, def),
        def.headshotMultiplier,
        def.penetration,
      );

      const beforeHits = hits;
      const beforeKills = kills;
      const beforeHeadshots = headshots;

      if (events.length > 0) {
        registerEvents(events);
      } else if (worldHit) {
        this.effects.impact(worldHit.point, worldHit.normal, true);
        if (pellet === 0) this.audio.ricochet(worldHit.point);
      }

      _end.copy(_origin).addScaledVector(_spread, maxDist);
      const impact = events[0]?.point ?? worldHit?.point ?? _end;
      if (def.wonder?.kind === 'plasma') {
        // The direct hit remains a normal precision hit. The bloom then catches
        // nearby bodies, but deliberately excludes that first target so one
        // projectile never receives an invisible double-damage bonus.
        this.effects.plasmaBolt(_muzzle, impact);
        this.effects.plasmaBurst(impact, 1.08);
        const blastEvents = this.zombies.blast(
          impact,
          def.wonder.splashRadius ?? 2.6,
          this.damage(slot) * (def.wonder.splashDamageMultiplier ?? 0.68),
          _spread,
          events[0]?.zombie,
        );
        registerEvents(blastEvents);
      } else if (def.wonder?.kind === 'arc') {
        if (events[0]) {
          this.effects.lightningArc(_muzzle, impact);
          this.effects.electricBurst(impact);
          const chainEvents = this.zombies.chainLightning(
            events[0].zombie,
            def.wonder.chainTargets ?? 4,
            def.wonder.chainRange ?? 7,
            this.damage(slot) * (def.wonder.chainDamageMultiplier ?? 0.75),
          );
          registerEvents(chainEvents);
        } else {
          // A missed arc still visibly grounds itself against the first wall it
          // reaches, which keeps its feedback honest rather than disappearing.
          this.effects.lightningArc(_muzzle, impact);
          this.effects.electricBurst(impact);
        }
      } else if (this.rng.chance(def.pellets > 1 ? 0.25 : 0.34)) {
        // Tracers on a minority of conventional rounds — every round would turn
        // the scene into a laser show.
        this.effects.tracer(_muzzle, _end);
      }

      // One marker per trigger pull, after secondary wonder-weapon damage has
      // resolved. A chain kill therefore earns a kill marker even if its first
      // target survived the opening bolt.
      if (pellet === 0 && hits > beforeHits) {
        this.onHitmarker?.(kills > beforeKills, headshots > beforeHeadshots);
      }
    }

    if (points > 0) {
      this.onPointsEarned?.(points, kills > 0 ? (headshots > 0 ? 'headshot' : 'kill') : 'hit');
    }

    this.viewModel.fire(def, this.shotIndex);
    if (def.wonder) this.audio.wonderShot(def.wonder.kind);
    else this.audio.gunshot(def.audio);

    // The pump cycle is what gates the shotgun's rate of fire.
    if (def.fireMode === 'pump') this.pumpTimer = 0.42;
    // Shell ejection is visual only. The casing bounce it used to play was a
    // stack of bare high oscillators, which landed as a scoring chime after
    // every shot instead of brass on concrete.
    this.viewModel.ejectShell(def);
  }

  private falloff(distance: number, def: WeaponDef): number {
    if (distance <= def.falloffStart) return 1;
    const t = clamp((distance - def.falloffStart) / (def.range - def.falloffStart), 0, 1);
    return 1 + (def.falloffFloor - 1) * t;
  }

  update(
    dt: number,
    camera: PerspectiveCamera,
    viewCamera: PerspectiveCamera,
    ctx: { moveIntensity: number; crouching: boolean; sprinting: boolean; bobPhase: number; bobAmount: number; canAct: boolean },
  ) {
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.pumpTimer = Math.max(0, this.pumpTimer - dt);
    this.swapTimer = Math.max(0, this.swapTimer - dt);

    // Deferred swap so the lower animation has time to play.
    if (this.pendingSwap >= 0 && this.swapTimer <= 0) {
      this.activeIndex = this.pendingSwap;
      this.pendingSwap = -1;
      this.viewModel.equip(this.active.def);
      this.swapTimer = this.active.def.swapTime;
      this.audio.mechanical(1.3, 0.22);
    }

    const busy = this.swapTimer > 0 || this.pendingSwap >= 0;

    if (ctx.canAct && !busy) {
      if (this.input.wasPressed('KeyR')) this.beginReload();
      if (this.input.wasPressed('Digit1')) this.switchTo(0);
      if (this.input.wasPressed('Digit2')) this.switchTo(1);
      if (this.input.wasPressed('KeyQ') || this.input.wheel !== 0) {
        this.switchTo((this.activeIndex + 1) % Math.max(1, this.slots.length));
      }
    }

    if (this.reloading) {
      this.reloadTimer -= dt;
      // Firing cancels a shell-by-shell reload, exactly as it should.
      if (this.active.def.shellReload && this.input.mousePressed && this.active.magazine > 0) {
        this.reloading = false;
        this.viewModel.cancelReload();
      } else if (this.reloadTimer <= 0) {
        this.finishReloadStep();
      }
    }

    const canFire =
      ctx.canAct &&
      !busy &&
      !this.reloading &&
      !ctx.sprinting &&
      this.fireCooldown <= 0 &&
      this.pumpTimer <= 0;

    if (canFire) {
      const def = this.active.def;
      const wantsFire = def.fireMode === 'auto' ? this.input.mouseHeld : this.input.mousePressed;
      if (wantsFire) this.fire(camera, ctx.moveIntensity, ctx.crouching);
    }

    // Auto-reload on an empty magazine, once the trigger is released.
    if (!this.reloading && this.active.magazine === 0 && this.active.reserve > 0 && !busy) {
      this.beginReload();
    }

    this.viewModel.setAiming(this.input.rightHeld && ctx.canAct);
    this.viewModel.update(dt, viewCamera, {
      lookX: this.input.lookX,
      lookY: this.input.lookY,
      moveIntensity: ctx.moveIntensity,
      bobPhase: ctx.bobPhase,
      bobAmount: ctx.bobAmount,
      sprinting: ctx.sprinting,
      inspecting: this.input.isDown('KeyF'),
    });

    this.applyAimZoom(camera);
  }

  /**
   * Narrows the world camera toward the weapon's magnification as it comes up.
   *
   * Interpolating the half-angle's tangent rather than the FOV in degrees is
   * what makes the transition feel like one continuous pull instead of racing
   * at the start and crawling at the end — magnification is a ratio of
   * tangents, so that is the quantity that should move linearly.
   *
   * A weapon with an optic is the exception: the magnification belongs inside
   * the tube, and pulling the host view in as well would magnify the world
   * *around* the scope by the same amount, so the player would see a 3x scene
   * through a 3x scope. The host keeps a slight pull-in only, which is what
   * shouldering a weapon should feel like.
   */
  private applyAimZoom(camera: PerspectiveCamera) {
    if (this.baseFov === 0) this.baseFov = camera.fov;
    const zoom = this.viewModel.hasOptic ? OPTIC_HOST_ZOOM : this.active.def.adsZoom ?? 1;
    const half = (this.baseFov * Math.PI) / 360;
    const aimed = Math.atan(Math.tan(half) / zoom);
    const fov = (lerp(half, aimed, this.viewModel.adsBlend) * 360) / Math.PI;
    if (Math.abs(camera.fov - fov) > 1e-4) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  /** View punch the camera should apply and then decay, in radians. */
  consumeViewPunch(dt: number): { pitch: number; yaw: number } {
    const pitch = this.viewModel.viewPunchPitch * this.recoilMultiplier;
    const yaw = this.viewModel.viewPunchYaw * this.recoilMultiplier;
    // The viewmodel decays its own copy; the camera integrates the difference.
    // Damping only the camera's share is deliberate — Deadshot should steady
    // the *sight picture*, not stop the weapon itself from kicking, which is
    // the animation the shot reads from.
    return { pitch: pitch * Math.min(1, dt * 26), yaw: yaw * Math.min(1, dt * 26) };
  }

  get aimBlend() {
    return this.viewModel.adsBlend;
  }

  /**
   * Vertical field of view the optic's own pass should render at, or 0 when no
   * off-screen pass is needed — no scope, or the weapon is not up yet. Measured
   * against the *base* field rather than the live one, so the host view's own
   * pull-in never compounds into the magnification. Gating on the blend rather
   * than on the aim input keeps the extra scene render out of hip-fire frames.
   */
  get opticFov(): number {
    if (!this.viewModel.hasOptic || this.viewModel.adsBlend < 0.15 || this.baseFov === 0) return 0;
    const zoom = Math.max(this.active.def.adsZoom ?? 1, 0.01);
    const half = Math.atan(Math.tan((this.baseFov * Math.PI) / 360) / zoom);
    return (half * 360) / Math.PI;
  }

  /** Hands the optic its rendered sight picture, or `null` to clear it. */
  setOpticView(texture: Texture | null) {
    this.viewModel.setOpticView(texture);
  }

  /** Crosshair spread in normalised screen units, for the HUD. */
  crosshairSpread(moveIntensity: number, crouching: boolean): number {
    return damp(0, this.spreadRadians(moveIntensity, crouching) * 26, 1, 1);
  }
}
