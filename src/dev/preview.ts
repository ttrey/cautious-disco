import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  DirectionalLight,
  Group,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { buildEnvironment } from '../core/Environment';
import { buildPistol, buildRifle, buildShotgun, buildSmg } from '../weapons/GunSmith';
import { buildArms } from '../weapons/Arms';
import { buildZombieMesh } from '../zombies/ZombieMesh';
import { makeSurface } from '../assets/Materials';

/**
 * Standalone asset turntable (`/preview.html`).
 *
 * Kept in the repo because iterating on model and material quality inside a
 * running game is slow and imprecise — this shows one asset at a time under
 * controlled three-point lighting, which is how you actually catch a bad
 * normal map or a wrong bevel.
 */

const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new Scene();
scene.environment = buildEnvironment(renderer);
scene.environmentIntensity = 0.7;

const camera = new PerspectiveCamera(38, innerWidth / innerHeight, 0.01, 60);

// Three-point studio rig. The lights orbit with the camera (see `frame`) so
// whichever side of an asset you rotate to is the side that is properly lit —
// otherwise half the turntable is spent looking at a silhouette.
const key = new DirectionalLight(0xdfe8ff, 1.6);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 0.1;
key.shadow.camera.far = 14;
key.shadow.bias = -0.0008;
scene.add(key);

const fill = new PointLight(0xffb070, 3, 14, 2);
scene.add(fill);

const rim = new PointLight(0x9fc0ff, 8, 16, 2);
scene.add(rim);

scene.add(new AmbientLight(0x2a3040, 0.35));

const floor = new Mesh(
  new PlaneGeometry(20, 20),
  makeSurface('concrete', { repeat: 6, tint: 0x8a8a8a }) as MeshStandardMaterial,
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const stage = new Group();
scene.add(stage);

let current: Object3D | null = null;
let radius = 1;
let target = new Vector3();

function show(builder: () => Object3D, label: string) {
  if (current) stage.remove(current);
  current = builder();
  current.traverse((o) => {
    const m = o as Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
  });
  stage.add(current);

  const bbox = new Box3().setFromObject(current);
  const size = bbox.getSize(new Vector3());
  bbox.getCenter(target);
  radius = Math.max(size.x, size.y, size.z) * 1.9;
  floor.position.y = bbox.min.y - 0.02;
  document.getElementById('hud')!.querySelector('b')!.textContent = label;
}

const builders: Record<string, [() => Object3D, string]> = {
  Digit1: [() => buildPistol().root, 'M9 Sidearm'],
  Digit2: [() => buildSmg().root, 'MP-40K SMG'],
  Digit3: [() => buildRifle().root, 'M4 Carbine'],
  Digit4: [() => buildShotgun().root, 'Trench Sweeper'],
  Digit5: [() => buildZombieMesh(0).root, 'Zombie'],
  Digit6: [
    () => {
      const g = new Group();
      const arms = buildArms();
      arms.right.root.position.set(0.2, 0.5, 0);
      arms.left.root.position.set(-0.2, 0.5, 0);
      g.add(arms.left.root, arms.right.root);
      return g;
    },
    'Arms',
  ],
};

show(builders.Digit3[0], builders.Digit3[1]);

addEventListener('keydown', (e) => {
  const b = builders[e.code];
  if (b) show(b[0], b[1]);
});

// --- Orbit ---
let yaw = 0.9;
let pitch = 0.22;
let zoom = 1;
let dragging = false;
renderer.domElement.addEventListener('pointerdown', () => (dragging = true));
addEventListener('pointerup', () => (dragging = false));
addEventListener('pointermove', (e) => {
  if (!dragging) return;
  yaw -= e.movementX * 0.006;
  pitch = MathUtils.clamp(pitch + e.movementY * 0.006, -1.3, 1.3);
});
addEventListener('wheel', (e) => {
  zoom = MathUtils.clamp(zoom * (1 + Math.sign(e.deltaY) * 0.09), 0.35, 3);
}, { passive: true });

// Expose a hook so automated screenshots can set a deterministic pose.
(window as unknown as Record<string, unknown>).__preview = {
  show: (code: string) => {
    const b = builders[code];
    if (b) show(b[0], b[1]);
  },
  setView: (y: number, p: number, z: number) => {
    yaw = y;
    pitch = p;
    zoom = z;
  },
};

function frame() {
  const d = radius * zoom;
  camera.position.set(
    target.x + Math.sin(yaw) * Math.cos(pitch) * d,
    target.y + Math.sin(pitch) * d,
    target.z + Math.cos(yaw) * Math.cos(pitch) * d,
  );
  camera.lookAt(target);

  // Key 40 degrees off the camera axis, fill on the opposite side, rim behind.
  const place = (light: { position: Vector3 }, offset: number, height: number, dist: number) => {
    light.position.set(
      target.x + Math.sin(yaw + offset) * dist,
      target.y + height,
      target.z + Math.cos(yaw + offset) * dist,
    );
  };
  place(key, -0.7, radius * 1.4, radius * 1.6);
  place(fill, 1.3, radius * 0.2, radius * 1.3);
  place(rim, Math.PI + 0.5, radius * 0.9, radius * 1.5);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
