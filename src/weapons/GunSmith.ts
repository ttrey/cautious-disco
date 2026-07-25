import {
  BufferGeometry,
  CylinderGeometry,
  Group,
  LatheGeometry,
  Material,
  Mesh,
  Object3D,
  Shape,
  ExtrudeGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector2,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { boxProjectUV, mergeAll } from '../util/geometry';
import { Presets } from '../assets/Materials';

/**
 * Procedural firearm construction.
 *
 * These are the final weapon assets. There is no licensed model library
 * available to this build, so instead of shipping boxes-as-guns, each weapon is
 * assembled from chamfered solids, lathed barrels and extruded receiver
 * profiles that follow real firearm proportions.
 *
 * Two things do the heavy lifting visually:
 *   1. **Every edge is chamfered.** RoundedBoxGeometry and bevelled extrusions
 *      produce a highlight line along each edge. Sharp-cornered boxes read as
 *      programmer art precisely because they have no edge highlight.
 *   2. **Detail density at the right scale.** Serrations, rail slots, vent
 *      holes and sights are small enough to read as machining rather than as
 *      geometry, which is what sells the object as manufactured.
 *
 * Convention: the weapon is authored muzzle-forward along -Z, +Y up, +X right —
 * the same basis as the camera, so the viewmodel needs no correction rotation.
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

/** Lathed solid of revolution about the barrel axis — muzzle devices, cans. */
export function lathe(profile: [number, number][], seg = 24): BufferGeometry {
  const g = new LatheGeometry(
    profile.map(([r, z]) => new Vector2(Math.max(r, 0.00001), z)),
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
 * rifle is ~50 pieces of geometry but only four draw calls.
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
   * `uvScale` is texture tiles per metre. Every bucket is re-projected so that
   * a chamfered box, a lathed muzzle device and an extruded grip all end up
   * with the same texel density — without this the extrusions read as flat
   * untextured plastic.
   */
  flushInto(parent: Object3D, castShadow = false, uvScale = 11): Object3D {
    for (const [key, bucket] of this.buckets) {
      if (!bucket.geos.length) continue;
      const merged = mergeAll(bucket.geos);
      if (!merged) continue;
      merged.computeVertexNormals();
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
function railGeometries(length: number, width: number, z0: number, y: number): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  out.push(place(box(width, 0.004, length, 0.0012), 0, y, z0 - length / 2));
  const slots = Math.max(3, Math.floor(length / 0.0115));
  for (let i = 0; i < slots; i++) {
    const z = z0 - 0.006 - i * (length / slots);
    out.push(place(box(width * 1.02, 0.005, 0.0055, 0.0012), 0, y + 0.0035, z));
  }
  return out;
}

/** Slide / receiver serrations — angled cuts that catch a rim of light. */
function serrations(
  count: number,
  spacing: number,
  z0: number,
  y: number,
  width: number,
  height: number,
  tilt = 0.16,
): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    // Rotate about the piece's own origin first, then position it — the
    // opposite order would swing each cut away from the slide.
    out.push(place(box(width, height, 0.0026, 0.0008), 0, y, z0 + i * spacing, tilt));
  }
  return out;
}

/**
 * Curved box magazine.
 *
 * Built as a single extruded side profile swept along an arc, rather than a
 * stack of rotated boxes — stacked boxes leave a visible staircase down the
 * spine of the magazine no matter how much they overlap.
 */
function curvedMagazine(
  segments: number,
  segLength: number,
  width: number,
  depth: number,
  curve: number,
): BufferGeometry[] {
  const front: [number, number][] = [];
  const back: [number, number][] = [];
  let y = 0;
  let z = 0;
  let angle = 0;

  for (let i = 0; i <= segments; i++) {
    // Walk down the magazine's spine, banking by `curve` each step, and record
    // the front and back walls as we go.
    const nx = Math.cos(angle);
    const nz = Math.sin(angle);
    // Taper very slightly toward the floorplate, as real magazines do.
    const halfDepth = (depth / 2) * (1 - (i / segments) * 0.06);
    front.push([z + nx * halfDepth, y + nz * halfDepth]);
    back.unshift([z - nx * halfDepth, y - nz * halfDepth]);
    y -= segLength * Math.cos(angle);
    z += segLength * Math.sin(angle);
    angle += curve;
  }

  // `profile` treats x as running along the weapon and y as height, which is
  // exactly the space the spine walk above produced.
  const body = profile([...front, ...back], width, 0.0018);

  // Floorplate, seated at the end of the spine.
  const plate = box(width * 1.16, segLength * 0.3, depth * 1.1, 0.0018);
  plate.rotateX(angle - curve);
  plate.translate(0, y + segLength * 0.85, z);

  return [body, plate];
}

/**
 * Trigger guard: a partial torus rotated into the weapon's side plane, then
 * squashed into the elongated oval real guards have and widened across the gun.
 */
function triggerGuard(radius: number, tube: number, width: number): BufferGeometry {
  const g = new TorusGeometry(radius, tube, 8, 22, Math.PI * 1.3);
  // Open the arc toward the rear-top, where it meets the receiver.
  g.rotateZ(Math.PI * 0.85);
  g.rotateY(Math.PI / 2);
  // X is now across the weapon (guard thickness), Z along it.
  g.scale(width / (tube * 2), 1, 1.3);
  return g;
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
  /** Detachable magazine, animated during reload. */
  magazine: Object3D | null;
  /** Charging handle, animated on the reload cycle. */
  charging: Object3D | null;
  /** Trigger, pulled on fire. */
  trigger: Object3D | null;
  /**
   * Local-space offset that, when negated and applied to the viewmodel root,
   * puts the sight line on the camera axis. Tuned per weapon.
   */
  sightHeight: number;
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

  // --- Frame: extruded side profile with the classic 17-degree grip rake ---
  const frameProfile: [number, number][] = [
    [0.0, 0.0],
    [0.108, 0.0],
    [0.108, -0.012],
    [0.058, -0.016],
    [0.048, -0.03],
    [0.026, -0.108],
    [-0.006, -0.112],
    [0.004, -0.03],
    [-0.004, -0.014],
    [-0.004, 0.0],
  ];
  const frame = new Group();
  const frameKit = new MeshKit();
  frameKit.add('frame', poly, place(profile(frameProfile, 0.026, 0.0022), 0, 0, 0, 0, 0, 0));

  // Grip texture panels either side.
  for (const side of [-1, 1]) {
    frameKit.add(
      'frame',
      poly,
      place(box(0.004, 0.06, 0.028, 0.001), side * 0.0138, -0.062, 0.021, 0.28, 0, 0),
    );
  }
  // Trigger guard and takedown lever.
  frameKit.add('frame', poly, place(triggerGuard(0.019, 0.0035, 0.024), 0, -0.03, 0.048));
  frameKit.add('bright', bright, place(barrel(0.005, 0.005, 0.006, 12), -0.014, -0.012, 0.052, 0, Math.PI / 2, 0));
  frameKit.add('bright', bright, place(box(0.007, 0.012, 0.004, 0.001), -0.014, -0.006, 0.038));
  frameKit.flushInto(frame);
  root.add(frame);

  // --- Slide: chamfered, with serrations, ejection port and sights ---
  const slide = new Group();
  slide.name = 'slide';
  const slideKit = new MeshKit();
  slideKit.add('steel', steel, place(box(0.027, 0.03, 0.176, 0.004, 3), 0, 0.016, -0.038));
  // Dust cover / lower rail under the barrel.
  slideKit.add('steel', steel, place(box(0.023, 0.009, 0.06, 0.002), 0, -0.003, -0.09));
  // Ejection port cut, right side.
  slideKit.add('steel', steel, place(box(0.006, 0.014, 0.036, 0.0015), 0.013, 0.02, -0.028));
  slideKit.add(
    'steel',
    steel,
    ...serrations(7, 0.0072, 0.012, 0.017, 0.028, 0.026),
    ...serrations(4, 0.0072, -0.108, 0.017, 0.028, 0.024),
  );
  // Sights: front blade, rear notch blocks.
  slideKit.add('bright', bright, place(box(0.0035, 0.007, 0.005, 0.0006), 0, 0.034, -0.112));
  slideKit.add('bright', bright, place(box(0.008, 0.007, 0.006, 0.0006), -0.008, 0.034, 0.036));
  slideKit.add('bright', bright, place(box(0.008, 0.007, 0.006, 0.0006), 0.008, 0.034, 0.036));
  // Barrel protruding at the muzzle, with a visible bore.
  slideKit.add('bright', bright, place(barrel(0.0072, 0.0072, 0.03, 20), 0, 0.014, -0.128));
  slideKit.add(
    'bore',
    Presets.gunSteel(0x141414),
    place(barrel(0.0046, 0.0046, 0.012, 16), 0, 0.014, -0.14),
  );
  slideKit.flushInto(slide, true);
  root.add(slide);

  // --- Magazine ---
  const magazine = new Group();
  magazine.name = 'magazine';
  const magKit = new MeshKit();
  magKit.add('mag', Presets.gunSteel(0x9a9a9a), place(box(0.019, 0.098, 0.026, 0.0018), 0, -0.062, 0.026, 0.22, 0, 0));
  magKit.add('mag', poly, place(box(0.024, 0.008, 0.03, 0.0015), 0, -0.112, 0.036, 0.22, 0, 0));
  magKit.flushInto(magazine);
  root.add(magazine);

  // --- Trigger ---
  const trigger = new Group();
  trigger.name = 'trigger';
  new MeshKit()
    .add('bright', bright, place(box(0.005, 0.02, 0.006, 0.0012), 0, -0.022, 0.045, -0.12, 0, 0))
    .flushInto(trigger);
  root.add(trigger);

  root.add(marker('muzzle', 0, 0.014, -0.148));
  root.add(marker('eject', 0.016, 0.024, -0.02));

  return {
    root,
    muzzle: root.getObjectByName('muzzle')!,
    ejectPort: root.getObjectByName('eject')!,
    slide,
    magazine,
    charging: null,
    trigger,
    sightHeight: 0.0345,
    sightForward: -0.05,
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

  const body = new Group();
  const kit = new MeshKit();

  // Stamped-steel receiver: a rounded tube section, not a slab.
  kit.add('steel', steel, place(box(0.036, 0.042, 0.2, 0.008, 4), 0, 0.004, -0.03));
  // Cocking tube along the left side, ending in the classic dogleg.
  kit.add('steel', steel, place(barrel(0.011, 0.011, 0.16, 18), -0.019, 0.021, -0.098));
  kit.add('steel', steel, place(box(0.02, 0.014, 0.03, 0.004), -0.019, 0.021, -0.172));

  // Handguard.
  kit.add('poly', poly, place(box(0.038, 0.038, 0.115, 0.01, 4), 0, -0.004, -0.148));
  for (let i = 0; i < 5; i++) {
    kit.add('poly', poly, place(box(0.042, 0.004, 0.008, 0.0012), 0, -0.02, -0.11 - i * 0.017));
  }

  // Barrel and muzzle nut.
  kit.add('bright', bright, place(barrel(0.0085, 0.0085, 0.06, 20), 0, 0.004, -0.222));
  kit.add(
    'steel',
    steel,
    place(
      lathe(
        [
          [0.0, 0.0],
          [0.011, 0.0],
          [0.012, -0.004],
          [0.012, -0.018],
          [0.009, -0.022],
          [0.0, -0.022],
        ],
        20,
      ),
      0,
      0.004,
      -0.244,
    ),
  );
  kit.add('bore', Presets.gunSteel(0x121212), place(barrel(0.0052, 0.0052, 0.014, 16), 0, 0.004, -0.26));

  // Hooded front sight and rotary rear drum — the MP5's signature silhouette.
  kit.add('steel', steel, place(barrel(0.011, 0.011, 0.022, 14), 0, 0.031, -0.2));
  kit.add('bright', bright, place(box(0.0025, 0.014, 0.003, 0.0005), 0, 0.031, -0.2));
  kit.add('steel', steel, place(barrel(0.014, 0.014, 0.02, 16), 0, 0.03, 0.03, 0, 0, Math.PI / 2));
  kit.add('bright', bright, place(box(0.004, 0.006, 0.004, 0.0006), 0, 0.042, 0.03));

  // Pistol grip and trigger group housing.
  kit.add(
    'poly',
    poly,
    place(profile(
      [
        [0.0, 0.0],
        [0.062, 0.0],
        [0.056, -0.026],
        [0.03, -0.098],
        [0.0, -0.104],
        [0.006, -0.03],
      ],
      0.026,
      0.002,
    ), 0, -0.02, 0.058),
  );
  kit.add('poly', poly, place(triggerGuard(0.021, 0.0035, 0.024), 0, -0.038, 0.006));

  // Retractable stock: twin rails plus a butt pad.
  for (const side of [-1, 1]) {
    kit.add('steel', steel, place(barrel(0.005, 0.005, 0.13, 12), side * 0.014, 0.006, 0.135));
  }
  kit.add('poly', poly, place(box(0.036, 0.05, 0.014, 0.004), 0, 0.006, 0.196));

  kit.flushInto(body, true);
  root.add(body);

  // Curved 30-round magazine.
  const magazine = new Group();
  magazine.name = 'magazine';
  const magKit = new MeshKit();
  magKit.add('mag', Presets.gunSteel(0x86868c), ...curvedMagazine(7, 0.026, 0.02, 0.03, 0.028));
  magKit.flushInto(magazine);
  magazine.position.set(0, -0.024, -0.038);
  magazine.rotation.x = -0.12;
  root.add(magazine);

  // Cocking handle reciprocates on the left.
  const charging = new Group();
  charging.name = 'charging';
  new MeshKit()
    .add('bright', bright, place(box(0.026, 0.012, 0.016, 0.003), -0.03, 0.021, -0.172))
    .flushInto(charging);
  root.add(charging);

  const trigger = new Group();
  trigger.name = 'trigger';
  new MeshKit()
    .add('bright', bright, place(box(0.005, 0.019, 0.006, 0.0012), 0, -0.03, 0.004, -0.1, 0, 0))
    .flushInto(trigger);
  root.add(trigger);

  root.add(marker('muzzle', 0, 0.004, -0.27));
  root.add(marker('eject', 0.022, 0.014, -0.05));

  return {
    root,
    muzzle: root.getObjectByName('muzzle')!,
    ejectPort: root.getObjectByName('eject')!,
    slide: charging,
    magazine,
    charging,
    trigger,
    sightHeight: 0.0355,
    sightForward: -0.05,
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
  const body = new Group();
  const kit = new MeshKit();

  // Upper receiver — flat-top with a full-length rail.
  kit.add('poly', poly, place(box(0.038, 0.042, 0.19, 0.005, 3), 0, 0.012, -0.048));
  kit.add('poly', poly, ...railGeometries(0.185, 0.024, 0.045, 0.036));
  // Brass deflector and forward assist, right side.
  kit.add('poly', poly, place(box(0.01, 0.016, 0.022, 0.004), 0.021, 0.016, -0.006));
  kit.add('poly', poly, place(barrel(0.007, 0.007, 0.016, 12), 0.021, 0.006, 0.016, 0, Math.PI / 2, 0));
  // Ejection port cover.
  kit.add('steel', steel, place(box(0.004, 0.019, 0.038, 0.0012), 0.02, 0.014, -0.03));

  // Lower receiver with magazine well.
  kit.add(
    'poly',
    poly,
    place(profile(
      [
        [0.0, 0.0],
        [0.14, 0.0],
        [0.14, -0.03],
        [0.108, -0.034],
        [0.104, -0.07],
        [0.062, -0.074],
        [0.06, -0.03],
        [0.036, -0.028],
        [0.0, -0.026],
      ],
      0.03,
      0.0025,
    ), 0, -0.012, 0.062),
  );
  kit.add('poly', poly, place(triggerGuard(0.022, 0.0035, 0.028), 0, -0.036, 0.03));

  // Pistol grip, raked back with a beavertail.
  kit.add(
    'poly',
    poly,
    place(profile(
      [
        [0.0, 0.0],
        [0.05, 0.0],
        [0.044, -0.03],
        [0.026, -0.092],
        [-0.002, -0.096],
        [0.0, -0.03],
      ],
      0.028,
      0.002,
    ), 0, -0.036, 0.084, 0, 0, 0.28),
  );

  // Free-float handguard with vent slots and a low-profile gas block.
  kit.add('poly', poly, place(box(0.042, 0.042, 0.175, 0.012, 4), 0, 0.008, -0.176));
  for (let i = 0; i < 6; i++) {
    const z = -0.115 - i * 0.023;
    for (const side of [-1, 1]) {
      kit.add('poly', poly, place(box(0.008, 0.014, 0.016, 0.003), side * 0.021, 0.008, z));
    }
    kit.add('poly', poly, place(box(0.016, 0.008, 0.016, 0.003), 0, -0.013, z));
  }
  kit.add('poly', poly, ...railGeometries(0.16, 0.022, -0.1, 0.031));

  // Barrel, gas block, and A2-style flash hider.
  kit.add('bright', bright, place(barrel(0.0075, 0.0075, 0.09, 20), 0, 0.008, -0.29));
  kit.add('steel', steel, place(box(0.018, 0.024, 0.026, 0.003), 0, 0.014, -0.268));
  kit.add('bright', bright, place(barrel(0.0035, 0.0035, 0.09, 10), 0, 0.024, -0.29));
  const hider = lathe(
    [
      [0.0, 0.0],
      [0.0095, 0.0],
      [0.0105, -0.006],
      [0.0105, -0.034],
      [0.0125, -0.036],
      [0.0125, -0.042],
      [0.0, -0.042],
    ],
    20,
  );
  kit.add('steel', steel, place(hider, 0, 0.008, -0.334));
  // Prong slots in the flash hider.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    kit.add(
      'bore',
      Presets.gunSteel(0x101010),
      place(box(0.004, 0.004, 0.024, 0.001), Math.cos(a) * 0.009, 0.008 + Math.sin(a) * 0.009, -0.356),
    );
  }
  kit.add('bore', Presets.gunSteel(0x0f0f0f), place(barrel(0.005, 0.005, 0.016, 16), 0, 0.008, -0.37));

  // Buffer tube and collapsible stock.
  kit.add('steel', steel, place(barrel(0.016, 0.016, 0.15, 18), 0, 0.012, 0.15));
  kit.add(
    'poly',
    poly,
    place(profile(
      [
        [0.0, 0.028],
        [0.11, 0.03],
        [0.115, -0.006],
        [0.085, -0.014],
        [0.05, -0.03],
        [0.0, -0.024],
      ],
      0.036,
      0.004,
      true,
    ), 0, 0.006, 0.104),
  );
  kit.add('poly', Presets.gunPolymer(0x2a2a2a), place(box(0.04, 0.062, 0.012, 0.005), 0, 0.008, 0.228));

  // Flip-up iron sights.
  kit.add('steel', steel, place(box(0.016, 0.019, 0.007, 0.0018), 0, 0.046, -0.166));
  kit.add('bright', bright, place(box(0.0028, 0.014, 0.004, 0.0006), 0, 0.05, -0.166));
  kit.add('steel', steel, place(box(0.024, 0.017, 0.009, 0.002), 0, 0.045, 0.036));
  kit.add('bore', Presets.gunSteel(0x0d0d0d), place(barrel(0.0042, 0.0042, 0.01, 14), 0, 0.048, 0.036));

  kit.flushInto(body, true);
  root.add(body);

  // STANAG magazine, gently curved.
  const magazine = new Group();
  magazine.name = 'magazine';
  new MeshKit()
    .add('mag', Presets.gunPolymer(0x3c3f36), ...curvedMagazine(5, 0.026, 0.024, 0.031, 0.038))
    .flushInto(magazine);
  // Seated in the magazine well, forward of the trigger group.
  magazine.position.set(0, -0.042, -0.014);
  magazine.rotation.x = -0.055;
  root.add(magazine);

  // Charging handle in the upper receiver tail.
  const charging = new Group();
  charging.name = 'charging';
  new MeshKit()
    .add('steel', steel, place(box(0.05, 0.008, 0.02, 0.002), 0, 0.03, 0.052))
    .add('steel', steel, place(box(0.014, 0.01, 0.03, 0.002), 0, 0.03, 0.062))
    .flushInto(charging);
  root.add(charging);

  // Bolt carrier proxy — a small visible shift inside the ejection port.
  const slide = new Group();
  slide.name = 'slide';
  new MeshKit()
    .add('bright', bright, place(box(0.02, 0.018, 0.05, 0.002), 0, 0.014, -0.03))
    .flushInto(slide);
  root.add(slide);

  const trigger = new Group();
  trigger.name = 'trigger';
  new MeshKit()
    .add('bright', bright, place(box(0.005, 0.02, 0.006, 0.0012), 0, -0.03, 0.028, -0.1, 0, 0))
    .flushInto(trigger);
  root.add(trigger);

  root.add(marker('muzzle', 0, 0.008, -0.382));
  root.add(marker('eject', 0.026, 0.016, -0.02));

  return {
    root,
    muzzle: root.getObjectByName('muzzle')!,
    ejectPort: root.getObjectByName('eject')!,
    slide,
    magazine,
    charging,
    trigger,
    sightHeight: 0.0525,
    sightForward: -0.06,
  };
}

/* ------------------------------------------------------------------ */
/* Pump-action shotgun                                                 */
/* ------------------------------------------------------------------ */

export function buildShotgun(): GunModel {
  const root = new Group();
  const steel = Presets.gunSteel();
  const bright = Presets.brightSteel();
  const wood = Presets.stockWood();
  const body = new Group();
  const kit = new MeshKit();

  // Milled steel receiver.
  kit.add('steel', steel, place(box(0.042, 0.05, 0.15, 0.006, 3), 0, 0.0, -0.01));
  kit.add('steel', steel, place(box(0.006, 0.026, 0.05, 0.002), 0.023, 0.008, -0.02));
  // Loading port underneath.
  kit.add('steel', Presets.gunSteel(0x2a2a2a), place(box(0.024, 0.008, 0.05, 0.002), 0, -0.026, -0.01));

  // 18.5" barrel with a bead sight, plus the magazine tube beneath it.
  kit.add('steel', steel, place(barrel(0.0135, 0.0135, 0.3, 22), 0, 0.019, -0.24));
  kit.add('bore', Presets.gunSteel(0x111111), place(barrel(0.0098, 0.0098, 0.02, 18), 0, 0.019, -0.385));
  kit.add('steel', steel, place(barrel(0.012, 0.012, 0.24, 18), 0, -0.008, -0.21));
  kit.add('steel', steel, place(box(0.014, 0.014, 0.014, 0.003), 0, 0.006, -0.16));
  kit.add('bright', bright, place(new SphereGeometry(0.0032, 10, 8), 0, 0.034, -0.372));
  // Barrel-to-magazine clamp.
  kit.add('steel', steel, place(box(0.03, 0.04, 0.014, 0.004), 0, 0.007, -0.322));

  // Wooden buttstock with a rubber recoil pad.
  kit.add(
    'wood',
    wood,
    place(profile(
      [
        [0.0, 0.03],
        [0.045, 0.032],
        [0.14, 0.046],
        [0.15, 0.006],
        [0.115, -0.012],
        [0.06, -0.05],
        [0.03, -0.052],
        [0.0, -0.026],
      ],
      0.042,
      0.005,
      true,
    ), 0, 0.0, 0.068),
  );
  kit.add('poly', Presets.gunPolymer(0x1c1a18), place(box(0.046, 0.086, 0.016, 0.006), 0, 0.006, 0.216));
  kit.add('steel', steel, place(triggerGuard(0.02, 0.004, 0.03), 0, -0.034, 0.014));

  kit.flushInto(body, true);
  root.add(body);

  // Grooved wooden pump forend — this is the part that travels on cycling.
  const slide = new Group();
  slide.name = 'slide';
  const slideKit = new MeshKit();
  slideKit.add('wood', wood, place(box(0.05, 0.042, 0.115, 0.012, 4), 0, -0.005, -0.155));
  for (let i = 0; i < 7; i++) {
    slideKit.add(
      'wood',
      wood,
      place(box(0.054, 0.005, 0.007, 0.0018), 0, -0.005, -0.108 - i * 0.0155),
    );
  }
  slideKit.flushInto(slide, true);
  root.add(slide);

  const trigger = new Group();
  trigger.name = 'trigger';
  new MeshKit()
    .add('bright', bright, place(box(0.005, 0.02, 0.007, 0.0012), 0, -0.028, 0.012, -0.1, 0, 0))
    .flushInto(trigger);
  root.add(trigger);

  root.add(marker('muzzle', 0, 0.019, -0.395));
  root.add(marker('eject', 0.028, 0.008, -0.02));

  return {
    root,
    muzzle: root.getObjectByName('muzzle')!,
    ejectPort: root.getObjectByName('eject')!,
    slide,
    magazine: null,
    charging: null,
    trigger,
    sightHeight: 0.034,
    sightForward: -0.06,
  };
}
