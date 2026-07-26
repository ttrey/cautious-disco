import {
  BoxGeometry,
  Color,
  Group,
  HemisphereLight,
  MeshBasicMaterial,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PointLight,
  Quaternion,
  Scene,
  SpotLight,
  Vector3,
} from 'three';
import { Physics } from '../core/Physics';
import { NavGrid } from '../core/Nav';
import { makeSurface } from '../assets/Materials';
import { SurfaceId } from '../assets/TextureForge';
import { SpawnPoint } from '../zombies/ZombieManager';
import { Barrier, Door, Interactable, PackAPunch, PerkMachine, PERKS, WallBuy } from './Props';
import { Rng, clamp } from '../util/math';
import { mergeAll } from '../util/geometry';

/**
 * "Ashgate Terminal" — the playable map.
 *
 * A compact four-area loop in the classic Zombies shape: a defensible start
 * room, two purchasable doors opening onto larger arenas, and a corridor that
 * closes the circuit so the player can always train the horde rather than get
 * cornered. Perks and Pack-a-Punch are deliberately spread across three zones
 * so progression pulls the player outward.
 *
 * Construction is data-driven: walls are declared as segments with holes, then
 * compiled in one pass into render geometry, physics colliders and nav-grid
 * blocking. Keeping those three in lockstep from a single description is what
 * prevents the classic bug where a wall you can see is one you can walk through.
 */

const WALL_THICKNESS = 0.36;

interface Hole {
  /** Distance along the wall from its start, to the hole's centre. */
  at: number;
  width: number;
  bottom: number;
  top: number;
}

interface WallSpec {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  height: number;
  surface: SurfaceId;
  tint?: number;
  holes?: Hole[];
  /** Skip nav blocking — used for low ledges the AI should walk over. */
  passable?: boolean;
}

interface RoomSpec {
  id: string;
  zone: string;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  height: number;
  floor: SurfaceId;
  floorTint?: number;
  ceiling?: boolean;
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

const ROOMS: RoomSpec[] = [
  // Start room — small, two barriers, one wall buy. Defensible but a trap.
  { id: 'lobby', zone: 'start', minX: -7, minZ: 5, maxX: 6, maxZ: 19, height: 3.6, floor: 'tile' },
  // Central hall, tall and open. The natural training circle.
  { id: 'hall', zone: 'start', minX: -9, minZ: -7, maxX: 8, maxZ: 5, height: 5.4, floor: 'concrete' },
  // Warehouse — bought with the first door.
  { id: 'warehouse', zone: 'warehouse', minX: 8, minZ: -16, maxX: 24, maxZ: 5, height: 6.2, floor: 'concrete', floorTint: 0xb0aca6 },
  // Plant room — bought with the second door. Holds Pack-a-Punch.
  { id: 'plant', zone: 'plant', minX: -23, minZ: -16, maxX: -9, maxZ: 3, height: 4.2, floor: 'concrete', floorTint: 0x9a968f },
  // Service corridor closing the loop between warehouse and plant.
  { id: 'corridor', zone: 'warehouse', minX: -23, minZ: -22, maxX: 24, maxZ: -16, height: 3.4, floor: 'asphalt' },
];

const WALLS: WallSpec[] = [
  // --- Lobby shell -----------------------------------------------------
  // South wall with two boarded windows.
  {
    x1: -7, z1: 19, x2: 6, z2: 19, height: 3.6, surface: 'brick',
    holes: [
      { at: 3.2, width: 1.8, bottom: 0.9, top: 2.3 },
      { at: 9.8, width: 1.8, bottom: 0.9, top: 2.3 },
    ],
  },
  // West wall, one window.
  {
    x1: -7, z1: 5, x2: -7, z2: 19, height: 3.6, surface: 'plaster',
    holes: [{ at: 10.5, width: 1.8, bottom: 0.9, top: 2.3 }],
  },
  // East wall, solid.
  { x1: 6, z1: 5, x2: 6, z2: 19, height: 3.6, surface: 'plaster' },
  // North wall of the lobby: wide opening through to the hall.
  {
    x1: -7, z1: 5, x2: 6, z2: 5, height: 3.6, surface: 'plaster',
    holes: [{ at: 6.5, width: 4.2, bottom: 0, top: 2.9 }],
  },

  // --- Hall shell ------------------------------------------------------
  {
    x1: -9, z1: -7, x2: 8, z2: -7, height: 5.4, surface: 'concrete',
    holes: [{ at: 8.5, width: 2.4, bottom: 0.9, top: 2.4 }],
  },
  // West wall of the hall: contains the plant-room door.
  {
    x1: -9, z1: -7, x2: -9, z2: 5, height: 5.4, surface: 'concrete',
    holes: [{ at: 6.5, width: 2.6, bottom: 0, top: 3 }],
  },
  // East wall of the hall: contains the warehouse door.
  {
    x1: 8, z1: -7, x2: 8, z2: 5, height: 5.4, surface: 'concrete',
    holes: [{ at: 6.0, width: 2.8, bottom: 0, top: 3.2 }],
  },
  // Short returns closing the hall to the lobby footprint.
  { x1: -9, z1: 5, x2: -7, z2: 5, height: 5.4, surface: 'concrete' },
  { x1: 6, z1: 5, x2: 8, z2: 5, height: 5.4, surface: 'concrete' },

  // --- Warehouse shell -------------------------------------------------
  {
    x1: 24, z1: -16, x2: 24, z2: 5, height: 6.2, surface: 'brick',
    holes: [
      { at: 5.5, width: 1.8, bottom: 0.9, top: 2.3 },
      { at: 15.5, width: 1.8, bottom: 0.9, top: 2.3 },
    ],
  },
  { x1: 8, z1: 5, x2: 24, z2: 5, height: 6.2, surface: 'brick',
    holes: [{ at: 9, width: 1.8, bottom: 0.9, top: 2.3 }] },
  // North wall of the warehouse, opening into the corridor.
  {
    x1: 8, z1: -16, x2: 24, z2: -16, height: 6.2, surface: 'brick',
    holes: [{ at: 4.5, width: 3.0, bottom: 0, top: 2.9 }],
  },
  // The warehouse's west wall below the hall.
  { x1: 8, z1: -16, x2: 8, z2: -7, height: 6.2, surface: 'concrete' },

  // --- Plant room shell ------------------------------------------------
  {
    x1: -23, z1: -16, x2: -23, z2: 3, height: 4.2, surface: 'concrete',
    holes: [{ at: 9, width: 1.8, bottom: 0.9, top: 2.3 }],
  },
  {
    x1: -23, z1: 3, x2: -9, z2: 3, height: 4.2, surface: 'concrete',
    holes: [{ at: 4, width: 1.8, bottom: 0.9, top: 2.3 }],
  },
  {
    x1: -23, z1: -16, x2: -9, z2: -16, height: 4.2, surface: 'concrete',
    holes: [{ at: 10, width: 3.0, bottom: 0, top: 2.7 }],
  },
  { x1: -9, z1: -16, x2: -9, z2: -7, height: 4.2, surface: 'concrete' },

  // --- Corridor shell --------------------------------------------------
  { x1: -23, z1: -22, x2: 24, z2: -22, height: 3.4, surface: 'brick',
    holes: [
      { at: 12, width: 1.8, bottom: 0.9, top: 2.3 },
      { at: 33, width: 1.8, bottom: 0.9, top: 2.3 },
    ] },
  { x1: -23, z1: -22, x2: -23, z2: -16, height: 3.4, surface: 'brick' },
  { x1: 24, z1: -22, x2: 24, z2: -16, height: 3.4, surface: 'brick' },
  // The corridor's south wall, broken by the two room openings above.
  { x1: -9, z1: -16, x2: 8, z2: -16, height: 3.4, surface: 'brick' },
];

interface BarrierSpec {
  x: number;
  z: number;
  yaw: number;
  zone: string;
  /** Where zombies queue up outside. */
  spawn: [number, number];
}

const BARRIERS: BarrierSpec[] = [
  { x: -3.8, z: 19, yaw: 0, zone: 'start', spawn: [-3.8, 22.5] },
  { x: 2.8, z: 19, yaw: 0, zone: 'start', spawn: [2.8, 22.5] },
  { x: -7, z: 15.5, yaw: Math.PI / 2, zone: 'start', spawn: [-10.5, 15.5] },
  { x: 0.5, z: -7, yaw: 0, zone: 'start', spawn: [0.5, -10.5] },
  { x: 24, z: -10.5, yaw: -Math.PI / 2, zone: 'warehouse', spawn: [27.5, -10.5] },
  { x: 24, z: -0.5, yaw: -Math.PI / 2, zone: 'warehouse', spawn: [27.5, -0.5] },
  { x: 17, z: 5, yaw: Math.PI, zone: 'warehouse', spawn: [17, 8.5] },
  { x: -23, z: -7, yaw: Math.PI / 2, zone: 'plant', spawn: [-26.5, -7] },
  { x: -19, z: 3, yaw: Math.PI, zone: 'plant', spawn: [-19, 6.5] },
  { x: -11, z: -22, yaw: Math.PI, zone: 'warehouse', spawn: [-11, -25.5] },
  { x: 10, z: -22, yaw: Math.PI, zone: 'warehouse', spawn: [10, -25.5] },
];

/* ------------------------------------------------------------------ */
/* Builder                                                             */
/* ------------------------------------------------------------------ */

export interface LevelBuildResult {
  root: Group;
  nav: NavGrid;
  spawnPoints: SpawnPoint[];
  barriers: Barrier[];
  interactables: Interactable[];
  doors: Door[];
  playerSpawn: Vector3;
  /** Y coordinate of the walkable floor. Flat by design. */
  floorY: number;
}

const NAV_ORIGIN_X = -30;
const NAV_ORIGIN_Z = -30;
const NAV_WIDTH = 62;
const NAV_DEPTH = 58;
const NAV_CELL = 0.5;

export class Level {
  private readonly root = new Group();
  private readonly rng = new Rng(0x1e5e1);
  private readonly geometryBuckets = new Map<string, { mat: MeshStandardMaterial; geos: BoxGeometry[] }>();

  constructor(
    private readonly scene: Scene,
    private readonly physics: Physics,
  ) {}

  build(): LevelBuildResult {
    const nav = new NavGrid(NAV_ORIGIN_X, NAV_ORIGIN_Z, NAV_WIDTH, NAV_DEPTH, NAV_CELL);
    // Everything starts blocked; rooms carve out the walkable area, then walls
    // put obstacles back. Building "solid then subtract" is far more robust
    // than trying to enumerate every blocked cell.
    nav.setBox(NAV_ORIGIN_X, NAV_ORIGIN_Z, NAV_ORIGIN_X + NAV_WIDTH, NAV_ORIGIN_Z + NAV_DEPTH, true);

    this.buildExterior();
    for (const room of ROOMS) this.buildRoom(room, nav);
    for (const wall of WALLS) this.buildWall(wall, nav);

    this.flushGeometry();
    this.addProps();
    this.addLighting();

    const barriers: Barrier[] = [];
    const spawnPoints: SpawnPoint[] = [];
    for (const spec of BARRIERS) {
      const barrier = new Barrier(new Vector3(spec.x, 0, spec.z), spec.yaw, spec.zone);
      barrier.outward.set(spec.spawn[0] - spec.x, 0, spec.spawn[1] - spec.z).normalize();
      this.root.add(barrier.root);
      barriers.push(barrier);
      spawnPoints.push({
        position: new Vector3(spec.spawn[0], 0, spec.spawn[1]),
        zone: spec.zone,
      });

      // Carve a walkable apron running from the spawn pocket, through the
      // window, and a short way into the room. Without this the exterior is
      // solid, spawns are isolated islands, and the flow field can never reach
      // them — zombies stand outside pressed against the wall forever.
      const inside = new Vector3(spec.x - (spec.spawn[0] - spec.x), 0, spec.z - (spec.spawn[1] - spec.z));
      const minX = Math.min(spec.spawn[0], spec.x, inside.x) - 1.1;
      const maxX = Math.max(spec.spawn[0], spec.x, inside.x) + 1.1;
      const minZ = Math.min(spec.spawn[1], spec.z, inside.z) - 1.1;
      const maxZ = Math.max(spec.spawn[1], spec.z, inside.z) + 1.1;
      nav.setBox(minX, minZ, maxX, maxZ, false);

      // Bias the field against windows so zombies prefer an open door once one
      // exists, but still climb through when that is the only route in.
      nav.setCost(minX, minZ, maxX, maxZ, 2.6);
    }

    const { interactables, doors } = this.addInteractables(nav);

    this.scene.add(this.root);

    return {
      root: this.root,
      nav,
      spawnPoints,
      barriers,
      interactables,
      doors,
      playerSpawn: new Vector3(0, 0.02, 14),
      floorY: 0,
    };
  }

  /* --- Geometry batching ---------------------------------------------- */

  private bucket(key: string, surface: SurfaceId, repeat: number, tint: number) {
    let b = this.geometryBuckets.get(key);
    if (!b) {
      b = {
        mat: makeSurface(surface, {
          repeat,
          tint,
          roughness: 1,
          metalness: 1,
          // Architectural surfaces are seen at grazing angles across whole
          // rooms; a strong normal turns concrete into stucco at that scale.
          normalScale: 0.55,
          aoIntensity: 0.8,
        }),
        geos: [],
      };
      this.geometryBuckets.set(key, b);
    }
    return b;
  }

  /**
   * Adds a world-space box to a material batch. Geometry is generated with UVs
   * scaled by size so texel density stays constant regardless of how big the
   * surface is — a 16 m wall and a 2 m lintel share the same brick scale.
   */
  private addBox(
    key: string,
    surface: SurfaceId,
    tint: number,
    centre: Vector3,
    size: Vector3,
    uvScale: number,
    yaw = 0,
  ) {
    const geo = new BoxGeometry(size.x, size.y, size.z);
    // Rewrite UVs per face so tiling follows world size.
    const uv = geo.attributes.uv;
    const spans: [number, number][] = [
      [size.z, size.y], [size.z, size.y], // +X, -X
      [size.x, size.z], [size.x, size.z], // +Y, -Y
      [size.x, size.y], [size.x, size.y], // +Z, -Z
    ];
    for (let face = 0; face < 6; face++) {
      const [su, sv] = spans[face];
      for (let i = 0; i < 4; i++) {
        const idx = face * 4 + i;
        uv.setXY(idx, uv.getX(idx) * su * uvScale, uv.getY(idx) * sv * uvScale);
      }
    }
    uv.needsUpdate = true;

    if (yaw) geo.rotateY(yaw);
    geo.translate(centre.x, centre.y, centre.z);
    this.bucket(key, surface, 1, tint).geos.push(geo);
  }

  private flushGeometry() {
    for (const [key, bucket] of this.geometryBuckets) {
      const merged = mergeAll(bucket.geos);
      if (!merged) continue;
      const mesh = new Mesh(merged, bucket.mat);
      mesh.name = key;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.root.add(mesh);
      bucket.geos.forEach((g) => g.dispose());
    }
    this.geometryBuckets.clear();
  }

  /**
   * Ground and skyline outside the building.
   *
   * Without this every window and doorway looks into pure black, which reads as
   * a missing asset rather than as night. A wet asphalt apron plus a ring of
   * silhouetted blocks gives the openings something to frame, and the scene fog
   * does the rest.
   */
  private buildExterior() {
    this.addBox(
      'exterior_ground',
      'asphalt',
      0x6f6c68,
      new Vector3(0, -0.32, -2),
      new Vector3(110, 0.4, 110),
      0.28,
    );

    // Skyline: blocks at varying distance and height, deliberately unlit and
    // dark so they read as mass rather than as detail.
    const rng = new Rng(0x5c1);
    for (let i = 0; i < 26; i++) {
      const angle = (i / 26) * Math.PI * 2 + rng.range(-0.08, 0.08);
      const dist = rng.range(46, 74);
      const height = rng.range(8, 26);
      const width = rng.range(6, 16);
      this.addBox(
        'skyline',
        'concrete',
        0x4a5162,
        new Vector3(Math.cos(angle) * dist, height / 2 - 1, Math.sin(angle) * dist - 2),
        new Vector3(width, height, width * rng.range(0.7, 1.4)),
        0.12,
        rng.range(0, Math.PI),
      );
    }
  }

  /* --- Rooms and walls ------------------------------------------------- */

  private buildRoom(room: RoomSpec, nav: NavGrid) {
    const w = room.maxX - room.minX;
    const d = room.maxZ - room.minZ;
    const cx = (room.minX + room.maxX) / 2;
    const cz = (room.minZ + room.maxZ) / 2;

    this.addBox(
      `floor_${room.floor}_${room.floorTint ?? 0}`,
      room.floor,
      room.floorTint ?? 0xffffff,
      new Vector3(cx, -0.15, cz),
      new Vector3(w, 0.3, d),
      room.floor === 'tile' ? 0.42 : 0.6,
    );
    this.physics.addStaticBox(new Vector3(cx, -0.15, cz), new Vector3(w / 2, 0.15, d / 2));

    if (room.ceiling !== false) {
      this.addBox(
        'ceiling',
        'concrete',
        0x6a6862,
        new Vector3(cx, room.height + 0.15, cz),
        new Vector3(w, 0.3, d),
        1.1,
      );
      this.physics.addStaticBox(
        new Vector3(cx, room.height + 0.15, cz),
        new Vector3(w / 2, 0.15, d / 2),
      );
    }

    // Carve the room out of the nav grid, inset so agents keep off the walls.
    nav.setBox(room.minX + 0.45, room.minZ + 0.45, room.maxX - 0.45, room.maxZ - 0.45, false);
  }

  /** Compiles a wall spec into render geometry, colliders and nav blocking. */
  private buildWall(spec: WallSpec, nav: NavGrid) {
    const dx = spec.x2 - spec.x1;
    const dz = spec.z2 - spec.z1;
    const length = Math.hypot(dx, dz);
    if (length < 1e-4) return;
    const yaw = Math.atan2(dx, dz);
    const ux = dx / length;
    const uz = dz / length;

    // Split the wall into vertical slabs around each hole, plus the lintel and
    // sill pieces above and below.
    const holes = [...(spec.holes ?? [])].sort((a, b) => a.at - b.at);
    const segments: { start: number; end: number; bottom: number; top: number }[] = [];
    let cursor = 0;
    for (const hole of holes) {
      const holeStart = hole.at - hole.width / 2;
      const holeEnd = hole.at + hole.width / 2;
      if (holeStart > cursor) segments.push({ start: cursor, end: holeStart, bottom: 0, top: spec.height });
      if (hole.bottom > 0) segments.push({ start: holeStart, end: holeEnd, bottom: 0, top: hole.bottom });
      if (hole.top < spec.height) segments.push({ start: holeStart, end: holeEnd, bottom: hole.top, top: spec.height });
      cursor = holeEnd;
    }
    if (cursor < length) segments.push({ start: cursor, end: length, bottom: 0, top: spec.height });

    const tint = spec.tint ?? 0xffffff;
    for (const seg of segments) {
      const segLength = seg.end - seg.start;
      if (segLength < 1e-3) continue;
      const mid = (seg.start + seg.end) / 2;
      const centre = new Vector3(
        spec.x1 + ux * mid,
        (seg.bottom + seg.top) / 2,
        spec.z1 + uz * mid,
      );
      const size = new Vector3(WALL_THICKNESS, seg.top - seg.bottom, segLength);

      this.addBox(`wall_${spec.surface}_${tint}`, spec.surface, tint, centre, size, 0.85, yaw);
      this.physics.addStaticBox(
        centre,
        new Vector3(size.x / 2, size.y / 2, size.z / 2),
        new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw),
      );
    }

    if (spec.passable) return;

    // Nav blocking: mark the full wall line, then re-open any hole that reaches
    // the floor (a doorway) — window holes stay blocked here and are opened
    // explicitly by the barrier pass, which also applies their traversal cost.
    const pad = WALL_THICKNESS / 2 + 0.12;
    for (let s = 0; s <= length; s += NAV_CELL * 0.5) {
      const px = spec.x1 + ux * s;
      const pz = spec.z1 + uz * s;
      nav.setBox(px - pad, pz - pad, px + pad, pz + pad, true);
    }
    for (const hole of holes) {
      if (hole.bottom > 0.05) continue;
      const hs = hole.at - hole.width / 2 + 0.25;
      const he = hole.at + hole.width / 2 - 0.25;
      for (let s = hs; s <= he; s += NAV_CELL * 0.5) {
        const px = spec.x1 + ux * s;
        const pz = spec.z1 + uz * s;
        nav.setBox(px - pad, pz - pad, px + pad, pz + pad, false);
      }
    }
  }

  /* --- Dressing --------------------------------------------------------- */

  private addProps() {
    const crate = makeSurface('woodPlank', { repeat: 1.4, tint: 0x8a7a63, normalScale: 1 });
    const drum = makeSurface('rustedMetal', { repeat: 1.6, tint: 0x8f6a4a, normalScale: 1.1 });
    const shelf = makeSurface('rustedMetal', { repeat: 2, tint: 0x77787c });

    const place = (mesh: Mesh, x: number, y: number, z: number, yaw: number) => {
      mesh.position.set(x, y, z);
      mesh.rotation.y = yaw;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.root.add(mesh);
      return mesh;
    };

    // Crate stacks — cover and visual scale reference. Colliders included so
    // they read as solid rather than as decals on the floor.
    const crateSpots: [number, number, number][] = [
      [14, -12, 0], [15.4, -12.2, 0.4], [14.7, -12.1, 1.7],
      [20, 2, 0.3], [21.2, 1.4, 0.9],
      [-18, -12, 0.2], [-17, -12.4, 1.1],
      [3.5, 16.5, 0.5],
      [-5.5, -4, 0.2],
    ];
    for (const [x, z, yaw] of crateSpots) {
      const size = this.rng.range(0.75, 1.15);
      const box = new Mesh(new BoxGeometry(size, size * 0.82, size), crate);
      place(box, x, size * 0.41, z, yaw);
      this.physics.addStaticBox(
        new Vector3(x, size * 0.41, z),
        new Vector3(size / 2, size * 0.41, size / 2),
        new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw),
      );
    }

    // Oil drums.
    for (const [x, z] of [[18, -6], [19.4, -6.6], [-20, -4], [-13, -14], [10.5, -19]] as [number, number][]) {
      const barrel = new Mesh(new BoxGeometry(0.62, 0.92, 0.62), drum);
      place(barrel, x, 0.46, z, this.rng.range(0, 3));
      this.physics.addStaticBox(new Vector3(x, 0.46, z), new Vector3(0.31, 0.46, 0.31));
    }

    // Shelving against the warehouse wall gives the space vertical interest.
    for (let i = 0; i < 3; i++) {
      const z = -13 + i * 5.5;
      const rack = new Mesh(new BoxGeometry(0.6, 2.6, 3.4), shelf);
      place(rack, 22.6, 1.3, z, 0);
      this.physics.addStaticBox(new Vector3(22.6, 1.3, z), new Vector3(0.3, 1.3, 1.7));
    }

    // Long service pipes under the plant-room ceiling.
    for (let i = 0; i < 4; i++) {
      const pipe = new Mesh(new BoxGeometry(13, 0.26, 0.26), shelf);
      place(pipe, -16, 3.6 - i * 0.05, -13 + i * 1.2, 0);
    }
  }

  private addLighting() {
    // Base fill. Point lights alone leave the volumes between them completely
    // black, which reads as broken rather than as atmospheric — a shooter needs
    // its shadows to still have shape in them.
    const ambient = new HemisphereLight(0x39506e, 0x1a1512, 0.55);
    this.root.add(ambient);

    // Warm sodium work lamps against cold moonlight through the windows: the
    // colour contrast is what keeps a dark map readable.
    const lamp = (x: number, y: number, z: number, colour: number, intensity: number, range: number) => {
      const light = new PointLight(colour, intensity, range, 2);
      light.position.set(x, y, z);
      light.castShadow = false;
      this.root.add(light);

      // Visible fixture. The bulb is unlit basic material so it is uniformly
      // bright — an emissive Standard material renders a dark core wrapped in
      // bloom, which looks like a hole rather than a lamp.
      const shade = new Mesh(
        new BoxGeometry(0.5, 0.1, 0.5),
        new MeshStandardMaterial({ color: 0x15161a, roughness: 0.7, metalness: 0.6 }),
      );
      shade.position.set(x, y + 0.22, z);
      shade.castShadow = false;
      this.root.add(shade);

      const bulb = new Mesh(
        new BoxGeometry(0.3, 0.06, 0.3),
        new MeshBasicMaterial({ color: new Color(colour).multiplyScalar(1.5) }),
      );
      bulb.position.set(x, y + 0.15, z);
      this.root.add(bulb);
      return light;
    };

    lamp(0, 3.2, 12, 0xffb066, 34, 16);
    lamp(-3, 3.2, 17, 0xffb066, 26, 13);
    lamp(0, 4.6, 0, 0xffc48a, 62, 24);
    lamp(-6, 4.6, -4, 0x9fc4ff, 34, 16);
    lamp(16, 5.4, -2, 0xffb066, 78, 26);
    lamp(13, 5.4, -13, 0x9fc4ff, 52, 22);
    lamp(-16, 3.6, -6, 0xff8a4a, 58, 20);
    lamp(-19, 3.6, -13, 0xffb066, 38, 16);
    lamp(0, 2.9, -19, 0x9fc4ff, 40, 20);
    lamp(-14, 2.9, -19, 0xffb066, 32, 18);
    lamp(14, 2.9, -19, 0xffb066, 32, 18);

    // One shadow-casting key per major space. Shadow maps are the single most
    // expensive thing here, so they are rationed rather than sprinkled.
    const key = new SpotLight(0xdce8ff, 46, 30, Math.PI / 3.2, 0.62, 1.7);
    key.position.set(2, 5.2, 2);
    key.target.position.set(0, 0, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.0012;
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 28;
    this.root.add(key, key.target);

    const key2 = new SpotLight(0xffd2a0, 58, 34, Math.PI / 3, 0.66, 1.7);
    key2.position.set(16, 6, -5);
    key2.target.position.set(16, 0, -8);
    key2.castShadow = true;
    key2.shadow.mapSize.set(1024, 1024);
    key2.shadow.bias = -0.0012;
    key2.shadow.camera.near = 0.5;
    key2.shadow.camera.far = 32;
    this.root.add(key2, key2.target);
  }

  private addInteractables(nav: NavGrid) {
    const interactables: Interactable[] = [];
    const doors: Door[] = [];

    const addProp = (prop: Interactable) => {
      this.root.add(prop.root as Object3D);
      interactables.push(prop);
    };

    // --- Doors ---
    const warehouseDoor = new Door(
      'warehouse', 1000, 'warehouse',
      new Vector3(8, 0, -1), Math.PI / 2, 2.8, 3.2,
      () => nav.setBox(7.2, -2.4, 8.8, 0.4, false),
    );
    // Sealed until bought.
    nav.setBox(7.2, -2.4, 8.8, 0.4, true);
    doors.push(warehouseDoor);
    addProp(warehouseDoor);

    const plantDoor = new Door(
      'plant', 1250, 'plant',
      new Vector3(-9, 0, -0.5), Math.PI / 2, 2.6, 3.0,
      () => nav.setBox(-9.8, -1.8, -8.2, 0.8, false),
    );
    nav.setBox(-9.8, -1.8, -8.2, 0.8, true);
    doors.push(plantDoor);
    addProp(plantDoor);

    // --- Wall buys, spread so each zone has a reason to be visited ---
    addProp(new WallBuy('smg', new Vector3(5.7, 0, 11), -Math.PI / 2));
    addProp(new WallBuy('shotgun', new Vector3(-8.7, 0, -4.5), Math.PI / 2));
    addProp(new WallBuy('rifle', new Vector3(23.6, 0, -13), -Math.PI / 2));

    // --- Perk machines ---
    addProp(new PerkMachine(PERKS.doubleTap, new Vector3(-5.5, 0, 8.2), Math.PI));
    addProp(new PerkMachine(PERKS.juggernog, new Vector3(20.5, 0, -14.4), 0));
    addProp(new PerkMachine(PERKS.speedCola, new Vector3(-21, 0, -1.2), -Math.PI / 2));
    addProp(new PerkMachine(PERKS.staminUp, new Vector3(-6, 0, -20.4), 0));

    // --- Pack-a-Punch, deepest in the map ---
    addProp(new PackAPunch(new Vector3(-20, 0, -13.5), Math.PI * 0.25));

    // Machines are solid.
    for (const [x, z, w, d] of [
      [-5.5, 8.2, 0.7, 0.5], [20.5, -14.4, 0.7, 0.5], [-21, -1.2, 0.5, 0.7],
      [-6, -20.4, 0.7, 0.5], [-20, -13.5, 1.0, 0.9],
    ] as [number, number, number, number][]) {
      this.physics.addStaticBox(new Vector3(x, 1, z), new Vector3(w, 1, d));
      nav.setBox(x - w - 0.2, z - d - 0.2, x + w + 0.2, z + d + 0.2, true);
    }

    return { interactables, doors };
  }
}

/** Rounds a world position onto the nav grid, for debug readouts. */
export const snapToGrid = (v: number) => clamp(Math.round(v / NAV_CELL) * NAV_CELL, -60, 60);
