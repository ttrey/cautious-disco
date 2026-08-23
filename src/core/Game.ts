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
import { RemotePlayerManager } from '../characters/RemotePlayerManager';
import { DemoSquad } from '../characters/DemoSquad';
import { OPERATORS, OperatorId } from '../characters/SoldierMesh';
import { PlayerSnapshot, packFlags } from '../characters/RemotePlayer';
import { NetClient } from '../net/NetClient';
import { NetSession } from '../net/NetSession';
import { RosterEntry } from '../net/Protocol';
import {
  POINTS_HEADSHOT_KILL,
  POINTS_HIT,
  POINTS_KILL,
  WeaponSystem,
} from '../weapons/WeaponSystem';
import { AudioEngine } from '../audio/AudioEngine';
import { HUD, SquadEntry } from '../ui/HUD';
import { Nametags, NametagState } from '../ui/Nametags';
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
 * How far to the side of a window a zombie may be and still count as being on
 * the boards. Half the 1.8 m aperture: the proximity test that finds candidates
 * is a sphere, so without this a zombie walking past inside the room a metre to
 * the side of the frame gets shoved "outward" straight through solid wall and
 * into the sealed exterior, where the nav grid has no cells for it to walk back
 * along and it is lost for the rest of the round.
 */
const BARRIER_LATERAL = 0.9;
/**
 * Minimum spacing between hits the player can take. Six zombies whose attack
 * windows happen to line up would otherwise delete a full health bar in a
 * single frame with no chance to react.
 */
const DAMAGE_COOLDOWN = 0.42;

const _forward = new Vector3();
const _toProp = new Vector3();
const _tmp = new Vector3();
const _solo: Vector3[] = [new Vector3()];

/**
 * The single-player "roster": one position, in the array shape the horde wants.
 * Keeps `ZombieManager.update` from needing a second signature for the case
 * that is otherwise identical.
 */
function _soloPlayers(position: Vector3): readonly Vector3[] {
  _solo[0] = position;
  return _solo;
}

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
  /**
   * The other players in the lobby.
   *
   * In a co-op game this belongs to `NetSession`, which drives it from real
   * snapshots. `?squad=` still builds a standalone one fed by `DemoSquad` bots,
   * which is how the operator models get reviewed in motion without needing
   * three other machines. The two never coexist.
   */
  private remotes: RemotePlayerManager | null = null;
  private readonly squad: DemoSquad | null = null;
  private readonly nametags: Nametags;

  /** The co-op session, or null in single player. See `NetSession`. */
  private session: NetSession | null = null;
  /**
   * Cumulative melee counter the snapshot carries. There is no melee attack in
   * the game yet; the field exists because `SoldierAnimator` has the animation
   * and the wire format should not have to change on the day it is wired up.
   */
  private readonly meleeCount = 0;
  /** Reused each send so the 20 Hz loop allocates nothing. */
  private readonly snapshot: PlayerSnapshot = {
    t: 0,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    weaponId: 'pistol',
    shots: 0,
    melees: 0,
    flags: 0,
    reloadProgress: 0,
    health: 100,
  };
  private readonly nametagStates: NametagState[] = [];
  private readonly squadRows: SquadEntry[] = [];
  private roster: RosterEntry[] = [];
  private localName = 'You';

  private phase: Phase = 'menu';
  private round = 0;
  private points = STARTING_POINTS;
  private kills = 0;
  private health = MAX_HEALTH;
  private maxHealth = MAX_HEALTH;
  private timeSinceDamage = 99;
  private intermissionTimer = 0;
  private readonly perks = new Set<string>();
  /** Regeneration curve, relaxed by Quick Revive. */
  private regenDelay = REGEN_DELAY;
  private regenRate = REGEN_RATE;

  private focused: Interactable | null = null;
  private groanTimer = 3;
  private deathTimer = 0;
  /** Zombies left this round, as reported by the host. Clients only. */
  private netRemaining = 0;
  /**
   * Down but not out. Co-op only — see `die`. Kept separate from `phase`
   * precisely because the round clock must not stop when its owner goes down.
   */
  private downed = false;

  constructor(container: HTMLElement, engine: Engine, physics: Physics) {
    this.engine = engine;
    this.physics = physics;
    this.input = new Input(engine.renderer.domElement);
    this.effects = new Effects(engine.scene);

    this.level = new Level(engine.scene, physics, engine.quality).build();

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
      this.player.collider,
    );
    this.weapons.onPointsEarned = (amount) => {
      this.points += amount;
      this.hud.setPoints(this.points);
      this.hud.awardPoints(amount);
    };
    this.weapons.onHitmarker = (kill, headshot) => this.hud.hitmark(kill, headshot);

    this.hud = new HUD(container);
    this.hud.onStart = () => this.begin();
    this.hud.onRestart = () => this.restart();
    this.nametags = new Nametags(container, physics);

    // A client only ever *reports* damage; the host applies it and pays for it.
    this.zombies.onRemoteDamage = (index, damage, headshot) =>
      this.session?.reportHit(index, damage, headshot);

    this.input.onPointerLockChange((locked) => {
      if (!locked && this.phase !== 'menu' && this.phase !== 'dead' && !this.hud.overlayVisible) {
        this.hud.showPaused();
      }
    });

    // Stand-in teammates. Off unless asked for, because building three more
    // skinned characters costs real load time and a solo run does not need it.
    const squadSize = clamp(Number(new URLSearchParams(location.search).get('squad') ?? 0) || 0, 0, 3);
    if (squadSize > 0) {
      this.remotes = new RemotePlayerManager(engine.scene);
      this.squad = new DemoSquad(
        this.remotes,
        this.level.nav,
        this.level.floorY,
        this.level.playerSpawns,
        squadSize,
      );
    }

    this.hud.setPoints(this.points);
    this.hud.setRound(1, 0);
    engine.add(this);
  }

  /* --- Lifecycle -------------------------------------------------------- */

  /** Shows the classic briefing screen. Single player only. */
  startSinglePlayer() {
    this.session = null;
    this.hud.setSquad([]);
    this.hud.showStartScreen();
  }

  /**
   * Enters a co-op game.
   *
   * Called on every machine the moment the host presses start — the host from
   * its own click, everyone else from the button on the drop-in screen, which
   * exists because pointer lock and audio both need a real gesture and a
   * network message is not one.
   */
  startMultiplayer(session: NetSession, localName: string) {
    this.session = session;
    this.localName = localName;

    // The session owns the operator rigs in co-op. A `?squad=` demo manager, if
    // one was built, is retired: two managers would both try to hand out the
    // same four pooled characters.
    if (this.remotes && this.remotes !== session.remotes) this.remotes.clear();
    this.remotes = session.remotes;

    this.zombies.authority = session.isHost ? 'local' : 'remote';
    this.zombies.resetReplication();

    // A player dropping into a round already in progress has to catch up on the
    // doors that were bought before they arrived, or their nav grid is sealed
    // where everyone else's is open.
    if (!session.isHost) session.requestResync();

    this.spawnIntoLobby();
    this.begin();
  }

  /**
   * Moves the local player onto their own start point.
   *
   * Everybody spawning on `playerSpawn` would put four bodies inside each
   * other at the first frame, and the operator slot is the only index every
   * machine already agrees on — so it picks the spot, and nobody has to be told
   * where anybody else is standing.
   */
  private spawnIntoLobby() {
    const slot = this.session?.localIndex ?? 0;
    const spawn = this.level.playerSpawns[slot] ?? this.level.playerSpawn;
    this.player.teleport(spawn);
  }

  /** True when this machine runs the horde and the round clock. */
  private get authoritative(): boolean {
    return this.session === null || this.session.isHost;
  }

  private begin() {
    // Game state first: audio and pointer lock are best-effort, and neither
    // failing should leave the player staring at a menu that will not start.
    if (this.phase === 'menu') {
      this.phase = 'intermission';
      this.intermissionTimer = 3;
      this.hud.showBanner('ROUND 1', 'Get ready', 2.6);
    }
    this.engine.start();
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
    this.weapons.spreadMultiplier = 1;
    this.weapons.recoilMultiplier = 1;
    this.regenDelay = REGEN_DELAY;
    this.regenRate = REGEN_RATE;
    this.player.speedMultiplier = 1;
    this.player.controlEnabled = true;
    this.player.teleport(this.level.playerSpawn);
    for (const barrier of this.level.barriers) barrier.reset();
    for (const prop of this.level.interactables) prop.reset?.();

    this.hud.setPoints(this.points);
    this.hud.setPerks(this.perks);
    this.phase = 'intermission';
    this.intermissionTimer = 3;
    this.hud.showBanner('ROUND 1', 'Get ready', 2.6);
    this.input.requestLock();
  }

  private startRound() {
    this.round++;
    // Anybody who went down last round is back on their feet for this one.
    this.revive();
    // Wave size follows the classic curve: a handful early, plateauing near 26
    // so the frame budget and the spawn pool both stay honest.
    const count = Math.min(6 + Math.round(this.round * 2.9), 54);
    this.zombies.beginRound(this.round, count);
    this.phase = 'active';
    this.hud.setRound(this.round, this.zombies.remaining);
    // The banner is a status whisper, not a poster: the numeral itself already
    // lives top-right, so the centre text stays small and brief. (The HUD
    // clamps dwell and styles the type; here we only stop re-shouting what the
    // corner shows.)
    this.hud.showBanner(`ROUND ${this.round}`, this.round % 5 === 0 ? 'They are faster now' : 'Survive');
    this.audio.stinger(true);
    this.audio.duckAmbience(0.7, 2.2);
    // Out on the next frame rather than at the slow clock's convenience: a
    // round banner that lands after the wave it announces is worse than useless.
    this.session?.flushSlow();
  }

  private endRound() {
    this.phase = 'intermission';
    this.intermissionTimer = INTERMISSION;
    this.audio.stinger(false);
    this.hud.showBanner('ROUND CLEAR', 'Spend your points', 2.6);
    this.session?.flushSlow();
  }

  private onZombieKilled(_zombie: Zombie) {
    this.kills++;
  }

  /* --- Co-op event handlers --------------------------------------------- */

  /**
   * The host's round clock, applied on a client.
   *
   * Clients do not run round logic at all — they are told. Running the same
   * timers locally and hoping they agree is exactly the kind of thing that
   * works for ten rounds and then puts one player in an intermission while
   * everybody else is being chased.
   */
  onNetRound(round: number, phase: 'intermission' | 'active', remaining: number) {
    if (round !== this.round) {
      this.round = round;
      // Sets the difficulty numbers a replicated body is spawned with without
      // queueing any spawns of our own — the host owns those.
      this.zombies.beginRound(round, 0);
      this.revive();
      this.hud.showBanner(`ROUND ${round}`, round % 5 === 0 ? 'They are faster now' : 'Survive');
      this.audio.stinger(true);
    }
    if (phase !== this.phase && this.phase !== 'dead') {
      if (phase === 'intermission' && this.phase === 'active') {
        this.audio.stinger(false);
        this.hud.showBanner('ROUND CLEAR', 'Spend your points', 2.6);
      }
      this.phase = phase;
    }
    this.netRemaining = remaining;
  }

  /** A client applying the host's barrier state. */
  onNetBarriers(planks: number[]) {
    for (let i = 0; i < this.level.barriers.length && i < planks.length; i++) {
      this.level.barriers[i].setPlanks(planks[i]);
    }
  }

  /**
   * A host applying a hit a client reported.
   *
   * The damage number is taken on trust. This is a co-op game between friends
   * who were handed the lobby code personally — there is no ranked ladder to
   * protect, and the validation that would matter (does that player have line
   * of sight, does that weapon deal that much) costs more than the problem. The
   * one thing not taken on trust is the *payout*, which is computed here from
   * the zombie that actually died, so a bad actor can at worst kill things
   * early, not mint points.
   */
  onNetHit(from: string, index: number, damage: number, headshot: boolean) {
    const zombie = this.zombies.pool[index];
    if (!zombie?.active || zombie.state === 'dying' || zombie.state === 'dead') return;

    zombie.centre(_tmp);
    const killed = zombie.takeDamage(damage, {
      distance: 0,
      point: _tmp.clone(),
      label: headshot ? 'head' : 'torso',
      multiplier: 1,
    });
    if (!killed) return;

    // The *bonus*, not the whole payout.
    //
    // The shooter's own machine already paid itself `POINTS_HIT` for landing
    // the round, because on a client every hit comes back as `killed: false`
    // and is scored as an ordinary hit. Sending the full kill value on top
    // would pay a client 70 for a kill the host pays itself 60 for. Sending the
    // difference makes the two paths arrive at the same number, which is what
    // the scoreboard needs if it is going to be believed.
    const total = headshot ? POINTS_HEADSHOT_KILL : POINTS_KILL;
    this.session?.announceKill(index, from, total - POINTS_HIT, headshot);
    // The host runs its own kill effects; the shooter and everyone else get
    // theirs from the broadcast above.
    this.effects.gib(_tmp, _forward.set(0, 0, 1), zombie.position.y);
  }

  /** A confirmed kill, on every machine. Pays whoever earned it. */
  onNetKill(index: number, by: string, points: number, headshot: boolean) {
    const zombie = this.zombies.pool[index];
    if (!this.authoritative) {
      this.zombies.showRemoteKill(index, _tmp.set(0, 0, 1));
    }
    if (by !== this.session?.net.selfId) return;

    this.points += points;
    this.hud.setPoints(this.points);
    this.hud.awardPoints(points);
    this.hud.hitmark(true, headshot);
    this.kills++;
    // The shooter's own machine never declared this kill, so nothing has
    // played the heavy hit yet — the local `fireRay` came back with
    // `killed: false` because on a client it always does.
    if (zombie) this.audio.fleshHit(zombie.centre(_tmp), true);
  }

  /** Somebody else bought a door. Opens it here without charging for it. */
  onNetDoor(id: string) {
    const door = this.level.doors.find((d) => d.id === id);
    if (!door || door.open) return;
    door.open = true;
    this.openDoor(door, false);
  }

  /** This machine just gained or lost the host role. */
  onAuthorityChanged(isHost: boolean) {
    this.zombies.authority = isHost ? 'local' : 'remote';
    this.zombies.resetReplication();
    if (isHost) {
      // Inheriting the horde mid-round: the bodies on screen are the ones the
      // old host last sent, and they now belong to this machine's AI. Their
      // health was never replicated, so it is restored from the round curve
      // rather than left at whatever the pool happened to hold.
      this.zombies.adoptReplicatedHorde(this.round);
      this.hud.showBanner('HOST MIGRATED', 'You are running the game now', 2.4);
    }
  }

  /** Roster changed: names, scores, membership. */
  onRosterChanged(roster: RosterEntry[]) {
    this.roster = roster;
  }

  private damageCooldown = 0;

  private damagePlayer(amount: number) {
    if (this.phase !== 'active' || this.damageCooldown > 0 || this.downed) return;
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

  /**
   * The local player runs out of health.
   *
   * Solo, this is the end of the run. In co-op it is not, and treating it as
   * one breaks the lobby in a way that is not obvious until it happens: the
   * round clock lives on the host, and a host who is "dead" stops advancing it,
   * so one player being unlucky freezes the game for three people who are still
   * fighting.
   *
   * So co-op takes the rule the genre already settled on. Going down takes you
   * out of the round — no control, no weapon, no damage — and the next round
   * puts you back on your feet. The run ends when the *whole squad* is down,
   * which is the only condition that is genuinely everybody's business.
   */
  private die() {
    this.health = 0;
    this.audio.stinger(false);

    if (this.session) {
      this.downed = true;
      this.player.controlEnabled = false;
      // Pointer lock is kept: a downed player still gets to look around and
      // watch the round they are waiting to rejoin.
      this.session.reportScore(99, this.points, this.kills, true, false);
      this.hud.showBanner('YOU ARE DOWN', 'Back in at the next round', 3.2);
      return;
    }

    this.phase = 'dead';
    this.deathTimer = 0;
    this.player.controlEnabled = false;
    // Clearing the field is a solo courtesy — it stops the horde chewing on a
    // corpse behind the game-over screen.
    this.zombies.clear();
    this.input.releaseLock();
  }

  /** Puts a downed player back in at the start of a round. */
  private revive() {
    if (!this.downed) return;
    this.downed = false;
    this.health = this.maxHealth;
    this.timeSinceDamage = 99;
    this.player.controlEnabled = true;
    this.player.teleport(this.level.playerSpawns[this.session?.localIndex ?? 0] ?? this.level.playerSpawn);
    this.hud.showBanner('BACK UP', 'Stay with the squad', 2.2);
  }

  /**
   * Ends the run once nobody is left standing.
   *
   * Decided independently on each machine from the roster the server keeps,
   * rather than announced by the host — the host is quite possibly one of the
   * corpses, and a message it never got to send is exactly the failure this
   * has to survive.
   */
  private checkSquadWipe() {
    if (!this.session || this.phase === 'dead' || !this.downed) return;
    if (this.roster.length === 0) return;
    const anyoneUp = this.roster.some((entry) => !entry.downed && entry.alive);
    if (anyoneUp) return;
    this.phase = 'dead';
    this.deathTimer = 0;
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
      case 'quickRevive':
        // No downed state to revive from yet, so it does the solo thing: the
        // player comes back from a mauling far faster.
        this.regenDelay = 1.7;
        this.regenRate = 58;
        break;
      case 'deadshot':
        this.weapons.spreadMultiplier = 0.6;
        this.weapons.recoilMultiplier = 0.62;
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

  /**
   * Opens a door and everything that counts as the same purchase.
   *
   * `announce` is false when this is *replaying* somebody else's purchase, so
   * the message that caused it is not echoed back out. Doors are broadcast by
   * the buyer rather than the host: the buyer is the only machine that knows
   * whether the payment succeeded, and routing it through the host would put a
   * round trip between pressing E and the boards coming off.
   */
  private openDoor(door: Door, announce = true) {
    for (const zone of door.unlocksZones) this.zombies.openZone(zone);
    if (announce) this.session?.announceDoor(door.id);

    // Several areas of the map have more than one way in. Buying one of them
    // opens the rest: the alternative doorway is the same purchase seen from
    // another room, and leaving it boarded turns a deliberate loop into a
    // dead end the player has already paid for. Siblings animate themselves
    // open on the next frame and run their own nav callbacks.
    for (const other of this.level.doors) {
      if (other === door || other.open) continue;
      if (other.group === door.group) other.open = true;
    }

    this.hud.showBanner('AREA OPEN', door.label.toUpperCase(), 2);
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
      // Only the machine running the AI tears boards down. A client's horde is
      // a set of replicated transforms with no steering to hold back, so
      // running this there would rip planks off a window nothing is working on.
      if (!this.authoritative) continue;
      if (barrier.planksRemaining <= 0) continue;

      // Every zombie in the window works it, not just the first one found. This
      // loop used to break after one, which meant the second zombie to reach a
      // barrier was never held at all and strolled through six intact planks as
      // if the boards were not there.
      for (const z of this.zombies.pool) {
        if (!z.active || z.state === 'dying') continue;
        if (z.position.distanceToSquared(barrier.position) > 4) continue;

        // Hold the zombie on the outside of the window. The nav field routes it
        // here; the boards are what decide when it gets through.
        _tmp.subVectors(z.position, barrier.position).setY(0);
        const depth = _tmp.dot(barrier.outward);
        // Only a zombie squarely in the aperture is on the boards. Strip the
        // outward component and reject anything too far along the wall, so a
        // passer-by inside the room is never pushed out through the masonry.
        _tmp.addScaledVector(barrier.outward, -depth);
        if (_tmp.lengthSq() > BARRIER_LATERAL * BARRIER_LATERAL) continue;

        if (depth < BARRIER_STANDOFF) {
          z.position.addScaledVector(barrier.outward, BARRIER_STANDOFF - depth);
          // Kill the inward velocity component so it stops pushing.
          const inward = z.velocity.dot(barrier.outward);
          if (inward < 0) z.velocity.addScaledVector(barrier.outward, -inward);
        }

        barrier.breachTimer = 0.6;
        // Roughly one plank per second per zombie working the window.
        if (this.rng.chance(dt * 0.9)) {
          const breached = barrier.tearPlank();
          this.audio.hammer(barrier.position);
          // Last plank gone — nobody else at this window is held any longer.
          if (breached) {
            // A window opening is the one barrier change worth a packet of its
            // own: it is what tells a teammate the room they are in is no
            // longer sealed.
            this.session?.flushSlow();
            break;
          }
        }
      }
    }
  }

  private updateInteraction(dt: number) {
    // A downed player cannot buy, repair or board a window.
    if (this.downed) {
      this.focused = null;
      this.hud.setPrompt(null);
      return;
    }
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

    this.physics.step(dt);

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

    // Teammates first: the horde steers toward where they are *this* frame, and
    // updating them afterwards would aim every zombie at last frame's squad.
    if (this.squad) this.squad.update(dt, this.zombies);
    if (this.session) this.session.update(dt, this.player.position);
    else if (this.remotes) this.remotes.update(dt, this.player.position);

    const players = this.session
      ? this.session.playerPositions(this.player.position)
      : _soloPlayers(this.player.position);
    const localIndex = this.session?.localIndex ?? 0;

    // The horde keeps running through a co-op death: the bodies on screen
    // belong to teammates who are still alive and still being chased, and on
    // the host they are the round everybody else is playing.
    const hordeRuns =
      this.phase === 'active' || this.phase === 'intermission' || this.session !== null;
    if (hordeRuns) {
      this.zombies.update(dt, players, localIndex, 0.34, this.level.floorY);
    }

    for (const prop of this.level.interactables) prop.update?.(dt, elapsed);
    // The map carries more light fixtures than a scene can afford live lights
    // for, so the rig follows the player. See Level.addLighting.
    this.level.updateLights(this.player.position, dt);

    this.weapons.update(dt, this.engine.camera, this.engine.viewCamera, {
      moveIntensity: this.player.moveIntensity,
      crouching: this.player.crouching,
      sprinting: this.player.sprinting,
      bobPhase: this.player.bob.phase,
      bobAmount: this.player.bob.amount,
      canAct: !this.downed && (this.phase === 'active' || this.phase === 'intermission'),
    });

    // An optic's sight picture is a second view of the same world, so it has to
    // be drawn after everything that moves has been written for this frame and
    // before the main pass consumes the render target.
    const opticFov = this.weapons.opticFov;
    this.weapons.setOpticView(opticFov > 0 ? this.engine.renderScopeView(opticFov) : null);

    this.effects.update(dt, this.engine.camera);

    this.updateHealth(dt);
    this.checkSquadWipe();
    this.updateRoundFlow(dt);
    this.updateAudio(dt);
    this.updateHud(dt);
    // After the camera has been written for this frame, so the labels project
    // against the view actually being drawn rather than the previous one.
    this.updateSquadUi(dt);

    this.input.endFrame();
  }

  private updateHealth(dt: number) {
    if (this.phase === 'dead' || this.downed) return;
    this.damageCooldown = Math.max(0, this.damageCooldown - dt);
    this.timeSinceDamage += dt;
    if (this.timeSinceDamage > this.regenDelay && this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + this.regenRate * dt);
    }
  }

  private updateRoundFlow(dt: number) {
    // Clients are told when the round turns over; running the clock locally as
    // well would have two machines deciding the same thing and disagreeing.
    if (!this.authoritative) return;
    if (this.phase === 'intermission') {
      this.intermissionTimer -= dt;
      if (this.intermissionTimer <= 0) this.startRound();
    } else if (this.phase === 'active' && this.zombies.remaining === 0) {
      this.endRound();
    }
  }

  /**
   * Nametags and the corner scoreboard.
   *
   * Both are rebuilt from the roster rather than from the rigs, so a teammate
   * who has joined but whose first snapshot has not landed still has a row in
   * the corner. The nametag is the opposite — it needs a body to sit above, so
   * it waits for one.
   */
  private updateSquadUi(dt: number) {
    if (!this.session) {
      this.nametags.update(dt, this.engine.camera, this.player.eyePosition, [], this.player.collider);
      return;
    }

    this.nametagStates.length = 0;
    this.squadRows.length = 0;

    for (const entry of this.roster) {
      const self = entry.id === this.session.net.selfId;
      const accent = OPERATORS[entry.operator as OperatorId]?.accent ?? 0xffffff;
      this.squadRows.push({
        id: entry.id,
        name: self ? this.localName : entry.name,
        points: self ? this.points : entry.points,
        color: `#${accent.toString(16).padStart(6, '0')}`,
        self,
        downed: entry.downed,
        alive: entry.alive,
      });

      if (self) continue;
      const remote = this.session.remotes.get(entry.id);
      if (!remote?.active) continue;
      this.nametagStates.push({
        id: entry.id,
        name: entry.name,
        position: remote.position,
        // Above the helmet, and lower when they crouch, which the animator
        // already knows about — a constant offset puts the label in the chest
        // of a crouching operator.
        height: 1.78 + (remote.crouching ? -0.5 : 0),
        health: remote.health,
        maxHealth: 100,
        downed: entry.downed || !entry.alive,
      });
    }

    this.hud.setSquad(this.squadRows);
    this.nametags.update(
      dt,
      this.engine.camera,
      this.player.eyePosition,
      this.nametagStates,
      this.player.collider,
    );

    this.session.reportScore(dt, this.points, this.kills, this.downed, this.phase !== 'dead');
  }

  /** Fills the reused snapshot with the local player's current state. */
  private sampleLocalSnapshot(): PlayerSnapshot {
    const s = this.snapshot;
    s.x = this.player.position.x;
    s.y = this.player.position.y;
    s.z = this.player.position.z;
    s.yaw = this.player.yaw;
    s.pitch = this.player.pitch;
    s.weaponId = this.weapons.active.def.id;
    s.shots = this.weapons.shotsFired;
    s.melees = this.meleeCount;
    s.flags = packFlags({
      sprinting: this.player.sprinting,
      crouching: this.player.crouching,
      grounded: this.player.grounded,
      aiming: this.weapons.aimBlend > 0.5,
      reloading: this.weapons.isReloading,
      dead: this.downed || this.phase === 'dead',
    });
    s.reloadProgress = this.weapons.reloadProgress;
    s.health = Math.round(this.health);
    return s;
  }

  /** Board counts for the host's barrier packet, in the level's own order. */
  private sampleBarriers(): number[] {
    return this.level.barriers.map((b) => b.planksRemaining);
  }

  /**
   * Builds the co-op session for a connected socket.
   *
   * A factory rather than something the caller assembles, because the session
   * needs the scene and the horde, and handing those out to `main.ts` would
   * make the entry point a place that knows about zombie internals.
   */
  createSession(net: NetClient): NetSession {
    return new NetSession(net, this.engine.scene, this.zombies, this.netHooks());
  }

  /** The hooks `NetSession` drives this game through. */
  private netHooks() {
    return {
      sampleLocal: () => this.sampleLocalSnapshot(),
      sampleRound: () => ({
        round: Math.max(1, this.round),
        phase: (this.phase === 'active' ? 'active' : 'intermission') as 'active' | 'intermission',
        remaining: this.zombies.remaining,
      }),
      sampleBarriers: () => this.sampleBarriers(),
      onRound: (r: number, phase: 'intermission' | 'active', remaining: number) =>
        this.onNetRound(r, phase, remaining),
      onDoorOpened: (id: string) => this.onNetDoor(id),
      onBarriers: (planks: number[]) => this.onNetBarriers(planks),
      onKillConfirmed: (i: number, by: string, points: number, head: boolean) =>
        this.onNetKill(i, by, points, head),
      onRemoteHit: (from: string, i: number, damage: number, head: boolean) =>
        this.onNetHit(from, i, damage, head),
      onRoster: (roster: RosterEntry[]) => this.onRosterChanged(roster),
      onAuthorityChanged: (isHost: boolean) => this.onAuthorityChanged(isHost),
      onDisconnected: () => this.onDisconnected(),
    };
  }

  private onDisconnected() {
    if (!this.session) return;
    this.hud.showBanner('DISCONNECTED', 'Lost the lobby', 3.4);
    // Fall back to a solo game rather than freezing: the level, the horde and
    // the player are all still here, and only the horde's owner has changed.
    this.session = null;
    this.remotes = null;
    this.zombies.authority = 'local';
    this.zombies.adoptReplicatedHorde(this.round);
    this.hud.setSquad([]);
    this.nametags.clear();
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
    // On a client the count comes from the host: this machine's pool only holds
    // the bodies it has been sent, and knows nothing about the ones still
    // queued to spawn.
    const remaining = this.authoritative ? this.zombies.remaining : this.netRemaining;
    this.hud.setRound(Math.max(1, this.round), this.phase === 'active' ? remaining : 0);
    this.hud.setSpread(this.weapons.crosshairSpread(this.player.moveIntensity, this.player.crouching));
    const recoil = this.weapons.crosshairRecoil(this.engine.camera);
    this.hud.setRecoilOffset(recoil.x, recoil.y);
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
