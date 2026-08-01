import { BufferGeometry, Material, Mesh, Object3D } from 'three';

/**
 * Releases resources owned by one procedurally built model.
 *
 * Textures are deliberately left alone: the material library caches and shares
 * them across weapons and world props. Geometry and materials, by contrast,
 * are created for each model build and belong to this subtree.
 */
export function disposeModel(root: Object3D) {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();

  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    const owned = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of owned) materials.add(material);
  });

  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}
