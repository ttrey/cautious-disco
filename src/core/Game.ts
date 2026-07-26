import { Vector3 } from 'three';
import { Engine } from './Engine';
import { Input } from './Input';
import { Physics } from './Physics';
import { Effects } from './Effects';
import { Player } from '../entities/Player';
import { Level, LevelBuildResult } from '../map/Level';
import { Barrier, Door, Interactable, PromptContext } from '../map/Props';
import { ZombieManager } from '../zombies/ZombieManager';
import { Zombie } from '../zombies/Zombie';
import { WeaponSystem } from '../weapons/WeaponSystem';
import { AudioEngine } from '../audio/AudioEngine';
import { HUD } from '../ui/HUD';
import { Rng, TAU, clamp, damp } from '../util/math';

/**
 * Game orchestrator.
 *
 * Owns the round loop, the economy, perks and the interaction probe, and wires
 * the subsystems together. Everything here is coordination — no rendering, no
 * geometry, no AI. Systems talk to each other only through this class, which
 * is what keeps them independently testable and replaceable.
 */

type Phase = 'menu' | 'intermission' | 'active' | 'dead';

const STARTING_POINTS = 500;
const MAX_HEALTH = 100;
const JUGGERNOG_HEALTH = 220;
const REGEN_DELAY = 4.2;
const REGEN_RATE = 26;
const INTERMISSION = 7.5;
/** How far outside a boarded window a zombie is held while it tears planks. */
const BARRIER_STANDOFF = 0.85;
/**
 * Minimum spacing between hits the player can take. Six zombies whose attack
 * windows happen to line up would otherwise delete a full health bar in a
 * single frame with no chance to react.
 */
const DAMAGE_COOLDOWN = 0.42;

const _forward = new Vector3();
const _toProp = new Vector3();
const _tmp = new Vector3();

export class Game {
  private readonly engine: Engine;
  private readonly input: Input;
  private readonly physics: Physics;
  private readonly effects: Effects;
  private readonly audio = new AudioEngine();
  private readonly hud: HUD;
  private readonly player: Player;
  private readonly zombies: ZombieManager;
  private readonly weapons: WeaponSystem;
  private readonly level: LevelBuildResult;
  private readonly rng = new Rng(0xd00d);

  private phase: Phase = 'menu';
  private round = 0;
  private points = STARTING_POINTS;
  private kills = 0;
  private health = MAX_HEALTH;
  private maxHealth = MAX_HEALTH;
  private timeSinceDamage = 99;
  private intermissionTimer = 0;
  private readonly perks = new Set<string>();

  private focused: Interactable | null = null;
  private groanTimer = 3;
  private deathTimer = 0;

  constructor(container: HTMLElement, engine: Engine, physics: Physics) {
    this.engine = engine;
    this.physics = physics;
    this.input = new Input(engine.renderer.domElement);
    this.effects = new Effects(engine.scene);

    this.level = new Level(engine.scene, physics).build();

    this.zombies = new ZombieManager(engine.scene, this.level.nav, this.effects);
    this.zombies.setSpawnPoints(this.level.spawnPoints);
    this.zombies.onPlayerHit = (damage) => this.damagePlayer(damage);
    this.zombies.onKill = (z) => this.onZombieKilled(z);

    this.player = new Player(physics, this.input, this.level.playerSpawn);
    this.player.onFootstep = (running) => this.audio.footstep(running);
    this.player.onLand = () => this.audio.footstep(true);

    this.weapons = new WeaponSystem(
      engine.viewScene,
      this.input,
      physics,
      this.zombies,
      this.effects,
      this.audio,
    );
    this.weapons.onPointsEarned = (amount) => {
      this.points += amount;
      this.hud.setPoints(this.points);
      this.hud.awardPoints(amount);
    };
    this.weapons.onHitmarker = (kill) => this.hud.hitmark(kill);

    this.hud = new HUD(container);
    this.hud.onStart = () => this.begin();
    this.hud.onRestart = () => this.restart();

    this.input.onPointerLockChange((locked) => {
      if (!locked && this.phase !== 'menu' && this.phase !== 'dead' && !this.hud.overlayVisible) {
        this.hud.showPaused();
      }
    });

    this.hud.setPoints(this.points);
    this.hud.setRound(1, 0);
    engine.add(this);
  }

  /* --- Lifecycle -------------------------------------------------------- */

  private begin() {
    // Game state first: audio and pointer lock are best-effort, and neither
    // failing should leave the player staring at a menu that will not start.
    if (this.phase === 'menu') {
      this.phase = 'intermission';
      this.intermissionTimer = 3;
      this.hud.showBanner('ROUND 1', 'Get ready', 2.6);
    }
    try {
      this.audio.start();
      this.audio.resume();
    } catch (err) {
      console.warn('Audio unavailable:', err);
    }
    this.input.requestLock();
  }

  private restart() {
    this.round = 0;
    this.points = STARTING_POINTS;
    this.kills = 0;
    this.maxHealth = MAX_HEALTH;
    this.health = MAX_HEALTH;
    this.perks.clear();
    this.zombies.clear();
    this.weapons.reset();
    this.weapons.reloadSpeedMultiplier = 1;
    this.weapons.fireRateMultiplier = 1;
    this.player.speedMultiplier = 1;
    this.player.controlEnabled = true;
    this.player.teleport(this.level.playerSpawn);
    for (const barrier of this.level.barriers) barrier.reset();

    this.hud.setPoints(this.points);
    this.hud.setPerks(this.perks);
    this.phase = 'intermission';
    this.intermissionTimer = 3;
    this.hud.showBanner('ROUND 1', 'Get ready', 2.6);
    this.input.requestLock();
  }

  private startRound() {
    this.round++;
    // Wave size follows the classic curve: a handful early, plateauing near 26
    // so the frame budget and the spawn pool both stay honest.
    const count = Math.min(6 + Math.round(this.round * 2.6), 46);
    this.zombies.beginRound(this.round, count);
    this.phase = 'active';
    this.hud.setRound(this.round, this.zombies.remaining);
    this.hud.showBanner(`ROUND ${this.round}`, this.round % 5 === 0 ? 'They are faster now' : 'Survive');
    this.audio.stinger(true);
    this.audio.duckAmbience(0.7, 2.2);
  }

  private endRound() {
    this.phase = 'intermission';
    this.intermissionTimer = INTERMISSION;
    this.audio.stinger(false);
    this.hud.showBanner('ROUND CLEAR', 'Spend your points', 2.6);
  }

  private onZombieKilled(_zombie: Zombie) {
    this.kills++;
  }

  private damageCooldown = 0;

  private damagePlayer(amount: number) {
    if (this.phase !== 'active' || this.damageCooldown > 0) return;
    this.damageCooldown = DAMAGE_COOLDOWN;
    this.health -= amount;
    this.timeSinceDamage = 0;
    this.audio.playerHurt();

    // Point the damage indicator at whatever is closest — good enough, since
    // anything hitting the player is by definition adjacent.
    const attacker = this.zombies.nearest(this.player.position, 3);
    if (attacker) {
      _tmp.subVectors(attacker.position, this.player.position);
      const angle = Math.atan2(_tmp.x, -_tmp.z) - this.player.yaw;
      this.hud.showDamage(-angle);
    }

    if (this.health <= 0) this.die();
  }

  private die() {
    this.health = 0;
    this.phase = 'dead';
    this.deathTimer = 0;
    this.player.controlEnabled = false;
    this.zombies.clear();
    this.audio.stinger(false);
    this.input.releaseLock();
  }

  /* --- Economy and interaction ------------------------------------------ */

  private spend(amount: number): boolean {
    if (this.points < amount) {
      this.audio.deny();
      return false;
    }
    this.points -= amount;
    this.hud.setPoints(this.points);
    this.audio.purchase();
    return true;
  }

  private grantPerk(id: string) {
    this.perks.add(id);
    this.hud.setPerks(this.perks);
    this.audio.perkJingle(id.length + this.perks.size);

    switch (id) {
      case 'juggernog': {
        // Raise max health and top the player up, as the original does.
        this.maxHealth = JUGGERNOG_HEALTH;
        this.health = JUGGERNOG_HEALTH;
        break;
      }
      case 'speedCola':
        this.weapons.reloadSpeedMultiplier = 1.85;
        break;
      case 'doubleTap':
        this.weapons.fireRateMultiplier = 1.33;
        break;
      case 'staminUp':
        this.player.speedMultiplier = 1.22;
        break;
    }
  }

  private promptContext(): PromptContext {
    return {
      points: this.points,
      weaponId: this.weapons.active.def.id,
      weaponAmmoFull: this.weapons.ammoFull,
      ownedPerks: this.perks,
      spend: (amount) => this.spend(amount),
      buyWeapon: (id) => this.weapons.buyWeapon(id),
      refillAmmo: () => this.weapons.refillAmmo(),
      grantPerk: (id) => this.grantPerk(id),
      openDoor: (door) => this.openDoor(door),
      packWeapon: () => {
        if (this.weapons.packActive()) this.hud.showBanner('UPGRADED', this.weapons.displayName(), 2);
      },
      canPack: this.weapons.canPack,
    };
  }

  private openDoor(door: Door) {
    this.zombies.openZone(door.unlocksZone);
    this.hud.showBanner('AREA OPEN', door.unlocksZone.toUpperCase(), 2);
  }

  /**
   * Finds the interactable the player is looking at. Uses a dot-product cone
   * rather than a raycast: props are chunky and the player should not have to
   * pixel-hunt a vending machine.
   */
  private probeInteractable(): Interactable | null {
    const eye = this.player.eyePosition;
    this.player.forward(_forward);

    let best: Interactable | null = null;
    let bestScore = 0;

    const consider = (prop: Interactable) => {
      _toProp.subVectors(prop.focus, eye);
      const distance = _toProp.length();
      if (distance > prop.radius) return;
      _toProp.divideScalar(distance);
      const facing = _toProp.dot(_forward);
      if (facing < 0.55) return;
      // Prefer things that are both close and centred.
      const score = facing * (1 - distance / prop.radius) + facing;
      if (score > bestScore) {
        bestScore = score;
        best = prop;
      }
    };

    for (const prop of this.level.interactables) consider(prop);
    for (const barrier of this.level.barriers) {
      if (barrier.planksRemaining < 6) consider(barrier);
    }
    return best;
  }

  /* --- Zombies at barriers ---------------------------------------------- */

  /**
   * Zombies standing at an intact barrier tear it down before entering. The
   * barrier is treated as a soft obstacle: the nav grid already routes them to
   * the window, so all this does is gate how quickly they get through.
   */
  private updateBarriers(dt: number) {
    for (const barrier of this.level.barriers) {
      barrier.update(dt);
      if (barrier.planksRemaining <= 0) continue;

      for (const z of this.zombies.pool) {
        if (!z.active || z.state === 'dying') continue;
        if (z.position.distanceToSquared(barrier.position) > 4) continue;

        // Hold the zombie on the outside of the window. The nav field routes it
        // here; the boards are what decide when it gets through.
        _tmp.subVectors(z.position, barrier.position);
        const depth = _tmp.dot(barrier.outward);
        if (depth < BARRIER_STANDOFF) {
          z.position.addScaledVector(barrier.outward, BARRIER_STANDOFF - depth);
          // Kill the inward velocity component so it stops pushing.
          const inward = z.velocity.dot(barrier.outward);
          if (inward < 0) z.velocity.addScaledVector(barrier.outward, -inward);
        }

        barrier.breachTimer = 0.6;
        // Roughly one plank per second per zombie working the window.
        if (this.rng.chance(dt * 0.9)) {
          barrier.tearPlank();
          this.audio.hammer(barrier.position);
        }
        break;
      }
    }
  }

  private updateInteraction(dt: number) {
    this.focused = this.probeInteractable();

    if (!this.focused) {
      this.hud.setPrompt(null);
      return;
    }

    const ctx = this.promptContext();
    const prop = this.focused;

    if (prop instanceof Barrier) {
      this.hud.setPrompt('Hold to repair barrier', 0, true);
      if (this.input.isDown('KeyE')) {
        const earned = prop.repair(dt);
        if (earned > 0) {
          this.points += earned;
          this.hud.setPoints(this.points);
          this.hud.awardPoints(earned);
          this.audio.hammer(prop.position);
        }
      }
      return;
    }

    const info = prop.prompt(ctx);
    if (!info) {
      this.hud.setPrompt(null);
      return;
    }
    this.hud.setPrompt(info.text, info.cost, info.affordable);
    if (this.input.wasPressed('KeyE')) prop.interact(ctx);
  }

  /* --- Frame ------------------------------------------------------------ */

  update(dt: number, elapsed: number) {
    const interactive = this.phase === 'active' || this.phase === 'intermission';

    this.physics.step();

    if (interactive) {
      this.player.update(dt);
      this.updateInteraction(dt);
      this.updateBarriers(dt);
    } else if (this.phase === 'dead') {
      this.deathTimer += dt;
      // Camera sinks and rolls as the player goes down.
      this.player.update(dt);
      if (this.deathTimer > 1.6 && !this.hud.overlayVisible) {
        this.hud.showGameOver({ round: this.round, kills: this.kills, points: this.points });
      }
    }

    this.player.applyToCamera(this.engine.camera, dt);

    // Recoil is applied to the camera here so it composes with mouse aim
    // instead of fighting it.
    const punch = this.weapons.consumeViewPunch(dt);
    this.player.pitch = clamp(this.player.pitch + punch.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
    this.player.yaw += punch.yaw;

    if (this.phase === 'active' || this.phase === 'intermission') {
      this.zombies.update(dt, this.player.position, 0.34, this.level.floorY);
    }

    for (const prop of this.level.interactables) prop.update?.(dt, elapsed);

    this.weapons.update(dt, this.engine.camera, this.engine.viewCamera, {
      moveIntensity: this.player.moveIntensity,
      crouching: this.player.crouching,
      sprinting: this.player.sprinting,
      bobPhase: this.player.bob.phase,
      bobAmount: this.player.bob.amount,
      canAct: this.phase === 'active' || this.phase === 'intermission',
    });

    this.updateHealth(dt);
    this.updateRoundFlow(dt);
    this.updateAudio(dt);
    this.updateHud(dt);

    this.input.endFrame();
  }

  private updateHealth(dt: number) {
    if (this.phase === 'dead') return;
    this.damageCooldown = Math.max(0, this.damageCooldown - dt);
    this.timeSinceDamage += dt;
    if (this.timeSinceDamage > REGEN_DELAY && this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + REGEN_RATE * dt);
    }
  }

  private updateRoundFlow(dt: number) {
    if (this.phase === 'intermission') {
      this.intermissionTimer -= dt;
      if (this.intermissionTimer <= 0) this.startRound();
    } else if (this.phase === 'active' && this.zombies.remaining === 0) {
      this.endRound();
    }
  }

  private updateAudio(dt: number) {
    if (!this.audio.ready) return;
    this.player.forward(_forward);
    this.audio.setListener(this.player.eyePosition, _forward);

    // Ambient horde vocalisations, rate-limited and biased toward whoever is
    // closest so the sound tells the player where the pressure is.
    this.groanTimer -= dt;
    if (this.groanTimer <= 0) {
      this.groanTimer = this.rng.range(0.7, 2.4);
      const candidates = this.zombies.pool.filter((z) => z.active && z.state !== 'dying');
      if (candidates.length > 0) {
        const z = this.rng.pick(candidates);
        const distance = z.position.distanceTo(this.player.position);
        if (distance < 26) {
          z.centre(_tmp);
          this.audio.groan(_tmp, z.state === 'attacking' ? 1 : clamp(1 - distance / 14, 0, 0.7));
        }
      }
    }
  }

  private updateHud(dt: number) {
    const slot = this.weapons.active;
    const magSize = Math.round(slot.def.magSize * (slot.packed ? slot.def.packMagMultiplier : 1));
    this.hud.setAmmo(slot.magazine, slot.reserve, magSize, this.weapons.displayName(), slot.packed);
    this.hud.setReloading(this.weapons.isReloading);
    this.hud.setRound(Math.max(1, this.round), this.phase === 'active' ? this.zombies.remaining : 0);
    this.hud.setSpread(this.weapons.crosshairSpread(this.player.moveIntensity, this.player.crouching));
    // The reticle is redundant while aiming down irons and would obscure them.
    this.hud.setCrosshairVisible(this.weapons.aimBlend < 0.6 && this.phase !== 'dead');
    this.hud.setFps(this.engine.fps);
    this.hud.update(dt);

    // Health drives the post-process grade rather than a health bar: the screen
    // itself tells you how close you are to dying.
    const hurt = 1 - clamp(this.health / this.maxHealth, 0, 1);
    this.engine.setGrade(
      damp(0, Math.pow(hurt, 1.4), 1, 1),
      0.55 + this.weapons.aimBlend * 0.25 + hurt * 0.2,
    );
  }
}

/** Keeps the yaw helper honest about wrapping. */
export const wrapAngle = (a: number) => ((a % TAU) + TAU) % TAU;
