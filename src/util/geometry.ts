import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const CORE_ATTRIBUTES = ['position', 'normal', 'uv'] as const;

/**
 * Merges heterogeneous geometry safely.
 *
 * Three's `mergeGeometries` requires every input to agree on both its attribute
 * set and whether it is indexed. Our generators mix sources that disagree —
 * `ExtrudeGeometry` is non-indexed while lathes, spheres and tubes are indexed,
 * and some carry extra attributes. This normalises all of that first.
 *
 * Indexed inputs are preserved when they are unanimous (important for skinned
 * characters, where de-indexing would triple the vertex count); otherwise
 * everything is flattened to non-indexed.
 */
export function mergeAll(
  geometries: BufferGeometry[],
  extraAttributes: readonly string[] = [],
): BufferGeometry | null {
  if (geometries.length === 0) return null;
  const keep = new Set<string>([...CORE_ATTRIBUTES, ...extraAttributes]);

  for (const g of geometries) {
    for (const name of Object.keys(g.attributes)) {
      if (!keep.has(name)) g.deleteAttribute(name);
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) {
      // A missing UV set breaks the merge; a flat one is better than failing.
      g.setAttribute('uv', new Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    }
  }

  const allIndexed = geometries.every((g) => g.index !== null);
  const inputs = allIndexed ? geometries : geometries.map((g) => (g.index ? g.toNonIndexed() : g));

  const merged = BufferGeometryUtils.mergeGeometries(inputs, false);
  if (!merged) {
    console.warn('mergeAll: incompatible geometry set', {
      count: geometries.length,
      attributes: geometries.map((g) => Object.keys(g.attributes).sort().join(',')),
    });
  }

  if (!allIndexed) {
    inputs.forEach((g, i) => {
      if (g !== geometries[i]) g.dispose();
    });
  }
  return merged;
}

const _n = new Vector3();

/**
 * Replaces a geometry's UVs with a world-space box projection.
 *
 * Procedural parts are assembled from sources whose native UVs have wildly
 * different texel densities — an `ExtrudeGeometry` emits UVs in shape units
 * (so a 0.1 m grip samples a 0.1 x 0.1 slice of the texture and reads as flat
 * colour), while a tube emits 0..1 along its length regardless of whether that
 * length is a 0.5 m thigh or a 0.02 m finger.
 *
 * Projecting from position along the dominant normal axis gives every surface
 * the same texels per metre, which is the difference between "textured" and
 * "tinted grey". `scale` is texture tiles per metre.
 */
export function boxProjectUV(geo: BufferGeometry, scale = 4): void {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  if (!nrm) geo.computeVertexNormals();
  const normal = geo.attributes.normal;
  const uv = new Float32Array(pos.count * 2);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    _n.set(Math.abs(normal.getX(i)), Math.abs(normal.getY(i)), Math.abs(normal.getZ(i)));

    let u: number;
    let v: number;
    if (_n.x >= _n.y && _n.x >= _n.z) {
      u = z;
      v = y;
    } else if (_n.y >= _n.z) {
      u = x;
      v = z;
    } else {
      u = x;
      v = y;
    }
    uv[i * 2] = u * scale;
    uv[i * 2 + 1] = v * scale;
  }
  geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
}
