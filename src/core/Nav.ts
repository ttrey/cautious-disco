import { Vector3 } from 'three';

/**
 * Navigation via a flow field.
 *
 * Every zombie in a round wants to reach the same place — the player — so
 * running A* per agent solves the same problem twenty-four times. Instead a
 * single Dijkstra sweep from the player produces a distance field over the
 * whole map, and each zombie just descends the gradient. Cost is O(cells) once
 * per player-cell-change rather than O(agents · path length) every frame, and
 * pathing stays coherent when doors open or barriers go down.
 *
 * The gradient is sampled bilinearly and blended with local separation
 * steering in ZombieManager, which is what stops the horde walking a single
 * grid-aligned line.
 */

const UNREACHABLE = 1e9;

export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  private readonly blocked: Uint8Array;
  /** Extra cost per cell — used to bias zombies through windows and doorways. */
  private readonly cost: Float32Array;
  private readonly dist: Float32Array;
  /** Reused growable work queue; unlike a ring buffer it cannot alias full and empty. */
  private readonly queue: number[] = [];

  /**
   * The seed cells the current field was swept from, as a joined key. A plain
   * cell index was enough while there was only ever one player; with four it
   * has to describe the whole set, or the field silently keeps pointing at
   * wherever the first player was standing when somebody else moved.
   */
  private lastTargetKey = '';
  private readonly seeds: number[] = [];

  constructor(
    readonly originX: number,
    readonly originZ: number,
    width: number,
    depth: number,
    readonly cell: number,
  ) {
    this.cols = Math.ceil(width / cell);
    this.rows = Math.ceil(depth / cell);
    const n = this.cols * this.rows;
    this.blocked = new Uint8Array(n);
    this.cost = new Float32Array(n).fill(1);
    this.dist = new Float32Array(n).fill(UNREACHABLE);
  }

  private index(cx: number, cz: number) {
    return cz * this.cols + cx;
  }

  cellX(worldX: number) {
    return Math.floor((worldX - this.originX) / this.cell);
  }

  cellZ(worldZ: number) {
    return Math.floor((worldZ - this.originZ) / this.cell);
  }

  inBounds(cx: number, cz: number) {
    return cx >= 0 && cz >= 0 && cx < this.cols && cz < this.rows;
  }

  /** Marks an axis-aligned world-space rectangle as blocked or clear. */
  setBox(minX: number, minZ: number, maxX: number, maxZ: number, blocked: boolean) {
    const x0 = Math.max(0, this.cellX(minX));
    const x1 = Math.min(this.cols - 1, this.cellX(maxX));
    const z0 = Math.max(0, this.cellZ(minZ));
    const z1 = Math.min(this.rows - 1, this.cellZ(maxZ));
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) this.blocked[this.index(x, z)] = blocked ? 1 : 0;
    }
    // A geometry change invalidates the field.
    this.lastTargetKey = '';
  }

  /**
   * Nearest open cell to a blocked one, searched outward. Used when a player is
   * standing somewhere the grid calls solid — mid-doorway, or on a prop.
   */
  private nearestOpen(tx: number, tz: number): number {
    let best = -1;
    let bestD = Infinity;
    for (let r = 1; r <= 4 && best < 0; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const cx = tx + dx;
          const cz = tz + dz;
          if (!this.inBounds(cx, cz)) continue;
          const i = this.index(cx, cz);
          if (this.blocked[i]) continue;
          const d = dx * dx + dz * dz;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    return best;
  }

  setCost(minX: number, minZ: number, maxX: number, maxZ: number, value: number) {
    const x0 = Math.max(0, this.cellX(minX));
    const x1 = Math.min(this.cols - 1, this.cellX(maxX));
    const z0 = Math.max(0, this.cellZ(minZ));
    const z1 = Math.min(this.rows - 1, this.cellZ(maxZ));
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) this.cost[this.index(x, z)] = value;
    }
    this.lastTargetKey = '';
  }

  isBlockedWorld(x: number, z: number) {
    const cx = this.cellX(x);
    const cz = this.cellZ(z);
    if (!this.inBounds(cx, cz)) return true;
    return this.blocked[this.index(cx, cz)] === 1;
  }

  /**
   * Recomputes the distance field toward one or more targets. Returns false and
   * skips the work when no target has left its cell and nothing has changed.
   *
   * With several targets this is a *multi-source* sweep: every player's cell is
   * seeded at distance zero in the same pass, so the field that comes out is
   * the distance to the nearest player, and a zombie descending it walks toward
   * whichever of the squad is genuinely closest *through the map* rather than
   * closest as the crow flies. That distinction is the whole reason to do it
   * this way — a teammate three metres away through a wall is not the one to
   * chase, and a Euclidean nearest-player test picks them every time.
   *
   * It also costs exactly what one sweep costs. The alternative, a field per
   * player, would be four sweeps and four times the memory to answer a question
   * this already answers.
   */
  rebuild(target: Vector3 | readonly Vector3[], force = false): boolean {
    const targets = Array.isArray(target) ? target : [target as Vector3];

    this.seeds.length = 0;
    for (const t of targets) {
      const tx = this.cellX(t.x);
      const tz = this.cellZ(t.z);
      if (!this.inBounds(tx, tz)) continue;
      const cell = this.index(tx, tz);
      const seed = this.blocked[cell] ? this.nearestOpen(tx, tz) : cell;
      if (seed >= 0 && !this.seeds.includes(seed)) this.seeds.push(seed);
    }
    if (this.seeds.length === 0) return false;

    // Sorted so that two players swapping places is not treated as a change.
    this.seeds.sort((a, b) => a - b);
    const key = this.seeds.join(',');
    if (!force && key === this.lastTargetKey) return false;
    this.lastTargetKey = key;

    this.dist.fill(UNREACHABLE);

    // Bucket-free Dijkstra: because costs are near-uniform, a simple FIFO sweep
    // with re-relaxation converges in a handful of passes and avoids the
    // allocation churn of a binary heap.
    let head = 0;
    this.queue.length = 0;
    for (const seed of this.seeds) {
      this.dist[seed] = 0;
      this.queue.push(seed);
    }

    while (head < this.queue.length) {
      const current = this.queue[head++];
      const cx = current % this.cols;
      const cz = (current / this.cols) | 0;
      const base = this.dist[current];

      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nx = cx + dx;
          const nz = cz + dz;
          if (!this.inBounds(nx, nz)) continue;
          const ni = this.index(nx, nz);
          if (this.blocked[ni]) continue;
          // Disallow cutting a diagonal between two blocked orthogonals.
          if (dx !== 0 && dz !== 0) {
            if (this.blocked[this.index(cx + dx, cz)] || this.blocked[this.index(cx, cz + dz)]) continue;
          }
          const step = (dx !== 0 && dz !== 0 ? Math.SQRT2 : 1) * this.cost[ni];
          const nd = base + step;
          if (nd < this.dist[ni] - 1e-4) {
            this.dist[ni] = nd;
            this.queue.push(ni);
          }
        }
      }
    }
    return true;
  }

  private distanceAt(cx: number, cz: number): number {
    if (!this.inBounds(cx, cz)) return UNREACHABLE;
    return this.dist[this.index(cx, cz)];
  }

  /** Bilinear sample of the distance field, for a smooth gradient. */
  sampleDistance(x: number, z: number): number {
    const fx = (x - this.originX) / this.cell - 0.5;
    const fz = (z - this.originZ) / this.cell - 0.5;
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const tx = fx - x0;
    const tz = fz - z0;

    const d00 = this.distanceAt(x0, z0);
    const d10 = this.distanceAt(x0 + 1, z0);
    const d01 = this.distanceAt(x0, z0 + 1);
    const d11 = this.distanceAt(x0 + 1, z0 + 1);
    // Any unreachable corner poisons the interpolation, so fall back to the
    // nearest valid sample instead of blending in 1e9.
    if (d00 >= UNREACHABLE || d10 >= UNREACHABLE || d01 >= UNREACHABLE || d11 >= UNREACHABLE) {
      return Math.min(d00, d10, d01, d11);
    }
    const a = d00 + (d10 - d00) * tx;
    const b = d01 + (d11 - d01) * tx;
    return a + (b - a) * tz;
  }

  /**
   * Downhill direction of the distance field at a world position — the
   * direction that makes progress toward the player.
   */
  flow(x: number, z: number, out: Vector3): Vector3 {
    const h = this.cell * 0.9;
    const centre = this.sampleDistance(x, z);
    if (centre >= UNREACHABLE) return out.set(0, 0, 0);

    const dx = this.sampleDistance(x + h, z) - this.sampleDistance(x - h, z);
    const dz = this.sampleDistance(x, z + h) - this.sampleDistance(x, z - h);
    out.set(-dx, 0, -dz);
    const len = out.length();
    if (len < 1e-5) return out.set(0, 0, 0);
    return out.divideScalar(len);
  }

  /** Path cost from a position to the player, in cells. Infinity if cut off. */
  costToTarget(x: number, z: number): number {
    const d = this.sampleDistance(x, z);
    return d >= UNREACHABLE ? Infinity : d * this.cell;
  }
}
