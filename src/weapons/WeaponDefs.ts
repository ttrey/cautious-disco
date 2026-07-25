import { Vector3 } from 'three';
import { GunModel, buildPistol, buildRifle, buildShotgun, buildSmg } from './GunSmith';

export type WeaponClass = 'pistol' | 'smg' | 'rifle' | 'shotgun';
export type FireMode = 'auto' | 'semi' | 'pump';

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

  /** Viewmodel rest position relative to the view camera. */
  hipPosition: [number, number, number];
  hipRotation: [number, number, number];
  /** Seconds to raise/lower the weapon on swap. */
  swapTime: number;
  adsTime: number;
  /** Weapon-space grip points the hands are IK-solved onto. */
  rightGrip: [number, number, number];
  leftGrip: [number, number, number];

  /** Audio character. */
  audio: {
    /** Fundamental body of the report, Hz. */
    bodyHz: number;
    /** Length of the noise burst, seconds. */
    crack: number;
    /** Tail/reverb length, seconds. */
    tail: number;
    gain: number;
  };
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
    hipPosition: v(0.115, -0.115, -0.235),
    hipRotation: v(0.02, -0.05, 0.02),
    swapTime: 0.42,
    adsTime: 0.19,
    rightGrip: v(0, -0.062, 0.028),
    leftGrip: v(-0.026, -0.058, 0.05),
    audio: { bodyHz: 168, crack: 0.055, tail: 0.5, gain: 0.72 },
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
    swapTime: 0.5,
    adsTime: 0.22,
    rightGrip: v(0, -0.07, 0.078),
    leftGrip: v(0, -0.03, -0.16),
    audio: { bodyHz: 142, crack: 0.048, tail: 0.42, gain: 0.66 },
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
    swapTime: 0.56,
    adsTime: 0.25,
    rightGrip: v(0, -0.085, 0.098),
    leftGrip: v(0, -0.02, -0.185),
    audio: { bodyHz: 118, crack: 0.062, tail: 0.6, gain: 0.85 },
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
    swapTime: 0.6,
    adsTime: 0.28,
    rightGrip: v(0, -0.058, 0.05),
    leftGrip: v(0, -0.02, -0.155),
    audio: { bodyHz: 92, crack: 0.085, tail: 0.85, gain: 1.0 },
  },
};

export const STARTING_WEAPON = 'pistol';

/** Weapons that can appear as wall buys, in rough progression order. */
export const WALL_WEAPONS = ['smg', 'shotgun', 'rifle'] as const;

export function gripVector(def: WeaponDef, which: 'left' | 'right'): Vector3 {
  const g = which === 'left' ? def.leftGrip : def.rightGrip;
  return new Vector3(g[0], g[1], g[2]);
}
