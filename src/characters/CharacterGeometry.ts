import {
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Float32BufferAttribute,
  SphereGeometry,
  Uint16BufferAttribute,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { boxProjectUV } from '../util/geometry';
import { TAU, clamp, lerp, makeFbm, smoothstep } from '../util/math';

/**
 * Shared procedural-character toolkit.
 *
 * These primitives were authored for the zombie and are now the common floor
 * under every humanoid in the game — the zombie horde and the four player
 * operators. They are deliberately anatomy-shaped rather than generic CSG: a
 * tapered elliptical tube with a hand-authored radius profile, a ring loft whose
 * centre, width and depth vary independently, a grid surface whose cells can be
 * deleted along an iso-line, and a superelliptical skull parametrisation with
 * measured landmarks.
 *
 * Nothing here knows whether the body it is building is alive. Decay, kit and
 * colouring belong to the character that uses it.
 */

/* ------------------------------------------------------------------ */
/* Vertex tints                                                        */
/* ------------------------------------------------------------------ */

/**
 * Vertex colours multiply the material colour, so a tint of 1 means "whatever
 * this character's flesh or cloth colour is". Values above 1 are legal and are
 * how bone, sclera and bright webbing get brighter than the surface around them.
 */
export type Tint = readonly [number, number, number];

export const WHITE: Tint = [1, 1, 1];
/** Inside of an eye socket, a nostril, an ear canal or an open mouth. */
export const CAVITY: Tint = [0.055, 0.05, 0.05];
/** Frayed, dirt-soaked edge of a torn or cut panel. */
export const FRAY: Tint = [0.4, 0.3, 0.24];

export function tint(
  geo: BufferGeometry,
  t: Tint | ((x: number, y: number, z: number) => Tint),
): BufferGeometry {
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  if (typeof t === 'function') {
    for (let i = 0; i < pos.count; i++) {
      const c = t(pos.getX(i), pos.getY(i), pos.getZ(i));
      colors[i * 3] = c[0];
      colors[i * 3 + 1] = c[1];
      colors[i * 3 + 2] = c[2];
    }
  } else {
    for (let i = 0; i < pos.count; i++) {
      colors[i * 3] = t[0];
      colors[i * 3 + 1] = t[1];
      colors[i * 3 + 2] = t[2];
    }
  }
  geo.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return geo;
}

export function ensureTints(geometries: BufferGeometry[]) {
  for (const geo of geometries) if (!geo.attributes.color) tint(geo, WHITE);
}

export const mixTint = (a: Tint, b: Tint, t: number): Tint => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];

/* ------------------------------------------------------------------ */
/* Geometry primitives                                                 */
/* ------------------------------------------------------------------ */

/**
 * Texture tiles per metre of body surface. Shared by every character so pores,
 * weave and webbing read at the same density whoever is wearing them.
 */
export const UV_SCALE = 3.2;

export const gaussian = (d: number, sigma: number) => Math.exp(-(d * d) / (2 * sigma * sigma));

/** Piecewise-smooth curve through (input, value) keys. Used for every profile. */
export function smoothCurve(x: number, keys: readonly (readonly [number, number])[]): number {
  if (x <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [nx, nv] = keys[i];
    if (x <= nx) {
      const [px, pv] = keys[i - 1];
      return lerp(pv, nv, smoothstep((x - px) / (nx - px)));
    }
  }
  return keys[keys.length - 1][1];
}

/**
 * Tapered elliptical tube between two points.
 *
 * `profile(t)` returns [radiusX, radiusZ] in the tube's own frame at parameter
 * t, which is what lets a forearm swell at the elbow and narrow at the wrist.
 * UVs are in metres (around, along) so texel density matches every other part.
 */
export function tube(
  a: Vector3,
  b: Vector3,
  profile: (t: number) => [number, number],
  radial = 14,
  rings = 8,
  capA = true,
  capB = true,
): BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const axis = new Vector3().subVectors(b, a);
  const length = axis.length();
  axis.normalize();
  const up = Math.abs(axis.y) > 0.95 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
  const right = new Vector3().crossVectors(up, axis).normalize();
  const fwd = new Vector3().crossVectors(axis, right).normalize();

  const stride = radial + 1;
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const [rx, rz] = profile(t);
    const centre = new Vector3().copy(a).addScaledVector(axis, length * t);
    for (let j = 0; j <= radial; j++) {
      const ang = (j / radial) * TAU;
      const x = Math.cos(ang) * rx;
      const z = Math.sin(ang) * rz;
      positions.push(
        centre.x + right.x * x + fwd.x * z,
        centre.y + right.y * x + fwd.y * z,
        centre.z + right.z * x + fwd.z * z,
      );
      uvs.push((j / radial) * TAU * ((rx + rz) * 0.5) * UV_SCALE, t * length * UV_SCALE);
    }
  }

  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < radial; j++) {
      const p0 = i * stride + j;
      indices.push(p0, p0 + 1, p0 + stride, p0 + 1, p0 + stride + 1, p0 + stride);
    }
  }

  // Domed caps rather than flat discs — a flat cap reads as a cut end under any
  // grazing light, which on a limb is most of the time.
  const addCap = (atStart: boolean) => {
    const t = atStart ? 0 : 1;
    const [rx, rz] = profile(t);
    const centre = new Vector3().copy(a).addScaledVector(axis, length * t);
    const domeH = Math.max(rx, rz) * 0.8 * (atStart ? -1 : 1);
    const apex = new Vector3().copy(centre).addScaledVector(axis, domeH);
    const steps = 3;
    const base = positions.length / 3;
    for (let s = 1; s <= steps; s++) {
      const k = s / steps;
      const shrink = Math.cos((k * Math.PI) / 2);
      const lift = Math.sin((k * Math.PI) / 2);
      for (let j = 0; j <= radial; j++) {
        const ang = (j / radial) * TAU;
        const x = Math.cos(ang) * rx * shrink;
        const z = Math.sin(ang) * rz * shrink;
        const c = new Vector3().copy(centre).lerp(apex, lift);
        positions.push(
          c.x + right.x * x + fwd.x * z,
          c.y + right.y * x + fwd.y * z,
          c.z + right.z * x + fwd.z * z,
        );
        uvs.push(
          (j / radial) * TAU * ((rx + rz) * 0.5) * UV_SCALE,
          (t * length + (atStart ? -k * domeH : k * domeH)) * UV_SCALE,
        );
      }
    }
    const ringStart = atStart ? 0 : rings * stride;
    for (let s = 0; s < steps; s++) {
      const cur = s === 0 ? ringStart : base + (s - 1) * stride;
      const next = base + s * stride;
      for (let j = 0; j < radial; j++) {
        if (atStart) indices.push(cur + j, next + j, cur + j + 1, cur + j + 1, next + j, next + j + 1);
        else indices.push(cur + j, cur + j + 1, next + j, cur + j + 1, next + j + 1, next + j);
      }
    }
  };
  if (capA) addCap(true);
  if (capB) addCap(false);

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

export interface BodySection {
  halfWidth: number;
  halfDepth: number;
  centreZ: number;
}

/** Angle in a body ring that faces the character's front (-Z). */
export const FRONT_ANGLE = -Math.PI / 2;
/** How much a ring angle faces forward: +1 at the sternum, -1 at the spine. */
export const frontness = (angle: number) => -Math.sin(angle);

/**
 * Ring loft with independently varying centre, width and depth.
 *
 * Deliberately Y-oriented: keeping every ring horizontal lets the torso carry a
 * spinal curve without twisting its cross sections. `relief` adds a radial
 * offset per (y, angle), which is where ribs, sternum and spine come from.
 */
export function verticalLoft(
  bottomY: number,
  topY: number,
  profile: (y: number) => BodySection,
  radial = 20,
  rings = 16,
  capBottom = true,
  capTop = true,
  relief: ((y: number, angle: number) => number) | null = null,
  /**
   * How the V coordinate is measured up the loft.
   *
   * `height` is the cheap answer and is right whenever the surface is close to
   * vertical. `surface` walks the actual distance from ring to ring, and is
   * what a shoulder needs: the trapezius takes the section from 148 mm across
   * to 82 mm over the last 50 mm of height, so the surface there runs nearly
   * horizontally and a V measured in height compresses six centimetres of
   * fabric into one, smearing the print into long streaks across the top of
   * the chest.
   */
  uvAxis: 'height' | 'surface' = 'height',
): BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const stride = radial + 1;
  const climb = new Float32Array(stride);

  for (let i = 0; i <= rings; i++) {
    const y = lerp(bottomY, topY, i / rings);
    const s = profile(y);
    for (let j = 0; j <= radial; j++) {
      const angle = (j / radial) * TAU;
      const r = relief ? relief(y, angle) : 0;
      const x = Math.cos(angle) * (s.halfWidth + r);
      const z = s.centreZ + Math.sin(angle) * (s.halfDepth + r);
      if (uvAxis === 'surface' && i > 0) {
        const p = (i - 1) * stride + j;
        climb[j] += Math.hypot(x - positions[p * 3], y - positions[p * 3 + 1], z - positions[p * 3 + 2]);
      }
      positions.push(x, y, z);
      uvs.push(
        (j / radial) * TAU * ((s.halfWidth + s.halfDepth) * 0.5) * UV_SCALE,
        (uvAxis === 'surface' ? climb[j] : y - bottomY) * UV_SCALE,
      );
    }
  }

  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < radial; j++) {
      const p0 = i * stride + j;
      indices.push(p0, p0 + stride, p0 + 1, p0 + 1, p0 + stride, p0 + stride + 1);
    }
  }

  const addCap = (top: boolean) => {
    const y = top ? topY : bottomY;
    const s = profile(y);
    const centre = positions.length / 3;
    positions.push(0, y, s.centreZ);
    uvs.push(0, (y - bottomY) * UV_SCALE);
    const ring = top ? rings * stride : 0;
    for (let j = 0; j < radial; j++) {
      if (top) indices.push(ring + j, centre, ring + j + 1);
      else indices.push(ring + j, ring + j + 1, centre);
    }
  };
  if (capBottom) addCap(false);
  if (capTop) addCap(true);

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Grid surface whose cells can be deleted — the mechanism behind every tear in
 * a uniform and every cut edge on a helmet cover or a hat brim.
 *
 * `alive(u, v)` returns a signed margin in metres: positive means fabric,
 * negative means the hole. A cell survives when its corners average above zero,
 * and the surviving vertices are tinted by how close they are to an edge, so
 * every rip and ragged hem gets a frayed, dirt-darkened border for free. Only
 * referenced vertices are emitted, so a heavily shredded panel does not carry
 * the cost of the fabric it has lost.
 */
export function raggedSurface(
  point: (u: number, v: number) => Vector3,
  segsU: number,
  segsV: number,
  opts: {
    alive?: (u: number, v: number) => number;
    /** Metres over which a torn edge blends back to clean fabric. */
    edgeWidth?: number;
    edgeTint?: Tint;
    baseTint?: (u: number, v: number) => Tint;
  } = {},
): BufferGeometry | null {
  const { alive, edgeWidth = 0.018, edgeTint = FRAY, baseTint } = opts;
  const rows = segsV + 1;
  const cols = segsU + 1;
  const pts: Vector3[] = [];
  const margin: number[] = [];
  for (let j = 0; j < rows; j++) {
    const v = j / segsV;
    for (let i = 0; i < cols; i++) {
      const u = i / segsU;
      pts.push(point(u, v));
      margin.push(alive ? alive(u, v) : 1);
    }
  }

  // Shrink-wrap the surviving boundary onto the zero crossing of `alive`.
  // Without this every torn edge follows whole grid cells, and a rip reads as
  // pixel art no matter how good the noise driving it is. A vertex on the
  // boundary is slid toward its most-dead neighbour by the linearly
  // interpolated crossing point, which is marching-squares accuracy at the cost
  // of one pass over the grid.
  if (alive) {
    const slide: { at: number; by: Vector3 }[] = [];
    const offset = new Vector3();
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        if (margin[k] <= 0) continue;
        offset.set(0, 0, 0);
        let any = false;
        const consider = (ni: number, nj: number) => {
          if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) return;
          const nk = nj * cols + ni;
          if (margin[nk] > 0) return;
          // Fraction of the way to the neighbour at which the margin hits zero.
          const t = clamp(margin[k] / (margin[k] - margin[nk]), 0, 0.92);
          // Summed rather than taking the largest: at a corner of a hole a
          // vertex has dead neighbours in two directions and has to move
          // diagonally, or that corner keeps its right-angled step.
          offset.addScaledVector(pts[nk].clone().sub(pts[k]), t);
          any = true;
        };
        consider(i - 1, j);
        consider(i + 1, j);
        consider(i, j - 1);
        consider(i, j + 1);
        if (any) slide.push({ at: k, by: offset.clone() });
      }
    }
    // Applied after the scan so a slid vertex is never used as a reference.
    for (const s of slide) pts[s.at] = pts[s.at].clone().add(s.by);
  }

  // Arc lengths give the panel metre-based UVs, matching the tubes it meets.
  const uCoord = new Float32Array(rows * cols);
  const vCoord = new Float32Array(rows * cols);
  for (let j = 0; j < rows; j++) {
    let acc = 0;
    for (let i = 1; i < cols; i++) {
      acc += pts[j * cols + i].distanceTo(pts[j * cols + i - 1]);
      uCoord[j * cols + i] = acc;
    }
  }
  for (let i = 0; i < cols; i++) {
    let acc = 0;
    for (let j = 1; j < rows; j++) {
      acc += pts[j * cols + i].distanceTo(pts[(j - 1) * cols + i]);
      vCoord[j * cols + i] = acc;
    }
  }

  const remap = new Int32Array(rows * cols).fill(-1);
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const emit = (index: number): number => {
    if (remap[index] >= 0) return remap[index];
    const p = pts[index];
    const out = positions.length / 3;
    positions.push(p.x, p.y, p.z);
    uvs.push(uCoord[index] * UV_SCALE, vCoord[index] * UV_SCALE);
    const i = index % cols;
    const j = (index - i) / cols;
    const base = baseTint ? baseTint(i / segsU, j / segsV) : WHITE;
    const edge = 1 - clamp(margin[index] / edgeWidth, 0, 1);
    const c = mixTint(base, edgeTint, edge * edge);
    colors.push(c[0], c[1], c[2]);
    remap[index] = out;
    return out;
  };

  for (let j = 0; j < segsV; j++) {
    for (let i = 0; i < segsU; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      if ((margin[a] + margin[b] + margin[c] + margin[d]) * 0.25 <= 0) continue;
      const ia = emit(a);
      const ib = emit(b);
      const ic = emit(c);
      const id = emit(d);
      indices.push(ia, ic, ib, ib, ic, id);
    }
  }
  if (indices.length === 0) return null;

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

export function ellipsoid(
  centre: Vector3,
  radii: Vector3,
  widthSegments = 14,
  heightSegments = 10,
): BufferGeometry {
  const geo = new SphereGeometry(1, widthSegments, heightSegments);
  geo.scale(radii.x, radii.y, radii.z);
  geo.translate(centre.x, centre.y, centre.z);
  const uv = geo.attributes.uv as BufferAttribute;
  const around = TAU * ((radii.x + radii.z) * 0.5) * UV_SCALE;
  const over = Math.PI * ((radii.y + radii.z) * 0.5) * UV_SCALE;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * around, uv.getY(i) * over);
  uv.needsUpdate = true;
  return geo;
}

/**
 * Patch of an ellipsoid's surface, parametrised so that yaw 0 / pitch 0 is the
 * character's front. Eyelids, shoulder caps, helmet shells and scalp hair are
 * all bands of a sphere, and cutting them this way keeps the maths readable.
 */
export function dome(
  centre: Vector3,
  radii: Vector3,
  yawFrom: number,
  yawTo: number,
  pitchFrom: number,
  pitchTo: number,
  cols = 16,
  rows = 8,
  alive?: (u: number, v: number) => number,
): BufferGeometry | null {
  const point = (u: number, v: number) => {
    const yaw = lerp(yawFrom, yawTo, u);
    const pitch = lerp(pitchFrom, pitchTo, v);
    return new Vector3(
      centre.x + Math.sin(yaw) * Math.cos(pitch) * radii.x,
      centre.y + Math.sin(pitch) * radii.y,
      centre.z - Math.cos(yaw) * Math.cos(pitch) * radii.z,
    );
  };
  // raggedSurface winds (a, c, b); for this parametrisation that is outward.
  return raggedSurface(point, cols, rows, { alive, edgeWidth: 0.006, edgeTint: WHITE });
}

/**
 * Sweeps an elliptical cross-section along a curve. Lips, gums, the ear helix,
 * slings, straps and tendons are all this shape: something long and thin that
 * has to follow a path without becoming a round cable.
 */
export function sweep(
  points: Vector3[],
  profile: (t: number) => [number, number],
  segments = 18,
  radial = 7,
  up = new Vector3(0, 1, 0),
): BufferGeometry {
  const curve = new CatmullRomCurve3(points, false, 'centripetal');
  const positions: number[] = [];
  const indices: number[] = [];
  const stride = radial + 1;
  const p = new Vector3();
  const t = new Vector3();
  const n = new Vector3();
  const b = new Vector3();

  for (let i = 0; i <= segments; i++) {
    const s = i / segments;
    curve.getPoint(s, p);
    curve.getTangent(s, t).normalize();
    n.copy(up).addScaledVector(t, -up.dot(t));
    if (n.lengthSq() < 1e-8) n.set(0, 0, 1).addScaledVector(t, -t.z);
    n.normalize();
    b.crossVectors(t, n).normalize();
    const [rw, rt] = profile(s);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * TAU;
      positions.push(
        p.x + b.x * Math.cos(a) * rw + n.x * Math.sin(a) * rt,
        p.y + b.y * Math.cos(a) * rw + n.y * Math.sin(a) * rt,
        p.z + b.z * Math.cos(a) * rw + n.z * Math.sin(a) * rt,
      );
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < radial; j++) {
      const p0 = i * stride + j;
      indices.push(p0, p0 + 1, p0 + stride, p0 + 1, p0 + stride + 1, p0 + stride);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  boxProjectUV(geo, UV_SCALE);
  return geo;
}

/**
 * Chamfered kit panel, pocket or buckle, already placed in bind-pose space.
 * Every plate, pouch, flap and tab routes through here, so a sharp box would
 * leave the whole rig without a single edge highlight — the tell of programmer
 * art that `GunSmith` has always avoided by chamfering.
 */
export function box(
  centre: Vector3,
  width: number,
  height: number,
  depth: number,
  rotateZ = 0,
  rotateX = 0,
): BufferGeometry {
  const radius = Math.min(0.0055, Math.min(width, height, depth) * 0.32);
  const rounded = new RoundedBoxGeometry(width, height, depth, 1, radius);
  if (rotateX !== 0) rounded.rotateX(rotateX);
  if (rotateZ !== 0) rounded.rotateZ(rotateZ);
  rounded.translate(centre.x, centre.y, centre.z);
  boxProjectUV(rounded, UV_SCALE);
  const geo = mergeVertices(rounded, 1e-5);
  rounded.dispose();
  return geo;
}

/**
 * Solid panel that wraps a body section instead of hovering in front of it.
 * A flat rectangle has no way to follow a ribcage or a thigh, so pockets, armour
 * plates and cummerbunds are lofted from an angular sector of the host's own
 * cross-section.
 */
export function wrappedPanel(
  bottomY: number,
  topY: number,
  section: (y: number) => BodySection,
  centreAngle: number,
  halfAngleAt: (t: number) => number,
  innerAt: (t: number) => number,
  thicknessAt: (t: number) => number,
  rings = 8,
): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const BEVEL_ANGLE = 0.16;
  const BEVEL_THICKNESS = 0.3;
  const loop: readonly (readonly [number, number])[] = [
    [-1 + BEVEL_ANGLE, 1], [1 - BEVEL_ANGLE, 1],
    [1, 1 - BEVEL_THICKNESS], [1, BEVEL_THICKNESS],
    [1 - BEVEL_ANGLE, 0], [-1 + BEVEL_ANGLE, 0],
    [-1, BEVEL_THICKNESS], [-1, 1 - BEVEL_THICKNESS],
  ];
  const stride = loop.length;
  const rollAt = (t: number) => 0.58 + 0.42 * smoothstep(clamp(Math.min(t, 1 - t) / 0.13, 0, 1));

  const ringCentres: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const y = lerp(bottomY, topY, t);
    const s = section(y);
    const roll = rollAt(t);
    const halfAngle = halfAngleAt(t) * roll;
    const inner = innerAt(t);
    const thickness = thicknessAt(t) * roll;
    let cx = 0;
    let cz = 0;
    for (const [angleFraction, offsetFraction] of loop) {
      const a = centreAngle + angleFraction * halfAngle;
      const offset = inner + offsetFraction * thickness;
      const x = Math.sin(a) * (s.halfWidth + offset);
      const z = s.centreZ - Math.cos(a) * (s.halfDepth + offset);
      positions.push(x, y, z);
      cx += x / stride;
      cz += z / stride;
    }
    ringCentres.push(cx, y, cz);
  }

  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < stride; j++) {
      const next = (j + 1) % stride;
      const p0 = i * stride + j;
      const p1 = i * stride + next;
      indices.push(p0, p0 + stride, p1, p1, p0 + stride, p1 + stride);
    }
  }
  for (const top of [false, true]) {
    const ring = top ? rings * stride : 0;
    const centre = positions.length / 3;
    const c = (top ? rings : 0) * 3;
    positions.push(ringCentres[c], ringCentres[c + 1], ringCentres[c + 2]);
    for (let j = 0; j < stride; j++) {
      const next = (j + 1) % stride;
      if (top) indices.push(ring + next, ring + j, centre);
      else indices.push(ring + j, ring + next, centre);
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  boxProjectUV(geo, UV_SCALE);
  return geo;
}

/** Pushes vertices along their normals by band-limited noise. */
export function displaceAlongNormals(
  geo: BufferGeometry,
  seed: number,
  amount: number,
  frequency: number,
  mask: ((x: number, y: number, z: number) => number) | null = null,
) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const fbm = makeFbm(seed, { octaves: 3, frequency: 1 });
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const k = mask ? mask(x, y, z) : 1;
    if (k <= 0) continue;
    const n =
      fbm(x * frequency, y * frequency) * 0.5 +
      fbm(z * frequency + 3.1, y * frequency + 7.7) * 0.5;
    const d = (n - 0.5) * 2 * amount * k;
    pos.setXYZ(i, x + nrm.getX(i) * d, y + nrm.getY(i) * d, z + nrm.getZ(i) * d);
  }
  pos.needsUpdate = true;
}

/* ------------------------------------------------------------------ */
/* Contact occlusion                                                   */
/* ------------------------------------------------------------------ */

export interface OcclusionOptions {
  /** How far a vertex looks for things blocking it, metres. */
  radius?: number;
  /** Maximum darkening, 0..1. */
  strength?: number;
  /** Darkest multiplier the result may reach. */
  floor?: number;
  /**
   * Geometry that casts occlusion onto this mesh without being shaded itself —
   * the uniform over the body, the webbing over the uniform.
   */
  occluders?: BufferGeometry[];
  /** Colour the occluded areas are mixed toward. */
  shade?: Tint;
  /** Per-vertex multiplier on the effect, in the mesh's own space. */
  mask?: (x: number, y: number, z: number) => number;
  /**
   * Occlusion ratio at which darkening starts, and the span over which it
   * reaches full strength.
   *
   * The bias is not cosmetic. A character's surface is relief all the way down
   * — pores, weave, the ripple left by a displacement pass — so even a flat
   * cheek measures a steady ~0.14 and only the real hollows reach 0.7. Map the
   * raw ratio straight onto the output and that baseline becomes a uniform 20%
   * darkening over the whole model: the contrast is still in there, but every
   * surface has been dimmed by the same amount, which is precisely the flat
   * look the pass exists to fix. Cutting the baseline off first is what turns
   * the measurement into shape.
   */
  bias?: number;
  range?: number;
  /**
   * Weight of the *vertical* occlusion term, 0..1.
   *
   * Curvature alone cannot produce the shading that actually reads on a face,
   * because the thing that makes an eye look sunken is not the curve of the
   * socket — the eyeball fills it, and what is left visible is nearly flat.
   * It is the shadow the brow throws down onto the lid. That is a directional
   * quantity: how much of the sky above this point is blocked by something.
   *
   * Measured over the same neighbours, so it costs nothing extra, and it is
   * what darkens under a brow, under a nose, under a jaw, beneath a collar,
   * under a helmet brim, and inside a hole with cloth hanging over it.
   */
  sky?: number;
}

/**
 * Bakes ambient occlusion into a mesh's vertex colours.
 *
 * This is the single largest quality lever on any of these characters, and the
 * reason is a hard limit rather than a preference: the shadow map is 2048
 * texels over a 14 m frustum, which is about seven millimetres a texel, and
 * every feature that gives a character form is smaller than that. A 5 mm brow
 * ridge, an eye socket, a nostril, the fold under a collar and the inside of a
 * hole torn in a uniform all light *identically* to the flat surface beside
 * them. The geometry is there and the renderer cannot see it.
 *
 * So it is measured here instead, per vertex, once, at build time.
 *
 * The measure is deliberately not a ray cast. For each vertex it looks at the
 * points within `radius` and asks what fraction of them lie in front of the
 * surface — in the hemisphere the normal points into. On a flat panel every
 * neighbour is in the tangent plane and the fraction is zero; in a crease the
 * neighbours curl toward the normal and it climbs; on a bump they fall away and
 * it stays at zero. Expressing it as a *fraction* rather than a count is what
 * makes it survive this geometry: a head is tessellated an order of magnitude
 * finer than a thigh, and any absolute count would read the head as uniformly
 * buried.
 *
 * Passing other meshes as `occluders` is how a garment shades the body under
 * it, which is what makes a tear read as a hole rather than as a shape cut out
 * of a decal. Their own normals are irrelevant — only their positions block.
 */
export function bakeVertexOcclusion(geo: BufferGeometry, opts: OcclusionOptions = {}) {
  const {
    radius = 0.03,
    strength = 0.85,
    floor = 0.24,
    occluders = [],
    shade = [0.3, 0.29, 0.3],
    mask = null,
    bias = 0.13,
    range = 0.34,
    sky = 0.55,
  } = opts;

  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const col = geo.attributes.color as BufferAttribute | undefined;
  if (!pos || !nrm || !col) return;

  // Every point that can block light: this mesh plus whatever is layered over it.
  let total = pos.count;
  for (const o of occluders) total += o.attributes.position.count;
  const px = new Float32Array(total);
  const py = new Float32Array(total);
  const pz = new Float32Array(total);
  let n = 0;
  const gather = (attr: { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number }) => {
    for (let i = 0; i < attr.count; i++) {
      px[n] = attr.getX(i);
      py[n] = attr.getY(i);
      pz[n] = attr.getZ(i);
      n++;
    }
  };
  gather(pos);
  for (const o of occluders) gather(o.attributes.position);

  // Uniform hash grid at one cell per radius, so a query touches 27 cells.
  // Keys are packed into one integer — a string key per lookup is half a
  // million string allocations on a character this size.
  const inv = 1 / radius;
  const cellOf = (v: number) => Math.floor(v * inv) + 512;
  const keyOf = (cx: number, cy: number, cz: number) => (cx * 1024 + cy) * 1024 + cz;
  const grid = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const key = keyOf(cellOf(px[i]), cellOf(py[i]), cellOf(pz[i]));
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  }

  const r2 = radius * radius;
  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i);
    const vy = pos.getY(i);
    const vz = pos.getZ(i);
    const k = mask ? mask(vx, vy, vz) : 1;
    if (k <= 0) continue;

    const nx = nrm.getX(i);
    const ny = nrm.getY(i);
    const nz = nrm.getZ(i);

    let blocked = 0;
    let overhead = 0;
    let seen = 0;
    const cx = cellOf(vx);
    const cy = cellOf(vy);
    const cz = cellOf(vz);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (let oz = -1; oz <= 1; oz++) {
          const bucket = grid.get(keyOf(cx + ox, cy + oy, cz + oz));
          if (!bucket) continue;
          for (let b = 0; b < bucket.length; b++) {
            const j = bucket[b];
            const dx = px[j] - vx;
            const dy = py[j] - vy;
            const dz = pz[j] - vz;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > r2 || d2 < 1e-10) continue;
            const d = Math.sqrt(d2);
            // Near neighbours matter more than far ones, and the falloff also
            // stops the result depending on exactly where the radius lands.
            const w = 1 - d / radius;
            seen += w;
            const facing = (dx * nx + dy * ny + dz * nz) / d;
            if (facing > 0) blocked += w * facing;
            // Anything above this point, whichever way the surface faces.
            if (dy > 0) overhead += w * (dy / d);
          }
        }
      }
    }
    if (seen <= 0) continue;

    // A flat upward-facing surface still has roughly a quarter of its
    // neighbourhood technically "above" it, so the vertical term carries its
    // own baseline and needs its own bias.
    const crease = smoothstep(clamp((blocked / seen - bias) / range, 0, 1));
    const under = smoothstep(clamp((overhead / seen - 0.16) / 0.24, 0, 1));
    const ao = clamp(Math.max(crease, under * sky) * strength * k, 0, 1 - floor);
    if (ao <= 0.001) continue;
    const t = mixTint([col.getX(i), col.getY(i), col.getZ(i)], [
      col.getX(i) * shade[0],
      col.getY(i) * shade[1],
      col.getZ(i) * shade[2],
    ], ao);
    col.setXYZ(i, t[0], t[1], t[2]);
  }
  col.needsUpdate = true;
}

/* ------------------------------------------------------------------ */
/* Skull parametrisation                                               */
/* ------------------------------------------------------------------ */

/**
 * Skull dimensions, in metres from the head's centre (roughly 20 mm above the
 * ear canal). These are measured landmarks on an adult male head — 148 mm wide,
 * 196 mm front to back, 220 mm crown to chin — and every facial feature built on
 * top of them is placed against them.
 */
export const HEAD_TOP = 0.094;
export const HEAD_BOTTOM = -0.115;
/**
 * The landmark table describes a 213 mm head, which on a 1.75 m body is 8.2
 * heads tall — a proportion that reads as a small head on a long body.
 * Everything in head space is scaled by this on the way out, so the figure lands
 * at the conventional 7.7 heads without disturbing any of the measurements.
 */
export const HEAD_SCALE = 1.06;
/** Interpupillary distance is 62 mm; the eyes therefore sit at x = +/-31 mm. */
export const EYE_X = 0.031;
export const EYE_Y = -0.011;
/** Centre of the globe, 12.5 mm radius, set back so the sockets read as sunken. */
export const EYE_Z = -0.0535;
export const EYE_R = 0.0125;
export const MOUTH_Y = -0.072;

/**
 * Equator-equivalent half width of the skull at a given height: the value the
 * ring would have if it were at the widest latitude. The superelliptical ring
 * factor scales it down toward the poles.
 */
export const skullWidthAt = (y: number) => smoothCurve(y, [
  [-0.115, 0.0435],
  [-0.112, 0.0445],
  [-0.106, 0.0482],
  [-0.098, 0.0513],
  [-0.086, 0.0527],
  [-0.075, 0.0546],
  [-0.058, 0.059],
  [-0.035, 0.0661],
  [-0.01, 0.0731],
  [0.01, 0.074],
  [0.035, 0.0701],
  [0.07, 0.0693],
  [0.098, 0.066],
]);

/**
 * Depth stays large right down to the last ring: the underside of a jaw is a
 * broad plate running from the chin back to the throat, and letting the depth
 * collapse with the width turns the bottom of the head into a downward beak.
 */
export const skullDepthAt = (y: number) => smoothCurve(y, [
  [-0.115, 0.0534],
  [-0.112, 0.0534],
  [-0.106, 0.0537],
  [-0.098, 0.0543],
  [-0.086, 0.0577],
  [-0.075, 0.062],
  [-0.058, 0.0694],
  [-0.035, 0.0772],
  [-0.01, 0.0826],
  [0.01, 0.0865],
  [0.035, 0.0871],
  [0.07, 0.0851],
  [0.098, 0.085],
]);

/**
 * Front-to-back offset of each skull ring. The cranium reaches 99 mm behind
 * centre but the face only 76 mm in front, so the rings march backwards as they
 * rise — this is what stops the head reading as a ball with a face painted on.
 * The last few rings turn back under the jaw, which is what puts the bottom pole
 * beneath the chin instead of leaving a witch's-chin spike hanging off it.
 */
export const skullCentreZAt = (y: number) => smoothCurve(y, [
  [-0.115, -0.025],
  [-0.106, -0.025],
  [-0.098, -0.025],
  [-0.086, -0.0225],
  [-0.075, -0.017],
  [-0.058, -0.0053],
  [-0.035, 0.011],
  [-0.01, 0.0145],
  [0.01, 0.0125],
  [0.035, 0.0105],
  [0.07, 0.0125],
  [0.098, 0.012],
]);

/**
 * Superelliptical cross-section factor. A plain sphere pinches to a point at
 * both poles, which puts a cone where the chin should be; raising the exponent
 * broadens the approach into a crown above and a flat jaw underside below. The
 * lower exponent is higher because the underside of a jaw is nearly flat while
 * the crown of a skull is not.
 */
export const skullRing = (h: number) => {
  const p = h >= 0 ? 2.4 : 4;
  return Math.pow(Math.max(0, 1 - Math.pow(Math.abs(h), p)), 1 / p);
};

/** Height in metres of a skull row, from its sphere latitude. */
export const skullHeight = (h: number) => (h >= 0 ? h * HEAD_TOP : h * -HEAD_BOTTOM);

/**
 * Point on the undeformed skull surface. `outset` grows it along its own
 * normal-ish direction, which is how hair and headgear stay glued to the scalp.
 */
export function skullPoint(h: number, angle: number, outset = 0): Vector3 {
  const y = skullHeight(h);
  const ring = skullRing(h);
  const hw = skullWidthAt(y) * ring + outset;
  const hd = skullDepthAt(y) * ring + outset;
  return new Vector3(
    Math.sin(angle) * hw,
    y + outset * h * 0.9,
    skullCentreZAt(y) - Math.cos(angle) * hd,
  );
}

/**
 * A point on the skull surface in *world* space. Headgear is built outside the
 * head builder, so it has to apply the same head scale by hand or a helmet ends
 * up 6% too small for the skull it sits on.
 */
export function headWorld(h: number, angle: number, outset: number, centre: Vector3): Vector3 {
  return skullPoint(h, angle, outset).multiplyScalar(HEAD_SCALE).add(centre);
}

/** Half-width of the skull surface at a given height — where an ear attaches. */
export function skullSideX(y: number): number {
  const h = y >= 0 ? y / HEAD_TOP : y / -HEAD_BOTTOM;
  return skullWidthAt(y) * skullRing(h);
}

/* ------------------------------------------------------------------ */
/* Skeleton and skinning                                               */
/* ------------------------------------------------------------------ */

export type BoneName =
  | 'hips' | 'spine' | 'chest' | 'neck' | 'head'
  | 'clavicleL' | 'upperArmL' | 'lowerArmL' | 'handL'
  | 'clavicleR' | 'upperArmR' | 'lowerArmR' | 'handR'
  | 'upLegL' | 'lowLegL' | 'footL'
  | 'upLegR' | 'lowLegR' | 'footR';

export interface BoneSpec {
  name: BoneName;
  parent: BoneName | null;
  pos: [number, number, number];
}

/** Bind-pose skeleton. Y-up, facing -Z, arms hanging at the sides. */
export const SKELETON: BoneSpec[] = [
  { name: 'hips', parent: null, pos: [0, 1.0, 0] },
  { name: 'spine', parent: 'hips', pos: [0, 0.17, -0.008] },
  { name: 'chest', parent: 'spine', pos: [0, 0.18, 0.014] },
  { name: 'neck', parent: 'chest', pos: [0, 0.15, 0.006] },
  { name: 'head', parent: 'neck', pos: [0, 0.09, -0.004] },

  { name: 'clavicleL', parent: 'chest', pos: [0.075, 0.06, -0.004] },
  { name: 'upperArmL', parent: 'clavicleL', pos: [0.125, 0.01, -0.002] },
  { name: 'lowerArmL', parent: 'upperArmL', pos: [0, -0.28, 0] },
  { name: 'handL', parent: 'lowerArmL', pos: [0, -0.26, 0] },

  { name: 'clavicleR', parent: 'chest', pos: [-0.075, 0.06, -0.004] },
  { name: 'upperArmR', parent: 'clavicleR', pos: [-0.125, 0.01, -0.002] },
  { name: 'lowerArmR', parent: 'upperArmR', pos: [0, -0.28, 0] },
  { name: 'handR', parent: 'lowerArmR', pos: [0, -0.26, 0] },

  { name: 'upLegL', parent: 'hips', pos: [0.095, -0.05, 0] },
  { name: 'lowLegL', parent: 'upLegL', pos: [0, -0.45, 0] },
  { name: 'footL', parent: 'lowLegL', pos: [0, -0.46, 0] },

  { name: 'upLegR', parent: 'hips', pos: [-0.095, -0.05, 0] },
  { name: 'lowLegR', parent: 'upLegR', pos: [0, -0.45, 0] },
  { name: 'footR', parent: 'lowLegR', pos: [0, -0.46, 0] },
];

export type Chain = 'torso' | 'armL' | 'armR' | 'legL' | 'legR';

/** Chain codes carried in the `chainLock` attribute; 0 means "decide by distance". */
const CHAIN_CODE: Record<Chain, number> = { torso: 1, armL: 2, armR: 3, legL: 4, legR: 5 };
const CHAIN_BY_CODE: (Chain | null)[] = [null, 'torso', 'armL', 'armR', 'legL', 'legR'];

/**
 * Per-vertex override forcing a part onto a named chain whatever bone happens
 * to be nearest.
 *
 * Both directions of override are needed, and for the same underlying reason:
 * a garment is not owned by whatever bone it is closest to. A jacket hem or a
 * plate carrier's cummerbund reaches below the hip joints, so its outer edge is
 * nearest to a thigh, and a stride tears the skirt into two wings that flare
 * off the hips — that hem is torso cloth that happens to overlap the legs.
 * Equally, a sleeve's shoulder cap sits nearest the clavicle, so it is claimed
 * by the torso and stays put while the arm beneath it swings away, leaving the
 * bare limb hanging out of a sleeve that never moved.
 */
export function lockChain(geo: BufferGeometry, chain: Chain): BufferGeometry {
  const n = geo.attributes.position.count;
  geo.setAttribute(
    'chainLock',
    new Float32BufferAttribute(new Float32Array(n).fill(CHAIN_CODE[chain]), 1),
  );
  return geo;
}

export const lockToTorso = (geo: BufferGeometry) => lockChain(geo, 'torso');

export function ensureChainLock(geometries: BufferGeometry[]) {
  for (const g of geometries) {
    if (g.attributes.chainLock) continue;
    const n = g.attributes.position.count;
    g.setAttribute('chainLock', new Float32BufferAttribute(new Float32Array(n), 1));
  }
}

export interface BonePair {
  index: number;
  a: Vector3;
  b: Vector3;
  radius: number;
  /** Clavicles count as torso: they carry the shoulder line, and their travel is small. */
  chain: Chain;
}

/** Assigns up to four bone influences per vertex by distance to bone segments. */
export function autoSkin(geo: BufferGeometry, bonePairs: BonePair[]) {
  const pos = geo.attributes.position;
  const count = pos.count;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);

  const v = new Vector3();
  const ab = new Vector3();
  const av = new Vector3();
  const candidates: { i: number; w: number }[] = [];
  const dists = new Float64Array(bonePairs.length);
  const lock = geo.attributes.chainLock;

  for (let i = 0; i < count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    candidates.length = 0;

    // Pass one: distance to every bone, and the chain that owns this vertex.
    let owner: Chain = 'torso';
    let nearest = Infinity;
    for (let b = 0; b < bonePairs.length; b++) {
      const bone = bonePairs[b];
      ab.subVectors(bone.b, bone.a);
      av.subVectors(v, bone.a);
      const lenSq = ab.lengthSq();
      const t = lenSq > 0 ? clamp(av.dot(ab) / lenSq, 0, 1) : 0;
      const dist = av.sub(ab.multiplyScalar(t)).length();
      dists[b] = dist;
      // Surface distance, so a fat bone does not out-claim a thin one purely
      // by being thick — the hips would otherwise swallow the upper thighs.
      const surface = dist - bone.radius;
      if (surface < nearest) {
        nearest = surface;
        owner = bone.chain;
      }
    }
    if (lock) owner = CHAIN_BY_CODE[Math.round(lock.getX(i))] ?? owner;

    // Pass two: weight the bones this vertex is allowed to be driven by.
    for (let b = 0; b < bonePairs.length; b++) {
      const bone = bonePairs[b];
      if (bone.chain !== owner && bone.chain !== 'torso') continue;
      const w = Math.pow(clamp(1 - dists[b] / (bone.radius * 2.2), 0, 1), 3);
      if (w > 0.0001) candidates.push({ i: bone.index, w });
    }

    candidates.sort((a, b) => b.w - a.w);
    let total = 0;
    for (let k = 0; k < 4; k++) total += candidates[k]?.w ?? 0;
    if (total <= 0) {
      skinIndex[i * 4] = bonePairs[0].index;
      skinWeight[i * 4] = 1;
      continue;
    }
    for (let k = 0; k < 4; k++) {
      const c = candidates[k];
      skinIndex[i * 4 + k] = c ? c.i : 0;
      skinWeight[i * 4 + k] = c ? c.w / total : 0;
    }
  }

  geo.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new Float32BufferAttribute(skinWeight, 4));
}

/** Pins a spatially isolated rigid part (the head, or headgear) to one bone. */
export function rigidSkinRegion(
  geo: BufferGeometry,
  index: number,
  includes: (x: number, y: number, z: number) => boolean,
) {
  const pos = geo.attributes.position;
  const skinIndex = geo.attributes.skinIndex as BufferAttribute;
  const skinWeight = geo.attributes.skinWeight as BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    if (!includes(pos.getX(i), pos.getY(i), pos.getZ(i))) continue;
    skinIndex.setXYZW(i, index, 0, 0, 0);
    skinWeight.setXYZW(i, 1, 0, 0, 0);
  }
  skinIndex.needsUpdate = true;
  skinWeight.needsUpdate = true;
}
