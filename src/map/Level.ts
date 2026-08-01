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
import { SurfaceOptions, makeSurface } from '../assets/Materials';
import { SurfaceId } from '../assets/TextureForge';
import { SpawnPoint } from '../zombies/ZombieManager';
import { Barrier, Door, Interactable, MysteryBox, PackAPunch, PerkMachine, PERKS, WallBuy } from './Props';
import { Rng, clamp } from '../util/math';
import { mergeAll } from '../util/geometry';
import { QualitySettings } from '../core/Quality';

/**
 * "Ashgate Terminal" — the playable map.
 *
 * A derelict railway terminal in the classic Zombies shape, laid out for up to
 * four players: a small defensible start room at the centre of a ring, and
 * nine further areas bought outward from it.
 *
 *                       ┌──────── signal box ────────┐
 *                       └──────────┬────┬────────────┘
 *          ┌──────────────── train shed ──────────────┐
 *          └──────┬───────────────────────────────┬───┤
 *          ┌───────────── service corridor ───────────┤
 *          │ plant  │ ░ court ░ │    warehouse    │   │
 *          ├────────┤  ┌─hall─┐ ├─────────────────┤ y │
 *          │        └──┤      ├─┘                 │ a │
 *          ├── canteen ┤ lobby├──── concourse ────┤ r │
 *          └───────────┴──────┴───────────────────┴─d─┘
 *
 * The shape is deliberate. One loop is enough for one player; four players
 * training the same circle collide with each other, so the ring is doubled —
 * an inner loop (hall → warehouse → corridor → plant → hall) and an outer one
 * (concourse → yard → corridor → plant → canteen → lobby) — with the train
 * shed and the yard as open arenas wide enough that two players can hold
 * separate trains in the same room. Every large room has at least two exits;
 * nothing on the ring is a pocket you can be backed into.
 *
 * Progression pulls outward. The wings either side of the lobby are cheap, the
 * two workhorse rooms sit behind the classic doors, and Pack-a-Punch is in the
 * one dead end on the map, five purchases deep. Areas reached from more than
 * one room have a doorway in each; those are one purchase, not several — see
 * `Door.unlocksZones`.
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

/** Standard boarded window. Barrier planks are built to fill exactly this band. */
const pane = (at: number): Hole => ({ at, width: 1.8, bottom: 0.9, top: 2.3 });
/** Standard doorway. Anything reaching the floor is opened in the nav grid. */
const doorway = (at: number, width: number, top = 3.0): Hole => ({ at, width, bottom: 0, top });

interface WallSpec {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  /**
   * Wall height. For a wall between two rooms this must follow the *taller*
   * neighbour, or the shorter room's ceiling stops short of the top of the
   * opening and the taller room looks out over it into the void. The extra
   * height is hidden above the shorter room's own ceiling.
   */
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
  // --- Start: the lobby and the hall behind it. Free, and small on purpose.
  { id: 'lobby', zone: 'start', minX: -7, minZ: 5, maxX: 6, maxZ: 19, height: 3.6, floor: 'tile' },
  // The hall is tall and open — the first room a player can actually train in.
  { id: 'hall', zone: 'start', minX: -9, minZ: -7, maxX: 8, maxZ: 5, height: 5.4, floor: 'concrete' },

  // --- The two cheap wings either side of the lobby. They exist so four
  //     players are not all standing in the start room on round three, and each
  //     opens a second route into the big room beyond it.
  { id: 'canteen', zone: 'canteen', minX: -23, minZ: 5, maxX: -7, maxZ: 19, height: 3.9, floor: 'tile', floorTint: 0x9a8f80 },
  { id: 'concourse', zone: 'concourse', minX: 6, minZ: 5, maxX: 24, maxZ: 21, height: 5.6, floor: 'tile', floorTint: 0xb6afa2 },

  // --- The two workhorse rooms, each reachable from the hall and from a wing.
  { id: 'warehouse', zone: 'warehouse', minX: 8, minZ: -16, maxX: 24, maxZ: 5, height: 6.2, floor: 'concrete', floorTint: 0xb0aca6 },
  { id: 'plant', zone: 'plant', minX: -23, minZ: -16, maxX: -9, maxZ: 5, height: 4.2, floor: 'concrete', floorTint: 0x9a968f },

  // --- The north spine. Free once either workhorse room is open, which is what
  //     closes the inner loop.
  { id: 'corridor', zone: 'corridor', minX: -23, minZ: -22, maxX: 24, maxZ: -16, height: 3.4, floor: 'asphalt' },

  // --- Loading yard: open to the sky, runs the whole east flank and touches
  //     three other areas. The outer loop's long side.
  { id: 'yard', zone: 'yard', minX: 24, minZ: -34, maxX: 35, maxZ: 21, height: 5.6, floor: 'asphalt', floorTint: 0x878480, ceiling: false },

  // --- Train shed: the big arena, and the only room with the floor area for
  //     four players to fight in at once.
  { id: 'platform', zone: 'platform', minX: -20, minZ: -40, maxX: 24, maxZ: -22, height: 8.5, floor: 'concrete', floorTint: 0x8e8a84 },

  // --- Signal box: the one dead end. Pack-a-Punch.
  { id: 'signal', zone: 'signal', minX: -7, minZ: -52, maxX: 7, maxZ: -40, height: 3.8, floor: 'tile', floorTint: 0x8496a0 },
];

/**
 * Enclosed exterior spaces that get a nav carve but no geometry.
 *
 * The light well between the plant, the warehouse, the hall and the corridor is
 * walled in on all four sides and unreachable by the player, but six windows
 * look into it. Carving it walkable lets the horde mill about and pick a window
 * instead of each spawn pocket being an isolated one-metre slot, and it cannot
 * leak anywhere because every wall around it is solid apart from those windows.
 * The exterior ground slab already provides its floor.
 */
const COURTS = [{ minX: -9, minZ: -16, maxX: 8, maxZ: -7 }];

const WALLS: WallSpec[] = [
  /* --- Lobby ---------------------------------------------------------- */
  // South facade onto the forecourt: three boarded windows.
  {
    x1: -7, z1: 19, x2: 6, z2: 19, height: 3.6, surface: 'brick',
    holes: [pane(2.6), pane(6.5), pane(10.4)], // x = -4.4, -0.5, 3.4
  },
  // West: door into the canteen.
  {
    x1: -7, z1: 5, x2: -7, z2: 19, height: 3.9, surface: 'plaster',
    holes: [doorway(7, 2.6)], // z = 12
  },
  // East: door into the concourse. Carried up past the lobby's south wall
  // because the concourse is both taller and deeper than the lobby.
  {
    x1: 6, z1: 5, x2: 6, z2: 21, height: 5.6, surface: 'plaster',
    holes: [doorway(7, 2.6)], // z = 12
  },
  // North: wide opening through to the hall.
  {
    x1: -7, z1: 5, x2: 6, z2: 5, height: 5.4, surface: 'plaster',
    holes: [doorway(6.5, 4.2, 2.9)],
  },

  /* --- Hall ----------------------------------------------------------- */
  // North wall onto the service court. Windows sit at the barrier positions:
  // boards hung over solid masonry with the real hole a metre away is the
  // classic version of this bug, and the barrier's nav apron then cuts its
  // opening through the wall rather than through the aperture.
  {
    x1: -9, z1: -7, x2: 8, z2: -7, height: 5.4, surface: 'concrete',
    holes: [pane(5.5), pane(11.5)], // x = -3.5, 2.5
  },
  // West wall of the hall: the plant door.
  {
    x1: -9, z1: -7, x2: -9, z2: 5, height: 5.4, surface: 'concrete',
    holes: [doorway(6.5, 2.6)], // z = -0.5
  },
  // East wall of the hall: the warehouse door.
  {
    x1: 8, z1: -7, x2: 8, z2: 5, height: 6.2, surface: 'concrete',
    holes: [doorway(6.0, 2.8, 3.2)], // z = -1
  },
  // Short returns closing the hall to the lobby footprint.
  { x1: -9, z1: 5, x2: -7, z2: 5, height: 5.4, surface: 'concrete' },
  { x1: 6, z1: 5, x2: 8, z2: 5, height: 5.6, surface: 'concrete' },

  /* --- Canteen -------------------------------------------------------- */
  {
    x1: -23, z1: 5, x2: -23, z2: 19, height: 3.9, surface: 'brick',
    holes: [pane(7)], // z = 12
  },
  {
    x1: -23, z1: 19, x2: -7, z2: 19, height: 3.9, surface: 'brick',
    holes: [pane(4), pane(12)], // x = -19, -11
  },
  // North: the plant's south wall, and the west route's second door.
  {
    x1: -23, z1: 5, x2: -9, z2: 5, height: 4.2, surface: 'concrete',
    holes: [doorway(6, 2.6)], // x = -17
  },

  /* --- Concourse ------------------------------------------------------ */
  {
    x1: 6, z1: 21, x2: 24, z2: 21, height: 5.6, surface: 'brick',
    holes: [pane(4.5), pane(9), pane(13.5)], // x = 10.5, 15, 19.5
  },
  // North: the warehouse's south wall, and the east route's second door.
  {
    x1: 8, z1: 5, x2: 24, z2: 5, height: 6.2, surface: 'brick',
    holes: [doorway(6, 2.8, 3.2)], // x = 14
  },
  // East: door into the yard.
  {
    x1: 24, z1: 5, x2: 24, z2: 21, height: 5.6, surface: 'brick',
    holes: [doorway(7, 2.8, 3.2)], // z = 12
  },

  /* --- Warehouse ------------------------------------------------------ */
  // East: the yard's second door.
  {
    x1: 24, z1: -16, x2: 24, z2: 5, height: 6.2, surface: 'brick',
    holes: [doorway(10.5, 3.0, 3.4)], // z = -5.5
  },
  // North: open passage into the service corridor.
  {
    x1: 8, z1: -16, x2: 24, z2: -16, height: 6.2, surface: 'brick',
    holes: [doorway(4.5, 3.0, 2.9)], // x = 12.5
  },
  // West, below the hall: the warehouse's only windows, onto the service court.
  {
    x1: 8, z1: -16, x2: 8, z2: -7, height: 6.2, surface: 'concrete',
    holes: [pane(3), pane(7)], // z = -13, -9
  },

  /* --- Plant ---------------------------------------------------------- */
  {
    x1: -23, z1: -16, x2: -23, z2: 5, height: 4.2, surface: 'concrete',
    holes: [pane(9), pane(17)], // z = -7, 1
  },
  // North: open passage into the service corridor.
  {
    x1: -23, z1: -16, x2: -9, z2: -16, height: 4.2, surface: 'concrete',
    holes: [doorway(10, 3.0, 2.7)], // x = -13
  },
  // East, below the hall: onto the service court.
  {
    x1: -9, z1: -16, x2: -9, z2: -7, height: 4.2, surface: 'concrete',
    holes: [pane(3), pane(7)], // z = -13, -9
  },

  /* --- Service corridor ------------------------------------------------ */
  // North wall. Split at x = -20 because the train shed only starts there: the
  // shared stretch has to carry the shed's full 8.5 m or the shed looks out
  // over the corridor's roof, while the exterior return stays at corridor
  // height so the building silhouette does not grow a fin.
  { x1: -23, z1: -22, x2: -20, z2: -22, height: 3.4, surface: 'brick' },
  {
    x1: -20, z1: -22, x2: 24, z2: -22, height: 8.5, surface: 'brick',
    holes: [doorway(6, 3.0, 2.9)], // x = -14, into the train shed
  },
  {
    x1: -23, z1: -22, x2: -23, z2: -16, height: 3.4, surface: 'brick',
    holes: [pane(3)], // z = -19
  },
  // East end, solid. The yard is a separate purchase and the corridor must not
  // hand it over for free.
  { x1: 24, z1: -22, x2: 24, z2: -16, height: 6.2, surface: 'brick' },
  // South wall over the service court.
  {
    x1: -9, z1: -16, x2: 8, z2: -16, height: 3.4, surface: 'brick',
    holes: [pane(8.5)], // x = -0.5
  },

  /* --- Loading yard (open to the sky) ---------------------------------- */
  // West side above the corridor: the train shed's east wall, carrying the
  // yard's own way into the shed.
  {
    x1: 24, z1: -34, x2: 24, z2: -22, height: 8.5, surface: 'concrete',
    holes: [doorway(6, 3.0, 3.4)], // z = -28
  },
  // Perimeter wall — high enough that the yard is a room with a sky, not a
  // hole in the map the player can walk out of.
  {
    x1: 35, z1: -34, x2: 35, z2: 21, height: 5.6, surface: 'brick',
    holes: [pane(13), pane(27), pane(41)], // z = -21, -7, 7
  },
  {
    x1: 24, z1: -34, x2: 35, z2: -34, height: 5.6, surface: 'brick',
    holes: [pane(7)], // x = 31
  },
  {
    x1: 24, z1: 21, x2: 35, z2: 21, height: 5.6, surface: 'brick',
    holes: [pane(5.5)], // x = 29.5
  },

  /* --- Train shed ------------------------------------------------------ */
  {
    x1: -20, z1: -40, x2: -20, z2: -22, height: 8.5, surface: 'brick',
    holes: [pane(5), pane(13)], // z = -35, -27
  },
  // North wall, carrying the signal box door between two windows.
  {
    x1: -20, z1: -40, x2: 24, z2: -40, height: 8.5, surface: 'brick',
    holes: [pane(6), doorway(20, 3.0, 3.2), pane(36)], // x = -14, 0, 16
  },
  // East wall above the yard's north end.
  {
    x1: 24, z1: -40, x2: 24, z2: -34, height: 8.5, surface: 'concrete',
    holes: [pane(3)], // z = -37
  },

  /* --- Signal box ------------------------------------------------------ */
  {
    x1: -7, z1: -52, x2: -7, z2: -40, height: 3.8, surface: 'plaster',
    holes: [pane(6)], // z = -46
  },
  {
    x1: 7, z1: -52, x2: 7, z2: -40, height: 3.8, surface: 'plaster',
    holes: [pane(6)], // z = -46
  },
  {
    x1: -7, z1: -52, x2: 7, z2: -52, height: 3.8, surface: 'brick',
    holes: [pane(7)], // x = 0
  },
];

interface BarrierSpec {
  x: number;
  z: number;
  yaw: number;
  zone: string;
  /** Where zombies queue up outside. */
  spawn: [number, number];
}

/**
 * Boarded windows, one per window hole above.
 *
 * `yaw` only sets the plane the planks lie in — 0 for a wall running along X,
 * ±π/2 for one running along Z. Which way is "out" is derived from the spawn
 * point instead, so it can never disagree with the layout.
 *
 * Spawn pockets must not share nav cells with a neighbouring pocket unless the
 * space between them is genuinely open, or two windows end up feeding from one
 * lane and the horde queues at the wrong one. Along a shared facade that means
 * keeping the pockets on different lines; inside the service court it does not
 * matter, because the court is carved walkable.
 */
const BARRIERS: BarrierSpec[] = [
  // Start room — the forecourt facade. Five windows between the lobby and the
  // hall: with four players in the free area, three was a rout on round one and
  // a stalemate by round five.
  { x: -4.4, z: 19, yaw: 0, zone: 'start', spawn: [-4.4, 22.5] },
  { x: -0.5, z: 19, yaw: 0, zone: 'start', spawn: [-0.5, 22.5] },
  { x: 3.4, z: 19, yaw: 0, zone: 'start', spawn: [3.4, 22.5] },
  { x: -3.5, z: -7, yaw: 0, zone: 'start', spawn: [-3.5, -10.5] },
  { x: 2.5, z: -7, yaw: 0, zone: 'start', spawn: [2.5, -10.5] },

  // Canteen.
  { x: -23, z: 12, yaw: Math.PI / 2, zone: 'canteen', spawn: [-26.5, 12] },
  { x: -19, z: 19, yaw: 0, zone: 'canteen', spawn: [-19, 22.5] },
  { x: -11, z: 19, yaw: 0, zone: 'canteen', spawn: [-11, 22.5] },

  // Concourse.
  { x: 10.5, z: 21, yaw: 0, zone: 'concourse', spawn: [10.5, 24.5] },
  { x: 15, z: 21, yaw: 0, zone: 'concourse', spawn: [15, 24.5] },
  { x: 19.5, z: 21, yaw: 0, zone: 'concourse', spawn: [19.5, 24.5] },

  // Warehouse — interior on three sides, so both its windows look into the
  // service court.
  { x: 8, z: -13, yaw: Math.PI / 2, zone: 'warehouse', spawn: [4.5, -13] },
  { x: 8, z: -9, yaw: Math.PI / 2, zone: 'warehouse', spawn: [4.5, -9] },

  // Plant.
  { x: -23, z: -7, yaw: Math.PI / 2, zone: 'plant', spawn: [-26.5, -7] },
  { x: -23, z: 1, yaw: Math.PI / 2, zone: 'plant', spawn: [-26.5, 1] },
  { x: -9, z: -13, yaw: Math.PI / 2, zone: 'plant', spawn: [-5.5, -13] },
  { x: -9, z: -9, yaw: Math.PI / 2, zone: 'plant', spawn: [-5.5, -9] },

  // Service corridor.
  { x: -23, z: -19, yaw: Math.PI / 2, zone: 'corridor', spawn: [-26.5, -19] },
  { x: -0.5, z: -16, yaw: 0, zone: 'corridor', spawn: [-0.5, -12.5] },

  // Loading yard.
  { x: 35, z: -21, yaw: -Math.PI / 2, zone: 'yard', spawn: [38.5, -21] },
  { x: 35, z: -7, yaw: -Math.PI / 2, zone: 'yard', spawn: [38.5, -7] },
  { x: 35, z: 7, yaw: -Math.PI / 2, zone: 'yard', spawn: [38.5, 7] },
  { x: 31, z: -34, yaw: 0, zone: 'yard', spawn: [31, -37.5] },
  { x: 29.5, z: 21, yaw: 0, zone: 'yard', spawn: [29.5, 24.5] },

  // Train shed.
  { x: -20, z: -35, yaw: Math.PI / 2, zone: 'platform', spawn: [-23.5, -35] },
  { x: -20, z: -27, yaw: Math.PI / 2, zone: 'platform', spawn: [-23.5, -27] },
  { x: -14, z: -40, yaw: 0, zone: 'platform', spawn: [-14, -43.5] },
  { x: 16, z: -40, yaw: 0, zone: 'platform', spawn: [16, -43.5] },
  { x: 24, z: -37, yaw: -Math.PI / 2, zone: 'platform', spawn: [27.5, -37] },

  // Signal box.
  { x: -7, z: -46, yaw: Math.PI / 2, zone: 'signal', spawn: [-10.5, -46] },
  { x: 7, z: -46, yaw: -Math.PI / 2, zone: 'signal', spawn: [10.5, -46] },
  { x: 0, z: -52, yaw: 0, zone: 'signal', spawn: [0, -55.5] },
];

interface LampSpec {
  x: number;
  y: number;
  z: number;
  colour: number;
  intensity: number;
  range: number;
}

/**
 * Work lamps. Warm sodium against cold moonlight through the windows — the
 * colour contrast is what keeps a dark map readable.
 *
 * There are more of these than the scene can afford live lights for; see
 * `addLighting` for how the rig follows the player.
 */
const LAMPS: LampSpec[] = [
  // Lobby
  { x: 0, y: 3.2, z: 12, colour: 0xffb066, intensity: 34, range: 16 },
  { x: -3, y: 3.2, z: 17, colour: 0xffb066, intensity: 26, range: 13 },
  // Hall
  { x: 0, y: 4.6, z: 0, colour: 0xffc48a, intensity: 62, range: 24 },
  { x: -6, y: 4.6, z: -4, colour: 0x9fc4ff, intensity: 34, range: 16 },
  // Canteen
  { x: -19, y: 3.5, z: 9, colour: 0xffb066, intensity: 40, range: 18 },
  { x: -12, y: 3.5, z: 15, colour: 0x9fc4ff, intensity: 30, range: 16 },
  // Concourse
  { x: 11, y: 5.0, z: 9, colour: 0xffc48a, intensity: 56, range: 22 },
  { x: 19, y: 5.0, z: 17, colour: 0x9fc4ff, intensity: 42, range: 20 },
  // Warehouse
  { x: 16, y: 5.4, z: -2, colour: 0xffb066, intensity: 78, range: 26 },
  { x: 13, y: 5.4, z: -13, colour: 0x9fc4ff, intensity: 52, range: 22 },
  // Plant
  { x: -16, y: 3.6, z: -6, colour: 0xff8a4a, intensity: 58, range: 20 },
  { x: -19, y: 3.6, z: -13, colour: 0xffb066, intensity: 38, range: 16 },
  { x: -13, y: 3.6, z: 2, colour: 0x9fc4ff, intensity: 32, range: 16 },
  // Service corridor
  { x: 0, y: 2.9, z: -19, colour: 0x9fc4ff, intensity: 40, range: 20 },
  { x: -14, y: 2.9, z: -19, colour: 0xffb066, intensity: 32, range: 18 },
  { x: 14, y: 2.9, z: -19, colour: 0xffb066, intensity: 32, range: 18 },
  // Loading yard
  { x: 29, y: 4.8, z: -26, colour: 0x9fc4ff, intensity: 46, range: 22 },
  { x: 29, y: 4.8, z: -8, colour: 0xffb066, intensity: 46, range: 22 },
  { x: 29, y: 4.8, z: 10, colour: 0x9fc4ff, intensity: 44, range: 22 },
  // Train shed
  { x: -10, y: 7.4, z: -25, colour: 0xffb066, intensity: 98, range: 34 },
  { x: 10, y: 7.4, z: -25, colour: 0x9fc4ff, intensity: 82, range: 30 },
  { x: -8, y: 7.4, z: -37, colour: 0xffb066, intensity: 86, range: 30 },
  { x: 14, y: 7.4, z: -37, colour: 0x9fc4ff, intensity: 72, range: 28 },
  // Signal box
  { x: 0, y: 3.4, z: -45, colour: 0x9fc4ff, intensity: 44, range: 18 },
];

/**
 * How many of those lamps are real lights at any moment.
 *
 * Every light in the scene costs every lit fragment, whether or not it reaches
 * it, so the count is a per-frame budget rather than a memory one. Twenty-four
 * fixtures across ten rooms would roughly double the shading cost of the whole
 * map for lights the player is three rooms away from and cannot see. The rig
 * keeps this many live and assigns them to the nearest fixtures, which is
 * enough to cover the room the player is in plus everything visible through its
 * doorways; the fixtures themselves are always drawn, so a distant lamp still
 * reads as a lit bulb.
 */
const ACTIVE_LAMPS = 10;
/** Seconds between rig re-evaluations. Lamp swaps happen out of sight. */
const LAMP_REFRESH = 0.25;

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
  /** Where a single player starts. Always `playerSpawns[0]`. */
  playerSpawn: Vector3;
  /** Start positions for a full lobby, spread so nobody spawns inside anybody. */
  playerSpawns: Vector3[];
  /** Y coordinate of the walkable floor. Flat by design. */
  floorY: number;
  /** Drives the roaming light rig. Call once per frame. */
  updateLights: (position: Vector3, dt: number) => void;
}

const NAV_ORIGIN_X = -32;
const NAV_ORIGIN_Z = -60;
const NAV_WIDTH = 76;
const NAV_DEPTH = 90;
const NAV_CELL = 0.5;
/**
 * Half-width of a barrier's nav apron measured across the wall.
 *
 * Deliberately just under half a cell rather than the ~0.9 m the aperture would
 * suggest, because NavGrid.setBox rasterises with floor() on both bounds: a cell
 * is opened whenever the box touches it at all. Most barriers sit exactly on a
 * cell boundary, so a half-width of 0.5 or more opens three cells (1.5 m) or
 * four (2.0 m) and spills past the 0.9 m frame edge into solid wall. Anything in
 * (0, 0.5) rasterises identically for those, so the value is chosen at the top
 * of that range: 0.45 keeps the requested box inside the aperture for the
 * barriers that do sit mid-cell, without widening the ones that do not. The
 * result is a 1.0–1.5 m opening centred on the frame — wide enough for the horde
 * to funnel through in single file, always within the glass.
 */
const APRON_HALF = 0.45;

export class Level {
  private readonly root = new Group();
  private readonly rng = new Rng(0x1e5e1);
  private readonly geometryBuckets = new Map<
    string,
    { mat: MeshStandardMaterial; geos: BoxGeometry[] }
  >();

  private readonly lampLights: PointLight[] = [];
  /** Lamp index each pool slot currently drives, or -1 when idle. */
  private readonly lampSlots: number[] = [];
  private lampTimer = 0;

  constructor(
    private readonly scene: Scene,
    private readonly physics: Physics,
    private readonly quality: QualitySettings,
  ) {}

  build(): LevelBuildResult {
    const nav = new NavGrid(NAV_ORIGIN_X, NAV_ORIGIN_Z, NAV_WIDTH, NAV_DEPTH, NAV_CELL);
    // Everything starts blocked; rooms carve out the walkable area, then walls
    // put obstacles back. Building "solid then subtract" is far more robust
    // than trying to enumerate every blocked cell.
    nav.setBox(NAV_ORIGIN_X, NAV_ORIGIN_Z, NAV_ORIGIN_X + NAV_WIDTH, NAV_ORIGIN_Z + NAV_DEPTH, true);

    this.buildExterior();
    for (const room of ROOMS) this.buildRoom(room, nav);
    // Courts carve before the wall pass for the same reason rooms do: the walls
    // around them have to win where the two overlap.
    for (const court of COURTS) {
      nav.setBox(court.minX + 0.45, court.minZ + 0.45, court.maxX - 0.45, court.maxZ - 0.45, false);
    }
    for (const wall of WALLS) this.buildWall(wall, nav);

    this.addProps(nav);
    this.flushGeometry();
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
      //
      // The two axes need very different treatment. ALONG the outward direction
      // the apron has to be generous: it must bridge the spawn pocket, the wall
      // band, and enough floor inside to meet the room's own carve. ACROSS the
      // wall it has to be tight, because this pass runs after buildWall() has
      // marked the wall line blocked and therefore wins. Padding both axes by
      // the same 1.1 m opened 2.5–3.0 m of wall line against a 1.8 m aperture —
      // half a metre of walkable masonry hard against the frame, which is
      // exactly where zombies were seen strolling through the brickwork instead
      // of climbing the window.
      const outDx = spec.spawn[0] - spec.x;
      const outDz = spec.spawn[1] - spec.z;
      // Every barrier faces down an axis; take the dominant component so a spawn
      // nudged a few centimetres off-axis still classifies correctly.
      const alongX = Math.abs(outDx) < Math.abs(outDz);
      const inside = new Vector3(spec.x - outDx, 0, spec.z - outDz);
      const minX = alongX ? spec.x - APRON_HALF : Math.min(spec.spawn[0], spec.x, inside.x) - 1.1;
      const maxX = alongX ? spec.x + APRON_HALF : Math.max(spec.spawn[0], spec.x, inside.x) + 1.1;
      const minZ = alongX ? Math.min(spec.spawn[1], spec.z, inside.z) - 1.1 : spec.z - APRON_HALF;
      const maxZ = alongX ? Math.max(spec.spawn[1], spec.z, inside.z) + 1.1 : spec.z + APRON_HALF;
      nav.setBox(minX, minZ, maxX, maxZ, false);

      // Bias the field against windows so zombies prefer an open door once one
      // exists, but still climb through when that is the only route in.
      nav.setCost(minX, minZ, maxX, maxZ, 2.6);
    }

    const { interactables, doors } = this.addInteractables(nav);

    this.scene.add(this.root);

    // Four start points around the lobby's lamp, all clear of the three south
    // windows so nobody is spawned into a barrier they cannot see yet.
    const playerSpawns = [
      new Vector3(-2.6, 0.02, 15.4),
      new Vector3(2.0, 0.02, 15.4),
      new Vector3(-2.6, 0.02, 11.6),
      new Vector3(2.0, 0.02, 11.6),
    ];

    return {
      root: this.root,
      nav,
      spawnPoints,
      barriers,
      interactables,
      doors,
      playerSpawn: playerSpawns[0].clone(),
      playerSpawns,
      floorY: 0,
      updateLights: (position, dt) => this.updateLights(position, dt),
    };
  }

  /* --- Geometry batching ---------------------------------------------- */

  /**
   * Returns the batch for one material.
   *
   * The key folds in everything that changes the material, not just the
   * caller's group name. A batch is created on first use and reused by name
   * afterwards, so a group name shared by two tints — steel racking and steel
   * rails, say — would silently draw the second one with the first one's
   * material and leave a whole prop family the wrong colour.
   */
  private bucket(group: string, surface: SurfaceId, tint: number, opts: SurfaceOptions = {}) {
    const key = `${group}|${surface}|${tint}|${opts.roughness ?? ''}|${opts.metalness ?? ''}|${opts.normalScale ?? ''}|${opts.emissive ?? ''}`;
    let b = this.geometryBuckets.get(key);
    if (!b) {
      b = {
        mat: makeSurface(surface, {
          repeat: 1,
          tint,
          roughness: 1,
          metalness: 1,
          // Architectural surfaces are seen at grazing angles across whole
          // rooms; a strong normal turns concrete into stucco at that scale.
          normalScale: 0.55,
          aoIntensity: 0.8,
          ...opts,
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
    opts: SurfaceOptions = {},
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
    this.bucket(key, surface, tint, opts).geos.push(geo);
    return geo;
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
      new Vector3(6, -0.32, -14),
      new Vector3(210, 0.4, 210),
      0.28,
    );

    // Skyline: blocks at varying distance and height, deliberately unlit and
    // dark so they read as mass rather than as detail. The ring has to clear
    // the map's own footprint — the yard's east wall is 29 m out and the signal
    // box 40 m north of centre — while staying inside the fog's far plane, or
    // it converges on the sky colour and vanishes.
    const rng = new Rng(0x5c1);
    for (let i = 0; i < 32; i++) {
      const angle = (i / 32) * Math.PI * 2 + rng.range(-0.08, 0.08);
      const dist = rng.range(58, 88);
      const height = rng.range(9, 30);
      const width = rng.range(7, 18);
      this.addBox(
        'skyline',
        'concrete',
        0x4a5162,
        new Vector3(6 + Math.cos(angle) * dist, height / 2 - 1, -14 + Math.sin(angle) * dist),
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

  /**
   * Places a box prop: batched render geometry, a static collider, and
   * optionally nav blocking.
   *
   * Anything tall and wide enough to matter to the player has to be given to
   * the AI as well. Without the nav block a rack or a shipping container is
   * solid to the player and thin air to the flow field, and zombies walk
   * straight through the steel — which is worse than not having it, because the
   * player is using it as cover.
   */
  private block(
    key: string,
    surface: SurfaceId,
    tint: number,
    centre: Vector3,
    size: Vector3,
    uvScale: number,
    yaw = 0,
    nav?: NavGrid,
    opts: SurfaceOptions = {},
  ) {
    this.addBox(key, surface, tint, centre, size, uvScale, yaw, opts);
    this.physics.addStaticBox(
      centre,
      new Vector3(size.x / 2, size.y / 2, size.z / 2),
      new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw),
    );
    if (nav) {
      // Axis-aligned bound of the (possibly yawed) footprint, plus a margin so
      // agents do not clip the corners.
      const c = Math.abs(Math.cos(yaw));
      const s = Math.abs(Math.sin(yaw));
      const hx = (size.x / 2) * c + (size.z / 2) * s + 0.15;
      const hz = (size.x / 2) * s + (size.z / 2) * c + 0.15;
      nav.setBox(centre.x - hx, centre.z - hz, centre.x + hx, centre.z + hz, true);
    }
  }

  private addProps(nav: NavGrid) {
    const CRATE = 'prop_crate';
    const DRUM = 'prop_drum';
    const STEEL = 'prop_steel';
    const PAINT = 'prop_paint';
    const CONCRETE = 'prop_concrete';
    const wood: SurfaceOptions = { normalScale: 1 };

    // --- Crate stacks: cover, and a scale reference in the big rooms. -----
    const crateSpots: [number, number, number][] = [
      // Warehouse
      [14, -12, 0], [15.4, -12.2, 0.4], [14.7, -12.1, 1.7],
      [20, 2, 0.3], [21.2, 1.4, 0.9],
      // Plant: pushed onto the north wall, well off the room's main diagonal.
      [-16.5, -15.1, 0.2], [-15.4, -15.2, 1.1],
      // Lobby and hall
      [3.5, 16.5, 0.5], [-5.5, -4, 0.2],
      // Service corridor — small enough to squeeze past, which is the point of
      // a corridor obstacle.
      [-6, -20.4, 0.4], [5, -17.4, 1.2], [18, -20.4, 0.8],
      // Train shed
      [-17.5, -30, 0.3], [-16.4, -30.6, 1.0], [8, -29.5, 0.6], [9.2, -30.2, 1.4],
      // Loading yard
      [25.6, -19.5, 0.2], [33.4, -2.5, 1.1], [25.8, 6.5, 0.7],
      // Signal box
      [5.2, -42.4, 0.4],
    ];
    for (const [x, z, yaw] of crateSpots) {
      const size = this.rng.range(0.75, 1.15);
      this.block(
        CRATE, 'woodPlank', 0x8a7a63,
        new Vector3(x, size * 0.41, z), new Vector3(size, size * 0.82, size),
        1.4, yaw, undefined, wood,
      );
    }

    // --- Oil drums. Under a nav cell across, so the flow field ignores them.
    const drumSpots: [number, number][] = [
      [18, -6], [19.4, -6.6], [-20, -4], [-15.5, -13.5], [10.5, -19],
      [-18.5, 7.2], [22.4, 19.2], [-11.5, -24.6], [12, -24.2], [33.6, -29],
    ];
    for (const [x, z] of drumSpots) {
      this.block(
        DRUM, 'rustedMetal', 0x8f6a4a,
        new Vector3(x, 0.46, z), new Vector3(0.62, 0.92, 0.62),
        1.6, this.rng.range(0, 3), undefined, { normalScale: 1.1 },
      );
    }

    // --- Warehouse racking, free-standing so it splits the floor into two
    //     training lanes instead of screening a wall.
    //
    // These used to line the east wall. Keeping each rack clear of an aperture
    // is not enough: a rack is 3.4 long, 2.6 tall and stands a full metre proud
    // of the wall, so from anywhere in the room it screens the wall band either
    // side of itself. Standing them in the open costs nothing and turns them
    // into something to run around.
    for (const [x, z] of [[17, -12], [17, -6], [12, 1.5]] as [number, number][]) {
      this.block(
        STEEL, 'rustedMetal', 0x77787c,
        new Vector3(x, 1.3, z), new Vector3(0.6, 2.6, 3.4),
        2, 0, nav,
      );
    }

    // --- Plant: boilers and the long service pipes under the ceiling. ------
    this.block(
      STEEL, 'rustedMetal', 0x6d6a64,
      new Vector3(-13, 1.6, -3), new Vector3(1.8, 3.2, 1.8), 1.6, 0, nav,
    );
    this.block(
      STEEL, 'rustedMetal', 0x6d6a64,
      new Vector3(-19.5, 1.7, -9), new Vector3(2.0, 3.4, 2.0), 1.6, 0, nav,
    );
    for (let i = 0; i < 4; i++) {
      this.addBox(
        STEEL, 'rustedMetal', 0x77787c,
        new Vector3(-16, 3.6 - i * 0.05, -13 + i * 1.2), new Vector3(13, 0.26, 0.26), 2,
      );
    }

    // --- Canteen: a serving counter and four table blocks. ----------------
    this.block(
      PAINT, 'paintedMetal', 0x7d8a86,
      new Vector3(-19, 0.52, 15), new Vector3(5.0, 1.05, 0.9), 1.4, 0, nav,
    );
    for (const [x, z] of [[-13.5, 9.5], [-13.5, 14.5], [-10.5, 17], [-16, 12]] as [number, number][]) {
      this.block(
        CRATE, 'woodPlank', 0x7c6b56,
        new Vector3(x, 0.39, z), new Vector3(1.5, 0.78, 1.5), 1.2, 0, nav, wood,
      );
      // A pale top plate. Without it a table is a black slab at this light
      // level and reads as rubble rather than as furniture.
      this.addBox(
        CRATE, 'woodPlank', 0xbcae96,
        new Vector3(x, 0.8, z), new Vector3(1.62, 0.08, 1.62), 1.2, 0, wood,
      );
    }

    // --- Concourse: the ticket kiosk stands in the middle of the room, which
    //     is what makes this the best training circle on the map — four lanes
    //     around one block, all of them wide enough to run.
    //
    // Built up from five slabs rather than left as one box. A single block at
    // this scale reads as a missing asset standing in a finished room — it is
    // the only thing in the concourse the eye goes to, and it has to look like
    // somewhere tickets were sold.
    this.block(
      PAINT, 'paintedMetal', 0x59636b,
      new Vector3(15, 1.2, 13), new Vector3(5.0, 2.4, 3.2), 1.2, 0, nav,
    );
    // Glazed band wrapping all four sides, and the counter sill under it.
    this.addBox(
      'kiosk_glass', 'gunmetal', 0x141a22,
      new Vector3(15, 1.86, 13), new Vector3(5.06, 0.78, 3.26), 0.9, 0,
      { roughness: 0.3, normalScale: 0.2 },
    );
    this.addBox(
      STEEL, 'rustedMetal', 0x8d8b88,
      new Vector3(15, 1.4, 13), new Vector3(5.3, 0.1, 3.5), 1.4,
    );
    // Canopy. Deliberately given neither a collider nor nav blocking: it starts
    // at 2.4 m, so nothing on this map can walk into it, and blocking its
    // overhang would eat half a metre of running lane on all four sides.
    this.addBox(
      PAINT, 'paintedMetal', 0x3d464d,
      new Vector3(15, 2.55, 13), new Vector3(5.9, 0.3, 4.1), 1.0,
    );
    // Lit fascia, so the kiosk is a landmark from across a 16 m room.
    for (const [dx, dz, sx, sz] of [[0, 2.08, 5.0, 0.06], [0, -2.08, 5.0, 0.06],
                                    [2.53, 0, 0.06, 4.1], [-2.53, 0, 0.06, 4.1]] as [number,number,number,number][]) {
      this.addBox(
        'kiosk_fascia', 'paintedMetal', 0x2b3238,
        new Vector3(15 + dx, 2.28, 13 + dz), new Vector3(sx, 0.24, sz), 1.6, 0,
        { emissive: 0xffb066, emissiveIntensity: 0.55, roughness: 0.7 },
      );
    }
    for (const [x, z] of [[10, 17.5], [20, 8.5]] as [number, number][]) {
      this.block(
        CONCRETE, 'concrete', 0x8d897f,
        new Vector3(x, 2.8, z), new Vector3(0.8, 5.6, 0.8), 0.8, 0, nav,
      );
    }
    for (const [x, z] of [[9.5, 8], [9.5, 17], [21, 19]] as [number, number][]) {
      this.block(
        CRATE, 'woodPlank', 0x7c6b56,
        new Vector3(x, 0.35, z), new Vector3(2.4, 0.7, 0.6), 1.2, 0, undefined, wood,
      );
    }

    // --- Loading yard: containers, staggered east and west so the length of
    //     the yard is a serpentine rather than a runway. Each leaves a lane
    //     over 6 m wide on the other side.
    //
    // None of them may sit on a window's approach: the barrier pass runs after
    // this one and re-opens its apron cells, so a container laid across a lane
    // would end up with zombies walking through it.
    const containers: [number, number, number][] = [
      [27, -30, 0], [32, -25, 1], [27, -15, 0], [32, -11, 1],
      [27, -1, 0], [32, 2, 1], [27, 11, 0], [32, 17, 1],
    ];
    for (const [x, z, tone] of containers) {
      const colour = tone ? 0x8a5a48 : 0x4f6a72;
      this.block(
        PAINT, 'paintedMetal', colour,
        new Vector3(x, 1.3, z), new Vector3(2.5, 2.6, 6.0), 0.7, 0, nav,
      );
      // Cargo doors and a corner post at the south end. Six metres of flat
      // colour has no scale to it; two recessed leaves and a frame tell the
      // player how big the thing is and which way it is facing.
      this.addBox(
        PAINT, 'paintedMetal', tone ? 0x6f4739 : 0x3e545b,
        new Vector3(x, 1.28, z + 3.02), new Vector3(2.26, 2.3, 0.06), 1.6,
      );
      for (const dx of [-0.58, 0.58]) {
        this.addBox(
          STEEL, 'rustedMetal', 0x6b6660,
          new Vector3(x + dx, 1.28, z + 3.06), new Vector3(0.08, 2.2, 0.05), 2,
        );
      }
    }
    // Two stacked a second high. Only the lower box needs nav blocking.
    for (const [x, z, tone] of [[27, -15, 1], [32, 2, 0]] as [number, number, number][]) {
      this.block(
        PAINT, 'paintedMetal', tone ? 0x8a5a48 : 0x4f6a72,
        new Vector3(x, 3.92, z), new Vector3(2.5, 2.6, 6.0), 0.7, 0, undefined,
      );
    }

    // --- Train shed: roof columns, the platform kerb, the track bed and a
    //     stranded carriage. The carriage is the whole point of the room — it
    //     splits an eighteen-metre-deep hall into two full-length lanes with
    //     open ends, which is a training loop four people can share.
    for (const x of [-17, -10, -3, 4, 11, 18]) {
      this.block(
        CONCRETE, 'concrete', 0x807c74,
        new Vector3(x, 4.25, -25), new Vector3(0.7, 8.5, 0.7), 0.8, 0, nav,
      );
    }
    for (const x of [-17, -10, 6, 13, 20]) {
      this.block(
        CONCRETE, 'concrete', 0x807c74,
        new Vector3(x, 4.25, -38), new Vector3(0.7, 8.5, 0.7), 0.8, 0, nav,
      );
    }
    // Ballast and rails: visual only. A collider here would be a kerb to trip
    // on, and a nav block would cut the shed in half.
    this.addBox(
      'trackbed', 'asphalt', 0x4c4842,
      new Vector3(2, 0.03, -33), new Vector3(44, 0.06, 4.4), 0.5,
    );
    for (const z of [-34.2, -31.8]) {
      this.addBox(
        STEEL, 'gunmetal', 0x8d8b88,
        new Vector3(2, 0.09, z), new Vector3(44, 0.12, 0.14), 2,
      );
    }
    // Carriage: body, window band, roof and two bogies.
    this.block(
      PAINT, 'paintedMetal', 0x5c4a52,
      new Vector3(-4, 1.95, -33), new Vector3(18, 3.0, 2.9), 0.8, 0, nav,
    );
    this.addBox(
      'carriage_glass', 'gunmetal', 0x171b22,
      new Vector3(-4, 2.5, -33), new Vector3(17.4, 0.9, 3.02), 0.6, 0,
      { roughness: 0.34, normalScale: 0.25 },
    );
    this.addBox(
      PAINT, 'paintedMetal', 0x47383e,
      new Vector3(-4, 3.55, -33), new Vector3(18.2, 0.24, 3.1), 0.8,
    );
    for (const x of [-11, 3]) {
      this.addBox(
        STEEL, 'rustedMetal', 0x54514c,
        new Vector3(x, 0.4, -33), new Vector3(3.4, 0.55, 2.2), 1.4,
      );
    }
    // Platform kerb along the south side of the track. Low enough for the
    // player's autostep and left out of the nav grid so it never blocks.
    this.addBox(
      CONCRETE, 'concrete', 0x9a958c,
      new Vector3(2, 0.11, -30.4), new Vector3(44, 0.22, 0.5), 0.9,
    );

    // --- Signal box: console banks and a lever frame. ---------------------
    for (const x of [-5.2, 5.2]) {
      this.block(
        PAINT, 'paintedMetal', 0x4d5a55,
        new Vector3(x, 0.55, -49.5), new Vector3(1.4, 1.1, 3.2), 1.2, 0, nav,
      );
    }
    this.block(
      STEEL, 'rustedMetal', 0x6f6a60,
      new Vector3(-4, 0.5, -43), new Vector3(4.0, 1.0, 0.7), 1.6, 0, nav,
    );
  }

  private addLighting() {
    // Base fill. Point lights alone leave the volumes between them completely
    // black, which reads as broken rather than as atmospheric — a shooter needs
    // its shadows to still have shape in them.
    this.root.add(new HemisphereLight(0x39506e, 0x1a1512, 0.55));

    // Fixtures for every lamp, batched. These are always drawn: an unlit bulb
    // at the far end of the yard still tells the player there is a room there,
    // and separating them from the live lights is what lets the rig roam.
    const shadeGeos: BoxGeometry[] = [];
    const bulbGeos = new Map<number, BoxGeometry[]>();
    for (const lamp of LAMPS) {
      const shade = new BoxGeometry(0.5, 0.1, 0.5);
      shade.translate(lamp.x, lamp.y + 0.22, lamp.z);
      shadeGeos.push(shade);

      // The bulb is an unlit basic material so it is uniformly bright — an
      // emissive Standard material renders a dark core wrapped in bloom, which
      // looks like a hole rather than a lamp.
      const bulb = new BoxGeometry(0.3, 0.06, 0.3);
      bulb.translate(lamp.x, lamp.y + 0.15, lamp.z);
      const list = bulbGeos.get(lamp.colour);
      if (list) list.push(bulb);
      else bulbGeos.set(lamp.colour, [bulb]);
    }

    const shades = mergeAll(shadeGeos);
    if (shades) {
      this.root.add(
        new Mesh(shades, new MeshStandardMaterial({ color: 0x15161a, roughness: 0.7, metalness: 0.6 })),
      );
    }
    for (const [colour, geos] of bulbGeos) {
      const merged = mergeAll(geos);
      if (!merged) continue;
      this.root.add(
        new Mesh(merged, new MeshBasicMaterial({ color: new Color(colour).multiplyScalar(1.5) })),
      );
    }

    for (let i = 0; i < ACTIVE_LAMPS; i++) {
      const light = new PointLight(0xffffff, 0, 1, 2);
      light.castShadow = false;
      this.root.add(light);
      this.lampLights.push(light);
      this.lampSlots.push(-1);
    }
    // Seed from the player's start so the lobby is lit on the first frame,
    // before the rig has had a chance to tick.
    this.assignLamps(new Vector3(0, 1.6, 14));

    // One shadow-casting key per major space. Shadow maps are the single most
    // expensive thing here, so they are rationed rather than sprinkled: the
    // hall, the warehouse and the train shed are the three rooms with enough
    // vertical geometry for a cast shadow to be worth its cost.
    const key = (
      colour: number, intensity: number, range: number, angle: number,
      from: [number, number, number], at: [number, number, number], far: number,
    ) => {
      const spot = new SpotLight(colour, intensity, range, angle, 0.64, 1.7);
      spot.position.set(from[0], from[1], from[2]);
      spot.target.position.set(at[0], at[1], at[2]);
      spot.castShadow = true;
      spot.shadow.mapSize.set(this.quality.shadowMapSize, this.quality.shadowMapSize);
      spot.shadow.bias = -0.0012;
      spot.shadow.camera.near = 0.5;
      spot.shadow.camera.far = far;
      this.root.add(spot, spot.target);
    };

    key(0xdce8ff, 46, 30, Math.PI / 3.2, [2, 5.2, 2], [0, 0, 6], 28);
    key(0xffd2a0, 58, 34, Math.PI / 3, [16, 6, -5], [16, 0, -8], 32);
    key(0xdce8ff, 92, 46, Math.PI / 3.1, [0, 8.0, -27], [-2, 0, -32], 44);
  }

  /**
   * Points the live lights at the fixtures nearest the player.
   *
   * Reassignment is set-based rather than rank-based on purpose: sorting and
   * writing slot *i* from rank *i* re-points every light the moment two
   * fixtures swap places in the ranking, and a room full of lamps jumping one
   * seat sideways is visible. Here a slot keeps its lamp for as long as that
   * lamp stays in the nearest set, so walking through the map only ever lights
   * the fixture that just came into range and darkens the one that left.
   */
  private assignLamps(position: Vector3) {
    const ranked = LAMPS.map((lamp, index) => ({
      index,
      d: (lamp.x - position.x) ** 2 + (lamp.z - position.z) ** 2,
    }));
    ranked.sort((a, b) => a.d - b.d);
    const chosen = new Set(ranked.slice(0, ACTIVE_LAMPS).map((r) => r.index));

    // Nothing to do while the player stays in the same handful of rooms.
    let same = true;
    for (let i = 0; i < this.lampSlots.length && same; i++) {
      if (this.lampSlots[i] >= 0 && !chosen.has(this.lampSlots[i])) same = false;
    }
    if (same && this.lampSlots.every((s) => s >= 0)) return;

    const free: number[] = [];
    const held = new Set<number>();
    for (let i = 0; i < this.lampSlots.length; i++) {
      const current = this.lampSlots[i];
      if (current >= 0 && chosen.has(current)) held.add(current);
      else free.push(i);
    }

    for (const index of chosen) {
      if (held.has(index)) continue;
      const slot = free.pop();
      if (slot === undefined) break;
      const lamp = LAMPS[index];
      const light = this.lampLights[slot];
      light.color.setHex(lamp.colour);
      light.intensity = lamp.intensity;
      light.distance = lamp.range;
      light.position.set(lamp.x, lamp.y, lamp.z);
      this.lampSlots[slot] = index;
    }
    // Fewer fixtures than slots (never true for this map, but a smaller one
    // would leave the tail pointing at nothing).
    for (const slot of free) {
      this.lampLights[slot].intensity = 0;
      this.lampSlots[slot] = -1;
    }
  }

  private updateLights(position: Vector3, dt: number) {
    this.lampTimer -= dt;
    if (this.lampTimer > 0) return;
    this.lampTimer = LAMP_REFRESH;
    this.assignLamps(position);
  }

  private addInteractables(nav: NavGrid) {
    const interactables: Interactable[] = [];
    const doors: Door[] = [];

    const addProp = (prop: Interactable) => {
      this.root.add(prop.root as Object3D);
      interactables.push(prop);
    };

    /* --- Doors ---
     *
     * A door's front is its local -Z face, so it must be yawed to look at the
     * room the player arrives from — the price card renders on the front only,
     * and a door yawed 180° out is bought off a blank back panel.
     *
     * The nav opening is sealed here and cleared by the door's own callback.
     * Areas with two ways in list the same zone from both doorways; opening
     * either opens both (see Game.openDoor), so the seals are independent but
     * the purchase is not.
     */
    const gate = (
      id: string, cost: number, group: string, zones: string[], label: string,
      position: [number, number], yaw: number, width: number, height: number,
    ) => {
      // The seal is derived from the doorway rather than written out by hand,
      // because it has to agree with buildWall's carve *to the cell* and the
      // two are easy to drift apart.
      //
      // Along the wall it must match exactly. buildWall re-opens a doorway by
      // stamping WALL_THICKNESS/2 + 0.12 boxes along the hole inset by 0.25 at
      // each end, which reaches 0.05 m past the hole's true edge; because
      // setBox rasterises with floor() on both bounds, that overshoot pulls in
      // a whole extra cell whenever the jamb sits just inside one. A seal
      // measured to the bare half-width therefore leaves one open cell at each
      // jamb — invisible on a plan, and enough for the horde to walk through a
      // door nobody has bought. Overshooting the other way is not an option
      // either: the door's callback re-opens whatever it sealed, so a seal
      // wider than the hole would punch walkable holes in the masonry beside
      // the frame the moment the door is bought.
      //
      // Across the wall it only has to span the wall band. The extra reach here
      // lands on room floor that is already open, so it is harmless either way.
      const along = width / 2 + 0.05;
      const across = WALL_THICKNESS / 2 + 0.62;
      // A door yawed ±π/2 stands in a wall running along Z; one yawed 0 or π
      // stands in a wall running along X.
      const alongZ = Math.abs(Math.sin(yaw)) > 0.5;
      const hx = alongZ ? across : along;
      const hz = alongZ ? along : across;
      const [px, pz] = position;

      const door = new Door(
        id, cost, group, zones, label,
        new Vector3(px, 0, pz), yaw, width, height,
        () => nav.setBox(px - hx, pz - hz, px + hx, pz + hz, false),
      );
      nav.setBox(px - hx, pz - hz, px + hx, pz + hz, true);
      doors.push(door);
      addProp(door);
    };

    // The wings: cheap, and the first thing four players will want.
    gate('concourse', 750, 'concourse', ['concourse'], 'concourse',
      [6, 12], Math.PI / 2, 2.6, 3.0);
    gate('canteen', 750, 'canteen', ['canteen'], 'canteen',
      [-7, 12], -Math.PI / 2, 2.6, 3.0);

    // Warehouse — from the hall and from the concourse. Both unlock the service
    // corridor too, because the corridor is reached through an open passage
    // rather than a door of its own.
    gate('warehouse', 1000, 'warehouse', ['warehouse', 'corridor'], 'warehouse',
      [8, -1], Math.PI / 2, 2.8, 3.2);
    gate('warehouseSouth', 1000, 'warehouse', ['warehouse', 'corridor'], 'warehouse',
      [14, 5], Math.PI, 2.8, 3.2);

    // Plant — from the hall and from the canteen.
    gate('plant', 1250, 'plant', ['plant', 'corridor'], 'plant',
      [-9, -0.5], -Math.PI / 2, 2.6, 3.0);
    gate('plantSouth', 1250, 'plant', ['plant', 'corridor'], 'plant',
      [-17, 5], Math.PI, 2.6, 3.0);

    // Loading yard — from the concourse and from the warehouse.
    gate('yardSouth', 1250, 'yard', ['yard'], 'loading yard',
      [24, 12], Math.PI / 2, 2.8, 3.2);
    gate('yardNorth', 1250, 'yard', ['yard'], 'loading yard',
      [24, -5.5], Math.PI / 2, 3.0, 3.4);

    // Train shed — from the corridor and from the yard.
    gate('platform', 1750, 'platform', ['platform'], 'train shed',
      [-14, -22], Math.PI, 3.0, 2.9);
    gate('platformYard', 1750, 'platform', ['platform'], 'train shed',
      [24, -28], -Math.PI / 2, 3.0, 3.4);

    // Signal box — the dead end, and the deepest purchase on the map.
    gate('signal', 2000, 'signal', ['signal'], 'signal box',
      [0, -40], Math.PI, 3.0, 3.2);

    /* --- Wall buys, spread so each route has a gun on it ---
     *
     * Facing convention for every wall-mounted prop here: the *front* is the
     * local -Z face, so a prop yawed by θ shows its face along (-sinθ, 0, -cosθ)
     * and presents its back along (sinθ, 0, cosθ). Yaw these 180° out and the
     * price card and mounted gun end up buried inside the masonry while the
     * player is left staring at the blank grey backing board.
     *
     * Mounting depth: the board is 0.06 thick and centred on the origin, so the
     * origin sits 0.03 off the wall's inner face — which is itself half of
     * WALL_THICKNESS in from the wall's centre line.
     *
     * Two of each gun, one per route, so an east-side player and a west-side
     * player are not fighting over the same board.
     */
    addProp(new WallBuy('smg', new Vector3(5.79, 0, 8), Math.PI / 2)); // lobby east wall, x = 6
    addProp(new WallBuy('smg', new Vector3(-22.79, 0, 8), -Math.PI / 2)); // canteen west wall, x = -23
    addProp(new WallBuy('shotgun', new Vector3(-8.79, 0, -4.5), -Math.PI / 2)); // hall west wall, x = -9
    addProp(new WallBuy('shotgun', new Vector3(6.21, 0, 17.5), -Math.PI / 2)); // concourse west wall, x = 6
    addProp(new WallBuy('rifle', new Vector3(23.79, 0, -13), Math.PI / 2)); // warehouse east wall, x = 24
    addProp(new WallBuy('rifle', new Vector3(-9, 0, -22.21), 0)); // train shed south wall, z = -22
    addProp(new WallBuy('shotgun', new Vector3(24.21, 0, 3), -Math.PI / 2)); // yard west wall, x = 24

    /* --- Mystery box ---------------------------------------------------- */
    // The lobby placement makes the high-risk roll reachable from round one,
    // while its front faces the spawn side of the room. All prize weapons live
    // exclusively in MYSTERY_BOX_WEAPONS; none is duplicated as a wall prop.
    addProp(new MysteryBox(new Vector3(-2.6, 0, 13.4), Math.PI));

    /* --- Perk machines, one per zone that is not a corridor or a dead end ---
     *
     * Same facing convention. The deepest thing on a cabinet's back is the
     * plinth, 0.78 deep and centred on the origin, so the origin sits 0.4 off
     * the wall's inner face to stand the machine flush against it.
     */
    addProp(new PerkMachine(PERKS.quickRevive, new Vector3(-6.42, 0, 17.4), -Math.PI / 2)); // lobby west wall, x = -7
    addProp(new PerkMachine(PERKS.deadshot, new Vector3(-15, 0, 18.42), 0)); // canteen south wall, z = 19
    addProp(new PerkMachine(PERKS.doubleTap, new Vector3(23.42, 0, 7), Math.PI / 2)); // concourse east wall, x = 24
    addProp(new PerkMachine(PERKS.juggernog, new Vector3(20.5, 0, -15.42), Math.PI)); // warehouse north wall, z = -16
    addProp(new PerkMachine(PERKS.speedCola, new Vector3(-22.42, 0, -1.2), -Math.PI / 2)); // plant west wall, x = -23
    addProp(new PerkMachine(PERKS.staminUp, new Vector3(8, 0, -39.42), Math.PI)); // train shed north wall, z = -40

    /* --- Pack-a-Punch --- */
    // Free-standing in the middle of the signal box rather than shoved into a
    // corner: it is the one place four players converge on at once, and a
    // machine against a wall can only be used from one side.
    addProp(new PackAPunch(new Vector3(0, 0, -47.5), Math.PI));

    // Machines are solid. Half-extents follow the yaw above: a cabinet is 1.15
    // wide by 0.78 deep, so the wide axis is X for a machine facing ±Z and Z for
    // one facing ±X. These must be kept in step with the positions above or the
    // player collides with air in front of a machine standing flush to a wall.
    for (const [x, z, w, d] of [
      [-6.42, 17.4, 0.45, 0.62], [-15, 18.42, 0.62, 0.45], [23.42, 7, 0.45, 0.62],
      [20.5, -15.42, 0.62, 0.45], [-22.42, -1.2, 0.45, 0.62], [8, -39.42, 0.62, 0.45],
      [0, -47.5, 0.9, 0.6],
      [-2.6, 13.4, 0.82, 0.62],
    ] as [number, number, number, number][]) {
      this.physics.addStaticBox(new Vector3(x, 1, z), new Vector3(w, 1, d));
      nav.setBox(x - w - 0.2, z - d - 0.2, x + w + 0.2, z + d + 0.2, true);
    }

    return { interactables, doors };
  }
}

/** Rounds a world position onto the nav grid, for debug readouts. */
export const snapToGrid = (v: number) => clamp(Math.round(v / NAV_CELL) * NAV_CELL, -80, 80);
