import {
  BufferGeometry,
  CircleGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  LatheGeometry,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector2,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { boxProjectUV, mergeAll } from '../util/geometry';
import { makeSurface, Presets } from '../assets/Materials';

/**
 * Procedural firearm construction.
 *
 * These are the final weapon assets. There is no licensed model library
 * available to this build, so instead of shipping boxes-as-guns, each weapon is
 * assembled from lofted solids, extruded cross-sections and lathed barrels that
 * follow real firearm proportions.
 *
 * Four things do the heavy lifting visually:
 *
 *   1. **Cross-sections, not boxes.** A grip, a stock and a handguard are all
 *      swept solids: a closed outline carried along a path while it changes
 *      size. `loft` and `extrudeZ` build those directly. Stacked boxes cannot
 *      produce a wrist that necks down and a palm swell that comes back out,
 *      which is the single strongest "this is a real object" cue on a firearm.
 *   2. **Parts physically meet.** Every sub-assembly is authored against a
 *      declared bore axis and the neighbouring part's actual surface, so the
 *      barrel lands on the receiver's centreline and the stock's comb runs
 *      where a cheek would sit. Floating or interpenetrating parts are the
 *      loudest tell of programmer art.
 *   3. **Source normals are preserved.** Merging never recomputes normals — a
 *      barrel keeps its smooth shading and a chamfered box keeps the highlight
 *      line along each edge. Recomputing after a non-indexed merge facets
 *      everything, which is what makes procedural guns read as low-poly.
 *   4. **Detail density at the right scale.** Serrations, rail slots, vent
 *      holes, checkering and sights are small enough to read as machining
 *      rather than as geometry.
 *
 * Convention: the weapon is authored muzzle-forward along -Z, +Y up, +X right —
 * the same basis as the camera, so the viewmodel needs no correction rotation.
 * Each weapon declares a bore height and hangs everything off it.
 */

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

/** Chamfered box. The radius is what gives every edge a specular highlight. */
export function box(w: number, h: number, d: number, radius = 0.0025, seg = 2): BufferGeometry {
  const r = Math.min(radius, Math.min(w, h, d) * 0.49);
  return new RoundedBoxGeometry(w, h, d, seg, r);
}

/** Cylinder aligned down the barrel axis (-Z). */
export function barrel(radiusTop: number, radiusBottom: number, length: number, seg = 24): BufferGeometry {
  const g = new CylinderGeometry(radiusTop, radiusBottom, length, seg, 1, false);
  g.rotateX(Math.PI / 2);
  return g;
}

/** Parallel-sided cylinder down the barrel axis. */
export function rod(radius: number, length: number, seg = 20): BufferGeometry {
  return barrel(radius, radius, length, seg);
}

/** Lathed solid of revolution about the barrel axis — muzzle devices, cans. */
export function lathe(profilePts: [number, number][], seg = 24): BufferGeometry {
  const g = new LatheGeometry(
    profilePts.map(([r, z]) => new Vector2(Math.max(r, 0.00001), z)),
    seg,
  );
  g.rotateX(Math.PI / 2);
  return g;
}

/**
 * Extrudes a side-profile (x = along the weapon, y = height) into a solid of
 * the given width, oriented muzzle-forward and centred on X.
 */
export function profile(
  points: [number, number][],
  width: number,
  bevel = 0.0025,
  flip = false,
): BufferGeometry {
  // Reversing a profile must mirror its points, not rotate the finished solid:
  // a rotateY(PI) would swing the extrusion axis onto the weapon's length and
  // collapse the part into a flat plate.
  const pts = flip ? points.map(([x, y]) => [-x, y] as [number, number]).reverse() : points;
  const shape = new Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();

  const bevelled = bevel > 0;
  const g = new ExtrudeGeometry(shape, {
    depth: bevelled ? width - bevel * 2 : width,
    bevelEnabled: bevelled,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 8,
  });
  // With bevelling the solid spans z from -bevel to (depth + bevel), i.e. the
  // full requested width. Centre it, then rotate so +X (forward in profile
  // space) becomes -Z (the muzzle direction) and the width lands on X.
  g.translate(0, 0, -(width / 2 - (bevelled ? bevel : 0)));
  g.rotateY(Math.PI / 2);
  return g;
}

/**
 * Builds a closed outline through `pts` with a fillet at every corner.
 *
 * Cross-sections are authored in the weapon's own X (across) / Y (up) plane and
 * in absolute coordinates, so a handguard outline can be written against the
 * same bore height as the barrel it wraps. Concave corners fillet inward, which
 * is what lets an outline cradle a barrel or bite an ejection port out of a
 * receiver wall.
 */
export function roundedPoly(pts: [number, number][], radius: number | number[] = 0.002): Shape {
  const n = pts.length;
  const at = (i: number) => pts[((i % n) + n) % n];
  const radiusAt = (i: number) => (Array.isArray(radius) ? radius[((i % n) + n) % n] : radius);

  // A fillet may never eat more than half of either edge it sits between, or
  // adjacent fillets on a short edge overlap and the outline self-intersects.
  const filletAt = (i: number) => {
    const a = at(i - 1);
    const b = at(i);
    const c = at(i + 1);
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
    return Math.min(radiusAt(i), l1 * 0.5, l2 * 0.5);
  };

  const entry = (i: number): [number, number] => {
    const a = at(i - 1);
    const b = at(i);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const r = filletAt(i);
    return [b[0] - ((b[0] - a[0]) / len) * r, b[1] - ((b[1] - a[1]) / len) * r];
  };
  const exit = (i: number): [number, number] => {
    const b = at(i);
    const c = at(i + 1);
    const len = Math.hypot(c[0] - b[0], c[1] - b[1]) || 1;
    const r = filletAt(i);
    return [b[0] + ((c[0] - b[0]) / len) * r, b[1] + ((c[1] - b[1]) / len) * r];
  };

  const shape = new Shape();
  const start = exit(0);
  shape.moveTo(start[0], start[1]);
  for (let i = 1; i <= n; i++) {
    const p = entry(i);
    shape.lineTo(p[0], p[1]);
    const v = at(i);
    const e = exit(i);
    shape.quadraticCurveTo(v[0], v[1], e[0], e[1]);
  }
  return shape;
}

/**
 * Bites a rectangular opening out of the right flank of a cross-section — an
 * ejection port, cut for real.
 *
 * This splices into the *already filleted* outline rather than re-running
 * `roundedPoly` over an outline with extra vertices. That matters: the fillet
 * pass clamps each corner to half its shortest neighbouring edge, so adding
 * port vertices halfway up a flank silently shrinks the corner radii above and
 * below them. The port segment then sits proud of the un-notched segments
 * either side of it and the receiver grows a raised boss around the port.
 * Splicing leaves every corner the opening does not touch bit-identical.
 *
 * The opening must lie inside the flank's straight run, between the fillet
 * tangent points — outside it there is no flat wall to cut into.
 */
function notchFlank(base: Shape, yLow: number, yHigh: number, xInner: number, divisions = 8): Shape {
  const pts = base.getPoints(divisions).map((p) => [p.x, p.y] as [number, number]);
  const n = pts.length;
  const cut = pts.map(([x, y]) => x > xInner && y > yLow && y < yHigh);
  if (!cut.some(Boolean)) return base;

  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    if (!cut[i]) {
      out.push(pts[i]);
      continue;
    }
    // Cut points are dropped; the runs they form are replaced by the opening's
    // own corners, snapped to the exact band edges.
    const x = pts[i][0];
    if (!cut[(i - 1 + n) % n]) {
      const edge = pts[(i - 1 + n) % n][1] <= yLow ? yLow : yHigh;
      out.push([x, edge], [xInner, edge]);
    }
    if (!cut[(i + 1) % n]) {
      const edge = pts[(i + 1) % n][1] <= yLow ? yLow : yHigh;
      out.push([xInner, edge], [x, edge]);
    }
  }

  const s = new Shape();
  s.moveTo(out[0][0], out[0][1]);
  for (let i = 1; i < out.length; i++) s.lineTo(out[i][0], out[i][1]);
  s.closePath();
  return s;
}

/** Rounded rectangle cross-section, authored in absolute weapon X/Y. */
export function rrect(w: number, h: number, r: number, cx = 0, cy = 0): Shape {
  return roundedPoly(
    [
      [cx - w / 2, cy - h / 2],
      [cx + w / 2, cy - h / 2],
      [cx + w / 2, cy + h / 2],
      [cx - w / 2, cy + h / 2],
    ],
    r,
  );
}

/**
 * Extrudes an X/Y cross-section along the weapon's length, centred on Z.
 *
 * This is the workhorse: receivers, handguards, magwells and butt pads are all
 * a single outline pushed down the barrel axis, which keeps their silhouette
 * exactly as authored instead of approximating it with a stack of boxes.
 */
export function extrudeZ(shape: Shape, length: number, bevel = 0.0018, curveSegments = 10): BufferGeometry {
  const bevelled = bevel > 0 && length > bevel * 3;
  const g = new ExtrudeGeometry(shape, {
    depth: bevelled ? length - bevel * 2 : length,
    bevelEnabled: bevelled,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments,
  });
  g.translate(0, 0, -(length / 2 - (bevelled ? bevel : 0)));
  return g;
}

/**
 * One station of a lofted solid: a point on the path plus the cross-section
 * carried through it.
 */
export interface LoftSection {
  /** Path position along the weapon. */
  z: number;
  y: number;
  /** Lateral offset of the section centre. */
  x?: number;
  /** Full width, across X. */
  w: number;
  /** Full thickness, along the path normal. */
  h: number;
  /** Superellipse exponent: 2 = ellipse, 4 = rounded rect, 8 = near-square. */
  n?: number;
  /** Shifts the section along its normal — asymmetric swells, palm bulges. */
  offset?: number;
}

function superEllipse(t: number, n: number): [number, number] {
  const c = Math.cos(t);
  const s = Math.sin(t);
  const k = 2 / n;
  return [Math.sign(c) * Math.pow(Math.abs(c), k), Math.sign(s) * Math.pow(Math.abs(s), k)];
}

/**
 * Sweeps a superelliptical cross-section along a path in the weapon's Y/Z
 * plane, interpolating the section's size at every station.
 *
 * The frame is derived from the path tangent, so the same call builds a grip
 * (path running down), a stock (path running back) or a curved magazine (path
 * arcing forward) — and in every case `w` stays the width across the weapon
 * while `h` is the thickness in the direction the hand wraps.
 */
export function loft(sections: LoftSection[], radial = 20, caps = true): BufferGeometry {
  const rows = sections.length;
  const pos: number[] = [];
  const idx: number[] = [];

  // Central-difference tangents; the normal is the tangent turned 90 degrees in
  // the Y/Z plane. Both flip together when the path reverses, so the triangle
  // winding below stays outward-facing for any path direction.
  const normals: [number, number][] = [];
  for (let i = 0; i < rows; i++) {
    const a = sections[Math.max(i - 1, 0)];
    const b = sections[Math.min(i + 1, rows - 1)];
    const ty = b.y - a.y;
    const tz = b.z - a.z;
    const len = Math.hypot(ty, tz) || 1;
    normals.push([tz / len, -ty / len]);
  }

  for (let i = 0; i < rows; i++) {
    const s = sections[i];
    const [ny, nz] = normals[i];
    const n = s.n ?? 4;
    const off = s.offset ?? 0;
    for (let j = 0; j < radial; j++) {
      const [cu, cv] = superEllipse((j / radial) * Math.PI * 2, n);
      const u = cu * s.w * 0.5;
      const v = cv * s.h * 0.5 + off;
      pos.push((s.x ?? 0) + u, s.y + ny * v, s.z + nz * v);
    }
  }

  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const j2 = (j + 1) % radial;
      const a = i * radial + j;
      const b = i * radial + j2;
      const c = (i + 1) * radial + j;
      const d = (i + 1) * radial + j2;
      idx.push(a, b, c, b, d, c);
    }
  }

  if (caps) {
    // Caps get their own copies of the ring so the rim stays a crease rather
    // than being smoothed into the side wall.
    for (const end of [0, rows - 1]) {
      const s = sections[end];
      const base = pos.length / 3;
      pos.push(s.x ?? 0, s.y, s.z);
      for (let j = 0; j < radial; j++) {
        const k = (end * radial + j) * 3;
        pos.push(pos[k], pos[k + 1], pos[k + 2]);
      }
      for (let j = 0; j < radial; j++) {
        const j2 = (j + 1) % radial;
        if (end === 0) idx.push(base, base + 1 + j2, base + 1 + j);
        else idx.push(base, base + 1 + j, base + 1 + j2);
      }
    }
  }

  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Sweeps a constant cross-section along a path — guards, sling loops, wires. */
export function sweep(
  path: [number, number][],
  w: number,
  h: number,
  n = 4,
  radial = 12,
  x = 0,
): BufferGeometry {
  return loft(
    path.map(([z, y]) => ({ z, y, w, h, n, x })),
    radial,
  );
}

/** Samples an arc in the weapon's Z/Y plane — trigger guards, trigger blades. */
export function arcPath(
  cz: number,
  cy: number,
  rz: number,
  ry: number,
  a0: number,
  a1: number,
  steps = 12,
): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    out.push([cz + Math.cos(a) * rz, cy + Math.sin(a) * ry]);
  }
  return out;
}

export function place(
  g: BufferGeometry,
  x = 0,
  y = 0,
  z = 0,
  rx = 0,
  ry = 0,
  rz = 0,
): BufferGeometry {
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

/**
 * Batches geometry by material and merges each bucket into one mesh. A finished
 * rifle is ~150 pieces of geometry but only five draw calls.
 */
export class MeshKit {
  private readonly buckets = new Map<string, { mat: Material; geos: BufferGeometry[] }>();

  add(key: string, mat: Material, ...geos: BufferGeometry[]): this {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { mat, geos: [] };
      this.buckets.set(key, bucket);
    }
    bucket.geos.push(...geos);
    return this;
  }

  /**
   * Merges and appends the result to `parent`.
   *
   * Normals are *not* recomputed. Merging heterogeneous sources flattens them
   * to non-indexed, so a recompute would give every triangle its own face
   * normal — faceting the barrels and erasing the chamfer highlight that the
   * rounded boxes exist to produce. Each source already carries correct
   * normals, and `place` transforms them along with the positions.
   *
   * `uvScale` is texture tiles per metre. Every bucket is re-projected so that
   * a chamfered box, a lathed muzzle device and a lofted grip all end up with
   * the same texel density — without this the sweeps read as flat untextured
   * plastic.
   */
  flushInto(parent: Object3D, castShadow = false, uvScale = 11): Object3D {
    for (const [key, bucket] of this.buckets) {
      if (!bucket.geos.length) continue;
      const merged = mergeAll(bucket.geos);
      if (!merged) continue;
      boxProjectUV(merged, uvScale);
      const mesh = new Mesh(merged, bucket.mat);
      mesh.name = key;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = false;
      parent.add(mesh);
      bucket.geos.forEach((g) => g.dispose());
    }
    this.buckets.clear();
    return parent;
  }
}

/* ------------------------------------------------------------------ */
/* Shared sub-assemblies                                               */
/* ------------------------------------------------------------------ */

/** Picatinny rail: a base with evenly spaced transverse slots. */
function rail(length: number, width: number, zBack: number, y: number): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  out.push(place(box(width, 0.0035, length, 0.0008), 0, y, zBack - length / 2));
  const pitch = 0.0098;
  const count = Math.max(3, Math.floor((length - 0.004) / pitch));
  for (let i = 0; i < count; i++) {
    const z = zBack - 0.006 - i * pitch;
    // Cross-slot ribs sit proud of the base; their chamfer is what catches the
    // rim of light that makes a rail legible at viewmodel distance.
    out.push(place(box(width * 1.0, 0.0042, 0.0058, 0.0009), 0, y + 0.0038, z));
  }
  return out;
}

/**
 * Grasping serrations on the flank of a slide or receiver.
 *
 * Placed per side rather than as full-width bars: a bar that crosses the top of
 * a slide reads as a rack of fins, not as a machined cut.
 */
function serrations(
  count: number,
  spacing: number,
  zBack: number,
  x: number,
  y: number,
  height: number,
  depth = 0.0022,
  tilt = 0.18,
): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    for (const side of [-1, 1]) {
      // Rotate about the piece's own origin first, then position it — the
      // opposite order would swing each cut away from the slide.
      out.push(place(box(depth * 2, height, 0.0026, 0.0007), side * x, y, zBack - i * spacing, tilt));
    }
  }
  return out;
}

/**
 * Checkered panel — a diamond lattice of tiny studs down both flanks of a grip.
 *
 * The stations are given as points on the grip's own path so the panel follows
 * the rake instead of running straight down past the heel: a grid laid out on
 * a fixed axis walks off the back of any grip that is not vertical, and the
 * strays read as debris floating beside the weapon.
 *
 * Studs must also stay small. At 5 mm they read as a waffle iron; real
 * checkering is under 2 mm, which is the scale at which the eye takes it as
 * surface texture rather than as geometry.
 */
function checkering(
  path: [number, number][],
  x: number,
  cols: number,
  pitch: number,
  stud = 0.0026,
): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  path.forEach(([z, y], row) => {
    for (let c = 0; c < cols; c++) {
      // Offset alternate rows so the studs land on a diamond lattice.
      const dz = (c - (cols - 1) / 2 + (row % 2) * 0.5) * pitch;
      for (const side of [-1, 1]) {
        out.push(place(box(0.0016, stud, stud, 0.0004), side * x, y, z + dz, Math.PI / 4));
      }
    }
  });
  return out;
}

/** Cross-drilled pin or screw head, sitting proud of a flank. */
function pin(x: number, y: number, z: number, radius: number, len = 0.0022): BufferGeometry[] {
  return [-1, 1].map((side) =>
    place(barrel(radius, radius, len, 10), side * x, y, z, 0, Math.PI / 2, 0),
  );
}

/**
 * Curved box magazine, swept as one solid.
 *
 * Built as a single lofted body following an arc rather than a stack of rotated
 * boxes — stacked boxes leave a visible staircase down the spine of the
 * magazine no matter how much they overlap.
 */
function curvedMagazine(opts: {
  /** Where the magazine's mouth sits. */
  z: number;
  y: number;
  length: number;
  width: number;
  /** Front-to-back depth at the mouth. */
  depth: number;
  /** Total sweep, radians, positive curls the floorplate forward. */
  curve: number;
  /** Fraction the body narrows toward the floorplate. */
  taper?: number;
}): BufferGeometry[] {
  const steps = 10;
  const taper = opts.taper ?? 0.05;
  const sections: LoftSection[] = [];
  let y = opts.y;
  let z = opts.z;
  let angle = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    sections.push({
      z,
      y,
      w: opts.width * (1 - taper * t),
      h: opts.depth * (1 - taper * t),
      n: 5,
    });
    const step = opts.length / steps;
    y -= step * Math.cos(angle);
    z += step * Math.sin(angle);
    angle += opts.curve / steps;
  }

  const body = loft(sections, 18);

  // Floorplate, seated square on the end of the spine.
  //
  // It has to be carried along the spine's own tangent. Offsetting it on a
  // fixed axis instead leaves it hanging off the back of any magazine with a
  // curve, which is every magazine here.
  const last = sections[sections.length - 1];
  const endAngle = angle - opts.curve / steps;
  const reach = opts.length * 0.028;
  const plate = box(opts.width * 1.14, opts.length * 0.055, opts.depth * 1.1, 0.0016);
  plate.rotateX(-endAngle);
  plate.translate(0, last.y - reach * Math.cos(endAngle), last.z + reach * Math.sin(endAngle));

  // Reinforcing ribs down the flanks: a bare swept box reads as a bar of soap.
  const detail: BufferGeometry[] = [body, plate];
  for (let i = 1; i < steps - 1; i += 2) {
    const s = sections[i];
    for (const side of [-1, 1]) {
      detail.push(
        place(box(0.0018, opts.length / steps, s.h * 0.72, 0.0006), (side * s.w) / 2, s.y, s.z),
      );
    }
  }
  return detail;
}

/**
 * Trigger guard bow: a swept loop from the front strap, round the bottom, to
 * the rear of the trigger housing.
 */
function triggerGuard(
  zFront: number,
  zRear: number,
  yTop: number,
  yBottom: number,
  width: number,
  thickness = 0.0055,
): BufferGeometry {
  const cz = (zFront + zRear) / 2;
  const rz = (zFront - zRear) / 2;
  const ry = yTop - yBottom;
  // Overshoot both ends by a few degrees so the loop buries itself in the
  // receiver instead of stopping flush against it with a visible seam.
  const path = arcPath(cz, yTop, rz, ry, 0.24, -Math.PI - 0.24, 18);
  return sweep(path, width, thickness, 3.2, 12);
}

/**
 * Curved trigger blade hanging inside the guard.
 *
 * `yTop` is the top of the blade — where it disappears into the frame — and the
 * blade hangs *down* from there. The arc it is swept along runs through its
 * upper half only, so the arc's centre has to be dropped by the full radius:
 * centring on `yTop` instead puts the whole blade above the point it was asked
 * to hang from, which buries it in the frame and leaves the guard empty with
 * nothing for a trigger finger to rest on.
 */
const TRIGGER_BLADE_DROP = 0.021;

function triggerBlade(z: number, yTop: number, width = 0.0052): BufferGeometry {
  const path = arcPath(
    z + 0.006,
    yTop - TRIGGER_BLADE_DROP,
    0.009,
    TRIGGER_BLADE_DROP,
    Math.PI * 0.52,
    Math.PI * 0.98,
    8,
  );
  return sweep(path, width, 0.0055, 3, 10);
}

/**
 * Deep bore, so the muzzle reads as a hole rather than a flat disc.
 *
 * Takes the bore height explicitly: every weapon here sits on its own bore
 * axis, and a bore left on the model origin hangs in the air below the muzzle.
 */
function bore(radius: number, y: number, z: number, depth = 0.03): BufferGeometry {
  // `z` is the muzzle face; the shaft runs *back* down the barrel from there.
  // Sinking it forward instead leaves a dark stub hanging in front of the gun.
  return place(barrel(radius, radius, depth, 18), 0, y, z + depth / 2);
}

/* ------------------------------------------------------------------ */
/* Optics                                                              */
/* ------------------------------------------------------------------ */

/**
 * Hollow tube: a lathed annulus rather than a solid cylinder.
 *
 * An optic has to be genuinely open at both ends. The viewmodel is drawn over
 * the world with a cleared depth buffer, so wherever the sight draws nothing
 * the world shows through — and that hole *is* the sight picture. Building a
 * scope body from `rod` or from a `lathe` profile that returns to radius zero
 * caps both ends instead, which puts a solid disc exactly where the target
 * should be: aiming produces a black dot in the middle of the screen.
 *
 * The wall also needs real thickness, or the rim reads as paper when the sight
 * picture is centred on it. Revolving one closed rectangular profile yields the
 * outer wall, the inner wall and both rims together.
 */
export function tube(outerR: number, innerR: number, length: number, seg = 40): BufferGeometry {
  const half = length / 2;
  return lathe(
    [
      [innerR, -half],
      [outerR, -half],
      [outerR, half],
      [innerR, half],
      [innerR, -half],
    ],
    seg,
  );
}

/**
 * Lens glass.
 *
 * Transparent so the world behind it survives, with a tight specular so it
 * reads as a coated element rather than as an open hole. `depthWrite` is off:
 * the reticle sits behind the ocular element and is drawn in the opaque pass,
 * so the lens has to blend over it instead of masking it out.
 */
export function lensGlass(tint = 0x2f4d66, opacity = 0.2): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: tint,
    roughness: 0.05,
    metalness: 0.15,
    transparent: true,
    opacity,
    depthWrite: false,
    envMapIntensity: 2.4,
  });
}

/** Illuminated reticle filament — thin, self-lit, and never a solid disc. */
function reticleMaterial(tint: number, intensity = 2.6): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: tint,
    emissive: tint,
    emissiveIntensity: intensity,
    roughness: 0.35,
    metalness: 0,
    toneMapped: false,
  });
}

/**
 * Matte liner for the inside of an optic.
 *
 * A scope body made from one gunmetal lathe lights its bore as brightly as its
 * exterior, and a chrome tunnel around the sight picture is the one part of an
 * optic nobody has ever seen. Real tubes are blacked and ridged precisely to
 * kill that reflection.
 */
function boreLiner(): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: 0x07080a,
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.05,
  });
}

export interface TelescopicSightOptions {
  /** Height of the optical axis above the weapon origin. */
  y: number;
  /** Rear face of the ocular bell, along the barrel axis. */
  zRear: number;
  /** Ocular face to objective face. */
  length: number;
  /** Main tube outer radius; the bells step out from it. */
  radius: number;
  /** Top of the rail the rings clamp onto — the rings bridge down to it. */
  railY: number;
  /** Positions of the two mount rings along the barrel axis. */
  ringZ: [number, number];
  bodyTint?: number;
  reticleTint?: number;
}

/**
 * Telescopic sight, built so it can actually be looked through.
 *
 * The body is hollow end to end and the rings physically bridge the gap down to
 * the rail — a scope carried on two detached blocks reads as a floating can no
 * matter how well the tube is built.
 *
 * An open tube alone is not a sight picture, though. Looking down one from a
 * realistic eye relief, the far opening subtends a few degrees while the near
 * one subtends twenty: the target ends up as a coin at the end of a long dark
 * tunnel, because a bare tube has no lenses to widen the exit pupil. Real
 * optics solve that with glass; this solves it the way a game can, by showing
 * the *ocular* a separately rendered, magnified view of the world. That mesh is
 * returned rather than merged into the kit so the render target can be bound to
 * it every frame, and it is hidden until the weapon is actually aimed — at the
 * hip the tube is simply open and you see through it.
 */
export function telescopicSight(kit: MeshKit, opts: TelescopicSightOptions): Mesh {
  const { y, zRear, length, radius, railY, ringZ } = opts;
  const body = Presets.gunSteel(opts.bodyTint ?? 0x2a2f37);
  const bright = Presets.brightSteel(0x9aa1ab);
  const glass = lensGlass();
  const reticle = reticleMaterial(opts.reticleTint ?? 0xffb64a, 1.1);

  const wall = radius * 0.22;
  const zFront = zRear - length;
  const ocular = 0.030;
  const objective = 0.036;
  const bellR = radius * 1.55;
  const bellIn = bellR - wall;

  // Main tube plus the two bells. Every one of them is hollow, so the sight
  // line runs from the ocular face clean through to the target.
  //
  // The ocular ends up ~60 mm from the eye at full ADS, close enough that the
  // default cut shows every facet along its rim, so the bells are finer.
  const BELL_SEG = 72;
  kit.add(
    'scopeBody',
    body,
    place(tube(radius, radius - wall, length - ocular - objective), 0, y, (zRear - ocular + zFront + objective) / 2),
    place(tube(bellR, bellIn, ocular, BELL_SEG), 0, y, zRear - ocular / 2),
    place(tube(bellR, bellIn, objective, BELL_SEG), 0, y, zFront + objective / 2),
    // Shoulders closing the step between each bell and the tube.
    // Both profiles advance in the ascending direction required by LatheGeometry;
    // their anchors move to the same ends they occupied before the reflection.
    place(lathe([[radius - wall, 0], [bellR, 0], [bellR, 0.004], [radius - wall, 0.004]], 24), 0, y, zRear - ocular - 0.004),
    place(lathe([[radius - wall, -0.004], [bellR, -0.004], [bellR, 0], [radius - wall, 0]], 24), 0, y, zFront + objective + 0.004),
  );

  // Blacked bore, so the sight picture is not ringed by lit metal.
  kit.add(
    'scopeBore',
    boreLiner(),
    place(tube(radius - wall - 0.0002, radius - wall - 0.0011, length - ocular - objective), 0, y, (zRear - ocular + zFront + objective) / 2),
    place(tube(bellIn - 0.0002, bellIn - 0.0011, ocular, BELL_SEG), 0, y, zRear - ocular / 2),
    place(tube(bellIn - 0.0002, bellIn - 0.0011, objective, BELL_SEG), 0, y, zFront + objective / 2),
  );

  // Elements: one at the ocular, one behind the objective.
  kit.add(
    'scopeGlass',
    glass,
    place(rod(bellIn, 0.0018, 20), 0, y, zRear - 0.0008),
    place(rod(bellIn, 0.0022, 20), 0, y, zFront + objective * 0.55),
  );

  // The sight picture: a disc carrying the magnified view, sunk just inside the
  // ocular rim. Its UVs run 0..1 across the circle's bounding square, which is
  // exactly how a square render target needs to land on it. It is a touch wider
  // than the bore so the cone from the eye through the rim lands entirely on
  // it — undersize it and a lit crescent of tube wall reappears around the edge.
  // `toneMapped` is left on: the texture arrives as linear HDR straight off the
  // scope pass, so this material is where it gets the same ACES curve the rest
  // of the frame goes through. Switching it off leaves the sight picture flat
  // and pale beside the world around the tube.
  const sightPicture = new Mesh(
    new CircleGeometry(bellIn * 1.09, 40),
    new MeshBasicMaterial({ color: 0x000000 }),
  );
  sightPicture.name = 'sightPicture';
  sightPicture.position.set(0, y, zRear - 0.004);
  sightPicture.visible = false;

  // Duplex reticle, sitting between the eye and the sight picture so it reads
  // over the magnified view instead of being hidden behind it.
  const zRet = zRear - 0.0018;
  const postLen = bellIn * 0.5;
  for (const side of [-1, 1]) {
    kit.add(
      'scopeReticle',
      reticle,
      place(box(postLen, 0.0009, 0.0005, 0.0002), side * (bellIn - postLen / 2), y, zRet),
      place(box(0.0009, postLen, 0.0005, 0.0002), 0, y + side * (bellIn - postLen / 2), zRet),
    );
  }
  kit.add(
    'scopeReticle',
    reticle,
    place(box(bellIn * 2, 0.00045, 0.0004, 0.00015), 0, y, zRet),
    place(box(0.00045, bellIn * 2, 0.0004, 0.00015), 0, y, zRet),
  );

  // Rings: a split collar around the tube on a base that reaches the rail. The
  // base is sized from the actual gap so the assembly stays closed if the
  // scope height is ever retuned.
  const gap = Math.max(y - radius - railY, 0.001);
  for (const z of ringZ) {
    kit.add(
      'scopeRing',
      body,
      place(tube(radius + 0.006, radius - 0.0005, 0.017), 0, y, z),
      place(box(0.026, gap + 0.006, 0.017, 0.002), 0, y - radius - gap / 2 + 0.002, z),
      place(box(0.034, 0.006, 0.019, 0.0015), 0, railY + 0.001, z),
    );
    kit.add('scopeRing', bright, ...pin(radius + 0.0035, y - radius * 0.55, z, 0.0026, 0.0024));
  }

  // Windage and elevation turrets, capped.
  kit.add(
    'scopeBody',
    body,
    place(rod(0.0095, 0.014, 16), 0, y + radius + 0.007, ringZ[1] + 0.030, Math.PI / 2, 0, 0),
    place(rod(0.0095, 0.014, 16), radius + 0.007, y, ringZ[1] + 0.030, 0, Math.PI / 2, 0),
  );

  return sightPicture;
}

export interface ReflexSightOptions {
  /** Height of the aiming dot — this is the weapon's sight line. */
  y: number;
  /** Centre of the housing along the barrel axis. */
  z: number;
  /** Height of the surface the housing is mounted on. */
  baseY: number;
  width?: number;
  dotTint?: number;
  frameTint?: number;
}

/**
 * Compact reflex sight: an open hood carrying one canted element and a
 * projected dot.
 *
 * A reflex is the honest answer for a weapon whose barrel assembly sits above
 * the bore line — the sight picture is the world itself, seen past a pane, so
 * nothing about the host weapon's shape can occlude it. Irons on the same
 * weapons put the sight line straight through a coil cage and a receiver deck.
 */
export function reflexSight(kit: MeshKit, opts: ReflexSightOptions) {
  const { y, z, baseY } = opts;
  const w = opts.width ?? 0.034;
  const frame = Presets.gunSteel(opts.frameTint ?? 0x22262d);
  const glass = lensGlass(0x38607a, 0.16);
  const dot = reticleMaterial(opts.dotTint ?? 0xff5a3c);

  const hoodTop = y + 0.019;
  const deck = Math.min(baseY, y - 0.018);
  const hoodH = hoodTop - deck;

  // Base and side walls only: the window between them is deliberately empty.
  kit.add(
    'sightFrame',
    frame,
    place(box(w + 0.008, Math.max(baseY - deck, 0) + 0.008, 0.044, 0.0022), 0, deck - 0.002, z),
    place(box(w + 0.008, 0.005, 0.040, 0.0018), 0, hoodTop, z - 0.002),
  );
  for (const side of [-1, 1]) {
    kit.add(
      'sightFrame',
      frame,
      place(box(0.004, hoodH, 0.042, 0.0016), (side * (w + 0.004)) / 2, deck + hoodH / 2, z),
    );
  }

  // The element leans back toward the eye, which is what puts the emitter's
  // reflection on the shooter's axis rather than on the hood.
  kit.add(
    'sightGlass',
    glass,
    place(box(w - 0.002, hoodH - 0.008, 0.0016, 0.0004), 0, y + 0.001, z - 0.009, -0.22),
  );
  kit.add('sightDot', dot, place(new SphereGeometry(0.0019, 10, 8), 0, y, z - 0.009));
  // Emitter housing under the front lip, aimed up at the element.
  kit.add('sightFrame', frame, place(box(0.011, 0.007, 0.012, 0.0012), 0, deck + 0.005, z + 0.014));
}

/* ------------------------------------------------------------------ */
/* Weapon model contract                                               */
/* ------------------------------------------------------------------ */

export interface GunModel {
  root: Group;
  /** Muzzle tip — flash, smoke and tracer origin. */
  muzzle: Object3D;
  /** Shell ejection point, on the right side of the receiver. */
  ejectPort: Object3D;
  /** Reciprocating mass (slide / bolt carrier / pump). Animated on fire. */
  slide: Object3D | null;
  /** Detachable magazine or belt box, animated during reload. */
  magazine: Object3D | null;
  /** Hinged feed cover, used by belt-fed reload choreography. */
  feedCover?: Object3D | null;
  /** Charging handle, animated on the reload cycle. */
  charging: Object3D | null;
  /** Trigger, pulled on fire. */
  trigger: Object3D | null;
  /**
   * Disc at an optic's ocular that carries the magnified view of the world.
   * Present only on weapons with a telescopic sight; the viewmodel binds a
   * render target to it while aiming and hides it the rest of the time.
   */
  sightPicture?: Mesh | null;
  /**
   * Local-space offset that, when negated and applied to the viewmodel root,
   * puts the sight line on the camera axis. Tuned per weapon.
   */
  sightHeight: number;
  /**
   * Negated model-space Z of the rear sighting element — the aperture, the
   * notch, the ocular lens or the emitter dot, whichever the shooter's eye
   * lines up behind. Paired with the definition's `adsDistance` (the eye
   * relief) it puts that element exactly where the aiming eye expects it, and
   * keeps the two halves of the ADS pose independently meaningful: the model
   * owns where its sight is, the definition owns how far back the eye sits.
   */
  sightForward: number;
}

function marker(name: string, x: number, y: number, z: number): Object3D {
  const o = new Object3D();
  o.name = name;
  o.position.set(x, y, z);
  return o;
}

/* ------------------------------------------------------------------ */
/* M9-pattern service pistol                                           */
/* ------------------------------------------------------------------ */

export function buildPistol(): GunModel {
  const root = new Group();
  const steel = Presets.gunSteel();
  const bright = Presets.brightSteel();
  const poly = Presets.gunPolymer();
  const dark = Presets.gunSteel(0x161616);

  // Bore on the weapon's own zero; everything else is measured off it.
  const BORE = 0.0;
  const SLIDE_W = 0.027;
  const SLIDE_TOP = BORE + 0.0175;
  const SLIDE_BOT = BORE - 0.0125;
  const SLIDE_MID = (SLIDE_TOP + SLIDE_BOT) / 2;
  const SLIDE_H = SLIDE_TOP - SLIDE_BOT;

  /* --- Slide -----------------------------------------------------------
   *
   * Open-topped, the way the M9's is: the barrel is exposed between a solid
   * breech block at the rear and a muzzle block at the front, tied together by
   * two side rails and a bridge under the barrel. Building the cut-out for
   * real rather than painting a dark stripe on a closed box is what makes the
   * silhouette recognisable from any angle.
   */
  const slide = new Group();
  slide.name = 'slide';
  const sk = new MeshKit();

  const BREECH_BACK = 0.056;
  const BREECH_FRONT = -0.014;
  const PORT_FRONT = -0.096;
  const MUZZLE_BLOCK = -0.138;

  const slideSection = (w: number) => rrect(w, SLIDE_H, 0.0055, 0, SLIDE_MID);
  sk.add(
    'steel',
    steel,
    place(extrudeZ(slideSection(SLIDE_W), BREECH_BACK - BREECH_FRONT), 0, 0, (BREECH_BACK + BREECH_FRONT) / 2),
    place(extrudeZ(slideSection(SLIDE_W), PORT_FRONT - MUZZLE_BLOCK), 0, 0, (PORT_FRONT + MUZZLE_BLOCK) / 2),
  );
  // Side walls and the bridge under the barrel, spanning the open section.
  //
  // The walls run the slide's *full* height. Cutting them down to the barrel's
  // centreline instead — on the reasoning that anything taller would close the
  // top back over the barrel — takes the upper half of the slide away for 82 mm
  // of its 194 mm length, and the silhouette reads as a rectangular bite out of
  // the slide just behind the muzzle rather than as a machined port.
  //
  // Nothing is closed over by keeping them tall: the open top is the 18 mm slot
  // *between* the walls, which is wider than the 14.8 mm barrel. That is how the
  // real pattern is built — thin full-height walls either side of an open slot.
  const openLen = BREECH_FRONT - PORT_FRONT;
  const openMid = (BREECH_FRONT + PORT_FRONT) / 2;
  const WALL_W = 0.0045;
  for (const side of [-1, 1]) {
    sk.add(
      'steel',
      steel,
      place(
        extrudeZ(
          rrect(WALL_W, SLIDE_H, 0.0018, (side * (SLIDE_W - WALL_W)) / 2, SLIDE_MID),
          openLen,
        ),
        0,
        0,
        openMid,
      ),
    );
  }
  sk.add(
    'steel',
    steel,
    place(extrudeZ(rrect(0.021, 0.009, 0.003, 0, SLIDE_BOT + 0.0045), openLen), 0, 0, openMid),
  );

  // Grasping serrations, rear block and front cocking cuts.
  sk.add(
    'steel',
    steel,
    ...serrations(8, 0.0068, 0.048, SLIDE_W / 2 - 0.0004, SLIDE_MID + 0.001, SLIDE_H * 0.72, 0.0022, 0.2),
    ...serrations(4, 0.0068, -0.104, SLIDE_W / 2 - 0.0004, SLIDE_MID + 0.001, SLIDE_H * 0.72, 0.0022, 0.2),
  );
  // Extractor, right side of the breech.
  sk.add('bright', bright, place(box(0.0035, 0.0075, 0.026, 0.0009), 0.0128, BORE + 0.006, 0.006));
  // Rear sight dovetail with a notch, front blade on the muzzle block.
  sk.add('steel', steel, place(box(0.020, 0.0075, 0.008, 0.0012), 0, SLIDE_TOP + 0.003, 0.046));
  sk.add('dark', dark, place(box(0.0032, 0.006, 0.009, 0.0004), 0, SLIDE_TOP + 0.0045, 0.046));
  sk.add('bright', bright, place(box(0.0032, 0.0072, 0.0042, 0.0006), 0, SLIDE_TOP + 0.0032, -0.130));
  // Front dot.
  sk.add('dot', Presets.gunPolymer(0xf2f2e6), place(new SphereGeometry(0.0011, 8, 6), 0, SLIDE_TOP + 0.0052, -0.1322));

  // Safety / decocking lever on both flanks of the breech.
  for (const side of [-1, 1]) {
    sk.add(
      'bright',
      bright,
      place(box(0.0042, 0.0085, 0.020, 0.0016), side * (SLIDE_W / 2 + 0.0006), BORE + 0.0075, 0.036),
      place(barrel(0.0042, 0.0042, 0.004, 10), side * (SLIDE_W / 2 + 0.0006), BORE + 0.0075, 0.026, 0, Math.PI / 2, 0),
    );
  }

  // Barrel through the open top, protruding at the muzzle, plus the crown.
  sk.add('bright', bright, place(rod(0.0074, 0.196, 22), 0, BORE + 0.0022, -0.046));
  sk.add(
    'bright',
    bright,
    place(
      lathe(
        [
          [0.0, 0.0],
          [0.0074, 0.0],
          [0.0082, 0.0022],
          [0.0082, 0.008],
          [0.0, 0.008],
        ],
        18,
      ),
      0,
      BORE + 0.0022,
      -0.152,
    ),
  );
  sk.add('dark', dark, bore(0.0046, BORE + 0.0022, -0.1452, 0.026));
  // Locking block lug under the chamber.
  sk.add('bright', bright, place(box(0.014, 0.010, 0.03, 0.0015), 0, BORE - 0.010, -0.02));
  sk.flushInto(slide, true);
  root.add(slide);

  /* --- Frame -----------------------------------------------------------
   *
   * The frame is authored as one continuous chain: dust cover under the slide,
   * trigger housing, then a lofted grip that rakes back and swells into the
   * palm. Authoring the grip as a loft is the whole reason it reads as a grip
   * rather than as a plank — the cross-section necks at the wrist under the
   * beavertail and comes back out at the heel.
   */
  const frame = new Group();
  const fk = new MeshKit();

  // Dust cover with an accessory rail beneath it.
  fk.add(
    'poly',
    poly,
    place(extrudeZ(rrect(0.0235, 0.0165, 0.003, 0, BORE - 0.0205), 0.088), 0, 0, -0.054),
    place(extrudeZ(rrect(0.0165, 0.0062, 0.0012, 0, BORE - 0.0315), 0.05), 0, 0, -0.064),
  );
  for (let i = 0; i < 3; i++) {
    fk.add('poly', poly, place(box(0.019, 0.0045, 0.0035, 0.0008), 0, BORE - 0.030, -0.048 - i * 0.0125));
  }

  // Trigger housing / frame body under the breech.
  fk.add(
    'poly',
    poly,
    place(extrudeZ(rrect(0.0265, 0.021, 0.004, 0, BORE - 0.0225), 0.072), 0, 0, 0.020),
  );

  // Grip. Path rakes back 14 degrees; `h` is the front-to-back depth, which is
  // what the hand actually closes around.
  const gripSections: LoftSection[] = [
    { z: 0.0300, y: BORE - 0.0250, w: 0.0290, h: 0.0500, n: 4.2 },
    { z: 0.0345, y: BORE - 0.0420, w: 0.0320, h: 0.0480, n: 4.4 },
    { z: 0.0395, y: BORE - 0.0620, w: 0.0334, h: 0.0450, n: 4.6 },
    { z: 0.0450, y: BORE - 0.0840, w: 0.0326, h: 0.0420, n: 4.6 },
    { z: 0.0495, y: BORE - 0.1010, w: 0.0310, h: 0.0400, n: 4.8 },
    { z: 0.0520, y: BORE - 0.1090, w: 0.0300, h: 0.0392, n: 5.0 },
  ];
  fk.add('poly', poly, loft(gripSections, 24));
  // Beavertail sweeping up behind the hammer.
  fk.add(
    'poly',
    poly,
    place(box(0.0225, 0.011, 0.030, 0.0045), 0, BORE - 0.0215, 0.0605, -0.22),
  );

  // Checkered side panels, on stations sampled from the grip path above.
  fk.add(
    'panel',
    Presets.gunPolymer(0x36373a),
    ...checkering(
      [
        [0.0355, BORE - 0.0450],
        [0.0385, BORE - 0.0575],
        [0.0417, BORE - 0.0700],
        [0.0447, BORE - 0.0825],
        [0.0475, BORE - 0.0950],
      ],
      0.0160,
      4,
      0.0082,
      0.0028,
    ),
  );
  // Front-strap grooving, following the grip's forward face.
  for (let i = 0; i < 6; i++) {
    fk.add(
      'poly',
      poly,
      place(box(0.020, 0.0030, 0.0026, 0.0007), 0, BORE - 0.040 - i * 0.0104, 0.0148 + i * 0.0022),
    );
  }

  // Trigger guard, undercut at the front for a high grip.
  fk.add('poly', poly, triggerGuard(-0.006, 0.028, BORE - 0.028, BORE - 0.0555, 0.0245, 0.0062));

  // Controls: magazine release, slide stop, takedown lever.
  fk.add('bright', bright, place(barrel(0.0048, 0.0048, 0.0055, 12), 0.0145, BORE - 0.032, 0.018, 0, Math.PI / 2, 0));
  fk.add('bright', bright, place(box(0.0038, 0.008, 0.026, 0.0012), -0.0145, BORE - 0.016, 0.010));
  fk.add('bright', bright, place(barrel(0.0055, 0.0055, 0.0042, 12), -0.0145, BORE - 0.0165, -0.014, 0, Math.PI / 2, 0));
  fk.add('bright', bright, ...pin(0.0135, BORE - 0.021, 0.0345, 0.0022));

  // Hammer spur, standing proud behind the slide.
  fk.add('bright', bright, place(box(0.0075, 0.019, 0.0075, 0.0022), 0, BORE + 0.002, 0.0645, 0.36));
  fk.flushInto(frame, true);
  root.add(frame);

  /* --- Magazine --------------------------------------------------------
   * Only the floorplate and a sliver of the body show; the rest fills the
   * grip, so the body is lofted to the grip's own inner section.
   */
  const magazine = new Group();
  magazine.name = 'magazine';
  new MeshKit()
    .add(
      'mag',
      Presets.gunSteel(0x8d8f94),
      loft(
        [
          { z: 0.0320, y: BORE - 0.0280, w: 0.0200, h: 0.0360, n: 5 },
          { z: 0.0440, y: BORE - 0.0820, w: 0.0200, h: 0.0345, n: 5 },
          { z: 0.0510, y: BORE - 0.1120, w: 0.0198, h: 0.0335, n: 5 },
        ],
        16,
      ),
    )
    .add(
      'mag',
      Presets.gunPolymer(0x2b2c2f),
      place(box(0.0252, 0.0072, 0.0396, 0.0016), 0, BORE - 0.1148, 0.0518, -0.24),
    )
    .flushInto(magazine);
  root.add(magazine);

  /* --- Trigger ---------------------------------------------------------- */
  const trigger = new Group();
  trigger.name = 'trigger';
  new MeshKit()
    .add('bright', bright, place(triggerBlade(0.008, BORE - 0.0265), 0, 0, 0))
    .flushInto(trigger);
  root.add(trigger);

  root.add(marker('muzzle', 0, BORE + 0.0022, -0.152));
  root.add(marker('eject', 0.016, BORE + 0.010, -0.03));

  return {
    root,
    muzzle: root.getObjectByName('muzzle')!,
    ejectPort: root.getObjectByName('eject')!,
    slide,
    magazine,
    charging: null,
    trigger,
    // The sight line runs through the floor of the rear notch and the tip of
    // the front blade, not over the top of the slide.
    sightHeight: SLIDE_TOP + 0.0040,
    sightForward: -0.046,
  };
}

/* ------------------------------------------------------------------ */
/* MP5-pattern SMG                                                     */
/* ------------------------------------------------------------------ */

export function buildSmg(): GunModel {
  const root = new Group();
  const steel = Presets.gunSteel();
  const bright = Presets.brightSteel();
  const poly = Presets.gunPolymer();
  const dark = Presets.gunSteel(0x151515);

  const BORE = 0.004;
  const body = new Group();
  const kit = new MeshKit();

  /* --- Receiver --------------------------------------------------------
   *
   * Stamped steel: a round-shouldered tube, not a slab, with the cocking tube
   * welded along the upper left. Their overlap is the MP5's whole read from
   * the front, so the tube is placed to actually intersect the receiver rather
   * than to float beside it.
   */
  const RECV_BACK = 0.078;
  const RECV_FRONT = -0.112;
  const recvSection = (scale = 1) => rrect(0.0375 * scale, 0.0425 * scale, 0.0125 * scale, 0, BORE - 0.0015);

  // Split around the ejection port so the port is a genuine opening: the
  // middle segment's outline takes a bite out of the right flank.
  const PORT_BACK = 0.020;
  const PORT_FRONT = -0.030;
  const portSection = notchFlank(recvSection(), BORE - 0.0100, BORE + 0.0070, 0.0075);
  kit.add(
    'steel',
    steel,
    place(extrudeZ(recvSection(), RECV_BACK - PORT_BACK), 0, 0, (RECV_BACK + PORT_BACK) / 2),
    place(extrudeZ(portSection, PORT_BACK - PORT_FRONT, 0.0012), 0, 0, (PORT_BACK + PORT_FRONT) / 2),
    place(extrudeZ(recvSection(), PORT_FRONT - RECV_FRONT), 0, 0, (PORT_FRONT + RECV_FRONT) / 2),
  );
  // Bolt face visible in the port.
  kit.add('bright', bright, place(box(0.010, 0.020, 0.042, 0.0018), 0.0085, BORE - 0.001, -0.004));

  // Cocking tube along the upper left, ending in the classic forward dogleg.
  kit.add('steel', steel, place(rod(0.0108, 0.190, 18), -0.0182, BORE + 0.0175, -0.108));
  kit.add(
    'steel',
    steel,
    place(box(0.0225, 0.0155, 0.030, 0.005), -0.0205, BORE + 0.0175, -0.196, 0, 0, 0),
  );
  // Weld seam / receiver ribs.
  for (const z of [0.05, -0.06]) {
    kit.add('steel', steel, place(extrudeZ(recvSection(1.045), 0.006, 0.0012), 0, 0, z));
  }

  /* --- Handguard ------------------------------------------------------- */
  kit.add(
    'poly',
    poly,
    loft(
      [
        { z: -0.112, y: BORE - 0.006, w: 0.0400, h: 0.0430, n: 4.4 },
        { z: -0.150, y: BORE - 0.007, w: 0.0420, h: 0.0440, n: 4.2 },
        { z: -0.200, y: BORE - 0.007, w: 0.0410, h: 0.0430, n: 4.2 },
        { z: -0.238, y: BORE - 0.005, w: 0.0350, h: 0.0380, n: 4.6 },
      ],
      22,
    ),
  );
  // Finger grooves along the underside.
  for (let i = 0; i < 5; i++) {
    kit.add('poly', poly, place(box(0.0325, 0.0038, 0.0075, 0.0012), 0, BORE - 0.0265, -0.132 - i * 0.0195));
  }
  // Sling loop under the front of the handguard.
  kit.add('steel', steel, place(new TorusGeometry(0.0072, 0.0018, 8, 16), 0, BORE - 0.026, -0.234, 0, Math.PI / 2, 0));

  /* --- Barrel and muzzle ----------------------------------------------- */
  kit.add('bright', bright, place(rod(0.0088, 0.070, 20), 0, BORE, -0.246));
  kit.add(
    'steel',
    steel,
    place(
      lathe(
        [
          [0.0, 0.0],
          [0.0088, 0.0],
          [0.0125, 0.003],
          [0.0125, 0.020],
          [0.0105, 0.024],
          [0.0, 0.024],
        ],
        20,
      ),
      0,
      BORE,
      -0.282,
    ),
  );
  // Three-lug adapter lugs.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    kit.add(
      'steel',
      steel,
      place(box(0.0055, 0.0055, 0.010, 0.0012), Math.cos(a) * 0.0115, BORE + Math.sin(a) * 0.0115, -0.266),
    );
  }
  kit.add('dark', dark, bore(0.0052, BORE, -0.2825, 0.028));

  /* --- Sights ----------------------------------------------------------
   * A hooded front post and a rotary rear drum: the MP5's signature.
   *
   * Both are built around one sight line at BORE + 35.5 mm — the front post's
   * tip and the rear drum's aperture have to agree on it or aiming down the
   * irons shows the post floating well below the notch.
   */
  const SIGHT_Y = BORE + 0.0355;
  kit.add('steel', steel, place(box(0.020, 0.014, 0.014, 0.003), 0, BORE + 0.0165, -0.222));
  kit.add('steel', steel, place(new TorusGeometry(0.0112, 0.0021, 8, 20), 0, SIGHT_Y - 0.0030, -0.222));
  kit.add('bright', bright, place(box(0.0026, 0.0135, 0.0032, 0.0005), 0, SIGHT_Y - 0.0068, -0.222));
  kit.add('steel', steel, place(box(0.014, 0.0175, 0.022, 0.003), 0, BORE + 0.0225, 0.034));
  kit.add('steel', steel, place(barrel(0.0138, 0.0138, 0.0195, 16), 0, SIGHT_Y, 0.034, 0, 0, Math.PI / 2));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    kit.add(
      'steel',
      steel,
      place(box(0.021, 0.0055, 0.0055, 0.0012), 0, SIGHT_Y + Math.sin(a) * 0.0125, 0.034 + Math.cos(a) * 0.0125),
    );
  }
  kit.add('dark', dark, place(tube(0.0030, 0.0016, 0.008, 16), 0, SIGHT_Y, 0.030));

  /* --- Grip and trigger group ------------------------------------------ */
  kit.add(
    'poly',
    poly,
    place(extrudeZ(rrect(0.0300, 0.0230, 0.005, 0, BORE - 0.0335), 0.100), 0, 0, 0.026),
  );
  kit.add(
    'poly',
    poly,
    loft(
      [
        { z: 0.0540, y: BORE - 0.0330, w: 0.0300, h: 0.0470, n: 4.2 },
        { z: 0.0600, y: BORE - 0.0520, w: 0.0320, h: 0.0450, n: 4.4 },
        { z: 0.0670, y: BORE - 0.0740, w: 0.0328, h: 0.0420, n: 4.6 },
        { z: 0.0740, y: BORE - 0.0960, w: 0.0310, h: 0.0390, n: 4.8 },
        { z: 0.0775, y: BORE - 0.1070, w: 0.0296, h: 0.0378, n: 5.0 },
      ],
      24,
    ),
  );
  kit.add(
    'panel',
    Presets.gunPolymer(0x303134),
    ...checkering(
      [
        [0.0590, BORE - 0.0490],
        [0.0625, BORE - 0.0620],
        [0.0662, BORE - 0.0750],
        [0.0700, BORE - 0.0880],
        [0.0735, BORE - 0.1000],
      ],
      0.0158,
      4,
      0.0084,
      0.0028,
    ),
  );
  kit.add('poly', poly, triggerGuard(0.018, 0.056, BORE - 0.0340, BORE - 0.0640, 0.0265, 0.0060));
  // Fire selector, both sides.
  kit.add('bright', bright, ...pin(0.0163, BORE - 0.0300, 0.0490, 0.0068, 0.0035));
  for (const side of [-1, 1]) {
    kit.add('bright', bright, place(box(0.0035, 0.0075, 0.0195, 0.0012), side * 0.0172, BORE - 0.0300, 0.0570));
  }
  kit.add('bright', bright, ...pin(0.0155, BORE - 0.0235, -0.0060, 0.0028));

  /* --- Retractable stock ----------------------------------------------- */
  for (const side of [-1, 1]) {
    kit.add('steel', steel, place(rod(0.0058, 0.126, 14), side * 0.0158, BORE + 0.0055, 0.140));
  }
  kit.add('steel', steel, place(extrudeZ(rrect(0.042, 0.020, 0.006, 0, BORE + 0.0055), 0.014), 0, 0, 0.086));
  kit.add(
    'poly',
    poly,
    place(extrudeZ(rrect(0.0355, 0.0480, 0.008, 0, BORE + 0.0035), 0.0140), 0, 0, 0.197),
  );
  kit.add(
    'rubber',
    Presets.rubber(),
    place(extrudeZ(rrect(0.0375, 0.0510, 0.009, 0, BORE + 0.0035), 0.0095), 0, 0, 0.2088),
  );

  kit.flushInto(body, true);
  root.add(body);

  /* --- Magazine --------------------------------------------------------- */
  const magazine = new Group();
  magazine.name = 'magazine';
  new MeshKit()
    .add(
      'mag',
      Presets.gunSteel(0x7f8187),
      // Curls toward the muzzle: a box magazine's concave face points forward,
      // and a rearward curl reads as the magazine being in backwards.
      ...curvedMagazine({
        z: -0.042,
        y: BORE - 0.020,
        length: 0.126,
        width: 0.0230,
        depth: 0.0330,
        curve: -0.30,
        taper: 0.06,
      }),
    )
    .flushInto(magazine);
  root.add(magazine);

  /* --- Cocking handle --------------------------------------------------- */
  const charging = new Group();
  charging.name = 'charging';
  new MeshKit()
    .add(
      'bright',
      bright,
      place(box(0.0295, 0.0125, 0.0170, 0.0032), -0.0325, BORE + 0.0175, -0.196),
      place(box(0.0130, 0.0110, 0.0110, 0.0026), -0.0245, BORE + 0.0175, -0.204),
    )
    .flushInto(charging);
  root.add(charging);

  const trigger = new Group();
  trigger.name = 'trigger';
  new MeshKit()
    .add('bright', bright, place(triggerBlade(0.030, BORE - 0.0345), 0, 0, 0))
    .flushInto(trigger);
  root.add(trigger);

  root.add(marker('muzzle', 0, BORE, -0.288));
  root.add(marker('eject', 0.024, BORE + 0.002, -0.006));

  return {
    root,
    muzzle: root.getObjectByName('muzzle')!,
    ejectPort: root.getObjectByName('eject')!,
    slide: charging,
    magazine,
    charging,
    trigger,
    sightHeight: SIGHT_Y,
    sightForward: -0.034,
  };
}

/* ------------------------------------------------------------------ */
/* AR-pattern assault rifle                                            */
/* ------------------------------------------------------------------ */

export function buildRifle(): GunModel {
  const root = new Group();
  const steel = Presets.gunSteel();
  const bright = Presets.brightSteel();
  const poly = Presets.gunPolymer();
  const dark = Presets.gunSteel(0x141414);
  const body = new Group();
  const kit = new MeshKit();

  const BORE = 0.008;

  /* --- Upper receiver ---------------------------------------------------
   * A flat-top: round shoulders rising to a flat rail platform. Authored as a
   * cross-section so the shoulders stay round down the whole length instead of
   * being approximated by a chamfered box.
   */
  const UPPER_BACK = 0.072;
  const UPPER_FRONT = -0.100;
  // Flanks run vertical almost to the top so there is a straight wall tall
  // enough to cut the ejection port into; the shoulders then break inward to
  // the rail platform.
  const upperOutline: [number, number][] = [
    [-0.0190, BORE - 0.0180],
    [0.0190, BORE - 0.0180],
    [0.0190, BORE + 0.0110],
    [0.0120, BORE + 0.0195],
    [-0.0120, BORE + 0.0195],
    [-0.0190, BORE + 0.0110],
  ];
  const upperSection = roundedPoly(upperOutline, [0.005, 0.005, 0.006, 0.004, 0.004, 0.006]);

  // Ejection port: a real opening bitten out of the right flank.
  const PORT_BACK = 0.028;
  const PORT_FRONT = -0.020;
  const portSection = notchFlank(upperSection, BORE - 0.0120, BORE + 0.0040, 0.0075);

  kit.add(
    'poly',
    poly,
    place(extrudeZ(upperSection, UPPER_BACK - PORT_BACK), 0, 0, (UPPER_BACK + PORT_BACK) / 2),
    place(extrudeZ(portSection, PORT_BACK - PORT_FRONT, 0.0012), 0, 0, (PORT_BACK + PORT_FRONT) / 2),
    place(extrudeZ(upperSection, PORT_FRONT - UPPER_FRONT), 0, 0, (PORT_FRONT + UPPER_FRONT) / 2),
  );
  kit.add('poly', poly, ...rail(UPPER_BACK - UPPER_FRONT - 0.006, 0.0215, UPPER_BACK - 0.003, BORE + 0.0205));

  // Brass deflector and forward assist on the right, behind the port.
  kit.add('poly', poly, place(box(0.0125, 0.0165, 0.0245, 0.005), 0.0205, BORE + 0.0055, 0.0135));
  kit.add('poly', poly, place(barrel(0.0072, 0.0072, 0.0165, 12), 0.0215, BORE - 0.0045, 0.0225, 0, Math.PI / 2, 0));
  kit.add('bright', bright, place(barrel(0.0045, 0.0045, 0.0055, 10), 0.0300, BORE - 0.0045, 0.0225, 0, Math.PI / 2, 0));
  // Ejection port cover, hinged shut below the opening.
  kit.add('steel', steel, place(box(0.0040, 0.0150, 0.0430, 0.0014), 0.0192, BORE - 0.0190, 0.0035));
  // Charging-handle raceway shroud at the tail.
  kit.add('poly', poly, place(box(0.0300, 0.0100, 0.0180, 0.0028), 0, BORE + 0.0175, 0.0665));

  /* --- Lower receiver --------------------------------------------------- */
  kit.add(
    'poly',
    poly,
    place(
      profile(
        [
          [0.0, 0.0],
          [0.128, 0.0],
          [0.128, -0.026],
          [0.096, -0.030],
          [0.090, -0.060],
          [0.040, -0.064],
          [0.036, -0.028],
          [0.0, -0.024],
        ],
        0.0300,
        0.0028,
      ),
      0,
      BORE - 0.0170,
      0.0620,
    ),
  );
  // Flared lip on the bottom of the magazine well. One piece at the mouth: two
  // stacked collars partway up the well read as shelves bolted to the outside
  // of the receiver rather than as a funnel cut into its end.
  kit.add(
    'poly',
    poly,
    place(
      extrudeZ(
        roundedPoly(
          [
            [-0.0188, BORE - 0.0800],
            [0.0188, BORE - 0.0800],
            [0.0158, BORE - 0.0680],
            [-0.0158, BORE - 0.0680],
          ],
          0.0030,
        ),
        0.0470,
      ),
      0,
      0,
      -0.0030,
    ),
  );
  // Takedown pins.
  kit.add('bright', bright, ...pin(0.0158, BORE - 0.0230, 0.0620, 0.0042));
  kit.add('bright', bright, ...pin(0.0158, BORE - 0.0230, -0.0125, 0.0042));
  // Magazine release and bolt catch.
  kit.add('bright', bright, place(barrel(0.0055, 0.0055, 0.0060, 12), 0.0175, BORE - 0.0245, 0.0195, 0, Math.PI / 2, 0));
  kit.add('bright', bright, place(box(0.0040, 0.0180, 0.0230, 0.0014), -0.0172, BORE - 0.0230, 0.0135));
  // Safety selector.
  kit.add('bright', bright, ...pin(0.0158, BORE - 0.0195, 0.0525, 0.0058, 0.0032));
  for (const side of [-1, 1]) {
    kit.add('bright', bright, place(box(0.0034, 0.0068, 0.0185, 0.0011), side * 0.0170, BORE - 0.0195, 0.0605));
  }

  kit.add('poly', poly, triggerGuard(0.0130, 0.0520, BORE - 0.0300, BORE - 0.0610, 0.0270, 0.0058));

  /* --- Receiver extension and pistol grip -------------------------------
   *
   * The grip's top section is 45 mm front-to-back and rakes back, so a good
   * third of it sits behind the lower receiver's rear face. On a real AR that
   * space is the receiver extension the buffer tube screws into; without it
   * modelled the grip's tang hangs in open air behind the gun.
   */
  kit.add('poly', poly, place(box(0.0300, 0.0420, 0.0330, 0.0045), 0, BORE - 0.0045, 0.0730));

  // A2 grip: raked 21 degrees, with a finger swell at the front and a flared
  // base the palm sits into.
  kit.add(
    'poly',
    poly,
    loft(
      [
        { z: 0.0570, y: BORE - 0.0270, w: 0.0300, h: 0.0450, n: 4.0 },
        { z: 0.0645, y: BORE - 0.0460, w: 0.0330, h: 0.0440, n: 4.3 },
        { z: 0.0730, y: BORE - 0.0680, w: 0.0340, h: 0.0415 , n: 4.5 },
        { z: 0.0820, y: BORE - 0.0900, w: 0.0322, h: 0.0390, n: 4.7 },
        { z: 0.0878, y: BORE - 0.1030, w: 0.0305, h: 0.0378, n: 5.0 },
        { z: 0.0902, y: BORE - 0.1090, w: 0.0330, h: 0.0400, n: 5.0 },
      ],
      24,
    ),
  );
  kit.add(
    'panel',
    Presets.gunPolymer(0x2f3033),
    ...checkering(
      [
        [0.0660, BORE - 0.0490],
        [0.0700, BORE - 0.0620],
        [0.0742, BORE - 0.0750],
        [0.0784, BORE - 0.0880],
        [0.0820, BORE - 0.1000],
      ],
      0.0163,
      4,
      0.0086,
      0.0029,
    ),
  );
  // Finger swell on the front strap.
  kit.add('poly', poly, place(box(0.0270, 0.0300, 0.0080, 0.0035), 0, BORE - 0.0540, 0.0435, -0.30));

  /* --- Free-float handguard ---------------------------------------------
   * Octagonal M-LOK tube: flats read as machined aluminium where a rounded box
   * reads as moulded plastic.
   */
  const HG_BACK = -0.100;
  const HG_FRONT = -0.262;
  const oct = (s: number): [number, number][] => {
    const pts: [number, number][] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      pts.push([Math.cos(a) * 0.0232 * s, BORE + 0.0015 + Math.sin(a) * 0.0238 * s]);
    }
    return pts;
  };
  kit.add(
    'poly',
    poly,
    place(extrudeZ(roundedPoly(oct(1), 0.0032), HG_BACK - HG_FRONT), 0, 0, (HG_BACK + HG_FRONT) / 2),
  );
  // Barrel-nut collar where the handguard clamps to the upper.
  kit.add('poly', poly, place(extrudeZ(roundedPoly(oct(1.09), 0.004), 0.016), 0, 0, -0.104));
  // M-LOK slots at 3, 6 and 9 o'clock.
  for (let i = 0; i < 6; i++) {
    const z = -0.128 - i * 0.0225;
    for (const side of [-1, 1]) {
      kit.add('dark', dark, place(box(0.0055, 0.0110, 0.0155, 0.0022), side * 0.0212, BORE + 0.0018, z));
    }
    kit.add('dark', dark, place(box(0.0135, 0.0055, 0.0155, 0.0022), 0, BORE - 0.0205, z));
  }
  kit.add('poly', poly, ...rail(0.150, 0.0215, HG_BACK - 0.004, BORE + 0.0205));

  /* --- Barrel, gas system and muzzle device ----------------------------- */
  kit.add('bright', bright, place(rod(0.0092, 0.060, 20), 0, BORE, -0.126));
  kit.add('bright', bright, place(rod(0.0072, 0.180, 20), 0, BORE, -0.242));
  // Low-profile gas block plus the gas tube running back over the barrel.
  kit.add('steel', steel, place(extrudeZ(rrect(0.0175, 0.0230, 0.0030, 0, BORE + 0.0030), 0.0240), 0, 0, -0.2735));
  kit.add('bright', bright, place(rod(0.0026, 0.150, 10), 0, BORE + 0.0138, -0.204));
  // A2 birdcage.
  kit.add(
    'steel',
    steel,
    place(
      lathe(
        [
          [0.0, 0.0],
          [0.0072, 0.0],
          [0.0098, 0.0035],
          [0.0102, 0.0300],
          [0.0125, 0.0330],
          [0.0125, 0.0390],
          [0.0, 0.0390],
        ],
        20,
      ),
      0,
      BORE,
      -0.3530,
    ),
  );
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2 + 0.6;
    kit.add(
      'dark',
      dark,
      place(box(0.0042, 0.0042, 0.0230, 0.0010), Math.cos(a) * 0.0092, BORE + Math.sin(a) * 0.0092, -0.3305),
    );
  }
  kit.add('dark', dark, bore(0.0052, BORE, -0.3535, 0.030));

  /* --- Buffer tube and collapsible stock -------------------------------- */
  kit.add('steel', steel, place(rod(0.0152, 0.160, 20), 0, BORE + 0.0045, 0.1480));
  kit.add('steel', steel, place(box(0.0330, 0.0135, 0.0170, 0.0035), 0, BORE - 0.0060, 0.0790));
  kit.add(
    'poly',
    poly,
    loft(
      [
        { z: 0.0980, y: BORE + 0.0040, w: 0.0355, h: 0.0430, n: 4.2 },
        { z: 0.1350, y: BORE + 0.0025, w: 0.0390, h: 0.0470, n: 4.2 },
        { z: 0.1800, y: BORE - 0.0010, w: 0.0420, h: 0.0540, n: 4.2 },
        { z: 0.2180, y: BORE - 0.0040, w: 0.0430, h: 0.0610, n: 4.4 },
      ],
      22,
    ),
  );
  // Cheek weld ridge and the sling slot at the toe.
  kit.add('poly', poly, place(box(0.0430, 0.0080, 0.0900, 0.0030), 0, BORE + 0.0230, 0.1650));
  kit.add('dark', dark, place(box(0.0180, 0.0090, 0.0260, 0.0025), 0, BORE - 0.0270, 0.2050));
  kit.add(
    'rubber',
    Presets.rubber(),
    place(extrudeZ(rrect(0.0445, 0.0640, 0.0090, 0, BORE - 0.0045), 0.0120), 0, 0, 0.2285),
  );
  // Stock release lever under the buffer tube.
  kit.add('poly', poly, place(box(0.0135, 0.0230, 0.0180, 0.0035), 0, BORE - 0.0165, 0.1290, 0.25));

  /* --- Flip-up iron sights ----------------------------------------------
   * The aperture is a `tube`, not a disc: a peep sight is defined by the hole
   * through it, and a solid cylinder with a ring around it presents the aiming
   * eye with a dark plug where the target should be.
   *
   * Front post tip and rear aperture share one height, so the post sits
   * centred in the ring instead of riding above it.
   */
  const SIGHT_Y = BORE + 0.0390;
  kit.add('steel', steel, place(box(0.0165, 0.0195, 0.0075, 0.0018), 0, BORE + 0.0300, -0.1560));
  kit.add('steel', steel, place(new TorusGeometry(0.0070, 0.0016, 8, 16), 0, SIGHT_Y - 0.0010, -0.1560));
  kit.add('bright', bright, place(box(0.0026, 0.0125, 0.0038, 0.0005), 0, SIGHT_Y - 0.0062, -0.1560));
  kit.add('steel', steel, place(box(0.0245, 0.0175, 0.0090, 0.0020), 0, BORE + 0.0310, 0.0400));
  kit.add('dark', dark, place(tube(0.0044, 0.0024, 0.0100, 20), 0, SIGHT_Y, 0.0400));
  kit.add('steel', steel, place(new TorusGeometry(0.0058, 0.0016, 8, 16), 0, SIGHT_Y, 0.0400));

  kit.flushInto(body, true);
  root.add(body);

  /* --- STANAG magazine --------------------------------------------------- */
  const magazine = new Group();
  magazine.name = 'magazine';
  new MeshKit()
    .add(
      'mag',
      Presets.gunPolymer(0x3b3e36),
      ...curvedMagazine({
        z: -0.0060,
        y: BORE - 0.0480,
        length: 0.1350,
        width: 0.0245,
        depth: 0.0320,
        curve: -0.34,
        taper: 0.04,
      }),
    )
    .flushInto(magazine);
  root.add(magazine);

  /* --- Charging handle ---------------------------------------------------- */
  const charging = new Group();
  charging.name = 'charging';
  new MeshKit()
    .add(
      'steel',
      steel,
      place(box(0.0480, 0.0075, 0.0170, 0.0020), 0, BORE + 0.0215, 0.0755),
      place(box(0.0140, 0.0090, 0.0280, 0.0020), 0, BORE + 0.0215, 0.0685),
    )
    .add('bright', bright, place(box(0.0140, 0.0055, 0.0090, 0.0014), -0.0140, BORE + 0.0215, 0.0790))
    .flushInto(charging);
  root.add(charging);

  // Bolt carrier proxy — a small visible shift inside the ejection port.
  const slide = new Group();
  slide.name = 'slide';
  new MeshKit()
    .add('bright', bright, place(box(0.0165, 0.0200, 0.0480, 0.0022), 0.0035, BORE - 0.0010, 0.0040))
    .flushInto(slide);
  root.add(slide);

  const trigger = new Group();
  trigger.name = 'trigger';
  new MeshKit()
    .add('bright', bright, place(triggerBlade(0.0250, BORE - 0.0305), 0, 0, 0))
    .flushInto(trigger);
  root.add(trigger);

  root.add(marker('muzzle', 0, BORE, -0.358));
  root.add(marker('eject', 0.026, BORE + 0.004, 0.004));

  return {
    root,
    muzzle: root.getObjectByName('muzzle')!,
    ejectPort: root.getObjectByName('eject')!,
    slide,
    magazine,
    charging,
    trigger,
    sightHeight: SIGHT_Y,
    sightForward: -0.040,
  };
}

/* ------------------------------------------------------------------ */
/* FN SCAR-H battle rifle                                              */
/* ------------------------------------------------------------------ */

/**
 * FN SCAR-H (Mk 17).
 *
 * Every dimension below is read off a side-on photograph of a real Mk 17 rather
 * than recalled, on one scale: 0.812 mm per reference pixel, fixed by two
 * absolute checks that agree — the magazine is 87 mm front-to-back (a 7.62 NATO
 * round is 71 mm long) and rail-top to magazine-floor is 214 mm against a
 * published 216 mm.
 *
 * Those proportions *are* the identity, and they are not an M4's:
 *
 *   - The bore sits low in a tall monolithic upper, so the receiver deck stands
 *     48 mm over the barrel — 12 mm higher than an AR flat-top — and the folding
 *     irons on top of it are higher still. Get this wrong and no amount of tan
 *     paint reads as a SCAR.
 *   - The top rail is one unbroken 430 mm run from the stock hinge to the gas
 *     block. It is the longest straight line on the weapon and the eye finds it
 *     first.
 *   - The polymer lower is a shallow 25 mm tray slung under all that, which is
 *     what makes the receiver look top-heavy and the magazine look long.
 *   - The stock is a solid slab, not a skeleton: its underside runs dead level
 *     forward from a very deep butt, then the top steps down over the comb.
 *
 * The 20-round 7.62 magazine is near enough straight, the charging handle rides
 * a long slot on the left flank, and the ejection port is cut through the right.
 */
export function buildScar(): GunModel {
  const root = new Group();
  // Anodised FDE over aluminium for the upper, warmer polymer for the furniture:
  // on the real rifle the two are visibly different materials, and matching them
  // is what flattens the whole weapon into one tan extrusion.
  //
  // Low metalness on purpose. This receiver has to read *light*, and it is mostly
  // flat vertical flank; at high metalness a flat panel has no diffuse term and
  // reflects the backdrop, which in a night level is nothing, so the whole
  // monolithic upper — the part that carries the weapon's identity — goes black
  // at exactly the grazing angles the viewmodel shows it at.
  const upper = makeSurface('gunmetal', {
    repeat: 1,
    tint: 0xd8caa4,
    roughness: 0.8,
    metalness: 0.15,
    normalScale: 0.5,
  });
  const polymer = Presets.gunPolymer(0xa1916b);
  const polymerDark = Presets.gunPolymer(0x5e5744);
  const bright = Presets.brightSteel(0xc7cbd0);
  // Two greys, because they do different jobs. `steel` is the parkerised
  // furniture — sights, muzzle brake, controls. The gunmetal albedo is only
  // ~0.26, and at full metalness that albedo times the tint *is* the
  // reflectance, so tinting toward a true black-oxide value buys nothing but a
  // black hole; the sights especially are thin plates whose whole job is to be
  // legible edge-on, and the lighting is what darkens them. `dark` is for
  // openings — slots, vents and the bore — where being a hole is the point.
  const steel = Presets.brightSteel(0xb6bcc3);
  const dark = Presets.gunSteel(0x111316);
  const rubber = Presets.rubber(0x151719);
  const body = new Group();
  const kit = new MeshKit();

  const BORE = 0.015;

  /* --- Stations, all measured off the reference ------------------------ */
  const Z_BUTT = 0.324;
  const Z_PAD_FACE = 0.3094;
  const Z_COMB_BACK = 0.3050;
  const Z_COMB_FRONT = 0.2030;
  const Z_HINGE = 0.0739;
  const Z_RX_BACK = 0.0707;
  const Z_REAR_SIGHT = 0.0536;
  const Z_MAG_BACK = -0.0641;
  const Z_MAG_FRONT = -0.1559;
  const Z_LOWER_FRONT = -0.1591;
  const Z_RAIL_FRONT = -0.3597;
  const Z_GAS_BACK = -0.3621;
  const Z_FRONT_SIGHT = -0.3800;
  const Z_GAS_FRONT = -0.4084;
  const Z_BARREL_END = -0.5651;
  const Z_MUZZLE = -0.6163;

  const Y_DECK = 0.0629;
  const Y_SEAM = 0.0;
  const Y_LOWER_BOT = -0.0248;
  const Y_HG_BOT = -0.0094;
  const RAIL_Y = 0.0646;
  const SIGHT_Y = 0.0990;

  // Half-widths, and the wall each one actually presents. `extrudeZ` inflates a
  // cross-section outward by its bevel in X and Y as well as along Z, so a flank
  // detail placed at the authored half-width is sunk *inside* the part and
  // simply never appears. Every slot, rail and pin below is placed against these
  // wall constants instead.
  const UPPER_HW = 0.0240;
  const UPPER_BEVEL = 0.0018;
  const UPPER_WALL = UPPER_HW + UPPER_BEVEL;
  const HG_HW = 0.0240;
  const HG_BEVEL = 0.0022;
  const HG_WALL = HG_HW + HG_BEVEL;
  const LOWER_HW = 0.0232;
  const LOWER_WALL = LOWER_HW + 0.0018;

  /* --- Monolithic upper receiver --------------------------------------- */
  // The flank steps inward twice on the way up — a full-width lower band, a
  // narrower band above it, then a chamfer under the rail. A single slab of the
  // same width reads as a box; the two step lines are what catch the light and
  // give the receiver its machined-from-billet look at viewmodel size.
  const upperCrown: [number, number][] = [
    [0.0212, 0.0424],
    [0.0212, 0.0566],
    [0.0152, Y_DECK],
    [-0.0152, Y_DECK],
    [-0.0212, 0.0566],
    [-0.0212, 0.0424],
  ];
  const crownRadii = [0.0015, 0.0015, 0.002, 0.002, 0.0015, 0.0015];
  const upperSection = roundedPoly(
    [[-UPPER_HW, Y_SEAM], [UPPER_HW, Y_SEAM], [UPPER_HW, 0.0376], ...upperCrown, [-UPPER_HW, 0.0376]],
    [0.004, 0.004, 0.003, ...crownRadii, 0.003],
  );
  kit.add(
    'upper',
    upper,
    place(extrudeZ(upperSection, Z_RX_BACK - Z_LOWER_FRONT), 0, 0, (Z_RX_BACK + Z_LOWER_FRONT) / 2),
  );

  /* --- Handguard, one casting with the receiver -------------------------- */
  // The top face and both step lines carry straight through; only the underside
  // drops, and it does so exactly where the polymer lower ends. Breaking the top
  // line here is what makes a SCAR look like an AR upper with a rail tube
  // bolted on the front, and leaving the underside stepped back from the lower
  // opens a notch under the ejection port that nothing on the real rifle has.
  const hgSection = roundedPoly(
    [[-HG_HW, Y_HG_BOT], [HG_HW, Y_HG_BOT], [HG_HW, 0.0376], ...upperCrown, [-HG_HW, 0.0376]],
    [0.005, 0.005, 0.003, ...crownRadii, 0.003],
  );
  const PORT_BACK = -0.1591;
  const PORT_FRONT = -0.2100;
  const portSection = notchFlank(hgSection, 0.0060, 0.0285, 0.0186);
  kit.add(
    'upper',
    upper,
    place(extrudeZ(portSection, PORT_BACK - PORT_FRONT, HG_BEVEL), 0, 0, (PORT_BACK + PORT_FRONT) / 2),
    place(extrudeZ(hgSection, PORT_FRONT - Z_GAS_BACK, HG_BEVEL), 0, 0, (PORT_FRONT + Z_GAS_BACK) / 2),
  );
  // Barrel extension on the bore axis behind the opening, in a dark chamber, so
  // the port has depth instead of reading as a painted black stripe.
  kit.add('dark', dark, place(box(0.0300, 0.0250, 0.0480, 0.0020), 0.0060, BORE + 0.0010, -0.1970));
  kit.add('bright', bright, place(rod(0.0122, 0.0620, 16), 0, BORE, -0.1970));
  // Brass deflector: a small wedge just behind the port, and one of the few
  // shapes that says "right side of a modern rifle" on its own.
  kit.add('upper', upper, place(box(0.0100, 0.0190, 0.0200, 0.0030), HG_WALL, 0.0175, -0.1480, 0, 0, 0.42));
  // Charging-handle raceway, sunk into the left flank.
  kit.add('vent', dark, place(box(0.0050, 0.0155, 0.1320, 0.0012), -(UPPER_WALL - 0.0012), 0.0110, -0.0960));
  // Bolt catch paddle at the back of the raceway.
  kit.add('steel', steel, place(box(0.0060, 0.0190, 0.0150, 0.0020), -(UPPER_WALL + 0.0018), 0.0090, -0.0245, 0, 0, -0.45));
  // Cooling slots, in the narrow band of bare wall the side rail leaves above
  // itself — the rail occupies y 0.005–0.025 and the flank tops out at 0.038, so
  // a taller slot both overlaps the rail and breaks the handguard's top edge.
  // Nothing along the belly: the six o'clock rail covers that whole run.
  for (let i = 0; i < 5; i++) {
    const z = -0.2420 - i * 0.0245;
    for (const s of [-1, 1]) {
      kit.add('vent', dark, place(box(0.0050, 0.0090, 0.0135, 0.0009), s * HG_WALL, 0.0310, z));
    }
  }
  kit.add('bright', bright, ...pin(HG_WALL, 0.0310, -0.2180, 0.0038, 0.0026));
  kit.add('bright', bright, ...pin(HG_WALL, 0.0310, -0.3480, 0.0038, 0.0026));

  /* --- Rails: one long deck rail, plus accessory rails on the handguard -- */
  kit.add('upper', upper, ...rail(Z_HINGE - Z_RAIL_FRONT - 0.005, 0.0212, 0.0698, RAIL_Y));
  // Six o'clock rail, built the same way and rolled over: the support hand and
  // any light or grip live on it, so it has to be real geometry, not a stripe.
  kit.add(
    'upper',
    upper,
    // Runs from the magwell out to the gas block, as the reference does — the
    // support hand grips it at 245 mm, which is inside that span.
    ...rail(0.2000, 0.0206, -0.1620, 0.0098).map((g) => place(g, 0, 0, 0, 0, 0, Math.PI)),
  );
  // Three and nine o'clock rails. Rolling `rail` a quarter turn puts its slots
  // on the flank; the lift afterwards is applied post-rotation, so it stays a
  // height in weapon Y rather than becoming a lateral offset.
  for (const s of [-1, 1]) {
    kit.add(
      'upper',
      upper,
      ...rail(0.1120, 0.0206, -0.2320, HG_WALL + 0.00175).map((g) => place(g, 0, 0.0150, 0, 0, 0, s * Math.PI * 0.5)),
    );
  }

  /* --- Polymer lower: a shallow tray under all that receiver ------------ */
  kit.add(
    'polymer',
    polymer,
    place(
      extrudeZ(rrect(LOWER_HW * 2, Y_SEAM - Y_LOWER_BOT, 0.005, 0, (Y_SEAM + Y_LOWER_BOT) / 2), Z_HINGE - Z_LOWER_FRONT),
      0,
      0,
      (Z_HINGE + Z_LOWER_FRONT) / 2,
    ),
  );
  // Magazine well: a slightly proud collar the magazine disappears into.
  kit.add(
    'polymer',
    polymer,
    place(
      extrudeZ(rrect(0.0400, 0.0130, 0.004, 0, -0.0270), Z_MAG_BACK - Z_MAG_FRONT),
      0,
      0,
      (Z_MAG_BACK + Z_MAG_FRONT) / 2,
    ),
  );
  // The guard is integral with the lower and gloved-hand sized, so its bar is a
  // 9 mm section rather than the wire hoop a thinner sweep reads as edge-on.
  kit.add('polymer', polymer, triggerGuard(-0.0633, -0.0138, Y_LOWER_BOT, -0.0670, 0.0290, 0.0088));

  // Ambidextrous fire selector, magazine release and bolt catch.
  for (const s of [-1, 1]) {
    kit.add('bright', bright, place(barrel(0.0050, 0.0050, 0.0060, 12), s * LOWER_WALL, -0.0075, 0.0035, 0, Math.PI / 2, 0));
    kit.add('bright', bright, place(box(0.0055, 0.0140, 0.0230, 0.0015), s * (LOWER_WALL + 0.0016), -0.0090, -0.0010, s * 0.5));
    kit.add('steel', steel, place(box(0.0050, 0.0125, 0.0125, 0.0018), s * (LOWER_WALL + 0.0012), -0.0105, -0.0585));
  }
  kit.add('bright', bright, ...pin(LOWER_WALL, -0.0060, 0.0605, 0.0048, 0.0032));
  kit.add('bright', bright, ...pin(LOWER_WALL, -0.0060, -0.1330, 0.0048, 0.0032));

  /* --- Pistol grip ------------------------------------------------------ */
  // Raked well back: butt-face to grip puts the length of pull at 340 mm, and a
  // grip crowded up against the magwell is the single quickest way to make a
  // battle rifle read as a carbine.
  kit.add(
    'polymer',
    polymer,
    loft(
      [
        { z: 0.0090, y: -0.0210, w: 0.0326, h: 0.0470, n: 4.0 },
        { z: 0.0240, y: -0.0530, w: 0.0344, h: 0.0450, n: 4.4 },
        { z: 0.0395, y: -0.0830, w: 0.0344, h: 0.0450, n: 4.6 },
        { z: 0.0530, y: -0.1100, w: 0.0334, h: 0.0492, n: 4.8 },
        { z: 0.0602, y: -0.1265, w: 0.0350, h: 0.0545, n: 5.4 },
        { z: 0.0625, y: -0.1330, w: 0.0356, h: 0.0552, n: 5.6 },
      ],
      24,
    ),
  );
  kit.add(
    'gripPanel',
    polymerDark,
    ...checkering(
      [
        [0.0235, -0.0520],
        [0.0310, -0.0670],
        [0.0385, -0.0820],
        [0.0460, -0.0970],
      ],
      0.0172,
      5,
      0.0084,
      0.0026,
    ),
  );

  /* --- Folding stock ---------------------------------------------------- */
  // Solid slab, not a skeleton frame. The line that matters is the underside:
  // it runs dead level forward from a butt 140 mm deep, then the top steps down
  // over the comb. Read those two edges wrong and the rifle grows an M4 tube.
  kit.add(
    'polymer',
    polymer,
    profile(
      (
        [
          [Z_PAD_FACE, 0.0330],
          [Z_COMB_FRONT, 0.0330],
          [0.1990, 0.0588],
          [0.1210, 0.0597],
          [0.0763, 0.0710],
          [Z_HINGE, 0.0540],
          [Z_HINGE, Y_LOWER_BOT],
          [0.2010, -0.0224],
          [0.2347, -0.0215],
          [0.2509, -0.0402],
          [0.2672, -0.0686],
          [0.2834, -0.0954],
          [Z_PAD_FACE, -0.1027],
        ] as [number, number][]
      ).map(([z, y]) => [-z, y] as [number, number]),
      0.0420,
      0.0035,
    ),
  );
  // Adjustable comb, sitting proud of the stock body on both flanks.
  kit.add(
    'polymer',
    polymer,
    place(
      extrudeZ(rrect(0.0456, 0.0088, 0.0030, 0, 0.0364), Z_COMB_BACK - Z_COMB_FRONT),
      0,
      0,
      (Z_COMB_BACK + Z_COMB_FRONT) / 2,
    ),
  );
  kit.add('polymerDark', polymerDark, place(box(0.0472, 0.0035, 0.0620, 0.0010), 0, 0.0300, 0.2650));
  // Rubber butt pad with its recoil grooves.
  kit.add(
    'rubber',
    rubber,
    place(extrudeZ(rrect(0.0470, 0.1430, 0.0090, 0, -0.0313), Z_BUTT - Z_PAD_FACE), 0, 0, (Z_BUTT + Z_PAD_FACE) / 2),
  );
  for (const y of [-0.0790, -0.0930]) {
    kit.add('vent', dark, place(box(0.0506, 0.0035, 0.0060, 0.0008), 0, y, 0.3170));
  }
  // Hinge knuckle on the left flank — the stock folds to that side.
  kit.add('bright', bright, place(barrel(0.0088, 0.0088, 0.0300, 14), -0.0195, 0.0250, 0.0770, Math.PI / 2, 0, 0));
  kit.add('bright', bright, ...pin(0.0210, 0.0300, 0.1520, 0.0045, 0.0028));
  // Sling loop through the toe of the stock.
  kit.add('steel', steel, place(new TorusGeometry(0.0090, 0.0022, 6, 12), -0.0215, -0.0620, 0.2760, 0, Math.PI / 2, 0));

  /* --- Barrel, gas block and muzzle brake -------------------------------- */
  const BARREL_BACK = -0.3300;
  kit.add(
    'bright',
    bright,
    place(barrel(0.0088, 0.0098, BARREL_BACK - Z_BARREL_END, 22), 0, BORE, (BARREL_BACK + Z_BARREL_END) / 2),
  );
  // The gas block is a tall stepped tower that fills the gap between the end of
  // the handguard and the barrel, and carries the front sight. On an AR that
  // area is a thin tube; on a SCAR it is a block nearly as tall as the receiver,
  // which is most of why the front half looks so much heavier.
  const gasSection = (top: number) =>
    roundedPoly(
      [
        [-0.0150, 0.0030],
        [0.0150, 0.0030],
        [0.0150, 0.0330],
        [0.0112, 0.0400],
        [0.0112, top],
        [-0.0112, top],
        [-0.0112, 0.0400],
        [-0.0150, 0.0330],
      ],
      0.0022,
    );
  // Two steps, not one block: the tower carrying the sight is full height and
  // the collar in front of it drops 8 mm, which is what the reference shows and
  // what stops the front end reading as a solid brick out to the barrel.
  const GAS_STEP = -0.3930;
  kit.add(
    'upper',
    upper,
    place(extrudeZ(gasSection(0.0580), Z_GAS_BACK - GAS_STEP), 0, 0, (Z_GAS_BACK + GAS_STEP) / 2),
    place(extrudeZ(gasSection(0.0500), GAS_STEP - Z_GAS_FRONT), 0, 0, (GAS_STEP + Z_GAS_FRONT) / 2),
  );
  // Gas regulator, seated flush into the top of the tall section. Stood proud
  // on the front collar it puts an 11 mm lump on the one part of the outline the
  // reference has running dead flat.
  kit.add('steel', steel, place(box(0.0230, 0.0060, 0.0130, 0.0016), 0, 0.0555, -0.3880));

  // Muzzle brake: a stepped cylinder with a proud front ring and three port
  // slots cut through it, then a genuinely dark bore down the middle.
  //
  // Authored front-to-back, which looks backwards but is the only order that
  // works: `LatheGeometry` takes each vertex normal from the profile's own
  // tangent, so a profile that runs down the page revolves into a solid whose
  // normals all face *inward*. On a rough metal that is not subtle — the whole
  // device goes matte black and disappears off the end of the barrel.
  kit.add(
    'steel',
    steel,
    place(
      lathe(
        [
          [0.0, 0.0],
          [0.0128, 0.0],
          [0.0152, 0.0046],
          [0.0152, 0.0170],
          [0.0136, 0.0212],
          [0.0136, 0.0462],
          [0.0098, 0.0512],
          [0.0, 0.0512],
        ],
        22,
      ),
      0,
      BORE,
      Z_MUZZLE,
    ),
  );
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + ((i + 1) / 4) * Math.PI * 2;
    for (const z of [-0.5860, -0.6010]) {
      kit.add(
        'vent',
        dark,
        place(box(0.0075, 0.0075, 0.0080, 0.0009), Math.cos(a) * 0.0125, BORE + Math.sin(a) * 0.0125, z),
      );
    }
  }
  // Stood a whisker proud of the brake's front face, or the face's own cap
  // covers it and the muzzle reads as a solid disc.
  kit.add('bore', dark, bore(0.0080, BORE, Z_MUZZLE - 0.0015, 0.032));

  /* --- Folding back-up sights ------------------------------------------- */
  // Both stand on the same line. A SCAR whose irons disagree by a couple of
  // millimetres is obvious the instant the player aims, and because the deck is
  // so high, that line sits 84 mm over the bore — far above an AR's.
  // The rear leaf is deliberately spare — a base, an aperture ring and two low
  // protective wings, with nothing bridged across the top. At a hundred-odd
  // millimetres from the eye anything more becomes a cage the player aims
  // through rather than a sight, and the ring is the only part they read.
  kit.add('steel', steel, place(box(0.0210, 0.0100, 0.0220, 0.0018), 0, 0.0745, Z_REAR_SIGHT));
  for (const s of [-1, 1]) {
    kit.add('steel', steel, place(box(0.0034, 0.0250, 0.0080, 0.0011), s * 0.0082, 0.0900, Z_REAR_SIGHT));
  }
  kit.add('steel', steel, place(tube(0.0048, 0.0026, 0.0080, 20), 0, SIGHT_Y, Z_REAR_SIGHT));

  // The front post carries the aiming point, so it is the bright part; its ears
  // are tall because the gas block it stands on is already 43 mm over the bore.
  // Ears kept to 4 mm over the sight line rather than the 9 mm they measure at:
  // seen down the rear aperture the hood sits inside the ring, and any taller it
  // stops framing the post and starts hiding it behind a bar.
  for (const s of [-1, 1]) {
    kit.add('steel', steel, place(box(0.0036, 0.0460, 0.0090, 0.0011), s * 0.0068, 0.0810, Z_FRONT_SIGHT));
  }
  kit.add('steel', steel, place(box(0.0172, 0.0030, 0.0090, 0.0009), 0, 0.1025, Z_FRONT_SIGHT));
  kit.add('bright', bright, place(box(0.0036, 0.0250, 0.0044, 0.0006), 0, 0.0870, Z_FRONT_SIGHT));

  kit.flushInto(body, true);
  root.add(body);

  /* --- Twenty-round 7.62x51 magazine ------------------------------------ */
  // Near enough straight: a 7.62 NATO case tapers little, so the deep banana of
  // an intermediate-calibre magazine would be plainly wrong here.
  const magazine = new Group();
  magazine.name = 'magazine';
  new MeshKit()
    .add(
      'magazine',
      polymerDark,
      ...curvedMagazine({
        z: (Z_MAG_BACK + Z_MAG_FRONT) / 2,
        y: -0.0210,
        length: 0.1290,
        width: 0.0290,
        depth: 0.0910,
        // Barely any curve at all. A 7.62 NATO case is nearly parallel-sided, so
        // this magazine hangs almost straight down and its floorplate is only
        // 10 mm lower at the back than the front — measured off the reference.
        // Curl it like an intermediate-calibre magazine and the front corner
        // rides 15 mm high, which reads instantly as the wrong cartridge.
        curve: 0.05,
        taper: 0.03,
      }),
    )
    .add('witness', bright, place(box(0.0026, 0.0130, 0.0480, 0.0006), 0.0150, -0.0800, -0.1070))
    .flushInto(magazine);
  root.add(magazine);

  /* --- Action parts driven by the fire and reload timelines --------------- */
  const slide = new Group();
  slide.name = 'slide';
  new MeshKit()
    .add('bolt', bright, place(box(0.0230, 0.0205, 0.0400, 0.0025), 0.0060, BORE + 0.0015, -0.1620))
    .flushInto(slide);
  root.add(slide);

  const charging = new Group();
  charging.name = 'charging';
  // Left flank, riding a long slot, and forward because the bolt is closed. Its
  // own group so the reload timeline can rack it without dragging the upper.
  new MeshKit()
    .add('bright', bright, place(box(0.0090, 0.0125, 0.1000, 0.0018), -0.0290, 0.0110, -0.0980))
    .add('bright', bright, place(box(0.0190, 0.0150, 0.0230, 0.0030), -0.0360, 0.0100, -0.1390, 0, 0, 0.30))
    .flushInto(charging);
  root.add(charging);

  const trigger = new Group();
  trigger.name = 'trigger';
  new MeshKit().add('bright', bright, triggerBlade(-0.0300, -0.0240, 0.0060)).flushInto(trigger);
  root.add(trigger);

  root.add(marker('muzzle', 0, BORE, Z_MUZZLE - 0.002));
  root.add(marker('eject', 0.0270, 0.0180, -0.1800));

  return {
    root,
    muzzle: root.getObjectByName('muzzle')!,
    ejectPort: root.getObjectByName('eject')!,
    slide,
    magazine,
    charging,
    trigger,
    sightHeight: SIGHT_Y,
    sightForward: -Z_REAR_SIGHT,
  };
}

/* ------------------------------------------------------------------ */
/* Pump-action shotgun                                                 */
/* ------------------------------------------------------------------ */

/**
 * Forend cross-section: a wood block that cradles the barrel.
 *
 * The concave arc across the top is the important part. A forend modelled as a
 * plain box either floats below the barrel with a visible gap or swallows the
 * bottom third of it; a real one has ears that rise either side of the barrel
 * and a groove between them, which is what this outline is.
 */
function forendShape(halfWidth: number, top: number, bottom: number, boreY: number, boreR: number): Shape {
  const sin = Math.max(-0.98, Math.min(0.98, (top - boreY) / boreR));
  const a = Math.asin(sin);
  const xr = boreR * Math.cos(a);
  // The belly takes a large radius and the ears a small one: a forend with a
  // uniform chamfer reads as a milled block, where the wood it represents is
  // turned round underneath and only squares off where it clears the barrel.
  const belly = Math.min(halfWidth * 0.86, (top - bottom) * 0.42);
  const ear = 0.0032;

  const s = new Shape();
  s.moveTo(-halfWidth + belly, bottom);
  s.lineTo(halfWidth - belly, bottom);
  s.quadraticCurveTo(halfWidth, bottom, halfWidth, bottom + belly);
  s.lineTo(halfWidth, top - ear);
  s.quadraticCurveTo(halfWidth, top, halfWidth - ear, top);
  s.lineTo(xr, top);
  s.absarc(0, boreY, boreR, a, Math.PI - a, true);
  s.lineTo(-halfWidth + ear, top);
  s.quadraticCurveTo(-halfWidth, top, -halfWidth, top - ear);
  s.lineTo(-halfWidth, bottom + belly);
  s.quadraticCurveTo(-halfWidth, bottom, -halfWidth + belly, bottom);
  return s;
}

export function buildShotgun(): GunModel {
  const root = new Group();
  const steel = Presets.gunSteel();
  const bright = Presets.brightSteel();
  // Oil-finished walnut. The untinted bake is a pale ash that reads as bare
  // pine against parkerised steel.
  const wood = Presets.stockWood(0x8e6a47);
  const dark = Presets.gunSteel(0x171717);
  const body = new Group();
  const kit = new MeshKit();

  const BORE = 0.020;
  const BARREL_R = 0.0140;
  // Magazine tube hangs tangent beneath the barrel — not floating below it.
  const TUBE_R = 0.0128;
  const TUBE_Y = BORE - (BARREL_R + TUBE_R - 0.0008);

  /* --- Receiver ---------------------------------------------------------
   * Milled steel, split into three segments so the ejection port is a genuine
   * opening rather than a dark decal on a closed box.
   */
  const RECV_BACK = 0.080;
  const RECV_FRONT = -0.098;
  const RECV_CY = BORE - 0.025;
  // Round-shouldered on top, square-ish on the bottom — the milled-billet
  // profile. A uniform chamfer all round reads as an extruded bar.
  const recvSection = roundedPoly(
    [
      [-0.023, RECV_CY - 0.028],
      [0.023, RECV_CY - 0.028],
      [0.023, RECV_CY + 0.028],
      [-0.023, RECV_CY + 0.028],
    ],
    [0.008, 0.008, 0.020, 0.020],
  );
  const PORT_BACK = 0.030;
  const PORT_FRONT = -0.048;
  const portSection = notchFlank(recvSection, RECV_CY - 0.0140, RECV_CY + 0.0060, 0.0100);

  kit.add(
    'steel',
    steel,
    place(extrudeZ(recvSection, RECV_BACK - PORT_BACK), 0, 0, (RECV_BACK + PORT_BACK) / 2),
    place(extrudeZ(portSection, PORT_BACK - PORT_FRONT, 0.0014), 0, 0, (PORT_BACK + PORT_FRONT) / 2),
    place(extrudeZ(recvSection, PORT_FRONT - RECV_FRONT), 0, 0, (PORT_FRONT + RECV_FRONT) / 2),
  );
  // Barrel-extension boss: carries the receiver's section up onto the barrel so
  // the two meet on one axis instead of stepping.
  kit.add(
    'steel',
    steel,
    place(extrudeZ(rrect(0.0400, 0.0455, 0.0150, 0, BORE - 0.0135), 0.0240), 0, 0, -0.1050),
  );
  // Bolt, sitting in the open port.
  kit.add('bright', bright, place(box(0.0165, 0.0250, 0.0520, 0.0025), 0.0080, BORE - 0.0245, -0.0090));
  kit.add('dark', dark, place(box(0.0150, 0.0180, 0.0430, 0.0022), 0.0020, BORE - 0.0245, -0.0090));
  // Loading port and shell lifter underneath.
  kit.add('dark', dark, place(box(0.0250, 0.0090, 0.0560, 0.0022), 0, RECV_CY - 0.0265, -0.0100));
  kit.add('bright', bright, place(box(0.0215, 0.0060, 0.0400, 0.0018), 0, RECV_CY - 0.0235, -0.0060, 0.10));
  // Assembly pins and the bolt-release tab.
  kit.add('bright', bright, ...pin(0.0228, RECV_CY - 0.0175, 0.0500, 0.0034));
  kit.add('bright', bright, ...pin(0.0228, RECV_CY - 0.0175, -0.0650, 0.0034));
  kit.add('bright', bright, place(box(0.0060, 0.0170, 0.0110, 0.0018), -0.0245, RECV_CY - 0.0135, 0.0180, 0.2));

  /* --- Barrel and magazine tube ------------------------------------------ */
  // Chamber section steps down to the barrel proper, as a real one does.
  kit.add('steel', steel, place(rod(0.0176, 0.0760, 22), 0, BORE, -0.1330));
  kit.add('steel', steel, place(barrel(0.0140, 0.0176, 0.0120, 22), 0, BORE, -0.1770));
  kit.add('steel', steel, place(rod(BARREL_R, 0.2520, 22), 0, BORE, -0.3090));
  kit.add(
    'steel',
    steel,
    place(
      lathe(
        [
          [0.0, 0.0],
          [BARREL_R, 0.0],
          [0.0148, 0.0030],
          [0.0148, 0.0090],
          [0.0102, 0.0110],
          [0.0, 0.0110],
        ],
        22,
      ),
      0,
      BORE,
      -0.4450,
    ),
  );
  kit.add('dark', dark, bore(0.0102, BORE, -0.4448, 0.034));

  kit.add('steel', steel, place(rod(TUBE_R, 0.2340, 20), 0, TUBE_Y, -0.2130));
  // Knurled magazine cap with a sling stud.
  kit.add('steel', steel, place(rod(0.0138, 0.0220, 20), 0, TUBE_Y, -0.3410));
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    kit.add(
      'steel',
      steel,
      place(box(0.0030, 0.0030, 0.0180, 0.0007), Math.cos(a) * 0.0134, TUBE_Y + Math.sin(a) * 0.0134, -0.3410, 0, 0, a),
    );
  }
  // Barrel-to-magazine clamp: one peanut-shaped collar around both tubes.
  kit.add(
    'steel',
    steel,
    place(
      extrudeZ(
        roundedPoly(
          [
            [-0.0158, TUBE_Y - 0.0150],
            [0.0158, TUBE_Y - 0.0150],
            [0.0158, BORE + 0.0165],
            [-0.0158, BORE + 0.0165],
          ],
          0.0145,
        ),
        0.0150,
      ),
      0,
      0,
      -0.3300,
    ),
  );

  /* --- Front bead -------------------------------------------------------- */
  kit.add('steel', steel, place(box(0.0085, 0.0075, 0.0165, 0.0016), 0, BORE + 0.0140, -0.4160));
  const BEAD_Y = BORE + 0.0205;
  kit.add('brass', Presets.brass(), place(new SphereGeometry(0.0034, 12, 10), 0, BEAD_Y, -0.4160));

  /* --- Buttstock --------------------------------------------------------
   * A straight-comb stock with a semi-pistol wrist. The comb runs a few
   * millimetres below the bore for the whole of its length, so the eye that
   * lands on it is already looking down the barrel — the previous stock's comb
   * stood 26 mm proud of the bore and blocked the bead entirely.
   */
  kit.add(
    'wood',
    wood,
    loft(
      [
        { z: 0.0700, y: BORE - 0.0250, w: 0.0430, h: 0.0530, n: 4.4 },
        { z: 0.0990, y: BORE - 0.0290, w: 0.0380, h: 0.0500, n: 4.4 },
        { z: 0.1300, y: BORE - 0.0330, w: 0.0400, h: 0.0540, n: 4.3 },
        { z: 0.1700, y: BORE - 0.0385, w: 0.0430, h: 0.0620, n: 4.2 },
        { z: 0.2150, y: BORE - 0.0440, w: 0.0455, h: 0.0700, n: 4.2 },
        { z: 0.2520, y: BORE - 0.0480, w: 0.0465, h: 0.0740, n: 4.2 },
      ],
      24,
    ),
  );
  // Semi-pistol grip swell under the wrist.
  kit.add(
    'wood',
    wood,
    loft(
      [
        { z: 0.1200, y: BORE - 0.0430, w: 0.0385, h: 0.0470, n: 4.4 },
        { z: 0.1140, y: BORE - 0.0570, w: 0.0375, h: 0.0430, n: 4.6 },
        { z: 0.1105, y: BORE - 0.0690, w: 0.0350, h: 0.0380, n: 4.8 },
        { z: 0.1090, y: BORE - 0.0760, w: 0.0310, h: 0.0330, n: 5.0 },
      ],
      22,
    ),
  );
  kit.add(
    'panel',
    Presets.stockWood(0xa8825a),
    ...checkering(
      [
        [0.1185, BORE - 0.0455],
        [0.1155, BORE - 0.0545],
        [0.1128, BORE - 0.0635],
      ],
      0.0180,
      3,
      0.0090,
      0.0030,
    ),
  );
  kit.add(
    'rubber',
    Presets.rubber(),
    place(extrudeZ(rrect(0.0480, 0.0760, 0.0110, 0, BORE - 0.0490), 0.0140), 0, 0, 0.2620),
  );
  // Sling swivel stud on the belly.
  kit.add('steel', steel, place(new TorusGeometry(0.0060, 0.0016, 8, 14), 0, BORE - 0.0800, 0.2250, 0, Math.PI / 2, 0));

  /* --- Trigger group ----------------------------------------------------- */
  kit.add(
    'steel',
    steel,
    place(extrudeZ(rrect(0.0300, 0.0220, 0.0050, 0, BORE - 0.0570), 0.0820), 0, 0, 0.0080),
  );
  kit.add('steel', steel, triggerGuard(-0.0180, 0.0400, BORE - 0.0530, BORE - 0.0830, 0.0270, 0.0062));
  // Crossbolt safety and the action-bar release.
  kit.add('bright', bright, ...pin(0.0155, BORE - 0.0530, 0.0400, 0.0052, 0.0032));
  kit.add('bright', bright, place(box(0.0055, 0.0130, 0.0090, 0.0018), -0.0165, BORE - 0.0500, -0.0230, 0.25));

  kit.flushInto(body, true);
  root.add(body);

  /* --- Pump forend -------------------------------------------------------
   * Rides the magazine tube; the grooves are slices of the forend's own
   * cross-section scaled up slightly, so they follow its surface exactly
   * instead of reading as bars glued to a box.
   */
  const slide = new Group();
  slide.name = 'slide';
  const slideKit = new MeshKit();
  const FOREND_TOP = BORE - 0.0020;
  const FOREND_BOT = TUBE_Y - 0.0255;
  // Rest position leaves room for the 50 mm pump stroke: the forend has to be
  // able to travel its full length toward the receiver without its 52 mm-wide
  // body ending up wrapped around the 46 mm receiver, which would show the
  // wood standing proud on both flanks at the top of the cycle.
  const FOREND_Z = -0.2120;
  slideKit.add(
    'wood',
    wood,
    place(extrudeZ(forendShape(0.0258, FOREND_TOP, FOREND_BOT, BORE, 0.0153), 0.1420, 0.0035), 0, 0, FOREND_Z),
  );
  for (let i = 0; i < 9; i++) {
    slideKit.add(
      'wood',
      wood,
      place(
        extrudeZ(forendShape(0.0270, FOREND_TOP, FOREND_BOT - 0.0011, BORE, 0.0153), 0.0055, 0.0012),
        0,
        0,
        FOREND_Z + 0.0540 - i * 0.0135,
      ),
    );
  }
  // Twin action bars running back from the forend into the receiver.
  for (const side of [-1, 1]) {
    slideKit.add(
      'bright',
      bright,
      place(box(0.0035, 0.0090, 0.1150, 0.0010), side * 0.0175, TUBE_Y - 0.0075, -0.1050),
    );
  }
  slideKit.flushInto(slide, true);
  root.add(slide);

  const trigger = new Group();
  trigger.name = 'trigger';
  new MeshKit()
    .add('bright', bright, place(triggerBlade(0.0080, BORE - 0.0530), 0, 0, 0))
    .flushInto(trigger);
  root.add(trigger);

  root.add(marker('muzzle', 0, BORE, -0.4460));
  root.add(marker('eject', 0.030, BORE - 0.0180, -0.0100));

  return {
    root,
    muzzle: root.getObjectByName('muzzle')!,
    ejectPort: root.getObjectByName('eject')!,
    slide,
    magazine: null,
    charging: null,
    trigger,
    // A bead is aimed *at*, not over: the sight line runs through its centre.
    sightHeight: BEAD_Y,
    sightForward: 0.416,
  };
}

/* ------------------------------------------------------------------ */
/* Franchi SPAS-12 dual-mode shotgun                                   */
/* ------------------------------------------------------------------ */

/**
 * Franchi SPAS-12, built against photographs rather than from the idea of "a
 * black tactical shotgun".
 *
 * Six things identify one, and a generic autoloader in polymer furniture does
 * none of them:
 *
 *   1. **Two tones, split by material, not by shade.** The receiver is a black
 *      parkerised slab and the furniture is black polymer, but the barrel
 *      shroud and the top cover are noticeably *lighter* anodised alloy. That
 *      light band running along the top of an otherwise black gun is the first
 *      thing the eye picks up in every photograph.
 *   2. **A row of long oval slots down the top cover.** Not a picatinny rail,
 *      not round vent holes: elongated slots on a cover that runs unbroken from
 *      the front of the receiver almost to the muzzle end of the forend.
 *   3. **The magazine tube hangs clear of the barrel.** Both are near enough
 *      the same diameter and there is daylight between them — a shotgun with
 *      its tube tangent under the barrel reads as a pump gun.
 *   4. **A slab receiver.** Flat sides, square corners, no stamped ribbing and
 *      no rounded top deck; the interest lives in the shroud ahead of it.
 *   5. **A huge forend** with a rounded belly, a ring of vertical ribs over its
 *      rear half and a smooth swell in front of them.
 *   6. **The skeleton stock and its butt hook.** A perforated strut running
 *      back from a hinge at the top rear of the receiver, and a bent round bar
 *      hanging off the butt that curls forward — the feature nothing else has.
 *
 * The stock is drawn *deployed*. Folded, it lies over the receiver's top deck
 * and a real shooter simply cannot use the sights past it; a viewmodel cannot
 * flip it out mid-aim, so drawing it folded puts a strut across the top half of
 * the sight picture — which is exactly what the previous model did.
 *
 * The sights sit where the real ones do, and that is a bigger change than it
 * looks: the SPAS's rear notch is not on the receiver, it is a long way forward
 * on the top cover. `sightForward` is therefore *positive* here, and the
 * definition's eye relief grows to match, which is why aiming pushes the whole
 * weapon further down range than a receiver-sighted rifle.
 *
 * It uses the same tube reload contract as the pump gun, while its visible bolt
 * carrier cycles independently of the forend so semi-auto fire never reads as a
 * fake pump stroke.
 */
export function buildSpas12(): GunModel {
  const root = new Group();

  // Three finishes carry the SPAS's identity, and getting their *relative*
  // brightness right matters more than any single tint.
  //
  // A full-metalness surface here has no diffuse term at all: it is lit only by
  // what it reflects, and a flat vertical panel reflects the backdrop. That is
  // fine — desirable, even — for the receiver, which should be the black hole
  // in the middle of the gun. It is fatal for the shroud, which has to read as
  // *lighter* than everything around it, so the alloy is deliberately mostly
  // non-metallic: its brightness then comes from diffuse and survives any
  // angle, backdrop or light rig.
  const parkerized = Presets.gunSteel(0xc2c8cd);
  // Shroud, top cover and stock. That light band along the top of an otherwise
  // black gun is what separates a SPAS from every other tactical shotgun at a
  // glance, so it is the brightest thing here by a wide margin.
  const alloy = makeSurface('gunmetal', {
    repeat: 1,
    tint: 0xc6ccc6,
    roughness: 0.54,
    metalness: 0.14,
    normalScale: 0.42,
  });
  const bright = Presets.brightSteel(0xd4d8da);
  const polymer = Presets.gunPolymer(0x9aa1a6);
  const dark = Presets.gunSteel(0x0c0e10);
  const rubber = Presets.rubber(0x15171a);
  const body = new Group();
  const kit = new MeshKit();

  /* --- Stations ------------------------------------------------------- */
  // Metric SPAS-12 proportions, compressed only in overall length: a 250 mm
  // receiver, a barrel whose chamber lives inside it, a 205 mm forend and a
  // shroud showing ~120 mm of alloy between forend and receiver.
  const BORE = 0.019;
  const BARREL_R = 0.0113;
  const TUBE_R = 0.0120;
  // Centre-to-centre, not tangent. The tube hangs off barrel rings with a
  // visible gap; closing that gap is what made the old model read as a pump.
  const TUBE_Y = BORE - 0.0272;

  const MUZZLE_Z = -0.606;
  const RECV_BACK = 0.116;
  const RECV_FRONT = -0.126;
  const SHROUD_FRONT = -0.252;
  const FOREND_BACK = -0.244;
  const FOREND_FRONT = -0.448;
  const COVER_FRONT = -0.434;

  const RECV_TOP = BORE + 0.0165;
  const RECV_BOT = BORE - 0.0425;
  const RECV_HW = 0.0245;

  // `extrudeZ` inflates a cross-section *outward* by its bevel in X and Y —
  // `extrudeZ(rrect(0.040, …), len, 0.0018)` measures 0.0436 across, not 0.040.
  // Every slot, rib and lug below is a small solid meant to stand proud of an
  // extruded body, so each one is positioned against `swell(nominal, bevel)`
  // rather than the nominal outline. Sizing them against the nominal is what
  // buried this model's first pass: the shroud vents, the top-cover slots and
  // all thirteen forend ribs existed, were correctly placed, and were sunk
  // 0.2–1.8 mm *inside* the surface they were supposed to break.
  const swell = (halfWidth: number, bevel: number) => halfWidth + bevel;

  /* --- Slab receiver and ejection port -------------------------------- */
  // Flat flanks, square shoulders, a barely-there chamfer. Everything the
  // previous model spent on stamped ribbing and a rounded deck is spent on the
  // shroud instead, because that is where the real gun keeps its detail.
  const recvSection = roundedPoly(
    [
      [-RECV_HW, RECV_BOT],
      [RECV_HW, RECV_BOT],
      [RECV_HW, RECV_TOP],
      [-RECV_HW, RECV_TOP],
    ],
    [0.005, 0.005, 0.0032, 0.0032],
  );
  const PORT_BACK = 0.040;
  const PORT_FRONT = -0.034;
  const portSection = notchFlank(recvSection, BORE - 0.0115, BORE + 0.0105, 0.0155);
  kit.add(
    'parkerized',
    parkerized,
    place(extrudeZ(recvSection, RECV_BACK - PORT_BACK), 0, 0, (RECV_BACK + PORT_BACK) / 2),
    place(extrudeZ(portSection, PORT_BACK - PORT_FRONT, 0.0015), 0, 0, (PORT_BACK + PORT_FRONT) / 2),
    place(extrudeZ(recvSection, PORT_FRONT - RECV_FRONT), 0, 0, (PORT_FRONT + RECV_FRONT) / 2),
  );
  const RECV_FACE = swell(RECV_HW, 0.0018);
  // Bolt-handle track ahead of the port and the two takedown pins. The flank
  // gets nothing else: the real receiver is a bare slab wearing roll marks.
  kit.add('dark', dark, place(box(0.0045, 0.008, 0.062, 0.0012), RECV_FACE + 0.0008, BORE + 0.006, 0.006));
  kit.add('bright', bright, ...pin(RECV_FACE + 0.0012, BORE - 0.026, 0.086, 0.0038, 0.0034));
  kit.add('bright', bright, ...pin(RECV_FACE + 0.0012, BORE - 0.026, -0.086, 0.0038, 0.0034));
  // Loading port under the receiver — a shotgun is fed through its belly, and
  // the shell-reload animation plays to this opening.
  kit.add('dark', dark, place(box(0.030, 0.007, 0.074, 0.0015), 0, RECV_BOT - 0.0044, -0.004));

  /* --- Trigger group housing, guard and grip -------------------------- */
  // On the real gun the trigger group is a separate alloy unit slung under the
  // receiver with the pistol grip moulded to it, so it gets the lighter finish
  // and a visible parting line rather than being part of the same black slab.
  const HOUSE_TOP = BORE - 0.038;
  const HOUSE_BOT = BORE - 0.058;
  kit.add(
    'alloy',
    alloy,
    place(extrudeZ(rrect(0.046, HOUSE_TOP - HOUSE_BOT, 0.004, 0, (HOUSE_TOP + HOUSE_BOT) / 2), 0.116), 0, 0, 0.022),
  );
  kit.add('alloy', alloy, triggerGuard(-0.016, 0.052, BORE - 0.050, BORE - 0.086, 0.032, 0.0068));
  // Crossbolt safety: a fat button through the front of the guard, one of the
  // few high-contrast round shapes anywhere on the gun.
  kit.add('dark', dark, ...pin(0.019, BORE - 0.049, -0.010, 0.0062, 0.0042));

  // Pistol grip. Steeper than a rifle's — around 65 degrees — with a palm
  // swell and the flared, hooked heel the mouldings actually have.
  kit.add(
    'polymer',
    polymer,
    loft(
      [
        { z: 0.050, y: BORE - 0.050, w: 0.038, h: 0.055, n: 4.2 },
        { z: 0.060, y: BORE - 0.071, w: 0.043, h: 0.053, n: 4.4 },
        { z: 0.070, y: BORE - 0.092, w: 0.044, h: 0.050, n: 4.6 },
        { z: 0.078, y: BORE - 0.110, w: 0.042, h: 0.048, n: 4.8 },
        { z: 0.084, y: BORE - 0.123, w: 0.045, h: 0.044, n: 5.2 },
      ],
      24,
    ),
  );
  // Finger ridges, on the *front* strap.
  //
  // The strap is not the grip's path — `loft` carries each section along the
  // path *normal*, so the front face is offset from the path by half the
  // section thickness in a direction that is nowhere near vertical. Laying the
  // ridges on the path itself, as the first pass did, drops all six of them
  // ~18 mm inside a 50 mm-thick grip where nothing shows. These follow the
  // front surface and lie square across it.
  const STRAP_Z0 = 0.038;
  const STRAP_Y0 = BORE - 0.081;
  const STRAP_DZ = 0.019;
  const STRAP_DY = -0.038;
  const STRAP_LEAN = Math.atan2(STRAP_DZ, -STRAP_DY);
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    kit.add(
      'polymer',
      polymer,
      place(
        box(0.034, 0.0065, 0.0082, 0.0018),
        0,
        STRAP_Y0 + t * STRAP_DY,
        STRAP_Z0 + t * STRAP_DZ,
        -(Math.PI / 2 + STRAP_LEAN),
      ),
    );
  }

  /* --- Barrel, magazine tube and muzzle -------------------------------- */
  // Chamber section inside and just ahead of the receiver, then the step down
  // to the barrel proper.
  kit.add('parkerized', parkerized, place(rod(0.0148, 0.072, 24), 0, BORE, -0.144));
  kit.add('parkerized', parkerized, place(barrel(BARREL_R, 0.0148, 0.014, 24), 0, BORE, -0.187));
  kit.add('parkerized', parkerized, place(rod(BARREL_R, 0.402, 24), 0, BORE, -0.395));
  // Muzzle nut: a stepped collar standing proud of the barrel, with a groove
  // cut round it. Squared off at the face, not tapered.
  kit.add(
    'parkerized',
    parkerized,
    place(
      lathe(
        [
          [0.0, 0.0],
          [0.0138, 0.0],
          [0.0138, 0.014],
          [0.0122, 0.016],
          [0.0138, 0.020],
          [0.0138, 0.038],
          [BARREL_R, 0.040],
          [0.0, 0.040],
        ],
        24,
      ),
      0,
      BORE,
      MUZZLE_Z - 0.040,
    ),
  );
  kit.add('dark', dark, bore(0.0093, BORE, MUZZLE_Z, 0.036));

  // Magazine tube: runs from the receiver forward to a rounded plug that stops
  // short of the muzzle, with the knurled gas collar where the forend ends.
  kit.add('parkerized', parkerized, place(rod(TUBE_R, 0.434, 22), 0, TUBE_Y, -0.343));
  kit.add(
    'parkerized',
    parkerized,
    place(lathe([[0.0, 0.0], [TUBE_R, 0.0], [TUBE_R, 0.010], [0.0088, 0.016], [0.0, 0.017]], 20), 0, TUBE_Y, -0.560),
  );
  kit.add('bright', bright, place(rod(0.0148, 0.024, 22), 0, TUBE_Y, -0.462));
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    kit.add(
      'bright',
      bright,
      place(box(0.0024, 0.0024, 0.020, 0.0005), Math.cos(a) * 0.0154, TUBE_Y + Math.sin(a) * 0.0154, -0.462, 0, 0, a),
    );
  }
  // Collar behind the knurl, with the sling lug hanging off its underside.
  kit.add('alloy', alloy, place(rod(0.0158, 0.012, 22), 0, TUBE_Y, -0.481));
  kit.add('alloy', alloy, place(box(0.006, 0.014, 0.010, 0.0018), 0, TUBE_Y - 0.019, -0.481));
  kit.add(
    'bright',
    bright,
    place(new TorusGeometry(0.0052, 0.0016, 8, 14), 0, TUBE_Y - 0.026, -0.481, 0, Math.PI / 2, 0),
  );
  // One barrel ring, immediately ahead of the collar, ties tube to barrel
  // across the gap. Photographs show nothing else out here: past this point the
  // exposed run is bare tube, bare barrel and the front sight, and the extra
  // rings an earlier pass carried turned the cleanest part of the gun into a
  // thicket of collars.
  kit.add(
    'parkerized',
    parkerized,
    place(
      extrudeZ(
        roundedPoly(
          [
            [-0.0128, TUBE_Y - 0.002],
            [0.0128, TUBE_Y - 0.002],
            [0.0128, BORE + 0.002],
            [-0.0128, BORE + 0.002],
          ],
          0.010,
        ),
        0.011,
      ),
      0,
      0,
      -0.498,
    ),
  );

  /* --- Alloy shroud and slotted top cover ------------------------------ */
  // The shroud is the block of alloy between receiver and forend. It is wider
  // and taller than the cover that runs on from it, so the two read as a step
  // rather than one long extrusion.
  const SHROUD_TOP = BORE + 0.0235;
  const SHROUD_BOT = TUBE_Y - 0.004;
  const SHROUD_HW = 0.0238;
  kit.add(
    'alloy',
    alloy,
    place(
      extrudeZ(
        roundedPoly(
          [
            [-SHROUD_HW, SHROUD_BOT],
            [SHROUD_HW, SHROUD_BOT],
            [SHROUD_HW, SHROUD_TOP - 0.005],
            [SHROUD_HW - 0.006, SHROUD_TOP],
            [-(SHROUD_HW - 0.006), SHROUD_TOP],
            [-SHROUD_HW, SHROUD_TOP - 0.005],
          ],
          [0.005, 0.005, 0.003, 0.003, 0.003, 0.003],
        ),
        RECV_FRONT - SHROUD_FRONT,
        0.0018,
      ),
      0,
      0,
      (RECV_FRONT + SHROUD_FRONT) / 2,
    ),
  );
  // Two staggered rows of cooling slots down each flank of the shroud. The dark
  // recess behind each one is what survives a turntable silhouette; a painted
  // line would vanish the moment the light moved.
  const SHROUD_FACE = swell(SHROUD_HW, 0.0018);
  for (let i = 0; i < 3; i++) {
    const z = -0.156 - i * 0.032;
    for (const side of [-1, 1]) {
      kit.add('dark', dark, place(box(0.006, 0.0075, 0.022, 0.0012), side * (SHROUD_FACE + 0.0012), BORE + 0.005, z));
      kit.add('dark', dark, place(box(0.006, 0.0065, 0.015, 0.0012), side * (SHROUD_FACE + 0.0012), BORE - 0.010, z - 0.008));
    }
  }

  // Top cover: one unbroken alloy channel from the receiver almost to the front
  // of the forend, carrying the row of long oval slots.
  const COVER_TOP = BORE + 0.0235;
  // Wide enough to cap the forend rather than perch on it. A narrow channel
  // here reads as a rail bolted to the top of a shotgun, which is the one
  // silhouette this weapon must not have.
  const COVER_HW = 0.0208;
  kit.add(
    'alloy',
    alloy,
    place(
      extrudeZ(
        roundedPoly(
          [
            [-COVER_HW, BORE + 0.001],
            [COVER_HW, BORE + 0.001],
            [COVER_HW, COVER_TOP - 0.005],
            [COVER_HW - 0.005, COVER_TOP],
            [-(COVER_HW - 0.005), COVER_TOP],
            [-COVER_HW, COVER_TOP - 0.005],
          ],
          [0.003, 0.003, 0.0028, 0.0025, 0.0025, 0.0028],
        ),
        RECV_FRONT - COVER_FRONT,
        0.0018,
      ),
      0,
      0,
      (RECV_FRONT + COVER_FRONT) / 2,
    ),
  );
  // The slots on the deck are laid *flush* rather than proud. A raised dark bar
  // at this pitch is a picatinny rail, which is precisely the wrong reading —
  // sitting them level with the deck makes them holes instead of ribs. The
  // flank pair does stand slightly proud, because edge-on a flush slot on a
  // vertical wall disappears entirely.
  const COVER_FACE = swell(COVER_HW, 0.0018);
  const COVER_DECK = COVER_TOP + 0.0018;
  for (let i = 0; i < 7; i++) {
    const z = -0.264 - i * 0.0242;
    kit.add('dark', dark, place(box(0.017, 0.0035, 0.020, 0.0008), 0, COVER_DECK - 0.0016, z));
    for (const side of [-1, 1]) {
      kit.add('dark', dark, place(box(0.005, 0.0062, 0.020, 0.0012), side * (COVER_FACE + 0.0009), BORE + 0.0135, z));
    }
  }

  /* --- Forend ---------------------------------------------------------- */
  // Big, rounded and belly-heavy, wrapping barrel and tube together. Ribs over
  // the rear half, a smooth swell in front of them, and a raised lip at each
  // end — the profile the mouldings actually have, rather than a plain sleeve.
  const FOREND_TOP = BORE + 0.008;
  const FOREND_BOT = TUBE_Y - 0.0215;
  const FOREND_R = BARREL_R + 0.0018;
  const forendAt = (hw: number, top = FOREND_TOP, bot = FOREND_BOT) =>
    forendShape(hw, top, bot, BORE, FOREND_R);
  // Widths are quoted through `swell` so the stack stays ordered no matter what
  // bevel each section carries: body < ribs < swell < cap < rear lip.
  kit.add(
    'polymer',
    polymer,
    place(extrudeZ(forendAt(0.0268), FOREND_BACK - FOREND_FRONT, 0.003), 0, 0, (FOREND_BACK + FOREND_FRONT) / 2),
    // Rear lip, front cap, and the smooth belly swell between ribs and cap.
    place(extrudeZ(forendAt(0.0300, FOREND_TOP + 0.001, FOREND_BOT - 0.0022), 0.016, 0.004), 0, 0, -0.250),
    place(extrudeZ(forendAt(0.0288, FOREND_TOP - 0.001, FOREND_BOT - 0.0030), 0.078, 0.005), 0, 0, -0.400),
    place(extrudeZ(forendAt(0.0286, FOREND_TOP - 0.002, FOREND_BOT + 0.006), 0.014, 0.004), 0, 0, -0.442),
  );
  const RIB_HW = swell(0.0268, 0.003) - 0.0009 + 0.0018; // 1.8 mm proud of the body
  for (let i = 0; i < 11; i++) {
    kit.add(
      'polymer',
      polymer,
      place(
        extrudeZ(forendAt(RIB_HW, FOREND_TOP, FOREND_BOT - 0.0012), 0.0046, 0.0009),
        0,
        0,
        -0.264 - i * 0.0090,
      ),
    );
  }
  // Pump/semi selector: the button under the nose of the forend that switches
  // the gun between gas and manual operation.
  kit.add('dark', dark, place(box(0.011, 0.008, 0.013, 0.002), 0, FOREND_BOT - 0.0055, -0.428));

  /* --- Sights ---------------------------------------------------------- */
  // The rear notch lives on the top cover, well forward of the receiver — one
  // of the SPAS's odder features and the thing that sets its eye relief.
  //
  // The ears are drawn a little heavier than scale: at the eye relief this
  // sight placement demands, the notch is 345 mm from the eye and a true-size
  // 5 mm gap subtends under a degree — legible on a photograph, invisible in a
  // 58-degree viewmodel frame.
  const REAR_SIGHT_Z = -0.136;
  const SIGHT_Y = COVER_TOP + 0.0065;
  kit.add('parkerized', parkerized, place(box(0.022, 0.006, 0.017, 0.0015), 0, COVER_TOP + 0.002, REAR_SIGHT_Z));
  for (const side of [-1, 1]) {
    kit.add(
      'parkerized',
      parkerized,
      place(box(0.0062, 0.014, 0.0078, 0.0012), side * 0.0068, COVER_TOP + 0.0075, REAR_SIGHT_Z),
    );
  }
  kit.add('dark', dark, place(box(0.0075, 0.011, 0.0084, 0.0008), 0, COVER_TOP + 0.0095, REAR_SIGHT_Z));

  // Front blade: tall, because it has to be seen over a cover that stands above
  // the barrel it sits on, and raked forward on a low band.
  const FRONT_SIGHT_Z = -0.548;
  kit.add('parkerized', parkerized, place(rod(BARREL_R + 0.0022, 0.020, 20), 0, BORE, FRONT_SIGHT_Z));
  kit.add(
    'parkerized',
    parkerized,
    place(box(0.0072, 0.020, 0.0085, 0.0012), 0, BORE + 0.0203, FRONT_SIGHT_Z + 0.001, -0.13),
  );
  // Luminous bead on the blade's face. It is the only genuinely bright thing on
  // the weapon and at 770 mm it is what the eye actually centres in the notch.
  kit.add(
    'dot',
    Presets.gunPolymer(0xf2ecd8),
    place(new SphereGeometry(0.0021, 10, 8), 0, SIGHT_Y - 0.0022, FRONT_SIGHT_Z - 0.0035),
  );

  /* --- Skeleton folding stock, deployed -------------------------------- */
  // A flat strut with a row of drilled holes, built as two rails braced by
  // posts so the holes are genuinely open in silhouette; then the narrow butt
  // plate and the bent bar that curls forward under it. Everything sits below
  // the sight line.
  const stock = new Group();
  const stockKit = new MeshKit();
  const HINGE_Z = RECV_BACK - 0.014;
  stockKit.add(
    'alloy',
    alloy,
    sweep([[HINGE_Z, BORE + 0.011], [0.150, BORE + 0.003], [0.240, BORE - 0.008], [0.316, BORE - 0.017]], 0.013, 0.014, 4.4, 10),
    sweep([[0.146, BORE - 0.033], [0.240, BORE - 0.043], [0.316, BORE - 0.051]], 0.013, 0.013, 4.4, 10),
    // Diagonal brace closing the frame back onto the hinge.
    sweep([[HINGE_Z + 0.004, BORE + 0.005], [0.152, BORE - 0.026]], 0.012, 0.011, 4.4, 8),
  );
  // Posts are wide and heavily radiused on purpose: the openings between them
  // stand in for the strut's drilled holes, and the ratio has to favour metal
  // over air or the whole assembly reads as a garden fence rather than a plate.
  for (let i = 0; i < 5; i++) {
    const z = 0.171 + i * 0.0285;
    // Follow the rails' drop rather than sitting at a fixed height: a level row
    // of posts inside a frame that tapers leaves the holes different sizes and
    // the last post hanging out of the bottom rail.
    const t = (z - 0.150) / 0.166;
    const top = BORE + 0.003 - t * 0.020;
    const bot = BORE - 0.033 - t * 0.018;
    stockKit.add('alloy', alloy, place(box(0.0165, top - bot - 0.008, 0.013, 0.0063), 0, (top + bot) / 2, z));
  }
  stockKit.add('bright', bright, ...pin(0.0232, BORE + 0.011, HINGE_Z, 0.0072, 0.0034));
  stockKit.add('rubber', rubber, place(box(0.014, 0.062, 0.011, 0.0025), 0, BORE - 0.034, 0.322));
  // The butt hook. Nothing else in the game's arsenal has one, so it is worth
  // the segments: a round bar dropping off the butt and curling forward.
  stockKit.add(
    'alloy',
    alloy,
    sweep(
      [
        [0.317, BORE - 0.046],
        [0.316, BORE - 0.064],
        [0.312, BORE - 0.082],
        [0.303, BORE - 0.096],
        [0.290, BORE - 0.105],
        [0.274, BORE - 0.107],
        [0.259, BORE - 0.102],
        [0.248, BORE - 0.091],
        [0.243, BORE - 0.077],
        [0.242, BORE - 0.064],
      ],
      0.0088,
      0.0088,
      2,
      12,
    ),
  );
  stockKit.flushInto(stock, true);
  root.add(stock);

  kit.flushInto(body, true);
  root.add(body);

  /* --- Reciprocating bolt carrier and handle --------------------------- */
  const slide = new Group();
  slide.name = 'slide';
  new MeshKit()
    .add('bright', bright, place(box(0.020, 0.020, 0.066, 0.0026), 0.017, BORE - 0.001, 0.004))
    .add('dark', dark, place(box(0.013, 0.013, 0.048, 0.0016), 0.021, BORE + 0.002, -0.004))
    .flushInto(slide);
  root.add(slide);

  const charging = new Group();
  charging.name = 'charging';
  new MeshKit()
    .add('bright', bright, place(box(0.009, 0.010, 0.026, 0.0018), 0.028, BORE + 0.006, 0.046))
    .add('bright', bright, place(barrel(0.0062, 0.0072, 0.013, 14), 0.034, BORE + 0.006, 0.036, 0, Math.PI / 2, 0))
    .flushInto(charging);
  root.add(charging);

  const trigger = new Group();
  trigger.name = 'trigger';
  new MeshKit().add('bright', bright, triggerBlade(0.016, BORE - 0.050, 0.006)).flushInto(trigger);
  root.add(trigger);

  root.add(marker('muzzle', 0, BORE, MUZZLE_Z));
  root.add(marker('eject', 0.030, BORE + 0.002, 0.004));

  return {
    root,
    muzzle: root.getObjectByName('muzzle')!,
    ejectPort: root.getObjectByName('eject')!,
    slide,
    magazine: null,
    charging,
    trigger,
    sightHeight: SIGHT_Y,
    // Positive, because the rear notch sits *forward* of the model origin on
    // the top cover rather than back on the receiver like a rifle's.
    sightForward: -REAR_SIGHT_Z,
  };
}

/* ------------------------------------------------------------------ */
/* Desert Eagle .50 AE                                                */
/* ------------------------------------------------------------------ */

/**
 * Heavy gas-operated magnum pistol.
 *
 * Built against photographs of a Mark XIX rather than from the idea of "a big
 * pistol", because the three things that identify one are all things a generic
 * scaled-up service pistol does not do:
 *
 *   1. **The barrel's ribbed top rail stands proud of the slide.** The barrel is
 *      fixed and the slide cycles around it, and its rib rides *above* the
 *      slide's deck for most of the length, then carries on past the slide's
 *      front face to the muzzle. The top line of the gun is a raised spine with
 *      a smooth deck either side — never one flat plane.
 *   2. **The sights are tall,** because they have to look over that rib. A low
 *      combat notch sitting on the slide would be blind.
 *   3. **The underside steps twice** — frame, then gas cylinder, then barrel —
 *      as the gas system runs forward from the frame to a block near the muzzle.
 *
 * The earlier model extruded the slide the whole way to the muzzle with a flat
 * rib on top, so all of that collapsed into one rectangular slab and it read as
 * a brick with a grip. Smaller cues that survive at viewmodel scale: the
 * ambidextrous safety is on the *slide*, not the frame; the spur hammer stands
 * exposed behind it; the muzzle face is flat and squared; the cocking
 * serrations are vertical, not raked; and the grip panel is coarse pebble
 * stippling rather than fine diamond checkering.
 */
export function buildDesertEagle(): GunModel {
  const root = new Group();
  const steel = Presets.gunSteel(0xb8bdc5);
  const bright = Presets.brightSteel(0xf0f2f4);
  const frameMat = Presets.gunPolymer(0x1f2024);
  const dark = Presets.gunSteel(0x15171b);
  const dotMat = Presets.gunPolymer(0xf2eee3);
  const body = new Group();

  const BORE = 0.006;
  // Real Mark XIX proportions, in metres: 273 mm overall, a 164 mm slide and a
  // 96 mm barrel clear of it. The ratio between those last two is the whole
  // silhouette, so they are named rather than inlined.
  const SLIDE_BACK = 0.090;
  const SLIDE_FRONT = -0.074;
  const MUZZLE_Z = -0.170;
  // The slide deck is deliberately low. Its height is spent on the barrel rib
  // above it instead, which is where the gun's top line actually lives.
  const SLIDE_TOP = BORE + 0.020;
  const SLIDE_BOTTOM = BORE - 0.015;
  const SLIDE_MID = (SLIDE_TOP + SLIDE_BOTTOM) / 2;
  const SLIDE_H = SLIDE_TOP - SLIDE_BOTTOM;
  const SLIDE_W = 0.031;
  const RIB_W = 0.018;
  const RIB_TOP = SLIDE_TOP + 0.0045;
  // Notch floor: 4.3 mm over the rail slots, so nothing crosses the sight line.
  // Every millimetre added to the rib is a millimetre of rear-sight tower, and
  // a tower tall enough to read as a chimney costs more than the rib gains.
  const SIGHT_Y = SLIDE_TOP + 0.0122;

  /* --- Slide ------------------------------------------------------------ */
  const slide = new Group();
  slide.name = 'slide';
  const slideKit = new MeshKit();
  const slideSection = roundedPoly(
    [
      [-SLIDE_W / 2, SLIDE_BOTTOM],
      [SLIDE_W / 2, SLIDE_BOTTOM],
      [SLIDE_W / 2, SLIDE_TOP - 0.005],
      [0.0112, SLIDE_TOP],
      [-0.0112, SLIDE_TOP],
      [-SLIDE_W / 2, SLIDE_TOP - 0.005],
    ],
    [0.0045, 0.0045, 0.0035, 0.0022, 0.0022, 0.0035],
  );
  // Forward of the serrations the slide carries a long, shallow milled relief
  // down both flanks. It is authored *into* the cross-section rather than stuck
  // on as strips, because the whole point of it is that the flank is cut away:
  // without it a broad slide is a bare rectangle for 110 mm and no amount of
  // small hardware elsewhere stops it reading as a bar of metal.
  const FLUTE_LOW = BORE - 0.0072;
  const FLUTE_HIGH = BORE + 0.0062;
  // 3 mm deep. At 1.7 mm the fillets swallowed it and the flank still rendered
  // as one flat wall — a relief only reads once its lip casts its own shadow.
  const FLUTE_X = SLIDE_W / 2 - 0.0030;
  const flutedSection = roundedPoly(
    [
      [-SLIDE_W / 2, SLIDE_BOTTOM],
      [SLIDE_W / 2, SLIDE_BOTTOM],
      [SLIDE_W / 2, FLUTE_LOW],
      [FLUTE_X, FLUTE_LOW + 0.0016],
      [FLUTE_X, FLUTE_HIGH - 0.0016],
      [SLIDE_W / 2, FLUTE_HIGH],
      [SLIDE_W / 2, SLIDE_TOP - 0.005],
      [0.0112, SLIDE_TOP],
      [-0.0112, SLIDE_TOP],
      [-SLIDE_W / 2, SLIDE_TOP - 0.005],
      [-SLIDE_W / 2, FLUTE_HIGH],
      [-FLUTE_X, FLUTE_HIGH - 0.0016],
      [-FLUTE_X, FLUTE_LOW + 0.0016],
      [-SLIDE_W / 2, FLUTE_LOW],
    ],
    0.0009,
  );
  // A 60 mm port sitting just ahead of the rear sight. The old 135 mm cut ran
  // most of the length of the gun and read as a slot milled in a bar. Notching
  // the *fluted* outline lets the port swallow the relief on the right flank
  // while the left flank keeps it, which is what the real slide does.
  const PORT_BACK = 0.040;
  const PORT_FRONT = -0.020;
  const portSection = notchFlank(flutedSection, BORE - 0.008, BORE + 0.012, 0.0104);
  slideKit.add(
    'steel',
    steel,
    place(extrudeZ(slideSection, SLIDE_BACK - PORT_BACK), 0, 0, (SLIDE_BACK + PORT_BACK) / 2),
    place(extrudeZ(portSection, PORT_BACK - PORT_FRONT, 0.0015), 0, 0, (PORT_BACK + PORT_FRONT) / 2),
    place(extrudeZ(flutedSection, PORT_FRONT - SLIDE_FRONT, 0.0015), 0, 0, (PORT_FRONT + SLIDE_FRONT) / 2),
  );
  // Deagle cocking cuts stand straight up rather than raking forward, and there
  // is only the one rack: the front of the slide is where the flute lives.
  slideKit.add(
    'steel',
    steel,
    ...serrations(9, 0.0058, 0.084, SLIDE_W / 2 - 0.0004, SLIDE_MID + 0.0015, SLIDE_H * 0.74, 0.0026, 0),
  );
  // The bolt face sits inside the port rather than being painted on top of it.
  slideKit.add('bright', bright, place(box(0.020, 0.019, 0.058, 0.0028), 0.008, BORE - 0.001, 0.010));
  slideKit.add('dark', dark, place(box(0.012, 0.011, 0.040, 0.0018), 0.0132, BORE + 0.001, 0.004));
  slideKit.add('bright', bright, place(box(0.0035, 0.008, 0.028, 0.0008), 0.0148, BORE + 0.007, 0.022));

  // Rear sight, on a tower tall enough to see over the barrel rib in front of
  // it. Its top face is the notch floor, and SIGHT_Y is measured off that.
  slideKit.add('steel', steel, place(box(0.017, 0.0129, 0.011, 0.0016), 0, SLIDE_TOP + 0.0058, 0.061));
  for (const side of [-1, 1]) {
    slideKit.add('bright', bright, place(box(0.0072, 0.008, 0.0098, 0.0009), side * 0.0064, SLIDE_TOP + 0.0162, 0.061));
    slideKit.add('dot', dotMat, place(new SphereGeometry(0.0011, 8, 6), side * 0.0064, SLIDE_TOP + 0.0166, 0.0655));
  }
  // The safety is on the *slide* on this pistol, not the frame: a big
  // ambidextrous paddle on each rear flank, and the single fastest way to read
  // the gun correctly in silhouette.
  for (const side of [-1, 1]) {
    slideKit.add(
      'bright',
      bright,
      place(box(0.0048, 0.0115, 0.024, 0.0022), side * (SLIDE_W / 2 + 0.0011), BORE + 0.012, 0.069),
      place(barrel(0.0064, 0.0064, 0.005, 14), side * (SLIDE_W / 2 + 0.0008), BORE + 0.012, 0.0565, 0, Math.PI / 2, 0),
    );
  }
  slideKit.flushInto(slide, true);
  root.add(slide);

  /* --- Fixed barrel, rail and gas cylinder ----------------------------- */
  //
  // The barrel is bolted to the frame on a Desert Eagle — the slide cycles
  // around it — so it lives in the body group. That is also what makes the
  // action read: firing pulls the slide back off a barrel that stays put.
  const fk = new MeshKit();
  const BARREL_BACK = -0.060;
  const barrelSection = roundedPoly(
    [
      [-0.0120, BORE - 0.0115],
      [0.0120, BORE - 0.0115],
      [0.0120, SLIDE_TOP - 0.004],
      [0.0094, SLIDE_TOP],
      [-0.0094, SLIDE_TOP],
      [-0.0120, SLIDE_TOP - 0.004],
    ],
    [0.0032, 0.0032, 0.0028, 0.0018, 0.0018, 0.0028],
  );
  fk.add(
    'steel',
    steel,
    place(extrudeZ(barrelSection, BARREL_BACK - MUZZLE_Z), 0, 0, (BARREL_BACK + MUZZLE_Z) / 2),
  );
  // The rib, and the Weaver slots cut across it. This is the part that has to
  // stand *above* the slide: it starts over the middle of the slide, rides its
  // deck forward, and carries on past the slide's front face to the muzzle. A
  // rail sunk flush into the slide top is what flattened the old silhouette.
  const RIB_BACK = 0.012;
  fk.add(
    'steel',
    steel,
    place(box(RIB_W, RIB_TOP - SLIDE_TOP, RIB_BACK - MUZZLE_Z, 0.0012), 0, (RIB_TOP + SLIDE_TOP) / 2, (RIB_BACK + MUZZLE_Z) / 2),
  );
  for (let i = 0; i < 16; i++) {
    fk.add('steel', steel, place(box(RIB_W, 0.0034, 0.0056, 0.0009), 0, RIB_TOP + 0.0017, 0.006 - i * 0.0098));
  }
  // Gas is tapped near the muzzle and driven back down this cylinder into the
  // frame. Nothing else on a pistol puts a second tube under the barrel, so the
  // step it cuts into the underside is worth the two extra solids.
  // Round, not a squared rrect: a tube catches one long highlight down its
  // length, which is what separates it from the squared barrel above it.
  fk.add('steel', steel, place(rod(0.0072, 0.084, 18), 0, BORE - 0.0165, -0.110));
  fk.add('steel', steel, place(box(0.019, 0.022, 0.020, 0.0022), 0, BORE - 0.012, -0.158));
  // Squared muzzle face with a recessed crown, not a lathed round nose.
  fk.add(
    'bright',
    bright,
    place(lathe([[0.0064, 0], [0.0088, 0.0014], [0.0088, 0.0042], [0.0064, 0.0042]], 20), 0, BORE, MUZZLE_Z),
  );
  fk.add('dark', dark, bore(0.0062, BORE, MUZZLE_Z, 0.032));
  // Front blade, dovetailed into the rib and standing to the same height as the
  // rear notch floor so the two frame each other.
  fk.add('steel', steel, place(box(0.0078, 0.0055, 0.013, 0.0012), 0, SLIDE_TOP + 0.005, -0.148));
  fk.add('bright', bright, place(box(0.0034, 0.0105, 0.0040, 0.0009), 0, SLIDE_TOP + 0.007, -0.148));
  fk.add('dot', dotMat, place(new SphereGeometry(0.0013, 8, 6), 0, SLIDE_TOP + 0.0106, -0.1461));

  /* --- Frame ------------------------------------------------------------ */
  // The dust cover stops with the slide instead of running to the muzzle, which
  // is what leaves the barrel and gas cylinder standing clear of it.
  fk.add(
    'frame',
    frameMat,
    place(extrudeZ(rrect(0.029, 0.019, 0.004, 0, BORE - 0.0225), 0.096), 0, 0, -0.024),
    place(extrudeZ(rrect(0.032, 0.023, 0.005, 0, BORE - 0.0245), 0.086), 0, 0, 0.055),
  );
  // Mark XIX accessory rail, slots facing down where they belong.
  fk.add('frame', frameMat, place(box(0.019, 0.004, 0.050, 0.0009), 0, BORE - 0.0335, -0.046));
  for (let i = 0; i < 5; i++) {
    fk.add('frame', frameMat, place(box(0.019, 0.0042, 0.0056, 0.0009), 0, BORE - 0.0352, -0.026 - i * 0.0098));
  }
  // Frame rails proud of the flanks, so the slide/frame seam is a line of
  // hardware rather than a change of colour.
  for (const side of [-1, 1]) {
    fk.add(
      'bright',
      bright,
      place(box(0.0038, 0.007, 0.026, 0.0011), side * 0.0172, BORE - 0.019, 0.050),
      place(box(0.0038, 0.007, 0.022, 0.0011), side * 0.0157, BORE - 0.019, -0.032),
    );
  }

  /* --- Grip ------------------------------------------------------------- */
  // Slab-sided and deep front-to-back. The high exponents matter: a Desert
  // Eagle grip is a rectangular block with broken edges, and rounding it into
  // an oval is what makes a big pistol read as a toy.
  const grip: LoftSection[] = [
    { z: 0.029, y: BORE - 0.024, w: 0.035, h: 0.054, n: 5.0 },
    { z: 0.036, y: BORE - 0.046, w: 0.037, h: 0.052, n: 5.4 },
    { z: 0.044, y: BORE - 0.068, w: 0.038, h: 0.049, n: 5.8 },
    { z: 0.052, y: BORE - 0.090, w: 0.038, h: 0.046, n: 6.0 },
    { z: 0.059, y: BORE - 0.108, w: 0.037, h: 0.044, n: 6.0 },
    { z: 0.062, y: BORE - 0.116, w: 0.041, h: 0.047, n: 5.4 },
  ];
  fk.add('frame', frameMat, loft(grip, 24));
  // Pebble stippling, not a diamond lattice: the Desert Eagle's panel is a
  // coarse moulded grain, and a tidy checkered grid reads as a target pistol.
  fk.add(
    'panel',
    Presets.gunPolymer(0x303238),
    ...checkering(
      [
        [0.036, BORE - 0.043],
        [0.039, BORE - 0.053],
        [0.042, BORE - 0.063],
        [0.045, BORE - 0.073],
        [0.048, BORE - 0.083],
        [0.051, BORE - 0.093],
        [0.054, BORE - 0.103],
      ],
      0.0192,
      7,
      0.0052,
      0.0025,
    ),
  );
  // Beavertail tang, flared heel, and the exposed spur hammer standing behind
  // the slide's rear face — a cocked single-action hammer in the open is one of
  // the gun's loudest cues and it costs two solids.
  fk.add('frame', frameMat, place(box(0.026, 0.013, 0.040, 0.0045), 0, BORE - 0.021, 0.080, -0.16));
  fk.add('frame', frameMat, place(box(0.041, 0.009, 0.020, 0.003), 0, BORE - 0.118, 0.062));
  fk.add(
    'bright',
    bright,
    place(box(0.0062, 0.019, 0.011, 0.0022), 0, BORE - 0.006, 0.0965, 0.22),
    place(barrel(0.0058, 0.0058, 0.0075, 14), 0, BORE - 0.017, 0.0925, 0, Math.PI / 2, 0),
  );
  fk.add('bright', bright, ...pin(0.0196, BORE - 0.034, 0.046, 0.0026));

  /* --- Controls and trigger -------------------------------------------- */
  // Slide stop above the trigger and the oversized magazine release behind the
  // guard, both left-side only: the ambidextrous lever on this pistol is the
  // slide safety above, and duplicating it here reads as two safeties.
  fk.add('bright', bright, place(box(0.0042, 0.011, 0.030, 0.0012), -0.0172, BORE - 0.021, 0.014));
  fk.add('bright', bright, place(barrel(0.0055, 0.0055, 0.006, 14), -0.0172, BORE - 0.042, 0.036, 0, Math.PI / 2, 0));
  fk.add('frame', frameMat, triggerGuard(-0.006, 0.032, BORE - 0.036, BORE - 0.068, 0.028, 0.0065));
  fk.flushInto(body, true);
  root.add(body);

  /* --- Magazine --------------------------------------------------------- */
  const magazine = new Group();
  magazine.name = 'magazine';
  new MeshKit()
    .add(
      'mag',
      Presets.gunSteel(0x73777e),
      loft(
        [
          { z: 0.033, y: BORE - 0.030, w: 0.023, h: 0.040, n: 5.2 },
          { z: 0.048, y: BORE - 0.088, w: 0.023, h: 0.039, n: 5.2 },
          { z: 0.060, y: BORE - 0.119, w: 0.022, h: 0.038, n: 5.2 },
        ],
        16,
      ),
    )
    .add('floorplate', dark, place(box(0.028, 0.008, 0.044, 0.0018), 0, BORE - 0.122, 0.061, -0.14))
    .add('base', bright, place(box(0.019, 0.003, 0.027, 0.0008), 0, BORE - 0.127, 0.062))
    .flushInto(magazine);
  root.add(magazine);

  /* --- Trigger ---------------------------------------------------------- */
  // No charging group: a Desert Eagle is racked by its slide serrations, and
  // the reload animation falls back to the slide for exactly that.
  const trigger = new Group();
  trigger.name = 'trigger';
  new MeshKit().add('bright', bright, triggerBlade(0.010, BORE - 0.036)).flushInto(trigger);
  root.add(trigger);

  root.add(marker('muzzle', 0, BORE, MUZZLE_Z));
  root.add(marker('eject', 0.018, BORE + 0.002, 0.012));

  return {
    root,
    muzzle: root.getObjectByName('muzzle')!,
    ejectPort: root.getObjectByName('eject')!,
    slide,
    magazine,
    charging: null,
    trigger,
    sightHeight: SIGHT_Y,
    sightForward: -0.061,
  };
}

/* ------------------------------------------------------------------ */
/* Barrett M82A1 anti-materiel rifle                                  */
/* ------------------------------------------------------------------ */

/**
 * Semi-automatic .50 BMG rifle.
 *
 * The M82A1 is deliberately built as a long, heavy system: a separate upper
 * and lower receiver, side ejection port, scope mounts, oversized magazine,
 * stepped barrel, vented brake, recoil pad and folded bipod. Its proportions
 * are tuned for this game's viewmodel scale, but the relationships are kept
 * intact so it reads as an M82A1 beside the shorter M4 instead of as a very
 * long rifle.
 */
export function buildBarrettM82A1(): GunModel {
  const root = new Group();
  // The receiver is parkerised, but a fully metallic preset turns its broad
  // side faces into a silhouette under the studio environment. This tuned
  // gunmetal keeps the matte military finish while retaining enough diffuse
  // response to show the port, ribs and receiver transitions.
  const steel = makeSurface('gunmetal', {
    repeat: 1,
    tint: 0x78818d,
    roughness: 0.88,
    metalness: 0.38,
    normalScale: 0.55,
  });
  const bright = Presets.brightSteel(0xe1e4e8);
  const polymer = Presets.gunPolymer(0x30343b);
  const dark = Presets.gunSteel(0x15181c);
  const rubber = Presets.rubber(0x17181b);
  const body = new Group();
  const kit = new MeshKit();

  const BORE = 0.024;
  const UPPER_BACK = 0.148;
  const UPPER_FRONT = -0.268;
  const upperOutline: [number, number][] = [
    [-0.031, BORE - 0.034],
    [0.031, BORE - 0.034],
    [0.031, BORE + 0.026],
    [0.022, BORE + 0.039],
    [-0.022, BORE + 0.039],
    [-0.031, BORE + 0.026],
  ];
  const upperSection = roundedPoly(upperOutline, [0.006, 0.006, 0.007, 0.004, 0.004, 0.007]);
  const PORT_BACK = 0.038;
  const PORT_FRONT = -0.082;
  const portSection = notchFlank(upperSection, BORE - 0.018, BORE + 0.013, 0.020);

  /* --- Upper receiver --------------------------------------------------- */
  kit.add(
    'steel',
    steel,
    place(extrudeZ(upperSection, UPPER_BACK - PORT_BACK), 0, 0, (UPPER_BACK + PORT_BACK) / 2),
    place(extrudeZ(portSection, PORT_BACK - PORT_FRONT, 0.0016), 0, 0, (PORT_BACK + PORT_FRONT) / 2),
    place(extrudeZ(upperSection, PORT_FRONT - UPPER_FRONT), 0, 0, (PORT_FRONT + UPPER_FRONT) / 2),
  );
  // Bolt face and carrier visible through the ejection port.
  kit.add('bright', bright, place(box(0.028, 0.031, 0.095, 0.0035), 0.022, BORE - 0.004, -0.013));
  kit.add('dark', dark, place(box(0.021, 0.021, 0.067, 0.0025), 0.026, BORE + 0.002, -0.018));
  kit.add('bright', bright, place(box(0.004, 0.011, 0.039, 0.0012), 0.031, BORE + 0.005, 0.015));
  // Full-length top rail: the repeated cross ribs are visible even when the
  // optic is removed by a future feature.
  kit.add('poly', polymer, ...rail(0.340, 0.031, UPPER_BACK - 0.006, BORE + 0.043));
  // Receiver side ribs and the large hinge/pin bosses.
  for (let i = 0; i < 5; i++) {
    kit.add('steel', steel, place(box(0.004, 0.022, 0.032, 0.0012), 0.0325, BORE - 0.004, 0.090 - i * 0.052));
  }
  kit.add('bright', bright, ...pin(0.033, BORE - 0.022, 0.106, 0.0062, 0.0034));
  kit.add('bright', bright, ...pin(0.033, BORE - 0.022, -0.076, 0.0062, 0.0034));

  /* --- Lower receiver and fire control --------------------------------- */
  kit.add(
    'poly',
    polymer,
    place(extrudeZ(rrect(0.056, 0.064, 0.010, 0, BORE - 0.023), 0.184), 0, 0, 0.004),
    place(extrudeZ(rrect(0.060, 0.043, 0.008, 0, BORE - 0.070), 0.072), 0, 0, -0.053),
  );
  kit.add('dark', dark, place(box(0.046, 0.008, 0.064, 0.002, 2), 0, BORE - 0.057, -0.038));
  kit.add('bright', bright, ...pin(0.030, BORE - 0.020, 0.065, 0.0048));
  kit.add('bright', bright, place(box(0.004, 0.016, 0.030, 0.0012), -0.030, BORE - 0.022, 0.024));
  kit.add('bright', bright, place(barrel(0.0055, 0.0055, 0.007, 12), 0.031, BORE - 0.024, 0.022, 0, Math.PI / 2, 0));
  kit.add('poly', polymer, triggerGuard(0.007, 0.068, BORE - 0.061, BORE - 0.102, 0.040, 0.007));

  /* --- Pistol grip and stock ------------------------------------------- */
  kit.add(
    'poly',
    polymer,
    loft(
      [
        { z: 0.050, y: BORE - 0.056, w: 0.039, h: 0.060, n: 4.2 },
        { z: 0.061, y: BORE - 0.077, w: 0.042, h: 0.058, n: 4.4 },
        { z: 0.075, y: BORE - 0.103, w: 0.043, h: 0.054, n: 4.6 },
        { z: 0.089, y: BORE - 0.127, w: 0.041, h: 0.050, n: 4.8 },
        { z: 0.098, y: BORE - 0.143, w: 0.044, h: 0.052, n: 5.0 },
      ],
      24,
    ),
  );
  kit.add(
    'panel',
    Presets.gunPolymer(0x31343a),
    ...checkering(
      [
        [0.061, BORE - 0.080],
        [0.067, BORE - 0.093],
        [0.074, BORE - 0.107],
        [0.081, BORE - 0.121],
        [0.088, BORE - 0.134],
      ],
      0.0215,
      5,
      0.0090,
      0.0030,
    ),
  );
  // Long receiver extension into the distinctive M82 shoulder stock.
  kit.add('poly', polymer, place(box(0.047, 0.050, 0.083, 0.008, 3), 0, BORE - 0.010, 0.118));
  kit.add(
    'poly',
    polymer,
    loft(
      [
        { z: 0.098, y: BORE - 0.007, w: 0.052, h: 0.064, n: 4.0 },
        { z: 0.145, y: BORE - 0.010, w: 0.056, h: 0.069, n: 4.2 },
        { z: 0.200, y: BORE - 0.014, w: 0.060, h: 0.076, n: 4.2 },
        { z: 0.253, y: BORE - 0.018, w: 0.062, h: 0.083, n: 4.0 },
        { z: 0.286, y: BORE - 0.019, w: 0.061, h: 0.087, n: 4.0 },
      ],
      24,
    ),
  );
  // Cheek weld and the squared recoil pad are separate silhouettes, not a
  // single inflated stock blob.
  kit.add('poly', polymer, place(box(0.058, 0.012, 0.095, 0.004, 3), 0, BORE + 0.023, 0.188));
  kit.add('rubber', rubber, place(extrudeZ(rrect(0.064, 0.090, 0.012, 0, BORE - 0.019), 0.017), 0, 0, 0.300));
  kit.add('bright', bright, ...pin(0.031, BORE - 0.040, 0.203, 0.0042));

  /* --- Barrel, brake and folded bipod ---------------------------------- */
  const CHAMBER_Z = -0.306;
  kit.add('steel', steel, place(rod(0.027, 0.105, 28), 0, BORE, CHAMBER_Z));
  kit.add('steel', steel, place(barrel(0.027, 0.019, 0.016, 28), 0, BORE, -0.366));
  kit.add('bright', bright, place(rod(0.019, 0.338, 24), 0, BORE, -0.530));
  kit.add(
    'steel',
    steel,
    place(
      lathe(
        [
          [0.0, 0.0],
          [0.019, 0.0],
          [0.023, 0.006],
          [0.026, 0.016],
          [0.026, 0.071],
          [0.023, 0.078],
          [0.0, 0.078],
        ],
        24,
      ),
      0,
      BORE,
      -0.773,
    ),
  );
  kit.add('dark', dark, bore(0.014, BORE, -0.774, 0.035));
  // Vents are actual raised openings around the brake, with a dark interior
  // behind them so the muzzle reads as a device rather than a fat cylinder.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.24;
    kit.add('dark', dark, place(box(0.006, 0.009, 0.027, 0.001, 2), Math.cos(a) * 0.024, BORE + Math.sin(a) * 0.024, -0.734));
  }
  // Deployed bipod. The legs have to splay: at the original ±16 mm of spread
  // the two of them overlapped into a single dark strut hanging under the
  // barrel, which reads as a broken part rather than as a bipod. A real M82
  // stance is nearly as wide as the receiver, and it is the triangle between
  // the two legs that makes the assembly legible in silhouette.
  for (const side of [-1, 1]) {
    kit.add('steel', steel, place(box(0.010, 0.104, 0.017, 0.002, 2), side * 0.024, BORE - 0.070, -0.330, 0, 0, side * 0.42));
    kit.add('rubber', rubber, place(box(0.015, 0.018, 0.023, 0.003), side * 0.063, BORE - 0.118, -0.334, 0, 0, side * 0.42));
    kit.add('bright', bright, place(barrel(0.005, 0.005, 0.008, 12), side * 0.014, BORE - 0.028, -0.325, 0, Math.PI / 2, 0));
  }
  // Yoke tying both legs to the barrel, so they hang off hardware rather than
  // starting in mid-air just below the tube.
  kit.add('steel', steel, place(box(0.052, 0.016, 0.024, 0.003), 0, BORE - 0.030, -0.325));

  /* --- Scope and rail hardware ----------------------------------------- */
  //
  // The ocular sits well behind the ejection port so the eye relief in ADS is a
  // rifle's, not a pistol's. `telescopicSight` builds the assembly hollow: the
  // player looks through it to the world, and the rings bridge the measured gap
  // down to the rail rather than hovering above it.
  const scopeY = BORE + 0.074;
  const scope = new Group();
  scope.name = 'scope';
  const scopeKit = new MeshKit();
  const sightPicture = telescopicSight(scopeKit, {
    y: scopeY,
    zRear: 0.086,
    length: 0.210,
    radius: 0.019,
    railY: BORE + 0.043 + 0.0059,
    ringZ: [0.032, -0.082],
    bodyTint: 0x272c34,
    reticleTint: 0xffb04a,
  });
  scopeKit.flushInto(scope, true);
  scope.add(sightPicture);
  root.add(scope);

  kit.flushInto(body, true);
  root.add(body);

  /* --- Ten-round magazine ---------------------------------------------- */
  //
  // Shortened from 176 mm to 78 mm. On a real M82 the floorplate finishes level
  // with the heel of the pistol grip; at 176 mm this one bottomed out 110 mm
  // *past* it — deeper below the receiver than the receiver is tall — and hung
  // under the weapon like a pendulum. 78 mm leaves it a few millimetres proud
  // of the grip, so it still reads as the deepest thing on the gun without
  // being the first thing the eye lands on.
  //
  // The box is deepened front-to-back at the same time. A .50 BMG round is
  // 138 mm long and stacks along the bore, so the real magazine is far wider
  // than it is tall; 74 mm matches the magwell above it, and without that the
  // shortened box would have read as a thin blade. Everything hung off the
  // body follows the spine, so the floorplate and witness slot come up with it
  // — after the -0.16 rad curve the spine ends near BORE - 0.148, not at the
  // old BORE - 0.227.
  const magazine = new Group();
  magazine.name = 'magazine';
  new MeshKit()
    .add(
      'mag',
      Presets.gunSteel(0x42464d),
      ...curvedMagazine({
        z: -0.053,
        y: BORE - 0.070,
        length: 0.078,
        width: 0.043,
        depth: 0.074,
        curve: -0.16,
        taper: 0.02,
      }),
    )
    // Seated on the end of the spine rather than 16 mm ahead of it: the old
    // offset left the plate overhanging the front of the box.
    .add('floorplate', dark, place(box(0.047, 0.010, 0.078, 0.0024), 0, BORE - 0.1515, -0.0589, -0.09))
    .add('witness', bright, place(box(0.0025, 0.012, 0.030, 0.0006), 0.0215, BORE - 0.105, -0.054))
    .flushInto(magazine);
  root.add(magazine);

  /* --- Charging handle and bolt/trigger animation --------------------- */
  const charging = new Group();
  charging.name = 'charging';
  new MeshKit()
    .add('bright', bright, place(box(0.008, 0.012, 0.034, 0.0018), -0.036, BORE + 0.003, 0.090))
    .add('bright', bright, place(box(0.014, 0.010, 0.019, 0.0018), -0.036, BORE + 0.003, 0.070))
    .flushInto(charging);
  root.add(charging);

  const slide = new Group();
  slide.name = 'slide';
  // A separate carrier proxy lets fire animation move the heavy bolt mass
  // without moving the receiver shell or hiding the port cut.
  new MeshKit()
    .add('bright', bright, place(box(0.024, 0.025, 0.088, 0.003), 0.022, BORE - 0.003, -0.018))
    .flushInto(slide);
  root.add(slide);

  const trigger = new Group();
  trigger.name = 'trigger';
  new MeshKit().add('bright', bright, triggerBlade(0.026, BORE - 0.065, 0.0062)).flushInto(trigger);
  root.add(trigger);

  root.add(marker('muzzle', 0, BORE, -0.776));
  root.add(marker('eject', 0.036, BORE + 0.001, -0.018));

  return {
    root,
    muzzle: root.getObjectByName('muzzle')!,
    ejectPort: root.getObjectByName('eject')!,
    slide,
    magazine,
    charging,
    trigger,
    sightPicture,
    sightHeight: scopeY,
    sightForward: -0.086,
  };
}

/* ------------------------------------------------------------------ */
/* M240 general-purpose machine gun                                    */
/* ------------------------------------------------------------------ */

/**
 * Belt-fed M240.
 *
 * This is built around the parts that make a GPMG immediately legible from a
 * first-person view: a slab-sided receiver with a true open port, hinged feed
 * cover, exposed belt, hanging 100-round can, quick-change barrel hardware,
 * gas tube and folded bipod. It is intentionally not an M4 with a larger box
 * magazine; every major silhouette comes from a belt-fed assembly.
 */
export function buildM240(): GunModel {
  const root = new Group();
  const parkerized = makeSurface('gunmetal', {
    repeat: 1,
    // Same finish family as the SPAS, lifted just enough that the receiver
    // ribs, feed cover and barrel-change hardware remain legible in the
    // game's intentionally dark terminal lighting.
    tint: 0xa8b4bc,
    roughness: 0.9,
    metalness: 0.4,
    normalScale: 0.54,
  });
  const bright = Presets.brightSteel(0xc7ccd1);
  const polymer = Presets.gunPolymer(0x838d93);
  const dark = Presets.gunSteel(0x101316);
  const rubber = Presets.rubber(0x141719);
  const body = new Group();
  const kit = new MeshKit();

  const BORE = 0.025;
  const RECV_CY = BORE - 0.014;

  /* --- Receiver, port and feed tray ----------------------------------- */
  const RECV_BACK = 0.175;
  const RECV_FRONT = -0.248;
  const recvSection = roundedPoly(
    [
      [-0.033, RECV_CY - 0.035],
      [0.033, RECV_CY - 0.035],
      [0.033, RECV_CY + 0.032],
      [0.025, RECV_CY + 0.044],
      [-0.025, RECV_CY + 0.044],
      [-0.033, RECV_CY + 0.032],
    ],
    [0.0065, 0.0065, 0.008, 0.004, 0.004, 0.008],
  );
  const PORT_BACK = 0.074;
  const PORT_FRONT = -0.090;
  const portSection = notchFlank(recvSection, RECV_CY - 0.014, RECV_CY + 0.017, 0.0205);
  kit.add(
    'parkerized',
    parkerized,
    place(extrudeZ(recvSection, RECV_BACK - PORT_BACK), 0, 0, (RECV_BACK + PORT_BACK) / 2),
    place(extrudeZ(portSection, PORT_BACK - PORT_FRONT, 0.0016), 0, 0, (PORT_BACK + PORT_FRONT) / 2),
    place(extrudeZ(recvSection, PORT_FRONT - RECV_FRONT), 0, 0, (PORT_FRONT + RECV_FRONT) / 2),
  );
  // Reinforcing ribs are on the flanks, not across the top, preserving the
  // long receiver silhouette while making the broad side face catch light.
  for (let i = 0; i < 7; i++) {
    kit.add('parkerized', parkerized, place(box(0.004, 0.026, 0.024, 0.001), 0.0338, RECV_CY, 0.143 - i * 0.046));
  }
  kit.add('dark', dark, place(box(0.052, 0.008, 0.138, 0.0018), 0, RECV_CY - 0.034, -0.013));
  kit.add('dark', dark, place(box(0.046, 0.006, 0.112, 0.0015), 0, BORE + 0.033, -0.015));
  kit.add('bright', bright, ...pin(0.034, RECV_CY - 0.018, 0.139, 0.0054, 0.0036));
  kit.add('bright', bright, ...pin(0.034, RECV_CY - 0.018, -0.126, 0.0054, 0.0036));
  kit.add('bright', bright, place(box(0.006, 0.016, 0.028, 0.0013), -0.035, RECV_CY - 0.010, 0.052, 0.24));

  // Full-length rail and its mounting blocks sit on the receiver, leaving the
  // feed cover as an independently hinged part for the belt reload animation.
  kit.add('polymer', polymer, ...rail(0.296, 0.035, 0.145, BORE + 0.0435));
  for (const z of [0.094, 0.010, -0.074]) {
    kit.add('parkerized', parkerized, place(box(0.045, 0.008, 0.016, 0.002), 0, BORE + 0.035, z));
  }

  /* --- Trigger group, grip and stock ---------------------------------- */
  kit.add('polymer', polymer, place(extrudeZ(rrect(0.060, 0.057, 0.009, 0, BORE - 0.060), 0.148), 0, 0, 0.050));
  kit.add('polymer', polymer, triggerGuard(-0.010, 0.072, BORE - 0.070, BORE - 0.111, 0.042, 0.007));
  kit.add('bright', bright, place(barrel(0.005, 0.005, 0.008, 12), 0.034, BORE - 0.038, 0.038, 0, Math.PI / 2, 0));
  kit.add('bright', bright, place(box(0.006, 0.012, 0.022, 0.0014), -0.034, BORE - 0.034, 0.039));

  kit.add(
    'polymer',
    polymer,
    loft(
      [
        { z: 0.070, y: BORE - 0.066, w: 0.043, h: 0.061, n: 4.2 },
        { z: 0.083, y: BORE - 0.089, w: 0.046, h: 0.059, n: 4.4 },
        { z: 0.099, y: BORE - 0.115, w: 0.047, h: 0.055, n: 4.6 },
        { z: 0.112, y: BORE - 0.136, w: 0.044, h: 0.051, n: 4.8 },
      ],
      24,
    ),
  );
  kit.add(
    'panel',
    Presets.gunPolymer(0x3a3e42),
    ...checkering([[0.084, BORE - 0.090], [0.091, BORE - 0.103], [0.099, BORE - 0.116], [0.106, BORE - 0.128]], 0.024, 5, 0.008, 0.0027),
  );

  // The stock is a separate cheek piece over a hollow receiver extension and
  // a thick, visible recoil pad, keeping it recognisable as a machine-gun
  // stock rather than another solid rifle butt.
  kit.add('polymer', polymer, place(box(0.054, 0.051, 0.092, 0.006, 3), 0, BORE - 0.001, 0.187));
  kit.add(
    'polymer',
    polymer,
    loft(
      [
        { z: 0.172, y: BORE - 0.011, w: 0.061, h: 0.075, n: 4.1 },
        { z: 0.222, y: BORE - 0.015, w: 0.068, h: 0.083, n: 4.0 },
        { z: 0.273, y: BORE - 0.020, w: 0.069, h: 0.091, n: 4.0 },
      ],
      24,
    ),
  );
  kit.add('polymer', polymer, place(box(0.064, 0.014, 0.105, 0.004, 3), 0, BORE + 0.029, 0.226));
  kit.add('rubber', rubber, place(extrudeZ(rrect(0.073, 0.096, 0.012, 0, BORE - 0.020), 0.018), 0, 0, 0.288));
  kit.add('bright', bright, ...pin(0.036, BORE - 0.036, 0.208, 0.0046));

  /* --- Quick-change barrel, gas tube, handguard and bipod ------------- */
  const CHAMBER_Z = -0.299;
  kit.add('parkerized', parkerized, place(rod(0.027, 0.112, 26), 0, BORE, CHAMBER_Z));
  kit.add('parkerized', parkerized, place(barrel(0.027, 0.0185, 0.018, 26), 0, BORE, -0.364));
  kit.add('bright', bright, place(rod(0.0185, 0.410, 24), 0, BORE, -0.578));
  // Stepped flash hider, with a deep bore and dark ports inset behind its fins.
  kit.add(
    'parkerized',
    parkerized,
    place(
      lathe(
        [[0.0, 0.0], [0.0185, 0.0], [0.022, 0.006], [0.022, 0.046], [0.020, 0.054], [0.0, 0.054]],
        24,
      ),
      0,
      BORE,
      -0.864,
    ),
  );
  kit.add('dark', dark, bore(0.0125, BORE, -0.864, 0.038));
  for (let i = 0; i < 5; i++) {
    const z = -0.823 - i * 0.008;
    kit.add('dark', dark, place(box(0.010, 0.008, 0.004, 0.0007), 0.019, BORE + 0.010, z));
  }

  const GAS_Y = BORE - 0.034;
  kit.add('bright', bright, place(rod(0.0082, 0.442, 20), 0, GAS_Y, -0.565));
  kit.add('parkerized', parkerized, place(rod(0.0115, 0.054, 20), 0, GAS_Y, -0.357));
  kit.add('bright', bright, place(rod(0.010, 0.030, 20), 0, GAS_Y, -0.760));
  kit.add('dark', dark, place(box(0.014, 0.014, 0.028, 0.002), 0, GAS_Y, -0.372));

  // Ventilated barrel guard and folded bipod. The legs terminate in separate
  // rubber feet, which prevents the common "two dark sticks" silhouette.
  kit.add('parkerized', parkerized, place(box(0.050, 0.033, 0.204, 0.004, 3), 0, BORE - 0.013, -0.478));
  for (let i = 0; i < 9; i++) {
    const z = -0.400 - i * 0.022;
    for (const side of [-1, 1]) {
      kit.add('dark', dark, place(box(0.003, 0.011, 0.011, 0.0005), side * 0.026, BORE - 0.008, z));
    }
  }
  for (const side of [-1, 1]) {
    kit.add('parkerized', parkerized, place(box(0.010, 0.112, 0.018, 0.002, 2), side * 0.025, BORE - 0.086, -0.448, 0, 0, side * 0.18));
    kit.add('rubber', rubber, place(box(0.017, 0.021, 0.026, 0.003), side * 0.040, BORE - 0.139, -0.462, 0, 0, side * 0.18));
    kit.add('bright', bright, place(barrel(0.005, 0.005, 0.007, 12), side * 0.022, BORE - 0.040, -0.400, 0, Math.PI / 2, 0));
  }
  kit.add('bright', bright, place(new TorusGeometry(0.006, 0.0016, 8, 14), 0, BORE - 0.048, -0.675, 0, Math.PI / 2, 0));

  // Front blade and a protected rear aperture, both carried high enough to
  // clear the rail between them.
  //
  // The sight line has to be above *everything* it passes over, and on a GPMG
  // that includes 300 mm of its own top rail: at the old height the ribs stood
  // 3 mm proud of the line, so aiming looked through a picket fence. The rail
  // ribs top out at BORE + 0.0494, and the tower and post below are sized from
  // this constant rather than from their own literals so the pair cannot drift
  // apart if the height is retuned again.
  const SIGHT_Y = BORE + 0.062;
  const RAIL_Y = BORE + 0.0435;
  // The tower stops short of the aperture it carries. Running it up to the
  // sight line instead parks a slab of receiver across the middle of the sight
  // picture — the aperture ends up sitting on top of its own mount rather than
  // being the thing you look through.
  const TOWER_TOP = SIGHT_Y - 0.008;
  const TOWER_BOT = RAIL_Y - 0.004;
  kit.add(
    'parkerized',
    parkerized,
    place(box(0.026, TOWER_TOP - TOWER_BOT, 0.019, 0.002), 0, (TOWER_TOP + TOWER_BOT) / 2, 0.132),
  );
  kit.add('dark', dark, place(tube(0.0046, 0.0026, 0.011, 20), 0, SIGHT_Y, 0.132));
  kit.add('parkerized', parkerized, place(new TorusGeometry(0.0068, 0.0018, 8, 16), 0, SIGHT_Y, 0.132));
  // Front post on its own base off the barrel guard, hooded so the blade reads
  // against a bright wall instead of disappearing into it. Only the blade
  // reaches the sight line; the base stops well below it.
  kit.add(
    'parkerized',
    parkerized,
    place(box(0.013, SIGHT_Y - 0.012 - (BORE + 0.010), 0.017, 0.0018), 0, (SIGHT_Y - 0.012 + BORE + 0.010) / 2, -0.724),
  );
  kit.add('bright', bright, place(box(0.0036, 0.018, 0.006, 0.0006), 0, SIGHT_Y - 0.007, -0.726));
  kit.add('parkerized', parkerized, place(new TorusGeometry(0.0112, 0.0017, 8, 16), 0, SIGHT_Y - 0.003, -0.726));

  kit.flushInto(body, true);
  root.add(body);

  /* --- Animated feed cover and visible linked belt -------------------- */
  const feedCover = new Group();
  feedCover.name = 'feedCover';
  feedCover.position.set(0, BORE + 0.034, 0.057);
  const coverKit = new MeshKit();
  // Child geometry is forward of the hinge so the reload can visibly lift the
  // lid instead of rotating a symmetric rectangle in place.
  coverKit.add('parkerized', parkerized, place(box(0.060, 0.010, 0.158, 0.003), 0, 0.004, -0.076));
  coverKit.add('polymer', polymer, place(box(0.040, 0.006, 0.078, 0.002), 0, 0.011, -0.070));
  for (let i = 0; i < 7; i++) {
    coverKit.add('bright', bright, place(box(0.004, 0.006, 0.006, 0.0005), 0, 0.011, -0.030 - i * 0.018));
  }
  coverKit.flushInto(feedCover, true);
  root.add(feedCover);

  const magazine = new Group();
  magazine.name = 'beltBox';
  const canKit = new MeshKit();
  // A 100-round soft can hangs off the left/bottom of the receiver. The box
  // needs its own seams, latch and fabric fold so it reads as an ammo can,
  // not the generic detachable magazine used by the rifles.
  canKit.add('fabric', Presets.gunPolymer(0x3a4038), place(box(0.086, 0.096, 0.132, 0.005, 3), -0.043, BORE - 0.119, -0.018));
  canKit.add('dark', dark, place(box(0.065, 0.005, 0.105, 0.0012), -0.043, BORE - 0.168, -0.018));
  canKit.add('bright', bright, place(box(0.044, 0.010, 0.009, 0.0012), -0.043, BORE - 0.077, 0.043));
  for (const z of [-0.070, -0.018, 0.034]) {
    canKit.add('fabric', Presets.gunPolymer(0x464c43), place(box(0.090, 0.004, 0.007, 0.001), -0.043, BORE - 0.088, z));
  }
  // A short exposed linked belt bridges the box and the tray. The cartridges
  // are individually sized, alternating brass bodies with dark links, rather
  // than a single gold rod that would read as trim.
  for (let i = 0; i < 8; i++) {
    const z = 0.037 - i * 0.018;
    const y = BORE + 0.021 + Math.sin((i / 7) * Math.PI) * 0.006;
    canKit.add('brass', Presets.brass(), place(barrel(0.0042, 0.0032, 0.014, 12), 0.006, y, z));
    canKit.add('link', dark, place(box(0.014, 0.004, 0.004, 0.0006), 0.006, y, z + 0.006));
  }
  canKit.flushInto(magazine, true);
  root.add(magazine);

  // The heavy bolt stays visible in the port. The action animation moves this
  // actual carrier rather than the full receiver or the feed cover.
  const slide = new Group();
  slide.name = 'slide';
  new MeshKit()
    .add('bright', bright, place(box(0.026, 0.028, 0.105, 0.003), 0.024, RECV_CY - 0.002, -0.011))
    .add('dark', dark, place(box(0.017, 0.017, 0.070, 0.002), 0.029, RECV_CY + 0.003, -0.020))
    .flushInto(slide);
  root.add(slide);

  const charging = new Group();
  charging.name = 'charging';
  new MeshKit()
    .add('bright', bright, place(box(0.009, 0.012, 0.042, 0.0018), -0.041, RECV_CY + 0.006, 0.104))
    .add('bright', bright, place(box(0.016, 0.012, 0.021, 0.002), -0.041, RECV_CY + 0.006, 0.081))
    .flushInto(charging);
  root.add(charging);

  const trigger = new Group();
  trigger.name = 'trigger';
  new MeshKit().add('bright', bright, triggerBlade(0.028, BORE - 0.069, 0.0064)).flushInto(trigger);
  root.add(trigger);

  root.add(marker('muzzle', 0, BORE, -0.868));
  root.add(marker('eject', 0.041, RECV_CY + 0.002, -0.010));

  return {
    root,
    muzzle: root.getObjectByName('muzzle')!,
    ejectPort: root.getObjectByName('eject')!,
    slide,
    magazine,
    feedCover,
    charging,
    trigger,
    sightHeight: SIGHT_Y,
    sightForward: -0.132,
  };
}

/* ------------------------------------------------------------------ */
/* Aether-9 plasma sidearm                                             */
/* ------------------------------------------------------------------ */

/**
 * A purpose-built energy sidearm rather than a recoloured service pistol.
 * Its silhouette is a dense rear power cell and forward pressure chamber,
 * with a physically open luminous core so the cyan light has a believable
 * source instead of reading as paint on a conventional slide.
 */
export function buildAether9(): GunModel {
  const root = new Group();
  const steel = Presets.gunSteel(0x59606b);
  const dark = Presets.gunSteel(0x111721);
  const polymer = Presets.gunPolymer(0x202a31);
  const bright = Presets.brightSteel();
  const coreGlow = new MeshStandardMaterial({
    color: 0x5cecff,
    emissive: 0x25d9ff,
    emissiveIntensity: 2.4,
    roughness: 0.22,
    metalness: 0.45,
  });
  const coreDark = new MeshStandardMaterial({
    color: 0x123f55,
    emissive: 0x0c97ba,
    emissiveIntensity: 0.72,
    roughness: 0.3,
    metalness: 0.58,
  });

  const BORE = 0.018;
  const frame = new Group();
  const fk = new MeshKit();
  // A deep, squared receiver keeps the energy chamber visually separate from
  // the hand grip. The raised forward shroud wraps the plasma tube rather than
  // simply sitting under it as a generic rail.
  fk.add(
    'chassis',
    steel,
    place(extrudeZ(rrect(0.064, 0.064, 0.009, 0, BORE - 0.020), 0.164), 0, 0, -0.022),
    place(extrudeZ(rrect(0.052, 0.036, 0.006, 0, BORE + 0.004), 0.132), 0, 0, -0.154),
    place(box(0.074, 0.011, 0.084, 0.003, 3), 0, BORE + 0.020, -0.098),
  );
  fk.add(
    'shroud',
    dark,
    place(extrudeZ(rrect(0.046, 0.024, 0.004, 0, BORE + 0.008), 0.112), 0, 0, -0.145),
    place(rod(0.023, 0.046, 18), 0, BORE + 0.002, -0.242),
    place(rod(0.016, 0.038, 18), 0, BORE + 0.002, -0.278),
    bore(0.010, BORE + 0.002, -0.298, 0.027),
  );
  // Cooling slots need actual depth to read as ventilation rather than stripes.
  for (let i = 0; i < 5; i++) {
    const z = -0.112 - i * 0.023;
    for (const side of [-1, 1]) {
      fk.add('vent', dark, place(box(0.004, 0.010, 0.011, 0.0008), side * 0.034, BORE + 0.004, z));
    }
  }
  fk.add(
    'frame',
    polymer,
    place(extrudeZ(rrect(0.054, 0.028, 0.006, 0, BORE - 0.052), 0.075), 0, 0, 0.024),
    triggerGuard(-0.012, 0.040, BORE - 0.046, BORE - 0.084, 0.050, 0.007),
  );
  const gripSections: LoftSection[] = [
    { z: 0.034, y: BORE - 0.050, w: 0.047, h: 0.060, n: 4.5 },
    { z: 0.043, y: BORE - 0.076, w: 0.050, h: 0.057, n: 4.8 },
    { z: 0.053, y: BORE - 0.104, w: 0.048, h: 0.051, n: 5 },
    { z: 0.061, y: BORE - 0.128, w: 0.044, h: 0.046, n: 5 },
  ];
  fk.add('grip', polymer, loft(gripSections, 22));
  fk.add('accent', bright, ...pin(0.027, BORE - 0.043, 0.031, 0.0031));
  fk.flushInto(frame, true);
  root.add(frame);

  // The sealed pressure chamber reciprocates internally on recoil. Keeping its
  // animated pivot separate preserves the action contract without suspending a
  // second large assembly above the compact pistol silhouette.
  const slide = new Group();
  slide.name = 'plasmaCore';
  root.add(slide);

  // A removable capacitor replaces a conventional magazine. Its rear lugs and
  // illuminated seam make the reload read as swapping a power cell, not brass.
  const magazine = new Group();
  magazine.name = 'capacitor';
  new MeshKit()
    .add('cell', coreDark, place(box(0.039, 0.066, 0.067, 0.006, 3), 0, BORE - 0.105, 0.055, -0.16))
    .add('cellGlow', coreGlow, place(box(0.005, 0.039, 0.037, 0.0012), 0.023, BORE - 0.105, 0.055, -0.16))
    .add('cellLug', bright, place(box(0.047, 0.009, 0.014, 0.002), 0, BORE - 0.139, 0.065))
    .flushInto(magazine, true);
  root.add(magazine);

  const trigger = new Group();
  trigger.name = 'trigger';
  new MeshKit().add('trigger', bright, triggerBlade(0.011, BORE - 0.047, 0.006)).flushInto(trigger);
  root.add(trigger);

  // Sighting.
  //
  // The pistol previously declared a sight line at BORE + 0.015 with no sight
  // geometry anywhere on it — that height is inside the receiver's own top
  // deck, so aiming presented a flat plate and nothing else. An emitter sight
  // over the deck gives the weapon something to aim with and keeps the sight
  // picture open, which matters more here than on a rifle: the plasma chamber
  // fills the space a conventional slide's sight rib would occupy.
  const SIGHT_Y = BORE + 0.044;
  const sights = new MeshKit();
  reflexSight(sights, {
    y: SIGHT_Y,
    z: -0.070,
    baseY: BORE + 0.0255,
    width: 0.034,
    dotTint: 0x6ff0ff,
    frameTint: 0x1a222b,
  });
  sights.flushInto(root, true);

  root.add(marker('muzzle', 0, BORE + 0.002, -0.305));
  root.add(marker('eject', 0.034, BORE + 0.004, -0.016));
  return {
    root,
    muzzle: root.getObjectByName('muzzle')!,
    ejectPort: root.getObjectByName('eject')!,
    slide,
    magazine,
    charging: null,
    trigger,
    sightHeight: SIGHT_Y,
    sightForward: -(-0.070 - 0.009),
  };
}

/* ------------------------------------------------------------------ */
/* Stormweaver arc rifle                                               */
/* ------------------------------------------------------------------ */

/**
 * Coil rifle built around an exposed induction cage. The repeated copper rings
 * have enough separation to read as real high-voltage hardware at viewmodel
 * distance, while the buttstock and grip retain conventional, believable hand
 * contact points.
 */
export function buildStormweaver(): GunModel {
  const root = new Group();
  const steel = Presets.gunSteel(0x4f5660);
  const dark = Presets.gunSteel(0x10151e);
  const polymer = Presets.gunPolymer(0x262b35);
  const bright = Presets.brightSteel();
  const coilMetal = Presets.gunSteel(0x6d5b76);
  const arcGlow = new MeshStandardMaterial({
    color: 0xa990ff,
    emissive: 0x7c5cff,
    emissiveIntensity: 2.35,
    roughness: 0.18,
    metalness: 0.42,
  });
  const arcGlass = new MeshStandardMaterial({
    color: 0x24345f,
    emissive: 0x345bc7,
    emissiveIntensity: 0.82,
    roughness: 0.2,
    metalness: 0.55,
  });

  const BORE = 0.022;
  const body = new Group();
  const bk = new MeshKit();
  // Receiver and forward truss are deliberately separate. The gap becomes a
  // real cage for the induction tube instead of an LMG with purple trim.
  bk.add(
    'receiver',
    steel,
    place(extrudeZ(rrect(0.072, 0.074, 0.011, 0, BORE - 0.020), 0.236), 0, 0, -0.034),
    place(extrudeZ(rrect(0.056, 0.039, 0.007, 0, BORE + 0.002), 0.174), 0, 0, -0.224),
    place(rod(0.013, 0.450, 20), 0, BORE + 0.002, -0.447),
    place(rod(0.020, 0.048, 20), 0, BORE + 0.002, -0.684),
    bore(0.009, BORE + 0.002, -0.715, 0.032),
  );
  // Four ribs carry the coil cage while keeping the top sight line open.
  for (const side of [-1, 1]) {
    bk.add(
      'truss',
      dark,
      place(box(0.008, 0.030, 0.316, 0.002), side * 0.042, BORE + 0.004, -0.395),
      place(box(0.010, 0.048, 0.016, 0.002), side * 0.040, BORE + 0.004, -0.256),
      place(box(0.010, 0.048, 0.016, 0.002), side * 0.040, BORE + 0.004, -0.530),
    );
  }
  bk.add(
    'frame',
    polymer,
    place(extrudeZ(rrect(0.056, 0.032, 0.007, 0, BORE - 0.064), 0.092), 0, 0, 0.087),
    triggerGuard(-0.006, 0.059, BORE - 0.057, BORE - 0.102, 0.052, 0.007),
  );
  const gripSections: LoftSection[] = [
    { z: 0.096, y: BORE - 0.066, w: 0.047, h: 0.056, n: 4.5 },
    { z: 0.112, y: BORE - 0.094, w: 0.051, h: 0.054, n: 4.8 },
    { z: 0.127, y: BORE - 0.125, w: 0.048, h: 0.050, n: 5 },
    { z: 0.140, y: BORE - 0.149, w: 0.045, h: 0.046, n: 5.2 },
  ];
  bk.add('grip', polymer, loft(gripSections, 22));
  // A swept stock gives the rifle a stable rear silhouette and leaves a true
  // cheek line below the rear aperture.
  const stockSections: LoftSection[] = [
    { z: 0.108, y: BORE - 0.001, w: 0.052, h: 0.048, n: 4.5 },
    { z: 0.188, y: BORE - 0.010, w: 0.058, h: 0.060, n: 4.8 },
    { z: 0.272, y: BORE - 0.027, w: 0.061, h: 0.070, n: 5 },
    { z: 0.322, y: BORE - 0.042, w: 0.064, h: 0.078, n: 5 },
  ];
  bk.add('stock', polymer, loft(stockSections, 22));
  bk.add('buttpad', Presets.gunPolymer(0x171a21), place(box(0.066, 0.082, 0.015, 0.004), 0, BORE - 0.043, 0.330, 0.08));
  bk.add('hardware', bright, ...pin(0.036, BORE - 0.046, 0.090, 0.0032));
  bk.flushInto(body, true);
  root.add(body);

  // The coil assembly is the animated action: its violet dielectric tube is
  // enclosed by copper rings and three ceramic spacers, not floating alone.
  const slide = new Group();
  slide.name = 'inductionCage';
  const ck = new MeshKit();
  ck.add('dielectric', arcGlass, place(rod(0.020, 0.312, 20), 0, BORE + 0.002, -0.393));
  ck.add('arcCore', arcGlow, place(rod(0.008, 0.330, 20), 0, BORE + 0.002, -0.402));
  for (let i = 0; i < 7; i++) {
    const z = -0.272 - i * 0.047;
    ck.add('coil', coilMetal, place(new TorusGeometry(0.045, 0.0045, 8, 22), 0, BORE + 0.002, z));
    if (i % 2 === 0) ck.add('coilGlow', arcGlow, place(new TorusGeometry(0.032, 0.0025, 8, 18), 0, BORE + 0.002, z));
  }
  ck.flushInto(slide, true);
  root.add(slide);

  // The detachable capacitor is side-fed so it has its own silhouette rather
  // than disappearing into the grip like an ordinary rifle magazine.
  const magazine = new Group();
  magazine.name = 'stormCell';
  new MeshKit()
    .add('cellShell', dark, place(box(0.074, 0.097, 0.111, 0.008, 3), -0.042, BORE - 0.105, -0.015))
    .add('cellWindow', arcGlass, place(box(0.004, 0.053, 0.071, 0.001), -0.081, BORE - 0.104, -0.016))
    .add('cellCharge', arcGlow, place(box(0.005, 0.038, 0.055, 0.001), -0.084, BORE - 0.104, -0.016))
    .add('cellLatch', bright, place(box(0.052, 0.009, 0.016, 0.002), -0.042, BORE - 0.055, 0.031))
    .flushInto(magazine, true);
  root.add(magazine);

  const trigger = new Group();
  trigger.name = 'trigger';
  new MeshKit().add('trigger', bright, triggerBlade(0.020, BORE - 0.058, 0.0065)).flushInto(trigger);
  root.add(trigger);

  // Sighting.
  //
  // Irons cannot work on this weapon: the induction cage tops out at
  // BORE + 0.0515, so any notch-and-post pair low enough to sit on the receiver
  // deck puts the sight line straight through seven copper rings — which is
  // what the original pair did, and the front post was 6 mm below the rear
  // notch on top of that. A reflex carried on a riser over the cage is the
  // honest fix: the sight picture is the world itself, so nothing forward of
  // the emitter can occlude it.
  // Clear of the cage's BORE + 0.0515 crown with room to spare, so the glow
  // under the dot stays at the bottom of the window rather than through it.
  const SIGHT_Y = BORE + 0.070;
  const RISER_TOP = SIGHT_Y - 0.019;
  const sights = new MeshKit();
  sights.add(
    'sightRiser',
    steel,
    place(box(0.036, RISER_TOP - (BORE + 0.017), 0.058, 0.003), 0, (RISER_TOP + BORE + 0.017) / 2, 0.030),
  );
  sights.add('sightRiser', dark, place(box(0.042, 0.006, 0.064, 0.0015), 0, BORE + 0.020, 0.030));
  reflexSight(sights, {
    y: SIGHT_Y,
    z: 0.030,
    baseY: RISER_TOP,
    width: 0.042,
    dotTint: 0xb49cff,
    frameTint: 0x1b2029,
  });
  sights.flushInto(root, true);

  root.add(marker('muzzle', 0, BORE + 0.002, -0.722));
  root.add(marker('eject', 0.042, BORE + 0.004, -0.020));
  return {
    root,
    muzzle: root.getObjectByName('muzzle')!,
    ejectPort: root.getObjectByName('eject')!,
    slide,
    magazine,
    charging: null,
    trigger,
    sightHeight: SIGHT_Y,
    // The emitter's dot, not the housing centre — see `reflexSight`.
    sightForward: -(0.030 - 0.009),
  };
}
