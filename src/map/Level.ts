import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
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
import {
  Barrier,
  Door,
  Interactable,
  MysteryBox,
  PackAPunch,
  PerkMachine,
  PERKS,
  TerminalSign,
  WallBuy,
} from './Props';
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
    x1: -7, z1: 5, x2: -7, z2: 19, height: 3.9, surface: 'plaster', tint: 0xbab7ad,
    holes: [doorway(7, 2.6)], // z = 12
  },
  // East: door into the concourse. Carried up past the lobby's south wall
  // because the concourse is both taller and deeper than the lobby.
  {
    x1: 6, z1: 5, x2: 6, z2: 21, height: 5.6, surface: 'plaster', tint: 0xbab7ad,
    holes: [doorway(7, 2.6)], // z = 12
  },
  // North: wide opening through to the hall.
  {
    x1: -7, z1: 5, x2: 6, z2: 5, height: 5.4, surface: 'plaster', tint: 0xbab7ad,
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
  { x: 0, y: 3.2, z: 12, colour: 0xffb066, intensity: 22, range: 16 },
  { x: -3, y: 3.2, z: 17, colour: 0xffb066, intensity: 18, range: 13 },
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
  // Buckets accept any BufferGeometry: addBox contributes boxes, and the
  // dressing pass contributes cylinders (pipes). mergeAll normalises the mix.
  private readonly geometryBuckets = new Map<
    string,
    { mat: MeshStandardMaterial; geos: BufferGeometry[] }
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
    // Decorative passes go through the same batcher so they merge into the
    // scene's existing draw calls, but strictly after all gameplay geometry:
    // they are visual-only and must never influence colliders or nav.
    this.addGrime();
    this.addDressing();
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

    // A staged interior arrival gives the opening wave a readable first beat:
    // the player can see one silhouette through the hall doorway before the
    // window pressure builds around the room. Later releases still use the
    // authored barrier pockets and their repair economy.
    spawnPoints.push({ position: new Vector3(0, 0, -1.5), zone: 'start' });

    const { interactables, doors } = this.addInteractables(nav);

    this.scene.add(this.root);

    // Four start points around the lobby's lamp, all clear of the three south
    // windows. The solo view is deliberately offset from the mystery box so
    // the first frame establishes the terminal sightline instead of filling the
    // reticle with the largest interactable prop.
    const playerSpawns = [
      new Vector3(0.8, 0.02, 15.4),
      new Vector3(3.0, 0.02, 15.4),
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

  /* --- Surface variation ------------------------------------------------ */

  /**
   * Quantised luminance steps for the tile-breaking pass.
   *
   * A single material across a 40 m floor tiles into an obviously repeating
   * pattern — the eye locks onto the repeat within a couple of strides. These
   * steps are deliberately *quantised* rather than continuous: every section
   * that lands on the same step shares one material and therefore one draw
   * call, where per-section float tints would give the map dozens of
   * near-identical materials. Five steps at ±7% is inside the ±8% brief and
   * still visibly distinct under the warm lamp falloff.
   */
  private static readonly SHADE_STEPS = [-0.07, -0.035, 0, 0.035, 0.07];

  /** Multiplies a packed RGB tint by `factor`, clamped per channel. */
  private static shadeTint(tint: number, factor: number): number {
    const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * factor)));
    return (ch((tint >> 16) & 0xff) << 16) | (ch((tint >> 8) & 0xff) << 8) | ch(tint & 0xff);
  }

  /**
   * Adds a large horizontal slab (floor or ceiling) as 2–4 independently
   * shaded, independently quarter-turned sections.
   *
   * Two independent axes of variation are what actually kill the repeat:
   * luminance alone leaves the texel grid aligned across the seam, and rotation
   * alone keeps the same contrast values marching in lockstep. Both together,
   * with the turn index offset by the section index so two adjacent slices can
   * never land on the same orientation even when their shade step collides,
   * guarantees adjacent sections never show an identical texel pattern.
   *
   * addBox derives UVs from world size, so an odd quarter-turn must swap the
   * box's X/Z extents to keep the footprint identical while turning the texel
   * grid 90°; even turns rotate in place.
   *
   * This only slices RENDER geometry — callers keep their single physics box
   * and nav carve exactly as before, so gameplay contracts are untouched.
   */
  private addSectionedSlab(
    key: string,
    slabSurface: SurfaceId,
    baseTint: number,
    centre: Vector3,
    size: Vector3,
    uvScale: number,
    opts: SurfaceOptions = {},
  ) {
    // One slice per ~7 m of the longer axis, clamped to 2–4: the lobby gets a
    // seam, the train shed gets four, nothing degenerates into one giant or a
    // dozen tiny slabs.
    const sections = Math.max(2, Math.min(4, Math.round(Math.max(size.x, size.z) / 7)));
    // Seed from the slab's origin so the map is byte-identical run to run but
    // neighbouring rooms do not land on the same shade sequence.
    const rng = new Rng((0x51ab ^ Math.round(centre.x * 131) ^ Math.round(centre.z * 57)) >>> 0);
    const alongX = size.x >= size.z;
    for (let i = 0; i < sections; i++) {
      const shadeIdx = rng.int(0, Level.SHADE_STEPS.length - 1);
      // +i forces adjacent sections onto different turns.
      const turn = (rng.int(0, 3) + i) % 4;
      const segW = alongX ? size.x / sections : size.x;
      const segD = alongX ? size.z : size.z / sections;
      const cx = alongX ? centre.x - size.x / 2 + segW * (i + 0.5) : centre.x;
      const cz = alongX ? centre.z : centre.z - size.z / 2 + segD * (i + 0.5);
      const swap = turn % 2 === 1;
      const segTint = Level.shadeTint(baseTint, 1 + Level.SHADE_STEPS[shadeIdx]);
      // Suffix by BOTH indices so same-look sections merge into one batch
      // while different-looking ones can never share a material.
      this.addBox(
        `${key}_s${shadeIdx}t${turn}`,
        slabSurface,
        segTint,
        new Vector3(cx, centre.y, cz),
        new Vector3(swap ? segD : segW, size.y, swap ? segW : segD),
        uvScale,
        (turn * Math.PI) / 2,
        opts,
      );
    }
  }

  private flushGeometry() {
    for (const [key, bucket] of this.geometryBuckets) {
      const merged = mergeAll(bucket.geos);
      if (!merged) continue;
      const mesh = new Mesh(merged, bucket.mat);
      mesh.name = key;
      // Decorative buckets (grime overlays, cables, pipes, puddles) hug the
      // surfaces they dress; letting them cast would double-shadow every
      // threshold and cable for no visible gain. They still receive.
      mesh.castShadow = !key.startsWith('deco_');
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

    const floorTint = room.floorTint ?? (room.floor === 'tile' ? 0x817a73 : 0xffffff);
    const floorSurface: SurfaceOptions = room.floor === 'tile'
      ? { roughness: 0.94, metalness: 0.02, normalScale: 0.28, aoIntensity: 0.78 }
      : { roughness: 0.96, metalness: 0.02, normalScale: 0.45, aoIntensity: 0.82 };
    // Floor: split into shade/rotation-varied sections so a whole room of one
    // material doesn't read as wallpaper (see addSectionedSlab). The physics
    // box below stays the single full-size collider it always was — only the
    // render geometry is sliced.
    this.addSectionedSlab(
      `floor_${room.floor}_${floorTint}`,
      room.floor,
      floorTint,
      new Vector3(cx, -0.15, cz),
      new Vector3(w, 0.3, d),
      // The baked tile is an 8x8 cell texture; this keeps each cell close to
      // half a metre so the lobby reads as a worn terminal floor, not noise.
      room.floor === 'tile' ? 0.24 : 0.6,
      floorSurface,
    );
    this.physics.addStaticBox(new Vector3(cx, -0.15, cz), new Vector3(w / 2, 0.15, d / 2));

    if (room.ceiling !== false) {
      // Same treatment as the floor: ceilings are the largest uninterrupted
      // surface in every interior shot and repeated the hardest.
      this.addSectionedSlab(
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
    // Per-segment shade ladder, seeded from the wall's start point: every wall
    // gets its own deterministic sequence, and the +segIndex offset guarantees
    // neighbouring segments (the slabs between holes) never land on the same
    // step — a wall pierced by three doors reads as three pours of concrete,
    // not one texture stamped three times. Quantised so segments across the
    // whole map still share a handful of materials.
    const wallRng = new Rng((0x77aa ^ Math.round(spec.x1 * 97) ^ Math.round(spec.z1 * 31)) >>> 0);
    let segIndex = 0;
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

      const shadeIdx = (wallRng.int(0, Level.SHADE_STEPS.length - 1) + segIndex) % Level.SHADE_STEPS.length;
      const segTint = Level.shadeTint(tint, 1 + Level.SHADE_STEPS[shadeIdx]);
      this.addBox(`wall_${spec.surface}_${segTint}`, spec.surface, segTint, centre, size, 0.85, yaw);
      this.physics.addStaticBox(
        centre,
        new Vector3(size.x / 2, size.y / 2, size.z / 2),
        new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw),
      );
      segIndex++;
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
    const PAINT = 'paintedMetal';
    const CONCRETE = 'prop_concrete';
    const wood: SurfaceOptions = { normalScale: 1 };

    const addSign = (
      title: string,
      subtitle: string,
      position: Vector3,
      yaw: number,
      options: { width?: number; height?: number; accent?: number } = {},
    ) => {
      // Signage is wall-mounted and intentionally has no physics/nav footprint.
      this.root.add(new TerminalSign(title, subtitle, position, yaw, options).root);
    };

    /* --- Spawn arrival composition ------------------------------------
     *
     * The lobby is the first image of the map, so it needs a readable arrival
     * axis rather than a loose collection of machines. The header frames the
     * hall opening, while the dais, hazard inlay and low baggage cover give the
     * free starting room a deliberate centre without closing its four-player
     * spawn lanes.
     */
    // Keep the header below the lobby ceiling so the first arrival landmark is
    // actually visible from the player spawn rather than hidden in the slab.
    addSign('ASHGATE TERMINAL', 'PLATFORM 01 // MAIN HALL', new Vector3(-0.5, 2.34, 5.40), Math.PI, {
      width: 4.9,
      height: 1.15,
      accent: 0xffb66e,
    });
    this.addBox(
      'arrival_header', 'rustedMetal', 0x625e57,
      new Vector3(-0.5, 3.16, 5.40), new Vector3(7.0, 0.22, 0.3), 1.2,
      0, { roughness: 0.72, metalness: 0.9 },
    );
    for (const x of [-6.6, 5.6]) {
      this.addBox(
        'arrival_jamb', 'rustedMetal', 0x6f6b62,
        new Vector3(x, 1.52, 5.22), new Vector3(0.22, 3.05, 0.32), 1.6,
        0, { roughness: 0.7, metalness: 0.85 },
      );
    }
    // Thin emergency strips are emissive practicals, not new live lights: they
    // remain readable at distance without increasing the active-light budget.
    for (const x of [-6.66, 5.66]) {
      this.addBox(
        'arrival_emergency_strip', 'paintedMetal', 0x7c2e28,
        new Vector3(x, 2.58, 5.02), new Vector3(0.045, 0.085, 0.42), 1,
        0, { emissive: 0xf04c32, emissiveIntensity: 0.9, roughness: 0.55, metalness: 0.3 },
      );
    }
    addSign('ARRIVALS', 'CENTRAL LOBBY // 06:40', new Vector3(5.78, 2.18, 12.15), Math.PI / 2, {
      width: 2.65,
      height: 0.82,
      accent: 0x79d4c2,
    });
    addSign('HALL 01', 'MAIN CONCOURSE // NORTH', new Vector3(-6.78, 2.18, 9.55), -Math.PI / 2, {
      width: 2.45,
      height: 0.76,
      accent: 0xffb66e,
    });
    // The first sightline needs a readable ceiling rhythm. These are meshes,
    // not extra point lights: the existing lamp rig supplies illumination while
    // the visible fixture bodies provide scale and a believable source for it.
    for (const [z, glow] of [[7.6, 0xffc08a], [12.1, 0xffd7a0], [16.6, 0x9fcaff]] as [number, number][]) {
      this.addBox(
        'lobby_fixture_frame', 'paintedMetal', 0x3e4549,
        new Vector3(0, 3.47, z), new Vector3(2.8, 0.08, 0.46), 1.2,
        0, { roughness: 0.72, metalness: 0.25, normalScale: 0.4 },
      );
      this.addBox(
        'lobby_fixture_glow', 'paintedMetal', glow,
        new Vector3(0, 3.42, z), new Vector3(2.18, 0.025, 0.2), 1.2,
        0, { emissive: glow, emissiveIntensity: 0.28, roughness: 0.3, metalness: 0.02 },
      );
    }
    // A low split wainscot makes the doorway read as architecture and keeps
    // the long plaster wall from presenting as one unbroken procedural slab.
    for (const [x, width] of [[-4.55, 4.35], [4.55, 3.55]] as [number, number][]) {
      this.addBox(
        'lobby_wainscot', 'paintedMetal', 0x4e5a5c,
        new Vector3(x, 0.78, 5.07), new Vector3(width, 1.28, 0.055), 0.8,
        0, { roughness: 0.86, metalness: 0.22, normalScale: 0.55 },
      );
      this.addBox(
        'lobby_wainscot_rail', 'rustedMetal', 0x716658,
        new Vector3(x, 1.48, 5.02), new Vector3(width + 0.08, 0.07, 0.12), 1.2,
        0, { roughness: 0.72, metalness: 0.72, normalScale: 0.45 },
      );
    }
    // A small platform and four painted corner marks sell the mystery box as a
    // fitted terminal fixture. They are visual-only because the box already owns
    // the interaction collider and nav seal below.
    this.addBox(
      'arrival_dais', 'concrete', 0x555d58,
      new Vector3(-2.6, 0.07, 13.4), new Vector3(2.75, 0.14, 2.1), 0.8,
    );
    for (const [x, z, sx, sz] of [
      [-3.82, 13.4, 0.08, 1.9], [-1.38, 13.4, 0.08, 1.9],
      [-2.6, 12.5, 2.35, 0.08], [-2.6, 14.3, 2.35, 0.08],
    ] as [number, number, number, number][]) {
      this.addBox(
        'arrival_hazard_mark', 'paintedMetal', 0xb57d42,
        new Vector3(x, 0.16, z), new Vector3(sx, 0.035, sz), 1.5,
        0, { emissive: 0x8b3b1c, emissiveIntensity: 0.18, roughness: 0.68, metalness: 0.35 },
      );
    }
    this.block(
      'arrival_luggage', PAINT, 0x55666a,
      new Vector3(3.85, 0.44, 8.8), new Vector3(1.35, 0.88, 0.9), 1.1, 0, nav,
      { roughness: 0.78, metalness: 0.85 },
    );
    this.addBox(
      'arrival_luggage_top', 'gunmetal', 0x86847b,
      new Vector3(3.85, 0.91, 8.8), new Vector3(1.5, 0.08, 1.02), 1.2,
      0, { roughness: 0.6, metalness: 0.95 },
    );
    // Surface-mounted hand rails add scale and decay to the long lobby walls;
    // they sit inside the existing wall collision band and never alter nav.
    for (const x of [-6.72, 5.72]) {
      this.addBox(
        'arrival_wall_rail', 'rustedMetal', 0x69645c,
        new Vector3(x, 1.18, 9.2), new Vector3(0.08, 0.08, 5.0), 1.4,
        0, { roughness: 0.76, metalness: 0.86 },
      );
      for (const z of [7.0, 11.4]) {
        this.addBox(
          'arrival_wall_rail_bracket', 'rustedMetal', 0x4f4c48,
          new Vector3(x, 1.18, z), new Vector3(0.2, 0.16, 0.12), 1.4,
          0, { roughness: 0.78, metalness: 0.9 },
        );
      }
    }

    /* --- Lobby construction pass --------------------------------------
     *
     * These are deliberately render-only layers. The room and wall specs above
     * remain the authority for traversal; the shallow panels, trims, conduits
     * and debris only give the existing shell the visual construction a player
     * reads at eye level. The north opening is the first zombie approach, so it
     * gets the strongest authored rhythm and a clean visual frame.
     */
    const panelSurface: SurfaceOptions = {
      roughness: 0.9,
      metalness: 0.24,
      normalScale: 0.65,
    };
    const trimSurface: SurfaceOptions = {
      roughness: 0.72,
      metalness: 0.78,
      normalScale: 0.45,
    };

    // Wainscot modules on both long side walls. Varying the panel widths keeps
    // the lobby from reading as one repeated texture while the rails establish
    // a believable terminal kick-plate line behind the weapon viewmodel.
    for (const [x, side] of [[-6.79, -1], [5.79, 1]] as [number, number][]) {
      this.addBox(
        'lobby_side_wainscot_rail', 'rustedMetal', 0x6e665b,
        new Vector3(x, 1.5, 12.1), new Vector3(0.075, 0.08, 12.7), 1.3,
        0, trimSurface,
      );
      for (const [z, depth] of [[6.55, 2.1], [9.25, 2.45], [12.35, 2.7], [15.55, 2.35], [18.05, 1.35]] as [number, number][]) {
        this.addBox(
          'lobby_side_panel', 'paintedMetal', side < 0 ? 0x536064 : 0x4c595d,
          new Vector3(x + side * 0.012, 0.78, z), new Vector3(0.055, 1.28, depth), 0.72,
          0, panelSurface,
        );
        this.addBox(
          'lobby_side_panel_cap', 'rustedMetal', 0x776c5e,
          new Vector3(x + side * 0.045, 1.47, z), new Vector3(0.095, 0.07, depth + 0.06), 1.1,
          0, trimSurface,
        );
      }
    }

    // A proper portal casing makes the hall feel built into the terminal. The
    // posts sit just outside the 4.2 m opening and do not narrow its collider.
    for (const x of [-2.92, 1.92]) {
      this.addBox(
        'hall_portal_pilaster', 'concrete', 0x77736c,
        new Vector3(x, 1.55, 4.78), new Vector3(0.24, 3.1, 0.48), 0.9,
        0, { roughness: 0.9, metalness: 0.12, normalScale: 0.8 },
      );
      this.addBox(
        'hall_portal_pilaster_trim', 'rustedMetal', 0x686057,
        new Vector3(x, 1.55, 4.48), new Vector3(0.32, 3.22, 0.09), 1.0,
        0, trimSurface,
      );
    }
    this.addBox(
      'hall_portal_lintel', 'concrete', 0x817a70,
      new Vector3(-0.5, 3.15, 4.78), new Vector3(5.1, 0.28, 0.48), 0.9,
      0, { roughness: 0.88, metalness: 0.1, normalScale: 0.78 },
    );
    this.addBox(
      'hall_portal_lintel_trim', 'rustedMetal', 0x696057,
      new Vector3(-0.5, 2.96, 4.48), new Vector3(5.25, 0.09, 0.1), 1.1,
      0, trimSurface,
    );
    // A thin amber threshold line gives the player a destination without
    // placing a bright decal or prompt in the crosshair.
    for (const x of [-2.38, 1.38]) {
      this.addBox(
        'hall_portal_threshold', 'paintedMetal', 0xa37248,
        new Vector3(x, 0.025, 5.7), new Vector3(0.075, 0.035, 1.35), 1.4,
        0, { emissive: 0x4a2415, emissiveIntensity: 0.16, roughness: 0.7, metalness: 0.38 },
      );
    }

    // The lobby ceiling is a single slab by design; shallow service beams turn
    // it into a believable suspended structure and give the warm fixtures a
    // repeatable architectural cadence without adding lights or collisions.
    for (const z of [6.1, 9.55, 13.15, 16.75, 18.55]) {
      this.addBox(
        'lobby_ceiling_crossbeam', 'rustedMetal', 0x44484a,
        new Vector3(0, 3.48, z), new Vector3(12.1, 0.12, 0.16), 1.15,
        0, { roughness: 0.82, metalness: 0.72, normalScale: 0.38 },
      );
    }
    for (const x of [-5.55, 5.55]) {
      this.addBox(
        'lobby_ceiling_service_rail', 'rustedMetal', 0x505154,
        new Vector3(x, 3.42, 12.1), new Vector3(0.16, 0.14, 12.7), 1.1,
        0, { roughness: 0.8, metalness: 0.78, normalScale: 0.38 },
      );
    }
    for (const z of [3.2, -0.4, -4.0]) {
      this.addBox(
        'hall_ceiling_joist', 'rustedMetal', 0x4c4d4d,
        new Vector3(-0.5, 5.02, z), new Vector3(16.0, 0.16, 0.22), 1.05,
        0, { roughness: 0.82, metalness: 0.74, normalScale: 0.38 },
      );
    }

    // Boarded hall windows now have a real masonry reveal: posts, sill and
    // lintel make the existing barrier planks read as a barricade in a wall,
    // rather than two floating dark rectangles at the end of the hall.
    for (const x of [-3.5, 2.5]) {
      for (const offset of [-0.92, 0.92]) {
        this.addBox(
          'hall_boarded_window_post', 'rustedMetal', 0x655b50,
          new Vector3(x + offset, 1.6, -6.77), new Vector3(0.1, 1.65, 0.12), 1.1,
          0, trimSurface,
        );
      }
      this.addBox(
        'hall_boarded_window_lintel', 'rustedMetal', 0x655b50,
        new Vector3(x, 2.42, -6.77), new Vector3(1.95, 0.1, 0.12), 1.1,
        0, trimSurface,
      );
      this.addBox(
        'hall_boarded_window_sill', 'concrete', 0x5b5752,
        new Vector3(x, 0.82, -6.77), new Vector3(1.95, 0.13, 0.16), 0.9,
        0, { roughness: 0.94, metalness: 0.1, normalScale: 0.8 },
      );
      for (const offset of [-0.44, 0.44]) {
        this.addBox(
          'hall_boarded_window_bracket', 'rustedMetal', 0x8a684d,
          new Vector3(x + offset, 1.54, -6.69), new Vector3(0.16, 0.12, 0.08), 1.2,
          0, trimSurface,
        );
      }
    }

    // Exposed conduits and a service junction break up the hall side walls and
    // carry the eye toward the windows without changing the training lane.
    for (const x of [-8.72, 7.72]) {
      this.addBox(
        'hall_wall_conduit', 'rustedMetal', 0x55534f,
        new Vector3(x, 2.8, -0.85), new Vector3(0.09, 0.09, 8.1), 1.3,
        0, trimSurface,
      );
      for (const z of [-4.6, -1.0, 2.7]) {
        this.addBox(
          'hall_wall_conduit_bracket', 'rustedMetal', 0x6b5d50,
          new Vector3(x, 2.8, z), new Vector3(0.2, 0.17, 0.12), 1.2,
          0, trimSurface,
        );
      }
    }
    this.addBox(
      'hall_service_junction', 'paintedMetal', 0x59666a,
      new Vector3(7.73, 2.48, 3.25), new Vector3(0.12, 0.62, 0.74), 0.85,
      0, panelSurface,
    );
    this.addBox(
      'hall_service_junction_label', 'paintedMetal', 0xd09052,
      new Vector3(7.80, 2.51, 3.25), new Vector3(0.025, 0.22, 0.42), 1.1,
      0, { emissive: 0x4a2413, emissiveIntensity: 0.18, roughness: 0.56, metalness: 0.28 },
    );

    // Small, non-blocking decay clusters live against the wall edges. Their
    // low profile supplies the missing lived-in scale while leaving every
    // authored spawn lane and collider untouched.
    for (const [x, z, yaw] of [[-5.92, 7.0, 0.22], [5.38, 16.9, -0.32], [-6.0, 17.65, 0.48]] as [number, number, number][]) {
      this.addBox(
        'lobby_floor_debris', 'concrete', 0x4e4b47,
        new Vector3(x, 0.035, z), new Vector3(0.46, 0.07, 0.18), 1.4,
        yaw, { roughness: 0.98, metalness: 0.04, normalScale: 0.95 },
      );
      this.addBox(
        'lobby_floor_debris_edge', 'rustedMetal', 0x795740,
        new Vector3(x + 0.18, 0.055, z - 0.06), new Vector3(0.22, 0.035, 0.06), 1.5,
        yaw + 0.16, trimSurface,
      );
    }
    for (const [x, z, y, h, w] of [[-6.80, 8.35, 2.0, 0.72, 0.44], [5.80, 14.15, 2.3, 0.58, 0.68], [5.80, 18.0, 1.1, 0.92, 0.3]] as [number, number, number, number, number][]) {
      this.addBox(
        'lobby_plaster_failure', 'concrete', 0x665b54,
        new Vector3(x, y, z), new Vector3(0.035, h, w), 0.7,
        0, { roughness: 0.97, metalness: 0.04, normalScale: 1.0 },
      );
    }

    /* --- Terminal joinery and service wear ---------------------------
     *
     * The shell above establishes the silhouette. These low-profile layers
     * are the construction language that makes it read as a maintained-but-
     * abandoned public building: a kick plate at the floor, a shadowed
     * surround at each side entrance, and a real material break at the hall
     * threshold. They are render-only and stay inside the existing wall band,
     * so physics, nav and every authored spawn lane remain unchanged.
     */
    for (const [x, side] of [[-6.79, -1], [5.79, 1]] as [number, number][]) {
      this.addBox(
        'lobby_wall_plinth', 'concrete', 0x575a57,
        new Vector3(x, 0.18, 12.05), new Vector3(0.07, 0.34, 12.85), 0.72,
        0, { roughness: 0.96, metalness: 0.12, normalScale: 0.82 },
      );
      this.addBox(
        'lobby_wall_plinth_cap', 'rustedMetal', 0x766d61,
        new Vector3(x + side * 0.045, 0.38, 12.05), new Vector3(0.09, 0.06, 12.92), 1.2,
        0, trimSurface,
      );

      // The real side door openings are at z=12. The dark inner reveal and
      // bright outer trim give the openings depth without narrowing them.
      for (const z of [10.56, 13.44]) {
        this.addBox(
          'lobby_side_door_reveal', 'concrete', 0x4d5353,
          new Vector3(x + side * 0.015, 1.52, z), new Vector3(0.055, 3.0, 0.14), 0.82,
          0, { roughness: 0.94, metalness: 0.1, normalScale: 0.75 },
        );
        this.addBox(
          'lobby_side_door_trim', 'rustedMetal', 0x746a5d,
          new Vector3(x + side * 0.055, 1.52, z), new Vector3(0.08, 3.12, 0.08), 1.05,
          0, trimSurface,
        );
      }
      this.addBox(
        'lobby_side_door_lintel', 'concrete', 0x6c6a64,
        new Vector3(x + side * 0.015, 3.08, 12), new Vector3(0.06, 0.16, 2.98), 0.88,
        0, { roughness: 0.9, metalness: 0.1, normalScale: 0.7 },
      );
      this.addBox(
        'lobby_side_door_lintel_trim', 'rustedMetal', 0x806c57,
        new Vector3(x + side * 0.06, 2.96, 12), new Vector3(0.08, 0.07, 3.08), 1.1,
        0, trimSurface,
      );
    }

    // Tile gives way to the hall's worn concrete through a dark stone sill;
    // the existing amber safety marks sit on top of this transition.
    this.addBox(
      'hall_floor_transition', 'concrete', 0x625f59,
      new Vector3(-0.5, 0.018, 5.08), new Vector3(4.18, 0.035, 0.3), 0.9,
      0, { roughness: 0.98, metalness: 0.08, normalScale: 0.9 },
    );
    for (const x of [-2.15, -1.05, 0.05, 1.15]) {
      this.addBox(
        'hall_floor_transition_inlay', 'rustedMetal', 0x8b6c4c,
        new Vector3(x, 0.043, 5.08), new Vector3(0.035, 0.018, 0.24), 1.1,
        0, { roughness: 0.72, metalness: 0.72, normalScale: 0.4 },
      );
    }

    // Compact service boxes make the wall dressing functional rather than
    // decorative. Their tiny face strips are emissive meshes only; no live
    // lights are added to the scene.
    for (const [x, side, z, tint] of [
      [-6.79, -1, 7.35, 0xc24d35],
      [5.79, 1, 16.85, 0x78b8b0],
    ] as [number, number, number, number][]) {
      this.addBox(
        'lobby_service_box', 'paintedMetal', 0x3e484b,
        new Vector3(x + side * 0.015, 1.9, z), new Vector3(0.1, 0.58, 0.58), 0.8,
        0, { roughness: 0.78, metalness: 0.7, normalScale: 0.45 },
      );
      this.addBox(
        'lobby_service_box_face', 'paintedMetal', tint,
        new Vector3(x + side * 0.075, 1.9, z), new Vector3(0.025, 0.24, 0.32), 1.0,
        0, { emissive: tint, emissiveIntensity: 0.18, roughness: 0.62, metalness: 0.32 },
      );
      this.addBox(
        'lobby_service_box_latch', 'rustedMetal', 0x9a8061,
        new Vector3(x + side * 0.08, 1.9, z - 0.2), new Vector3(0.03, 0.06, 0.08), 1.1,
        0, trimSurface,
      );
    }

    // A shallow patch and its exposed edge make the plaster failure read as a
    // layered repair, not a single dark decal pasted onto the wall.
    for (const [x, side, z, width] of [
      [-6.79, -1, 10.05, 0.72],
      [5.79, 1, 14.95, 0.86],
    ] as [number, number, number, number][]) {
      this.addBox(
        'lobby_wall_repair_patch', 'plaster', 0x8f877d,
        new Vector3(x + side * 0.018, 2.36, z), new Vector3(0.035, 0.46, width), 0.72,
        0, { roughness: 0.98, metalness: 0.02, normalScale: 0.9 },
      );
      this.addBox(
        'lobby_wall_repair_edge', 'concrete', 0x5f5952,
        new Vector3(x + side * 0.045, 2.36, z - width * 0.42), new Vector3(0.045, 0.5, 0.035), 0.75,
        0, { roughness: 0.98, metalness: 0.04, normalScale: 0.95 },
      );
    }

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
    addSign('PLATFORM 01', 'ASHGATE // ARRIVALS', new Vector3(0, 5.88, -39.78), Math.PI, {
      width: 5.6,
      height: 1.15,
      accent: 0x8fc6df,
    });
    // Overhead shed trusses make the roof volume legible from the floor. They
    // are well above the player and therefore decorative rather than traversable
    // geometry, while the existing columns remain the actual cover/collision.
    for (const z of [-25, -31.5, -38]) {
      this.addBox(
        'shed_overhead_truss', 'rustedMetal', 0x55534f,
        new Vector3(2, 7.86, z), new Vector3(43.2, 0.18, 0.24), 1.1,
        0, { roughness: 0.78, metalness: 0.9 },
      );
    }
    for (const x of [-17, -3, 11, 20]) {
      this.addBox(
        'shed_roof_brace', 'rustedMetal', 0x4c4a47,
        new Vector3(x, 7.5, -31.5), new Vector3(0.18, 0.75, 13.0), 1.0,
        0, { roughness: 0.82, metalness: 0.88 },
      );
    }

    // --- Landmark signage and industrial wear --------------------------
    addSign('LOADING YARD', 'BAY 04 // KEEP CLEAR', new Vector3(34.78, 3.72, 13.2), Math.PI / 2, {
      width: 3.7,
      height: 0.98,
      accent: 0xffa05c,
    });
    addSign('SIGNAL 09', 'CONTROL ROOM // DEAD END', new Vector3(0, 2.35, -51.78), Math.PI, {
      width: 3.6,
      height: 0.92,
      accent: 0x9a5cff,
    });
    // Paint failure and patch plates keep the long lobby/concourse walls from
    // reading as untouched procedural slabs. These overlap the existing walls
    // by only a few centimetres and add no separate collider.
    this.addBox(
      'spawn_decay_patch', 'concrete', 0x6b5d54,
      new Vector3(5.79, 1.28, 16.4), new Vector3(0.035, 1.55, 0.9), 0.8,
      0, { roughness: 0.94, metalness: 0.15, normalScale: 0.9 },
    );
    this.addBox(
      'platform_decay_patch', 'concrete', 0x5b504d,
      new Vector3(-19.78, 2.55, -29.5), new Vector3(0.035, 2.1, 1.0), 0.7,
      0, { roughness: 0.96, metalness: 0.12, normalScale: 0.95 },
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

  /* --- Grime and dressing ------------------------------------------------ */

  /**
   * Which floor surface lies under a world point.
   *
   * Grime has to inherit the surface it darkens — a tile-textured stain on a
   * concrete floor would read as a decal floating on the wrong material. Rooms
   * are the only authored floor geometry, so anything outside them (the service
   * court, the yard, the forecourt) sits on the exterior asphalt slab.
   */
  private floorSurfaceAt(x: number, z: number): SurfaceId {
    for (const room of ROOMS) {
      if (x >= room.minX && x <= room.maxX && z >= room.minZ && z <= room.maxZ) return room.floor;
    }
    return 'asphalt';
  }

  /**
   * One thin dark overlay pad on the floor.
   *
   * These anchor the traffic paths: a doorway or window approach that stays
   * visibly darker than the surrounding floor tells the player where the horde
   * comes from without a single UI element. The pad is the *existing* surface
   * id crushed to near-black rather than a new material, so it inherits the
   * floor's own texture response and just reads as worn-in dirt. It floats
   * +0.005 above the floor's top face (box spans 0.005–0.015) — close enough
   * that no step is visible, far enough that the shared plane never z-fights.
   */
  private addGrimePad(
    surface: SurfaceId,
    centre: Vector3,
    through: number,
    across: number,
    yaw: number,
  ): void {
    this.addBox(
      `deco_grime_${surface}`,
      surface,
      0x3a3a3a,
      new Vector3(centre.x, 0.01, centre.z),
      new Vector3(through, 0.01, across),
      0.5,
      yaw,
      { normalScale: 0.35 },
    );
  }

  /**
   * Threshold and window grime.
   *
   * Doorway centres mirror the `doorway(...)` holes in WALLS and the window
   * pads mirror BARRIERS. They are deliberately re-stated here instead of being
   * derived at compile time: this pass is purely decorative, and keeping it
   * read-only against the gameplay data means it can never perturb a collider,
   * a nav cell or a spawn — worst case a stain sits in the wrong place.
   */
  private addGrime(): void {
    // [centre x, centre z, through-axis, width of the opening]
    const doorways: [number, number, 'x' | 'z', number][] = [
      [-7, 12, 'x', 2.6], // lobby <-> canteen
      [6, 12, 'x', 2.6], // lobby <-> concourse
      [-0.5, 5, 'z', 4.2], // lobby <-> hall (wide opening)
      [-9, -0.5, 'x', 2.6], // hall <-> plant
      [8, -1, 'x', 2.8], // hall <-> warehouse
      [-17, 5, 'z', 2.6], // canteen <-> plant
      [14, 5, 'z', 2.8], // concourse <-> warehouse
      [24, 12, 'x', 2.8], // concourse <-> yard
      [24, -5.5, 'x', 3.0], // warehouse <-> yard
      [12.5, -16, 'z', 3.0], // warehouse <-> corridor
      [-13, -16, 'z', 3.0], // plant <-> corridor
      [-14, -22, 'z', 3.0], // corridor <-> train shed
      [24, -28, 'x', 3.0], // yard <-> train shed
      [0, -40, 'z', 3.0], // train shed <-> signal box
    ];
    for (const [x, z, axis, w] of doorways) {
      // The strip runs *through* the doorway (both sides of the wall line) and
      // oversails the frame slightly, because feet scuff wider than doors.
      const through = 2.3;
      const across = w + 0.9;
      this.addGrimePad(
        this.floorSurfaceAt(x, z),
        new Vector3(x, 0, z),
        axis === 'x' ? through : across,
        axis === 'x' ? across : through,
        axis === 'x' ? 0 : Math.PI / 2,
      );
    }

    // One dark apron on the room side of every boarded window: zombies pour
    // through these for the whole run, so the approach should look it.
    for (const b of BARRIERS) {
      const dx = b.x - b.spawn[0];
      const dz = b.z - b.spawn[1];
      const len = Math.hypot(dx, dz) || 1;
      const nx = dx / len;
      const nz = dz / len;
      // Local +X is rotated onto the inward direction (atan2(-dz, dx)), so the
      // pad's long axis always lies across the traffic lane regardless of the
      // wall's orientation.
      this.addGrimePad(
        this.floorSurfaceAt(b.x + nx * 1.15, b.z + nz * 1.15),
        new Vector3(b.x + nx * 1.15, 0, b.z + nz * 1.15),
        1.7,
        2.7,
        Math.atan2(-nz, nx),
      );
    }
  }

  /**
   * Purely decorative set dressing: ceiling cable runs with catenary sag and
   * junction boxes, bracketed pipe runs in two corridors, and glossy dark
   * puddle patches near three doorways.
   *
   * Everything here lives in `deco_` buckets, which flushGeometry marks
   * castShadow=false (they hug real surfaces; their shadows would only double
   * shadow the geometry they sit against) but receiveShadow=true. Nothing in
   * this method adds a collider, blocks nav, or touches a spawn — dressing
   * hangs above head height against walls/ceilings or lies 1 cm thick on the
   * floor inside already-walkable space. Total added triangle count is ~2k,
   * well under the 15k budget.
   */
  private addDressing(): void {
    const rng = new Rng(0xd05e5 >>> 0);

    /* Ceiling cable runs: chain that room's fixtures together. Sag follows a
     * parabola (4·s·t·(1−t), max s at midspan) which is visually identical to
     * a catenary at these scales and needs no trig per segment. Segments are
     * short overlapping boxes — one merged batch, trivially cheap, and they
     * catch the lamp light along their length like a real dropped line. */
    const cableChains: { cy: number; pts: [number, number][] }[] = [
      // The three start-adjacent rooms get runs too: they are what every
      // first frame and every early-round screenshot actually looks at.
      { cy: 3.6 - 0.18, pts: [[0, 12], [-3, 17]] }, // lobby
      { cy: 3.9 - 0.18, pts: [[-19, 9], [-12, 15]] }, // canteen
      { cy: 5.6 - 0.18, pts: [[11, 9], [19, 17]] }, // concourse
      { cy: 5.4 - 0.18, pts: [[0, 0], [-6, -4]] }, // hall
      { cy: 6.2 - 0.18, pts: [[16, -2], [13, -13]] }, // warehouse
      { cy: 4.2 - 0.18, pts: [[-16, -6], [-19, -13], [-13, 2]] }, // plant
      { cy: 3.4 - 0.18, pts: [[-14, -19], [0, -19], [14, -19]] }, // service corridor
      { cy: 8.5 - 0.18, pts: [[-10, -25], [10, -25], [14, -37], [-8, -37]] }, // train shed
    ];
    for (const chain of cableChains) {
      for (let p = 0; p < chain.pts.length; p++) {
        const [px, pz] = chain.pts[p];
        // Junction box where each run meets its fixture.
        this.addBox(
          'deco_jbox',
          'gunmetal',
          0x34373a,
          new Vector3(px, chain.cy, pz),
          new Vector3(0.26, 0.16, 0.18),
          0.6,
          rng.range(0, Math.PI),
          { roughness: 0.7, metalness: 0.55 },
        );
        if (p === chain.pts.length - 1) continue;
        const [qx, qz] = chain.pts[p + 1];
        const sx = qx - px;
        const sz = qz - pz;
        const span = Math.hypot(sx, sz);
        const segs = Math.max(4, Math.round(span / 1.2));
        const sag = Math.min(0.45, span * 0.05);
        const yaw = Math.atan2(sx, sz);
        for (let k = 0; k < segs; k++) {
          const t = (k + 0.5) / segs;
          this.addBox(
            'deco_cable',
            'polymer',
            0x17181a,
            new Vector3(px + sx * t, chain.cy - sag * 4 * t * (1 - t), pz + sz * t),
            new Vector3(0.05, 0.05, (span / segs) * 1.25),
            0.4,
            yaw,
          );
        }
      }
    }

    /* Wall pipe runs with brackets. Cylinders are open-ended (the ends die
     * inside walls) and pushed straight into the material bucket — merged with
     * the rest of the run into one draw call. Rotation happens BEFORE
     * translation (geometry ops compose in order), so each run is laid onto
     * its axis first and then moved into place. Straps span both pipes of a
     * run so one small box per bracket sells the whole assembly. */
    const pipeOpts = { roughness: 0.85, metalness: 0.6 };
    // Corridor north wall: a long twin run the player parallels for the whole
    // map's spine.
    for (const [r, y] of [[0.075, 2.58] as const, [0.05, 2.3] as const]) {
      const g = new CylinderGeometry(r, r, 44, 8, 1, true);
      g.rotateZ(Math.PI / 2); // cylinder's Y axis -> X: the run lies along the corridor
      g.translate(0.7, y, -21.64);
      this.bucket('deco_pipe', 'rustedMetal', 0x5a4636, pipeOpts).geos.push(g);
    }
    for (const bx of [-18, -12, -6, 0, 6, 12, 18]) {
      this.addBox(
        'deco_pipe_bracket',
        'rustedMetal',
        0x4c3c2e,
        new Vector3(bx, 2.44, -21.72),
        new Vector3(0.05, 0.44, 0.09),
        0.8,
        0,
        pipeOpts,
      );
    }
    // Hall east wall: a shorter riser run beside the warehouse door.
    for (const [r, y] of [[0.07, 2.75] as const, [0.045, 2.47] as const]) {
      const g = new CylinderGeometry(r, r, 9.4, 8, 1, true);
      g.rotateX(Math.PI / 2); // Y axis -> Z: the run climbs the hall's east wall
      g.translate(7.73, y, -1);
      this.bucket('deco_pipe', 'rustedMetal', 0x5a4636, pipeOpts).geos.push(g);
    }
    for (const bz of [-4, -1, 2]) {
      this.addBox(
        'deco_pipe_bracket',
        'rustedMetal',
        0x4c3c2e,
        new Vector3(7.77, 2.61, bz),
        new Vector3(0.09, 0.42, 0.05),
        0.8,
        0,
        pipeOpts,
      );
    }

    /* Puddle patches: near-black low-roughness quads a hair above the floor.
     * Three overlapping offset lobes per puddle break the perfect-ellipse
     * outline a single quad would give. Placed just inside three high-traffic
     * doorways, entirely within carved walkable space. */
    const puddles: [number, number][] = [
      [-0.3, 6.2], // lobby, by the hall opening
      [6.95, -0.9], // hall, by the warehouse door
      [-13.9, -20.7], // corridor, by the train-shed doorway
    ];
    const lobes: [number, number, number, number, number][] = [
      // [size x, size z, offset x, offset z, extra yaw]
      [1.7, 1.1, 0, 0, 0],
      [0.95, 0.75, 0.45, 0.35, 0.55],
      [0.62, 0.5, -0.4, -0.28, -0.7],
    ];
    for (const [uxp, uzp] of puddles) {
      const baseYaw = rng.range(0, Math.PI);
      for (const [sw, sd, ox, oz, rot] of lobes) {
        const yaw = baseYaw + rot;
        this.addBox(
          'deco_puddle',
          'asphalt',
          0x111315,
          new Vector3(
            uxp + ox * Math.cos(yaw) + oz * Math.sin(yaw),
            0.008,
            uzp - ox * Math.sin(yaw) + oz * Math.cos(yaw),
          ),
          new Vector3(sw, 0.008, sd),
          0.7,
          yaw,
          { roughness: 0.12, metalness: 0.04, normalScale: 0.15 },
        );
      }
    }

    /* Litter, dropped furniture and stored junk — the layer that turns a clean
     * greybox into a place people left in a hurry. Same rules as everything
     * above: deco_ buckets (no shadow casting, no colliders), everything lying
     * flat or leaning flush against a wall inside already-walkable space. */
    const paperTints = [0xcfcabc, 0xbfb49a, 0xd8d2c2];
    // [x, z, yaw] clusters sit beside bins and doorways where pockets would be.
    const papers: [number, number][] = [
      [-6.55, 14.6], [-6.35, 15.15], [-6.6, 9.3], // lobby, west wall by the bins
      [-4.05, -21.45], [-3.35, -21.6], [-4.5, -20.95], // train shed, south wall
      [23.45, 3.25], [23.6, 4.05], // concourse, yard doorway
      [7.4, -2.6], // hall, warehouse door
    ];
    for (const [px, pz] of papers) {
      this.addBox(
        `deco_paper${paperTints.indexOf(paperTints[0]) >= 0 ? '' : ''}`,
        'plaster',
        paperTints[Math.floor(rng.range(0, paperTints.length))],
        new Vector3(px, 0.012, pz),
        new Vector3(0.3, 0.004, 0.42),
        1.6,
        rng.range(0, Math.PI),
        { roughness: 0.9, metalness: 0 },
      );
    }
    // A second sheet per cluster lifted a hair and turned, so pairs read as two
    // sheets rather than one duplicated quad.
    for (const [px, pz] of [[-6.5, 14.85], [-3.75, -21.5], [23.52, 3.65]] as [number, number][]) {
      this.addBox(
        'deco_paper2',
        'plaster',
        0xb9ae92,
        new Vector3(px, 0.02, pz),
        new Vector3(0.28, 0.004, 0.4),
        1.6,
        rng.range(0, Math.PI),
        { roughness: 0.92, metalness: 0 },
      );
    }

    /* Tipped chair, lobby west wall: seat + back + four legs in one rotated
     * group pose — lying on its side, backrest toward the wall. Built from
     * chamfered boxes; total ~120 triangles. */
    {
      const chairYaw = 0.62;
      const chairParts: [number, number, number, number, number, number][] = [
        // [sx, sy, sz, ox, oy, oz] in chair-local space (origin at seat centre)
        [0.42, 0.035, 0.42, 0, 0, 0], // seat
        [0.42, 0.46, 0.035, 0, 0.24, -0.19], // backrest
        [0.032, 0.44, 0.032, -0.17, -0.235, -0.17], // legs
        [0.032, 0.44, 0.032, 0.17, -0.235, -0.17],
        [0.032, 0.44, 0.032, -0.17, -0.235, 0.17],
        [0.032, 0.44, 0.032, 0.17, -0.235, 0.17],
      ];
      const cy = 0.06;
      const cxw = -6.35;
      const czw = 11.1;
      for (const [sx, sy, sz, ox, oy, oz] of chairParts) {
        const rx = ox * Math.cos(chairYaw) + oz * Math.sin(chairYaw);
        const rz = -ox * Math.sin(chairYaw) + oz * Math.cos(chairYaw);
        this.addBox(
          'deco_chair',
          'gunWood',
          0x6b5638,
          new Vector3(cxw + rx, cy + oy, czw + rz),
          new Vector3(sx, sy, sz),
          1.1,
          chairYaw,
          { roughness: 0.8, metalness: 0.02 },
        );
      }
    }

    /* Broom leaning against the hall's west wall beside the plant door:
     * handle tilted into the wall, head block and bristle slab at the foot. */
    {
      const hx = -8.72;
      const hy = 0.72;
      const hz = -3.1;
      const lean = 0.3;
      const handleGeo = new CylinderGeometry(0.013, 0.013, 1.42, 8);
      handleGeo.rotateZ(lean);
      handleGeo.translate(hx, hy, hz);
      this.bucket('deco_broom', 'gunWood', 0x7a6647, { roughness: 0.75, metalness: 0 }).geos.push(handleGeo);
      this.addBox('deco_broom_head', 'gunWood', 0x5c4c33, new Vector3(hx + 0.22, 0.07, hz), new Vector3(0.34, 0.055, 0.075), 1.2, 0, { roughness: 0.8 });
      this.addBox('deco_broom_bristle', 'plaster', 0x9a8a5e, new Vector3(hx + 0.22, 0.028, hz), new Vector3(0.32, 0.05, 0.06), 1.2, 0, { roughness: 0.95 });
    }

    /* Flattened cardboard near the yard door, concourse east wall: two low
     * slabs slightly askew, plus a third folded upright against the wall. */
    for (const [bx, bz, bw, bd, byaw, bh] of [
      [23.5, 5.1, 0.78, 0.55, 0.35, 0.02],
      [23.55, 5.85, 0.7, 0.5, -0.2, 0.016],
    ] as [number, number, number, number, number, number][]) {
      this.addBox(
        'deco_cardboard',
        'plaster',
        0x8a744f,
        new Vector3(bx, 0.012 + bh, bz),
        new Vector3(bw, bh, bd),
        1.3,
        byaw,
        { roughness: 0.88, metalness: 0 },
      );
    }
    this.addBox(
      'deco_cardboard_upright',
      'plaster',
      0x7e6a48,
      new Vector3(23.68, 0.36, 6.6),
      new Vector3(0.04, 0.72, 0.6),
      1.3,
      0.12,
      { roughness: 0.9 },
    );

    /* Wall-base grime skirting: a dark band hugging the floor line of the two
     * walls the camera sees most (hall east, lobby west). Reads as years of
     * mop-avoidance; breaks the wall/floor hard edge the critic flagged. */
    for (const [skx, skz, skl, skyaw] of [
      [6.93, 8, 9, Math.PI / 2],
      [-6.93, 12, 10, Math.PI / 2],
      [-0.2, 4.83, 8, 0],
    ] as [number, number, number, number][]) {
      this.addBox(
        'deco_skirting',
        'paintedMetal',
        0x26282a,
        new Vector3(skx, 0.09, skz),
        new Vector3(skyaw ? 0.035 : skl, 0.18, skyaw ? skl : 0.035),
        0.8,
        0,
        { roughness: 0.85, metalness: 0.1 },
      );
    }
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
