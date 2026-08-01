import { Vector3 } from 'three';
import { NavGrid } from '../core/Nav';
import { ZombieManager } from '../zombies/ZombieManager';
import { PlayerSnapshot, packFlags } from './RemotePlayer';
import { RemotePlayerManager } from './RemotePlayerManager';
import { Rng, TAU, clamp, damp } from '../util/math';

/**
 * Stand-in teammates, for a build with no transport layer yet.
 *
 * There is no networking in this game, so without something driving them the
 * operator models can only ever be looked at on a turntable — and a turntable
 * cannot answer the questions that actually matter: does the walk cycle hold up
 * at the speed the game moves at, does a teammate crossing a doorway read, does
 * the reload look like a reload from six metres away in the dark.
 *
 * So these bots exist, and the important thing about them is what they are
 * *not* allowed to do: they never touch a rig, an animator or a bone. They walk
 * around and emit `PlayerSnapshot`s at a fixed 20 Hz, exactly as a peer would,
 * and everything downstream — the buffer, the interpolation, the counter-based
 * shot events, the animation mapping — is the same code a real connection will
 * drive. When the transport lands, this file is deleted and nothing else
 * changes.
 */

/** Snapshots a second. Deliberately far below the frame rate — that is the point. */
const SEND_RATE = 20;
const WALK_SPEED = 4.3;
const SPRINT_SPEED = 7.1;
const CROUCH_SPEED = 2.1;
/** How close a bot has to get to a waypoint before picking another. */
const ARRIVE = 1.2;
const ENGAGE_RANGE = 26;
/** Personal space, metres. A shoulder is 0.4 m, so this leaves a clear gap. */
const SEPARATION = 1.1;

interface Bot {
  id: string;
  position: Vector3;
  yaw: number;
  pitch: number;
  velocity: Vector3;
  waypoint: Vector3;
  home: Vector3;
  weaponId: string;
  shots: number;
  melees: number;
  magazine: number;
  magSize: number;
  reloadTimer: number;
  reloadTime: number;
  fireTimer: number;
  burst: number;
  crouchTimer: number;
  crouching: boolean;
  sprinting: boolean;
  sendTimer: number;
  rng: Rng;
}

const _toTarget = new Vector3();
const _desired = new Vector3();
const _separation = new Vector3();

export class DemoSquad {
  private readonly bots: Bot[] = [];
  private readonly manager: RemotePlayerManager;
  private readonly nav: NavGrid;
  private readonly floorY: number;

  constructor(
    manager: RemotePlayerManager,
    nav: NavGrid,
    floorY: number,
    spawns: Vector3[],
    count: number,
  ) {
    this.manager = manager;
    this.nav = nav;
    this.floorY = floorY;

    const weapons = ['rifle', 'smg', 'shotgun'];
    for (let i = 0; i < count; i++) {
      const id = `bot${i + 1}`;
      if (!manager.join(id)) break;
      // Spawns are the lobby's own start points, so the squad appears where a
      // real four-player game would put them.
      const spawn = (spawns[i + 1] ?? spawns[0]).clone();
      const rng = new Rng(0xb07 + i * 7919);
      this.bots.push({
        id,
        position: spawn.clone(),
        yaw: rng.range(0, TAU),
        pitch: 0,
        velocity: new Vector3(),
        waypoint: spawn.clone(),
        home: spawn.clone(),
        weaponId: weapons[i % weapons.length],
        shots: 0,
        melees: 0,
        magazine: 30,
        magSize: 30,
        reloadTimer: 0,
        reloadTime: 2.35,
        fireTimer: 0,
        burst: 0,
        crouchTimer: rng.range(4, 12),
        crouching: false,
        sprinting: false,
        sendTimer: rng.range(0, 1 / SEND_RATE),
        rng,
      });
    }
  }

  /** Picks a walkable point near home. Rejection sampling; the grid is cheap. */
  private repick(bot: Bot) {
    for (let attempt = 0; attempt < 24; attempt++) {
      const angle = bot.rng.range(0, TAU);
      const radius = bot.rng.range(2, 9);
      const x = bot.home.x + Math.cos(angle) * radius;
      const z = bot.home.z + Math.sin(angle) * radius;
      if (this.nav.isBlockedWorld(x, z)) continue;
      bot.waypoint.set(x, this.floorY, z);
      return;
    }
    bot.waypoint.copy(bot.home);
  }

  update(dt: number, zombies: ZombieManager) {
    for (const bot of this.bots) {
      this.steer(bot, dt);
      this.fight(bot, dt, zombies);

      bot.sendTimer -= dt;
      if (bot.sendTimer <= 0) {
        bot.sendTimer += 1 / SEND_RATE;
        this.send(bot);
      }
    }
  }

  private steer(bot: Bot, dt: number) {
    _toTarget.subVectors(bot.waypoint, bot.position).setY(0);
    if (_toTarget.length() < ARRIVE) this.repick(bot);

    bot.crouchTimer -= dt;
    if (bot.crouchTimer <= 0) {
      bot.crouchTimer = bot.rng.range(5, 14);
      bot.crouching = !bot.crouching && bot.rng.chance(0.35);
    }

    const distance = _toTarget.length();
    bot.sprinting = !bot.crouching && distance > 5.5;
    const speed = bot.crouching ? CROUCH_SPEED : bot.sprinting ? SPRINT_SPEED : WALK_SPEED;

    if (distance > 0.01) {
      _desired.copy(_toTarget).divideScalar(distance).multiplyScalar(speed);
      // Keep out of each other. Two teammates standing in the same half metre
      // is not a rendering bug, but it looks exactly like one, and it hides the
      // silhouettes that are the point of having four different operators.
      for (const other of this.bots) {
        if (other === bot) continue;
        _separation.subVectors(bot.position, other.position).setY(0);
        const gap = _separation.length();
        if (gap > 1e-3 && gap < SEPARATION) {
          _desired.addScaledVector(_separation.divideScalar(gap), (SEPARATION - gap) * speed * 1.6);
        }
      }
      bot.velocity.x = damp(bot.velocity.x, _desired.x, 8, dt);
      bot.velocity.z = damp(bot.velocity.z, _desired.z, 8, dt);
    }

    // Move, but never into a wall — the bots have no collider, and a teammate
    // standing inside masonry is a worse demonstration than one that stops.
    const nx = bot.position.x + bot.velocity.x * dt;
    const nz = bot.position.z + bot.velocity.z * dt;
    if (!this.nav.isBlockedWorld(nx, bot.position.z)) bot.position.x = nx;
    else {
      bot.velocity.x = 0;
      this.repick(bot);
    }
    if (!this.nav.isBlockedWorld(bot.position.x, nz)) bot.position.z = nz;
    else {
      bot.velocity.z = 0;
      this.repick(bot);
    }
    bot.position.y = this.floorY;
  }

  private fight(bot: Bot, dt: number, zombies: ZombieManager) {
    bot.fireTimer -= dt;

    const target = zombies.nearest(bot.position, ENGAGE_RANGE);
    if (target) {
      // Face and aim at the target. Yaw is the same convention as the player's:
      // forward is (-sin yaw, 0, -cos yaw).
      _toTarget.subVectors(target.position, bot.position);
      const wanted = Math.atan2(-_toTarget.x, -_toTarget.z);
      let delta = (wanted - bot.yaw) % TAU;
      if (delta > Math.PI) delta -= TAU;
      if (delta < -Math.PI) delta += TAU;
      bot.yaw += clamp(delta, -4 * dt, 4 * dt);
      const horizontal = Math.hypot(_toTarget.x, _toTarget.z);
      // Aim at chest height on the target rather than its feet.
      bot.pitch = damp(bot.pitch, Math.atan2(_toTarget.y + 1.1 - 1.6, horizontal), 8, dt);
    } else {
      // Nothing to shoot: look where it is going.
      const wanted = Math.atan2(-bot.velocity.x, -bot.velocity.z);
      let delta = (wanted - bot.yaw) % TAU;
      if (delta > Math.PI) delta -= TAU;
      if (delta < -Math.PI) delta += TAU;
      if (bot.velocity.lengthSq() > 0.5) bot.yaw += clamp(delta, -2.5 * dt, 2.5 * dt);
      bot.pitch = damp(bot.pitch, bot.rng.chance(dt * 0.4) ? bot.rng.range(-0.2, 0.2) : bot.pitch, 2, dt);
    }

    if (bot.reloadTimer > 0) {
      bot.reloadTimer -= dt;
      if (bot.reloadTimer <= 0) bot.magazine = bot.magSize;
      return;
    }

    const engaging = target !== null && !bot.sprinting;
    if (engaging && bot.fireTimer <= 0 && bot.magazine > 0) {
      bot.shots++;
      bot.magazine--;
      bot.burst--;
      if (bot.burst <= 0) {
        // Between bursts, so the fire is legible rather than a continuous drone.
        bot.burst = bot.rng.int(3, 7);
        bot.fireTimer = bot.rng.range(0.35, 1.1);
      } else {
        bot.fireTimer = 60 / 620;
      }
    }
    if (bot.magazine <= 0) {
      bot.reloadTimer = bot.reloadTime;
    }
    // Melee occasionally when something is on top of it.
    if (target && bot.position.distanceToSquared(target.position) < 2.6 && bot.rng.chance(dt * 0.5)) {
      bot.melees++;
    }
  }

  private send(bot: Bot) {
    const snapshot: PlayerSnapshot = {
      t: this.manager.now,
      x: bot.position.x,
      y: bot.position.y,
      z: bot.position.z,
      yaw: bot.yaw,
      pitch: bot.pitch,
      weaponId: bot.weaponId,
      shots: bot.shots,
      melees: bot.melees,
      flags: packFlags({
        sprinting: bot.sprinting,
        crouching: bot.crouching,
        grounded: true,
        aiming: bot.reloadTimer <= 0 && !bot.sprinting,
        reloading: bot.reloadTimer > 0,
        dead: false,
      }),
      reloadProgress: bot.reloadTimer > 0 ? 1 - bot.reloadTimer / bot.reloadTime : 0,
      health: 100,
    };
    this.manager.push(bot.id, snapshot);
  }
}
