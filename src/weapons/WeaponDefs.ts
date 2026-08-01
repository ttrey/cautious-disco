import { Vector3 } from 'three';
import type { GunAudioSpec } from '../audio/AudioEngine';
import {
  GunModel,
  buildBarrettM82A1,
  buildAether9,
  buildDesertEagle,
  buildPistol,
  buildRifle,
  buildScar,
  buildShotgun,
  buildSmg,
  buildSpas12,
  buildM240,
  buildStormweaver,
} from './GunSmith';

export type WeaponClass = 'pistol' | 'smg' | 'rifle' | 'shotgun' | 'lmg';
export type FireMode = 'auto' | 'semi' | 'pump';
export type WonderEffect = 'plasma' | 'arc';

/**
 * A small, data-driven extension to the normal hitscan gun profile. Keeping
 * this on the definition means the weapon system does not need to know either
 * wonder weapon by id, and Pack-a-Punch damage still flows through the normal
 * damage calculation.
 */
export interface WonderWeaponProfile {
  kind: WonderEffect;
  /** Plasma only: radius of the impact burst in metres. */
  splashRadius?: number;
  /** Plasma only: fraction of the direct damage dealt by the splash. */
  splashDamageMultiplier?: number;
  /** Arc only: number of additional targets after the initial hit. */
  chainTargets?: number;
  /** Arc only: maximum distance between two linked targets in metres. */
  chainRange?: number;
  /** Arc only: fraction of the direct damage dealt by the first arc. */
  chainDamageMultiplier?: number;
}

export interface RecoilProfile {
  /** Degrees of upward view kick per shot. */
  vertical: number;
  /** Degrees of horizontal wander per shot; sign alternates with a bias. */
  horizontal: number;
  /** Directional bias, -1..1 — gives each gun a recognisable climb pattern. */
  drift: number;
  /** Viewmodel punch backwards, in metres. */
  kick: number;
  /** How fast the view returns to centre, higher = snappier. */
  recovery: number;
}

export interface WeaponDef {
  id: string;
  name: string;
  class: WeaponClass;
  build: () => GunModel;

  damage: number;
  headshotMultiplier: number;
  /** Rounds per minute. */
  rpm: number;
  fireMode: FireMode;
  /** Projectiles per trigger pull — >1 for the shotgun. */
  pellets: number;

  magSize: number;
  reserveAmmo: number;
  maxReserve: number;
  reloadTime: number;
  /** Extra time for the first shell/charging cycle when the chamber is empty. */
  emptyReloadExtra: number;
  /** Shotgun-style shell-at-a-time reload, interruptible by firing. */
  shellReload: boolean;
  /**
   * A belt-fed gun opens its feed tray and swaps the ammo can during the
   * normal reload timeline. The standard path remains a detachable magazine.
   */
  reloadStyle?: 'belt';

  /** Cone half-angle in degrees at the hip, standing still. */
  spread: number;
  adsSpreadMultiplier: number;
  movementSpread: number;

  range: number;
  falloffStart: number;
  /** Damage multiplier at maximum range. */
  falloffFloor: number;
  /** How many zombies a single round punches through. */
  penetration: number;

  recoil: RecoilProfile;

  /** Points cost when bought off a wall; ammo refill is a third of this. */
  wallCost: number;
  /** Points awarded per damage dealt is global; this scales pack-a-punch cost. */
  packCost: number;
  packName: string;
  packDamageMultiplier: number;
  packMagMultiplier: number;

  /**
   * Viewmodel rest position relative to the view camera.
   *
   * Z is the one number that decides whether a weapon reads at the hip. The
   * camera sits at the origin looking down -Z, so anything at z >= 0 is behind
   * the eye and is clipped away: a long weapon parked at the same z as a
   * carbine loses its receiver, its grip and the hand holding it, and what
   * survives is a foreshortened sliver in the corner of the screen. Set this
   * from the firing grip — `-(rightGrip.z + reach)` — so every weapon presents
   * its fire controls at the same distance regardless of overall length.
   */
  hipPosition: [number, number, number];
  hipRotation: [number, number, number];
  /**
   * Eye relief: how far in front of the eye the *rear sighting element* sits
   * when aimed, as a negative number. Combined with the model's `sightForward`
   * (the negated model-space Z of that element) it places the weapon so the
   * sight lands exactly here.
   *
   * Too much of it is the classic ADS failure: push a rifle far enough forward
   * and its buttstock stops clearing the camera, leaving a slab of stock
   * smeared across the bottom of the sight picture. A shouldered long gun wants
   * roughly 0.10; a pistol at arm's length and a shotgun sighted on a muzzle
   * bead want far more, because their sighting element is further out.
   */
  adsDistance: number;
  /**
   * Magnification applied to the world camera at full ADS. Iron sights take a
   * slight pull-in; a telescopic sight takes its optical power, which is the
   * whole reason for carrying one.
   */
  adsZoom?: number;
  /** Seconds to raise/lower the weapon on swap. */
  swapTime: number;
  adsTime: number;
  /** Weapon-space grip points the hands are IK-solved onto. */
  rightGrip: [number, number, number];
  leftGrip: [number, number, number];

  /**
   * Audio character. See `GunAudioSpec` — every layer of the report is driven
   * from here, deliberately, so that no two weapons share a component of their
   * sound.
   */
  audio: GunAudioSpec;

  /** Optional per-platform muzzle scale for high-pressure cartridges. */
  muzzleFlashScale?: number;
  /** Optional casing scale for cartridges larger than the rifle baseline. */
  shellScale?: number;
  /** Special combat and presentation behaviour for a wonder weapon. */
  wonder?: WonderWeaponProfile;
  /** Relative Mystery Box selection weight; ordinary box weapons use 1. */
  mysteryWeight?: number;
}

const v = (x: number, y: number, z: number): [number, number, number] => [x, y, z];

export const WEAPONS: Record<string, WeaponDef> = {
  pistol: {
    id: 'pistol',
    name: 'M9 Sidearm',
    class: 'pistol',
    build: buildPistol,
    damage: 42,
    headshotMultiplier: 2.6,
    rpm: 420,
    fireMode: 'semi',
    pellets: 1,
    magSize: 15,
    reserveAmmo: 90,
    maxReserve: 150,
    reloadTime: 1.5,
    emptyReloadExtra: 0.45,
    shellReload: false,
    spread: 1.1,
    adsSpreadMultiplier: 0.28,
    movementSpread: 2.2,
    range: 60,
    falloffStart: 18,
    falloffFloor: 0.6,
    penetration: 1,
    recoil: { vertical: 1.5, horizontal: 0.5, drift: 0.2, kick: 0.024, recovery: 12 },
    wallCost: 0,
    packCost: 5000,
    packName: 'Mustang & Sally',
    packDamageMultiplier: 3.4,
    packMagMultiplier: 1.6,
    // A pistol is held out at arm's length, so it sits further from the eye
    // than the long guns despite being the smallest weapon here.
    hipPosition: v(0.095, -0.115, -0.32),
    hipRotation: v(0.02, -0.05, 0.02),
    // The rear notch sits 46 mm behind the model origin, so this is the same
    // sight placement the weapon has always had, restated in the terms the
    // field now documents.
    adsDistance: -0.239,
    adsZoom: 1.12,
    swapTime: 0.42,
    adsTime: 0.19,
    // Far enough back that the palm lands on the back strap and the knuckles
    // come to rest on the front strap — which also puts the trigger ahead of
    // the index knuckle, so the finger reaches forward to it instead of having
    // to hook backwards around its own hand.
    rightGrip: v(0.024, -0.070, 0.055),
    // The support hand rides forward of the firing hand, not alongside it —
    // its fingers close over the backs of the firing hand's fingers, and both
    // sets wrapping the same 30 mm of grip at the same depth interleaves them.
    leftGrip: v(-0.016, -0.070, 0.012),
    audio: {
      bodyHz: 168,
      crack: 0.055,
      tail: 0.5,
      gain: 0.72,
      // Light slide, snappy and high: the M9 is the brightest action here.
      actionHz: 3050,
      crackHz: 3900,
      crackFallHz: 620,
      bodyCutoffHz: 1250,
      bodyDrop: 0.46,
    },
  },

  smg: {
    id: 'smg',
    name: 'MP-40K',
    class: 'smg',
    build: buildSmg,
    damage: 34,
    headshotMultiplier: 2.1,
    rpm: 800,
    fireMode: 'auto',
    pellets: 1,
    magSize: 32,
    reserveAmmo: 192,
    maxReserve: 288,
    reloadTime: 2.1,
    emptyReloadExtra: 0.55,
    shellReload: false,
    spread: 1.9,
    adsSpreadMultiplier: 0.34,
    movementSpread: 2.6,
    range: 48,
    falloffStart: 14,
    falloffFloor: 0.5,
    penetration: 1,
    recoil: { vertical: 0.98, horizontal: 0.46, drift: -0.3, kick: 0.017, recovery: 14 },
    wallCost: 1000,
    packCost: 5000,
    packName: 'The Afterburner',
    packDamageMultiplier: 3.0,
    packMagMultiplier: 1.5,
    hipPosition: v(0.1, -0.13, -0.22),
    hipRotation: v(0.015, -0.04, 0.015),
    adsDistance: -0.236,
    adsZoom: 1.15,
    swapTime: 0.5,
    adsTime: 0.22,
    rightGrip: v(0.024, -0.066, 0.066),
    leftGrip: v(-0.006, -0.018, -0.175),
    audio: {
      bodyHz: 142,
      crack: 0.048,
      tail: 0.42,
      gain: 0.66,
      // Open-bolt chatter — the fastest cycle on the roster, so the action
      // layer is short and papery rather than sharp.
      actionHz: 2450,
      crackHz: 3150,
      crackFallHz: 540,
      bodyCutoffHz: 1050,
      bodyDrop: 0.40,
    },
  },

  rifle: {
    id: 'rifle',
    name: 'M4 Carbine',
    class: 'rifle',
    build: buildRifle,
    damage: 58,
    headshotMultiplier: 2.4,
    rpm: 620,
    fireMode: 'auto',
    pellets: 1,
    magSize: 30,
    reserveAmmo: 210,
    maxReserve: 330,
    reloadTime: 2.35,
    emptyReloadExtra: 0.6,
    shellReload: false,
    spread: 1.35,
    adsSpreadMultiplier: 0.2,
    movementSpread: 2.9,
    range: 90,
    falloffStart: 34,
    falloffFloor: 0.68,
    penetration: 2,
    recoil: { vertical: 1.32, horizontal: 0.42, drift: 0.45, kick: 0.022, recovery: 11 },
    wallCost: 1400,
    packCost: 5000,
    packName: 'Skullsplitter',
    packDamageMultiplier: 3.2,
    packMagMultiplier: 1.6,
    hipPosition: v(0.095, -0.13, -0.2),
    hipRotation: v(0.012, -0.035, 0.012),
    adsDistance: -0.22,
    adsZoom: 1.18,
    swapTime: 0.56,
    adsTime: 0.25,
    rightGrip: v(0.024, -0.060, 0.073),
    leftGrip: v(0.002, -0.012, -0.185),
    audio: {
      bodyHz: 118,
      crack: 0.062,
      tail: 0.6,
      gain: 0.85,
      // 5.56 out of a carbine: a hard, bright whipcrack over a modest body.
      actionHz: 2000,
      crackHz: 4400,
      crackFallHz: 430,
      bodyCutoffHz: 900,
      bodyDrop: 0.33,
    },
  },

  fnScar: {
    id: 'fnScar',
    name: 'FN SCAR-H',
    class: 'rifle',
    build: buildScar,
    // The SCAR is the battle-rifle roll: substantially harder-hitting and more
    // precise at range than the M4, balanced by a 20-round magazine, assertive
    // recoil and a slower reload. It is a reward, not a wall-buy sidegrade.
    damage: 94,
    headshotMultiplier: 2.2,
    rpm: 625,
    fireMode: 'auto',
    pellets: 1,
    magSize: 20,
    reserveAmmo: 120,
    maxReserve: 180,
    reloadTime: 2.7,
    emptyReloadExtra: 0.7,
    shellReload: false,
    spread: 1.08,
    adsSpreadMultiplier: 0.16,
    movementSpread: 3.05,
    range: 118,
    falloffStart: 46,
    falloffFloor: 0.72,
    penetration: 3,
    recoil: { vertical: 2.15, horizontal: 0.62, drift: 0.22, kick: 0.034, recovery: 9.4 },
    wallCost: 0,
    packCost: 5000,
    packName: 'Iron Dominion',
    packDamageMultiplier: 2.7,
    packMagMultiplier: 1.5,
    // The rifle's length of pull is 340 mm, measured off the reference: the
    // grip sits a long way forward of the butt, and 59 mm forward of where the
    // old model put it. Both grips and the hip Z follow it, or the firing hand
    // ends up out over the magwell holding nothing.
    hipPosition: v(0.108, -0.138, -0.178),
    hipRotation: v(0.016, -0.052, 0.016),
    // The rear aperture now sits where the real rifle's does, 54 mm forward of
    // the model origin instead of 112 mm back on the stock, so the relief has to
    // grow by the same amount to leave the weapon parked where it was. Held at
    // 100 mm the ring alone subtended a quarter of the screen.
    adsDistance: -0.165,
    adsZoom: 1.24,
    swapTime: 0.7,
    adsTime: 0.29,
    rightGrip: v(0.024, -0.071, 0.033),
    // Mid-handguard, on the six o'clock rail. Reachable now only because the
    // whole weapon came back with the grip — the original point out at 275 mm
    // was past the end of the arm, so the IK gave up short and the support
    // hand floated under the barrel holding nothing.
    leftGrip: v(-0.024, -0.021, -0.245),
    audio: {
      bodyHz: 102,
      crack: 0.070,
      tail: 0.7,
      gain: 0.98,
      // 7.62 through a heavier reciprocating group: lower action, deeper crack.
      actionHz: 1420,
      crackHz: 3700,
      crackFallHz: 330,
      bodyCutoffHz: 760,
      bodyDrop: 0.28,
    },
    muzzleFlashScale: 1.16,
    shellScale: 1.14,
  },

  shotgun: {
    id: 'shotgun',
    name: 'Trench Sweeper',
    class: 'shotgun',
    build: buildShotgun,
    damage: 34,
    headshotMultiplier: 1.5,
    rpm: 78,
    fireMode: 'pump',
    pellets: 9,
    magSize: 6,
    reserveAmmo: 42,
    maxReserve: 72,
    reloadTime: 0.52, // per shell
    emptyReloadExtra: 0.3,
    shellReload: true,
    spread: 4.6,
    adsSpreadMultiplier: 0.62,
    movementSpread: 1.4,
    range: 26,
    falloffStart: 7,
    falloffFloor: 0.25,
    penetration: 1,
    recoil: { vertical: 4.4, horizontal: 0.9, drift: 0.1, kick: 0.062, recovery: 8 },
    wallCost: 1200,
    packCost: 5000,
    packName: 'Widowmaker',
    packDamageMultiplier: 3.6,
    packMagMultiplier: 1.4,
    hipPosition: v(0.1, -0.128, -0.19),
    hipRotation: v(0.014, -0.04, 0.014),
    // Sighted on the muzzle bead rather than a rear notch, so the "eye relief"
    // here is the whole length of the gun plus a shoulder.
    adsDistance: -0.666,
    adsZoom: 1.1,
    swapTime: 0.6,
    adsTime: 0.28,
    // Right hand on the stock's semi-pistol wrist, left on the pump forend.
    rightGrip: v(0.024, -0.038, 0.114),
    leftGrip: v(-0.015, -0.014, -0.212),
    audio: {
      bodyHz: 92,
      crack: 0.085,
      tail: 0.85,
      gain: 1.0,
      // A pump gun's report is nearly all blast: a dull action, a broad crack
      // that barely sweeps, and a body that holds its pitch.
      actionHz: 900,
      crackHz: 2100,
      crackFallHz: 260,
      bodyCutoffHz: 620,
      bodyDrop: 0.55,
    },
  },

  spas12: {
    id: 'spas12',
    name: 'SPAS-12',
    class: 'shotgun',
    build: buildSpas12,
    // The SPAS earns its box slot through cadence and usable reach, not an
    // arbitrary one-shot kill. It has a tighter, longer-ranged ten-pellet
    // pattern than the Trench Sweeper, but still needs deliberate shell
    // management and cannot erase a horde at rifle distance.
    damage: 40,
    headshotMultiplier: 1.55,
    rpm: 220,
    fireMode: 'semi',
    pellets: 10,
    magSize: 8,
    reserveAmmo: 64,
    maxReserve: 96,
    reloadTime: 0.47,
    emptyReloadExtra: 0.32,
    shellReload: true,
    spread: 3.65,
    adsSpreadMultiplier: 0.48,
    movementSpread: 1.55,
    range: 34,
    falloffStart: 10,
    falloffFloor: 0.32,
    penetration: 2,
    recoil: { vertical: 3.7, horizontal: 0.7, drift: 0.08, kick: 0.052, recovery: 9.5 },
    // Reserved for the mystery box. A complete economy value is retained for
    // future code, but it is deliberately excluded from WALL_WEAPONS.
    wallCost: 0,
    packCost: 5000,
    packName: 'Last Rites',
    packDamageMultiplier: 3.2,
    packMagMultiplier: 1.5,
    hipPosition: v(0.105, -0.134, -0.255),
    hipRotation: v(0.018, -0.05, 0.018),
    // Long, because the SPAS's rear notch is not on the receiver — it sits well
    // forward on the top cover, so a shouldered gun puts it most of a receiver
    // length further down range than a rifle's aperture. Pairing this with the
    // model's positive `sightForward` is what keeps the notch on the eye axis
    // instead of burying the receiver's back end in the camera.
    adsDistance: -0.345,
    adsZoom: 1.14,
    swapTime: 0.68,
    adsTime: 0.3,
    rightGrip: v(0.027, -0.043, 0.11),
    // The forend now starts 244 mm out, and the support arm cannot quite reach
    // its middle from a hip pose this far forward — `solveTwoBoneIK` clamps
    // rather than failing, so an over-ambitious value parks the hand in mid-air
    // instead of erroring. Measured against the wrist in both poses, this is
    // the balance point: ~25 mm short at the hip, ~22 mm at ADS, where -0.186
    // and -0.202 each trade one for 30 mm of the other.
    leftGrip: v(-0.022, -0.026, -0.194),
    audio: {
      bodyHz: 78,
      crack: 0.09,
      tail: 0.9,
      gain: 1.05,
      // Gas-operated and heavier than the Trench Sweeper — a metallic clack on
      // top of an even lower blast.
      actionHz: 1150,
      crackHz: 1850,
      crackFallHz: 210,
      bodyCutoffHz: 540,
      bodyDrop: 0.60,
    },
    muzzleFlashScale: 1.26,
    shellScale: 1.5,
  },

  desertEagle: {
    id: 'desertEagle',
    name: 'Desert Eagle .50 AE',
    class: 'pistol',
    build: buildDesertEagle,
    // A box weapon should feel like a decisive answer without erasing the
    // need for a headshot in later rounds. The seven-round mag and slow cycle
    // keep it deliberate beside the M9's 15-round, 420 RPM profile.
    damage: 148,
    headshotMultiplier: 2.35,
    rpm: 180,
    fireMode: 'semi',
    pellets: 1,
    magSize: 7,
    reserveAmmo: 70,
    maxReserve: 98,
    reloadTime: 2.05,
    emptyReloadExtra: 0.58,
    shellReload: false,
    spread: 0.82,
    adsSpreadMultiplier: 0.16,
    movementSpread: 2.4,
    range: 82,
    falloffStart: 28,
    falloffFloor: 0.62,
    penetration: 2,
    recoil: { vertical: 5.4, horizontal: 0.9, drift: -0.16, kick: 0.072, recovery: 7.2 },
    // Intentionally absent from WALL_WEAPONS: this value is only retained so
    // future economy code has a complete WeaponDef without implying a wall
    // placement today.
    wallCost: 0,
    packCost: 5000,
    packName: 'The Hand of God',
    packDamageMultiplier: 2.45,
    packMagMultiplier: 1.7,
    // Matched to the M9's height and reach: at the old, lower and further-right
    // rest pose the whole grip fell below the bottom of the frame and the
    // pistol floated on screen with no hands on it.
    hipPosition: v(0.10, -0.117, -0.326),
    hipRotation: v(0.025, -0.06, 0.025),
    adsDistance: -0.271,
    adsZoom: 1.16,
    swapTime: 0.66,
    adsTime: 0.25,
    rightGrip: v(0.03, -0.072, 0.066),
    leftGrip: v(0.0, -0.068, 0.014),
    audio: {
      bodyHz: 98,
      crack: 0.078,
      tail: 0.72,
      gain: 1.08,
      // .50 AE: a huge slide slamming a heavy frame, and a very bright crack —
      // the pairing of a low action with a high crack is the Deagle's whole
      // signature.
      actionHz: 1250,
      crackHz: 5200,
      crackFallHz: 390,
      bodyCutoffHz: 820,
      bodyDrop: 0.30,
    },
    muzzleFlashScale: 1.42,
    shellScale: 1.2,
  },

  barrettM82A1: {
    id: 'barrettM82A1',
    name: 'Barrett M82A1',
    class: 'rifle',
    build: buildBarrettM82A1,
    // Anti-materiel damage and penetration are offset by a 38 RPM cycle,
    // heavy recoil and a deliberately long reload. This is a power weapon,
    // not a faster M4.
    damage: 340,
    headshotMultiplier: 2.2,
    rpm: 38,
    fireMode: 'semi',
    pellets: 1,
    magSize: 10,
    reserveAmmo: 40,
    maxReserve: 60,
    reloadTime: 3.3,
    emptyReloadExtra: 0.85,
    shellReload: false,
    spread: 1.05,
    adsSpreadMultiplier: 0.12,
    movementSpread: 2.7,
    range: 160,
    falloffStart: 70,
    falloffFloor: 0.86,
    penetration: 4,
    recoil: { vertical: 8.4, horizontal: 1.25, drift: 0.35, kick: 0.095, recovery: 5.5 },
    wallCost: 0,
    packCost: 5000,
    packName: 'The Obliterator',
    packDamageMultiplier: 2.25,
    packMagMultiplier: 1.25,
    hipPosition: v(0.11, -0.132, -0.280),
    hipRotation: v(0.02, -0.045, 0.02),
    // Scope eye relief. Short, because it also decides how much of the frame
    // the ocular fills — and it is what puts the M82's long stock behind the
    // camera instead of across the bottom of the sight picture.
    adsDistance: -0.060,
    adsZoom: 3.4,
    swapTime: 0.82,
    adsTime: 0.34,
    rightGrip: v(0.03, -0.068, 0.135),
    leftGrip: v(0.0, -0.010, -0.160),
    audio: {
      bodyHz: 58,
      crack: 0.112,
      tail: 1.18,
      gain: 1.26,
      // .50 BMG. The lowest action, the longest sweep and almost no lowpass:
      // this one should be felt before it is identified.
      actionHz: 620,
      crackHz: 4900,
      crackFallHz: 150,
      bodyCutoffHz: 430,
      bodyDrop: 0.20,
    },
    muzzleFlashScale: 1.75,
    shellScale: 1.9,
  },

  aether9: {
    id: 'aether9',
    name: 'Aether-9',
    class: 'pistol',
    build: buildAether9,
    // A compact plasma sidearm: the direct bolt is decisive, then its contained
    // energy cell blooms into a small crowd-control burst. The slow semi-auto
    // cycle and a meaningful reload keep it from becoming a no-risk pistol.
    damage: 292,
    headshotMultiplier: 1.15,
    rpm: 210,
    fireMode: 'semi',
    pellets: 1,
    magSize: 18,
    reserveAmmo: 108,
    maxReserve: 144,
    reloadTime: 2.4,
    emptyReloadExtra: 0.45,
    shellReload: false,
    spread: 0.62,
    adsSpreadMultiplier: 0.18,
    movementSpread: 2.15,
    range: 86,
    falloffStart: 52,
    falloffFloor: 0.82,
    penetration: 1,
    recoil: { vertical: 2.9, horizontal: 0.52, drift: 0.1, kick: 0.041, recovery: 10.6 },
    wallCost: 0,
    packCost: 5000,
    packName: 'Aether-9 Nova',
    packDamageMultiplier: 2.2,
    packMagMultiplier: 1.55,
    hipPosition: v(0.102, -0.114, -0.335),
    hipRotation: v(0.025, -0.055, 0.024),
    // The emitter dot sits 79 mm *ahead* of the model origin, so the eye relief
    // has to cover that as well as the arm's own reach.
    adsDistance: -0.464,
    adsZoom: 1.2,
    swapTime: 0.62,
    adsTime: 0.23,
    rightGrip: v(0.034, -0.080, 0.075),
    leftGrip: v(-0.005, -0.077, 0.017),
    audio: {
      bodyHz: 136,
      crack: 0.052,
      tail: 0.48,
      gain: 0.82,
      // Unused by the wonder-weapon path, kept complete so the definition stays
      // valid if the Aether-9 is ever routed through the conventional report.
      actionHz: 2700,
      crackHz: 2600,
      crackFallHz: 700,
      bodyCutoffHz: 1400,
      bodyDrop: 0.50,
    },
    muzzleFlashScale: 1.18,
    wonder: {
      kind: 'plasma',
      splashRadius: 2.85,
      splashDamageMultiplier: 0.72,
    },
    // The five standard box weapons each carry weight 1. At 0.15 this rolls
    // at roughly 2.9% per spin before the no-immediate-repeat rule is applied.
    mysteryWeight: 0.15,
  },

  stormweaver: {
    id: 'stormweaver',
    name: 'Stormweaver',
    class: 'rifle',
    build: buildStormweaver,
    // A high-voltage coil rifle. The first target takes the full discharge,
    // then the charge seeks through a compact group. It is intentionally slow
    // and shallow-magged so the chain effect remains a rescue tool, not a
    // replacement for positioning or aim.
    damage: 372,
    headshotMultiplier: 1.0,
    rpm: 98,
    fireMode: 'semi',
    pellets: 1,
    magSize: 6,
    reserveAmmo: 42,
    maxReserve: 54,
    reloadTime: 2.85,
    emptyReloadExtra: 0.62,
    shellReload: false,
    spread: 0.42,
    adsSpreadMultiplier: 0.09,
    movementSpread: 2.45,
    range: 92,
    falloffStart: 62,
    falloffFloor: 0.88,
    penetration: 1,
    recoil: { vertical: 4.15, horizontal: 0.62, drift: -0.12, kick: 0.052, recovery: 8.4 },
    wallCost: 0,
    packCost: 5000,
    packName: 'Tempest Engine',
    packDamageMultiplier: 2.05,
    packMagMultiplier: 1.5,
    hipPosition: v(0.105, -0.138, -0.263),
    hipRotation: v(0.018, -0.052, 0.018),
    adsDistance: -0.130,
    adsZoom: 1.3,
    swapTime: 0.76,
    adsTime: 0.31,
    rightGrip: v(0.033, -0.082, 0.118),
    leftGrip: v(-0.026, 0.000, -0.188),
    audio: {
      bodyHz: 96,
      crack: 0.07,
      tail: 0.72,
      gain: 0.94,
      // As above: the coil rifle plays `wonderShot`, not this.
      actionHz: 1700,
      crackHz: 3000,
      crackFallHz: 480,
      bodyCutoffHz: 1100,
      bodyDrop: 0.44,
    },
    muzzleFlashScale: 1.05,
    wonder: {
      kind: 'arc',
      chainTargets: 5,
      chainRange: 8.25,
      chainDamageMultiplier: 0.82,
    },
    // About 1.9% per spin in the full pool: rarer than Aether-9 and far rarer
    // than any conventional Mystery Box weapon.
    mysteryWeight: 0.1,
  },

  m240: {
    id: 'm240',
    name: 'M240',
    class: 'lmg',
    build: buildM240,
    // Sustained, belt-fed pressure. The M240 outlasts the M4 and pierces a
    // compact line, but its wide hip cone, deliberate ADS and long belt-box
    // reload keep it from replacing every other late-round weapon.
    damage: 74,
    headshotMultiplier: 2.2,
    rpm: 650,
    fireMode: 'auto',
    pellets: 1,
    magSize: 100,
    reserveAmmo: 200,
    maxReserve: 300,
    reloadTime: 4.45,
    emptyReloadExtra: 0.8,
    shellReload: false,
    reloadStyle: 'belt',
    spread: 2.05,
    adsSpreadMultiplier: 0.23,
    movementSpread: 3.35,
    range: 128,
    falloffStart: 42,
    falloffFloor: 0.64,
    penetration: 3,
    recoil: { vertical: 1.22, horizontal: 0.54, drift: -0.22, kick: 0.024, recovery: 10.4 },
    // Reserved for the mystery box; no level prop or purchase route references
    // this definition until the box feature itself is intentionally built.
    wallCost: 0,
    packCost: 5000,
    packName: 'The Drumbeat',
    packDamageMultiplier: 2.8,
    packMagMultiplier: 1.5,
    hipPosition: v(0.11, -0.142, -0.250),
    hipRotation: v(0.024, -0.065, 0.024),
    adsDistance: -0.100,
    adsZoom: 1.2,
    swapTime: 0.88,
    adsTime: 0.36,
    rightGrip: v(0.03, -0.074, 0.105),
    leftGrip: v(-0.026, -0.030, -0.198),
    audio: {
      bodyHz: 84,
      crack: 0.066,
      tail: 0.78,
      gain: 1.0,
      // Belt-fed: a big, slow-moving carrier under a broad crack. Low action
      // and mid crack keep sustained fire from turning into the M4's buzz.
      actionHz: 1050,
      crackHz: 3300,
      crackFallHz: 290,
      bodyCutoffHz: 700,
      bodyDrop: 0.26,
    },
    muzzleFlashScale: 1.22,
    shellScale: 1.35,
  },
};

export const STARTING_WEAPON = 'pistol';

/** Weapons that can appear as wall buys, in rough progression order. */
export const WALL_WEAPONS = ['smg', 'shotgun', 'rifle'] as const;

/** Exclusive mystery-box pool; none of these weapons is installed as a wall buy. */
export const MYSTERY_BOX_WEAPONS = [
  'desertEagle',
  'barrettM82A1',
  'spas12',
  'm240',
  'fnScar',
  'aether9',
  'stormweaver',
] as const;

/** Rare energy weapons, kept separate for presentation and balance tooling. */
export const WONDER_WEAPONS = ['aether9', 'stormweaver'] as const;

export function gripVector(def: WeaponDef, which: 'left' | 'right'): Vector3 {
  const g = which === 'left' ? def.leftGrip : def.rightGrip;
  return new Vector3(g[0], g[1], g[2]);
}
