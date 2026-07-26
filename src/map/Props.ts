import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  PointLight,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { makeSurface } from '../assets/Materials';
import { glowTexture, labelTexture } from '../assets/SpriteTextures';
import { Rng, clamp, damp } from '../util/math';
import { WEAPONS, WeaponDef } from '../weapons/WeaponDefs';

/**
 * Interactable props: perk machines, wall buys, doors and window barriers.
 *
 * Each exposes a uniform `Interactable` surface so the player's look-at probe
 * and the HUD prompt do not need to know what they are pointing at.
 */

export interface Interactable {
  readonly root: Object3D;
  /** World point the player must be near and looking at. */
  readonly focus: Vector3;
  readonly radius: number;
  /** Prompt text, or null when the prop currently offers nothing. */
  prompt(context: PromptContext): { text: string; cost: number; affordable: boolean } | null;
  /** Returns true if the interaction consumed the press. */
  interact(context: PromptContext): boolean;
  update?(dt: number, elapsed: number): void;
}

export interface PromptContext {
  points: number;
  weaponId: string;
  weaponAmmoFull: boolean;
  ownedPerks: Set<string>;
  spend: (amount: number) => boolean;
  buyWeapon: (id: string) => void;
  refillAmmo: () => void;
  grantPerk: (id: string) => void;
  openDoor: (door: Door) => void;
  packWeapon: () => void;
  canPack: boolean;
}

/* ------------------------------------------------------------------ */
/* Perk machines                                                       */
/* ------------------------------------------------------------------ */

export interface PerkDef {
  id: string;
  name: string;
  tagline: string;
  cost: number;
  color: number;
}

export const PERKS: Record<string, PerkDef> = {
  juggernog: {
    id: 'juggernog',
    name: 'JUGGER-NOG',
    tagline: 'TAKE A HIT',
    cost: 2500,
    color: 0xd8322a,
  },
  speedCola: {
    id: 'speedCola',
    name: 'SPEED COLA',
    tagline: 'RELOAD FASTER',
    cost: 3000,
    color: 0x4fd14a,
  },
  doubleTap: {
    id: 'doubleTap',
    name: 'DOUBLE TAP',
    tagline: 'FIRE FASTER',
    cost: 2000,
    color: 0xe8a021,
  },
  staminUp: {
    id: 'staminUp',
    name: 'STAMIN-UP',
    tagline: 'MOVE FASTER',
    cost: 2000,
    color: 0x38a7e0,
  },
};

export class PerkMachine implements Interactable {
  readonly root = new Group();
  readonly focus = new Vector3();
  readonly radius = 2.4;

  private readonly light: PointLight;
  private readonly glow: Mesh;
  private readonly screen: Mesh;
  private readonly baseIntensity: number;
  private flickerSeed: number;
  purchased = false;

  constructor(readonly def: PerkDef, position: Vector3, yaw: number) {
    const rng = new Rng(def.id.length * 7717 + def.cost);
    this.flickerSeed = rng.next() * 100;

    const shell = makeSurface('paintedMetal', {
      repeat: 1.4,
      tint: def.color,
      roughness: 0.9,
      metalness: 1,
      normalScale: 0.8,
      clearcoat: 0.6,
      clearcoatRoughness: 0.22,
    });
    const trim = makeSurface('rustedMetal', { repeat: 2, tint: 0x8d8d92, normalScale: 0.9 });

    // --- Cabinet: a chest-height vending body with a chamfered face ---
    const body = new Mesh(new RoundedBoxGeometry(1.15, 1.95, 0.72, 4, 0.05), shell);
    body.position.y = 0.98;
    body.castShadow = true;
    body.receiveShadow = true;
    this.root.add(body);

    // Kick plate and feet keep it from looking like it is floating.
    const plinth = new Mesh(new BoxGeometry(1.2, 0.12, 0.78), trim);
    plinth.position.y = 0.06;
    plinth.castShadow = true;
    this.root.add(plinth);

    // Crown sign.
    const crown = new Mesh(new RoundedBoxGeometry(1.24, 0.46, 0.5, 3, 0.04), trim);
    crown.position.set(0, 2.14, -0.05);
    crown.castShadow = true;
    this.root.add(crown);

    const signMat = new MeshBasicMaterial({
      map: labelTexture([def.name], { width: 640, height: 200, color: '#fff8e6', size: 118 }),
      transparent: true,
      toneMapped: false,
      color: new Color(def.color).lerp(new Color(0xffffff), 0.55),
    });
    const sign = new Mesh(new PlaneGeometry(1.12, 0.35), signMat);
    sign.position.set(0, 2.14, -0.26);
    sign.rotation.y = Math.PI;
    this.root.add(sign);

    // --- Illuminated front panel: the machine's identity at a distance ---
    const screenMat = new MeshStandardMaterial({
      color: new Color(def.color).multiplyScalar(0.35),
      emissive: new Color(def.color),
      emissiveIntensity: 2.6,
      roughness: 0.25,
      metalness: 0,
    });
    this.screen = new Mesh(new PlaneGeometry(0.86, 1.2), screenMat);
    this.screen.position.set(0, 1.16, -0.365);
    this.screen.rotation.y = Math.PI;
    this.root.add(this.screen);

    const taglineMat = new MeshBasicMaterial({
      map: labelTexture([def.tagline], { width: 512, height: 140, color: '#120c08', size: 78 }),
      transparent: true,
      toneMapped: false,
    });
    const tagline = new Mesh(new PlaneGeometry(0.8, 0.22), taglineMat);
    tagline.position.set(0, 0.58, -0.372);
    tagline.rotation.y = Math.PI;
    this.root.add(tagline);

    // Dispensing slot.
    const slot = new Mesh(new BoxGeometry(0.5, 0.16, 0.06), trim);
    slot.position.set(0, 0.38, -0.36);
    this.root.add(slot);

    // --- Light spill: what actually sells a perk machine in a dark room ---
    this.baseIntensity = 7;
    this.light = new PointLight(def.color, this.baseIntensity, 9, 2);
    this.light.position.set(0, 1.3, -0.85);
    this.light.castShadow = false;
    this.root.add(this.light);

    const glowMat = new MeshBasicMaterial({
      map: glowTexture(),
      color: def.color,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      opacity: 0.5,
      side: DoubleSide,
    });
    this.glow = new Mesh(new PlaneGeometry(2.4, 2.8), glowMat);
    this.glow.position.set(0, 1.2, -0.5);
    this.root.add(this.glow);

    this.root.position.copy(position);
    this.root.rotation.y = yaw;
    this.focus.copy(position).add(new Vector3(0, 1.2, 0));
  }

  prompt(ctx: PromptContext) {
    if (ctx.ownedPerks.has(this.def.id)) return null;
    return {
      text: `Buy ${this.def.name}`,
      cost: this.def.cost,
      affordable: ctx.points >= this.def.cost,
    };
  }

  interact(ctx: PromptContext) {
    if (ctx.ownedPerks.has(this.def.id)) return false;
    if (!ctx.spend(this.def.cost)) return false;
    ctx.grantPerk(this.def.id);
    this.purchased = true;
    return true;
  }

  update(_dt: number, elapsed: number) {
    // Slow pulse plus an occasional flicker — a perfectly steady neon sign in a
    // derelict building reads as fake.
    const t = elapsed * 1.7 + this.flickerSeed;
    const pulse = 0.82 + 0.18 * Math.sin(t);
    const glitch = Math.sin(t * 13.1) > 0.985 ? 0.35 : 1;
    this.light.intensity = this.baseIntensity * pulse * glitch;
    (this.screen.material as MeshStandardMaterial).emissiveIntensity = 2.6 * pulse * glitch;
    (this.glow.material as MeshBasicMaterial).opacity = 0.5 * pulse * glitch;
  }
}

/* ------------------------------------------------------------------ */
/* Wall buys                                                           */
/* ------------------------------------------------------------------ */

/**
 * Wall buy. Mounts the actual weapon model on the wall behind a chalk outline —
 * showing the real asset reads far better than a 2D icon and costs nothing
 * extra, since the model already exists.
 */
export class WallBuy implements Interactable {
  readonly root = new Group();
  readonly focus = new Vector3();
  readonly radius = 2.6;

  private readonly weapon: WeaponDef;
  private readonly gun: Object3D;
  private bob = 0;

  constructor(weaponId: string, position: Vector3, yaw: number) {
    this.weapon = WEAPONS[weaponId];

    // Chalked outline board.
    const boardMat = makeSurface('plaster', {
      repeat: 1.2,
      tint: 0x6d6a63,
      roughness: 1,
      metalness: 0,
      normalScale: 0.6,
    });
    const board = new Mesh(new BoxGeometry(1.5, 0.95, 0.06), boardMat);
    board.position.y = 1.5;
    board.receiveShadow = true;
    this.root.add(board);

    const priceMat = new MeshBasicMaterial({
      map: labelTexture([this.weapon.name, `${this.weapon.wallCost}`], {
        width: 512,
        height: 256,
        color: '#f0e2bb',
        size: 84,
      }),
      transparent: true,
      toneMapped: false,
    });
    const price = new Mesh(new PlaneGeometry(1.3, 0.65), priceMat);
    price.position.set(0, 1.5, -0.04);
    price.rotation.y = Math.PI;
    this.root.add(price);

    this.gun = this.weapon.build().root;
    this.gun.scale.setScalar(1.5);
    this.gun.position.set(0, 1.55, -0.2);
    this.gun.rotation.set(0, -Math.PI / 2, 0);
    this.gun.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) m.castShadow = true;
    });
    this.root.add(this.gun);

    const lamp = new PointLight(0xffdca8, 2.4, 4.5, 2);
    lamp.position.set(0, 2.15, -0.5);
    this.root.add(lamp);

    this.root.position.copy(position);
    this.root.rotation.y = yaw;
    this.focus.copy(position).add(new Vector3(0, 1.5, 0));
  }

  prompt(ctx: PromptContext) {
    if (ctx.weaponId === this.weapon.id) {
      const cost = Math.round(this.weapon.wallCost / 3);
      if (ctx.weaponAmmoFull) return null;
      return { text: `Refill ${this.weapon.name}`, cost, affordable: ctx.points >= cost };
    }
    return {
      text: `Buy ${this.weapon.name}`,
      cost: this.weapon.wallCost,
      affordable: ctx.points >= this.weapon.wallCost,
    };
  }

  interact(ctx: PromptContext) {
    if (ctx.weaponId === this.weapon.id) {
      if (ctx.weaponAmmoFull) return false;
      const cost = Math.round(this.weapon.wallCost / 3);
      if (!ctx.spend(cost)) return false;
      ctx.refillAmmo();
      return true;
    }
    if (!ctx.spend(this.weapon.wallCost)) return false;
    ctx.buyWeapon(this.weapon.id);
    return true;
  }

  update(dt: number) {
    // Gentle float so the mounted weapon does not look like set dressing.
    this.bob += dt;
    this.gun.position.y = 1.55 + Math.sin(this.bob * 1.4) * 0.014;
    this.gun.rotation.z = Math.sin(this.bob * 0.9) * 0.03;
  }
}

/* ------------------------------------------------------------------ */
/* Doors                                                               */
/* ------------------------------------------------------------------ */

export class Door implements Interactable {
  readonly root = new Group();
  readonly focus = new Vector3();
  readonly radius = 3;
  open = false;

  private openT = 0;
  private readonly panels: Object3D[] = [];

  constructor(
    readonly id: string,
    readonly cost: number,
    /** Zone unlocked when this door opens. */
    readonly unlocksZone: string,
    position: Vector3,
    yaw: number,
    width: number,
    height: number,
    /** Called once when the door finishes opening. */
    readonly onOpened: (door: Door) => void,
  ) {
    const wood = makeSurface('woodPlank', { repeat: [1.2, 0.8], tint: 0x9c8a72, normalScale: 0.9 });
    const metal = makeSurface('rustedMetal', { repeat: 2, tint: 0x8a8a90 });

    // Boarded-over doorway: crossed planks plus a chained gate.
    const rng = new Rng(id.length * 913 + cost);
    for (let i = 0; i < 6; i++) {
      const plank = new Mesh(
        new BoxGeometry(width * rng.range(0.94, 1.08), 0.22, 0.06),
        wood,
      );
      plank.position.set(rng.range(-0.1, 0.1), 0.35 + i * (height / 6.4), rng.range(-0.03, 0.03));
      plank.rotation.z = rng.range(-0.07, 0.07);
      plank.castShadow = true;
      plank.receiveShadow = true;
      this.panels.push(plank);
      this.root.add(plank);
    }
    for (const sign of [-1, 1]) {
      const brace = new Mesh(new BoxGeometry(width * 1.2, 0.14, 0.05), metal);
      brace.position.set(0, height * 0.5, sign * 0.06);
      brace.rotation.z = sign * 0.62;
      brace.castShadow = true;
      this.panels.push(brace);
      this.root.add(brace);
    }

    const priceMat = new MeshBasicMaterial({
      map: labelTexture(['OPEN', `${cost}`], { width: 512, height: 256, color: '#ffcf7a', size: 96 }),
      transparent: true,
      toneMapped: false,
    });
    const price = new Mesh(new PlaneGeometry(1.1, 0.55), priceMat);
    price.position.set(0, height * 0.55, -0.14);
    price.rotation.y = Math.PI;
    this.panels.push(price);
    this.root.add(price);

    this.root.position.copy(position);
    this.root.rotation.y = yaw;
    this.focus.copy(position).add(new Vector3(0, height * 0.5, 0));
  }

  prompt(ctx: PromptContext) {
    if (this.open) return null;
    return { text: 'Open the way', cost: this.cost, affordable: ctx.points >= this.cost };
  }

  interact(ctx: PromptContext) {
    if (this.open) return false;
    if (!ctx.spend(this.cost)) return false;
    this.open = true;
    ctx.openDoor(this);
    return true;
  }

  update(dt: number) {
    if (!this.open) return;
    if (this.openT >= 1) return;
    this.openT = clamp(this.openT + dt * 0.9, 0, 1);
    // Boards are torn away upward and fade out.
    for (let i = 0; i < this.panels.length; i++) {
      const p = this.panels[i];
      p.position.y += dt * 2.6 * (0.6 + (i % 3) * 0.3);
      p.rotation.z += dt * (i % 2 ? 1.4 : -1.4);
      p.scale.setScalar(Math.max(0.001, 1 - this.openT));
    }
    if (this.openT >= 1) {
      this.root.visible = false;
      this.onOpened(this);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Window barriers                                                     */
/* ------------------------------------------------------------------ */

/**
 * A boarded window. Zombies tear planks off one at a time; the player can
 * hammer them back on for points. Six planks, each independently removable.
 */
export class Barrier implements Interactable {
  readonly root = new Group();
  readonly focus = new Vector3();
  readonly radius = 2.2;

  /** 0..6 planks currently in place. */
  planksRemaining = 6;
  private readonly planks: Mesh[] = [];
  private readonly restY: number[] = [];
  private repairTimer = 0;
  /** Set while a zombie is working on this barrier. */
  breachTimer = 0;

  readonly position = new Vector3();
  /**
   * Unit vector pointing out of the building through this window. Used to hold
   * zombies on the outside until the last plank comes off, and derived from the
   * spawn point rather than the yaw so it can never disagree with the layout.
   */
  readonly outward = new Vector3(0, 0, 1);

  constructor(position: Vector3, yaw: number, readonly zone: string) {
    const wood = makeSurface('woodPlank', { repeat: [1.6, 0.7], tint: 0x8f7f68, normalScale: 1 });
    const rng = new Rng(Math.round(position.x * 31 + position.z * 17));

    // Window apertures in Level.ts run from 0.9 m to 2.3 m. Planks have to fill
    // that band or the hole reads as unboarded and the repair mechanic looks
    // like it is doing nothing.
    for (let i = 0; i < 6; i++) {
      const y = 1.0 + i * 0.24;
      const plank = new Mesh(new BoxGeometry(1.6 * rng.range(0.92, 1.06), 0.2, 0.055), wood);
      plank.position.set(rng.range(-0.08, 0.08), y, rng.range(-0.02, 0.02));
      plank.rotation.z = rng.range(-0.09, 0.09);
      plank.castShadow = true;
      plank.receiveShadow = true;
      this.planks.push(plank);
      this.restY.push(y);
      this.root.add(plank);
    }

    this.root.position.copy(position);
    this.root.rotation.y = yaw;
    this.position.copy(position);
    this.focus.copy(position).add(new Vector3(0, 1.1, 0));
  }

  /** Called by a zombie working the barrier. Returns true when it breaks through. */
  tearPlank(): boolean {
    if (this.planksRemaining <= 0) return true;
    this.planksRemaining--;
    const plank = this.planks[this.planksRemaining];
    plank.visible = false;
    return this.planksRemaining <= 0;
  }

  prompt() {
    if (this.planksRemaining >= 6) return null;
    return { text: 'Repair barrier', cost: 0, affordable: true };
  }

  /** Repair is a held action; each completed tick restores one plank. */
  interact() {
    return false;
  }

  /** Returns points earned this frame while the repair key is held. */
  repair(dt: number): number {
    if (this.planksRemaining >= 6) return 0;
    this.repairTimer += dt;
    if (this.repairTimer < 0.55) return 0;
    this.repairTimer = 0;
    const plank = this.planks[this.planksRemaining];
    plank.visible = true;
    plank.position.y = this.restY[this.planksRemaining];
    this.planksRemaining++;
    return 10;
  }

  update(dt: number) {
    // Planks that are being worked on rattle.
    if (this.breachTimer > 0) {
      this.breachTimer -= dt;
      const top = this.planks[Math.max(0, this.planksRemaining - 1)];
      if (top?.visible) {
        top.position.y = this.restY[this.planksRemaining - 1] + Math.sin(performance.now() * 0.03) * 0.02;
      }
    }
  }

  reset() {
    this.planksRemaining = 6;
    this.planks.forEach((p, i) => {
      p.visible = true;
      p.position.y = this.restY[i];
    });
  }
}

/* ------------------------------------------------------------------ */
/* Pack-a-Punch                                                        */
/* ------------------------------------------------------------------ */

export class PackAPunch implements Interactable {
  readonly root = new Group();
  readonly focus = new Vector3();
  readonly radius = 2.6;
  readonly cost = 5000;

  private readonly light: PointLight;
  private readonly core: Mesh;

  constructor(position: Vector3, yaw: number) {
    const shell = makeSurface('rustedMetal', { repeat: 1.6, tint: 0x6e6a60, normalScale: 1 });

    const body = new Mesh(new RoundedBoxGeometry(1.7, 1.5, 1.0, 4, 0.06), shell);
    body.position.y = 0.78;
    body.castShadow = true;
    body.receiveShadow = true;
    this.root.add(body);

    // Feed slot the weapon disappears into.
    const slot = new Mesh(new BoxGeometry(1.0, 0.22, 0.1), new MeshStandardMaterial({
      color: 0x0a0a0c,
      roughness: 0.6,
      metalness: 0.2,
    }));
    slot.position.set(0, 1.1, -0.5);
    this.root.add(slot);

    // The reactor core: a caged, violently bright emissive block.
    this.core = new Mesh(
      new BoxGeometry(0.62, 0.62, 0.62),
      new MeshStandardMaterial({
        color: 0x2a1c4a,
        emissive: 0x8a4bff,
        emissiveIntensity: 4.5,
        roughness: 0.3,
      }),
    );
    this.core.position.set(0, 1.85, 0);
    this.root.add(this.core);

    const cage = new Mesh(
      new BoxGeometry(0.9, 0.9, 0.9),
      makeSurface('rustedMetal', { repeat: 3, tint: 0x4a4640 }),
    );
    cage.material.side = BackSide;
    cage.position.copy(this.core.position);
    this.root.add(cage);

    const signMat = new MeshBasicMaterial({
      map: labelTexture(['PACK-A-PUNCH', `${this.cost}`], {
        width: 640,
        height: 220,
        color: '#d8b6ff',
        size: 84,
      }),
      transparent: true,
      toneMapped: false,
    });
    const sign = new Mesh(new PlaneGeometry(1.5, 0.5), signMat);
    sign.position.set(0, 1.42, -0.52);
    sign.rotation.y = Math.PI;
    this.root.add(sign);

    this.light = new PointLight(0x9a5cff, 9, 11, 2);
    this.light.position.set(0, 1.9, 0);
    this.root.add(this.light);

    this.root.position.copy(position);
    this.root.rotation.y = yaw;
    this.focus.copy(position).add(new Vector3(0, 1.3, 0));
  }

  prompt(ctx: PromptContext) {
    if (!ctx.canPack) return null;
    return { text: 'Pack-a-Punch', cost: this.cost, affordable: ctx.points >= this.cost };
  }

  interact(ctx: PromptContext) {
    if (!ctx.canPack) return false;
    if (!ctx.spend(this.cost)) return false;
    ctx.packWeapon();
    return true;
  }

  update(dt: number, elapsed: number) {
    this.core.rotation.y += dt * 0.8;
    this.core.rotation.x += dt * 0.3;
    const pulse = 0.75 + 0.25 * Math.sin(elapsed * 3.1);
    this.light.intensity = 9 * pulse;
    (this.core.material as MeshStandardMaterial).emissiveIntensity = 4.5 * pulse;
    this.core.position.y = damp(this.core.position.y, 1.85 + Math.sin(elapsed * 1.6) * 0.04, 8, dt);
  }
}
