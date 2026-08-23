import {
  ACESFilmicToneMapping,
  AmbientLight,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { buildEnvironment } from '../core/Environment';
import { ZombieRig, buildZombieMesh } from '../zombies/ZombieMesh';
import { ZombieAnimator, ZombieAnimName } from '../zombies/ZombieAnimations';
import { Rng } from '../util/math';

/**
 * Zombie inspection harness (`/zlab.html`).
 *
 * `preview.html` is a turntable for looking at one asset from any angle, which
 * is the wrong tool for a character: judging a face needs the *same* framing
 * before and after an edit, at the exposure the game actually uses. This page
 * supplies fixed camera presets, a horde row, mesh isolation and single-frame
 * animation stepping, all driven from `window.__zlab` so a screenshot of a
 * given view is directly comparable across changes.
 */

const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
// Matches Engine.ts, so what looks right here looks right in the game.
renderer.toneMappingExposure = 1.08;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new Scene();
scene.background = new Color(0x101820);
scene.environment = buildEnvironment(renderer);
scene.environmentIntensity = 0.9;

const camera = new PerspectiveCamera(34, innerWidth / innerHeight, 0.01, 60);

const key = new DirectionalLight(0xfff3e2, 2.8);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 0.1;
key.shadow.camera.far = 14;
key.shadow.bias = -0.0006;
scene.add(key);

const fill = new DirectionalLight(0xc8d8ff, 1.5);
scene.add(fill);
const rim = new DirectionalLight(0xbcd0ff, 1.6);
scene.add(rim);
scene.add(new AmbientLight(0x8894a8, 0.72));

// A neutral studio wall gives the face and torn-cloth silhouette a value
// reference. The previous black void hid both material separation and the
// layered wound in exactly the cases this harness is meant to catch.
const backdrop = new Mesh(
  new PlaneGeometry(18, 10),
  new MeshStandardMaterial({ color: 0x17212a, roughness: 0.98, metalness: 0 }),
);
backdrop.position.set(0, 4, 2.8);
backdrop.rotation.y = Math.PI;
backdrop.receiveShadow = true;
scene.add(backdrop);

const floor = new Mesh(
  new PlaneGeometry(24, 24),
  new MeshStandardMaterial({ color: 0x303840, roughness: 0.95 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const stage = new Group();
scene.add(stage);

let current: Object3D | null = null;
const animators: ZombieAnimator[] = [];
let rigs: ZombieRig[] = [];

function build(seeds: number[], clip?: ZombieAnimName) {
  if (current) {
    stage.remove(current);
  }
  animators.length = 0;
  rigs = [];
  const g = new Group();
  seeds.forEach((seed, i) => {
    const rig = buildZombieMesh(seed);
    rigs.push(rig);
    rig.root.position.x = (i - (seeds.length - 1) * 0.5) * 0.95;
    if (clip) {
      const animator = new ZombieAnimator(rig, new Rng(seed * 977 + 13));
      animator.reset();
      animator.play(clip, 0);
      animator.update(0.4 + i * 0.35);
      animators.push(animator);
    }
    g.add(rig.root);
  });
  g.traverse((o) => {
    const m = o as Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
  });
  current = g;
  stage.add(g);
}

const target = new Vector3();
let yaw = Math.PI;
let pitch = 0.05;
let dist = 3;

/** Camera presets. Model faces -Z, so yaw = PI looks at its front. */
const VIEWS: Record<string, () => void> = {
  // Keep the complete silhouette inside the fixed 34-degree review frame;
  // 2.9 m was tight enough to clip the helmet and boots on taller variants.
  front: () => set(0, 0.88, 0, Math.PI, 0.02, 3.25),
  threeQuarter: () => set(0, 0.88, 0, Math.PI + 0.7, 0.06, 3.25),
  side: () => set(0, 0.88, 0, Math.PI * 0.5, 0.02, 3.25),
  back: () => set(0, 0.88, 0, 0, 0.02, 3.25),
  face: () => set(0, 1.63, -0.02, Math.PI, 0.0, 0.42),
  faceQuarter: () => set(0, 1.63, -0.02, Math.PI + 0.75, 0.05, 0.42),
  faceSide: () => set(0, 1.63, -0.02, Math.PI * 0.5, 0.0, 0.42),
  faceLow: () => set(0, 1.6, -0.02, Math.PI, -0.35, 0.45),
  torso: () => set(0, 1.25, 0, Math.PI, 0.03, 1.1),
  torsoQuarter: () => set(0, 1.25, 0, Math.PI + 0.8, 0.05, 1.1),
  legs: () => set(0, 0.5, 0, Math.PI, 0.02, 1.3),
  hands: () => set(0.28, 0.85, 0, Math.PI + 0.5, 0.05, 0.55),
  row: () => set(0, 0.95, 0, Math.PI, 0.03, 4.6),
  rowBack: () => set(0, 0.95, 0, 0, 0.03, 4.6),
};

function set(tx: number, ty: number, tz: number, y: number, p: number, d: number) {
  target.set(tx, ty, tz);
  yaw = y;
  pitch = p;
  dist = d;
}

build([1]);
VIEWS.front();

(window as unknown as Record<string, unknown>).__zlab = {
  build: (seeds: number[], clip?: ZombieAnimName) => build(seeds, clip),
  /** Advances every animator by `dt`, so a posed frame can be inspected. */
  step: (dt: number) => animators.forEach((a) => a.update(dt)),
  view: (name: string) => VIEWS[name]?.(),
  free: (y: number, p: number, d: number) => {
    yaw = y;
    pitch = p;
    dist = d;
  },
  exposure: (v: number) => {
    renderer.toneMappingExposure = v;
  },
  /** Isolates one of zombieSkin / zombieClothes / zombieGear, or null for all. */
  only: (name: string | null) => {
    current?.traverse((o) => {
      if (o.name.startsWith('zombie') && o.name !== 'zombie') o.visible = !name || o.name === name;
    });
  },
  /** The built rigs, for measuring bone positions and framing off them. */
  rigs: () => rigs,
  /**
   * Frames a bone on the first zombie. Variant heights move the head by up to
   * 60 mm, which at the 0.42 m framing the face preset uses is most of the
   * frame — so a fixed target height is only ever right for one seed.
   */
  at: (bone: string, y: number, p: number, d: number) => {
    const b = rigs[0]?.bones[bone as keyof ZombieRig['bones']];
    if (!b) return;
    b.updateWorldMatrix(true, false);
    target.setFromMatrixPosition(b.matrixWorld);
    yaw = y;
    pitch = p;
    dist = d;
  },
};

// Keyboard: 1-9 pick a view, so the page is usable by hand as well.
const order = Object.keys(VIEWS);
addEventListener('keydown', (e) => {
  const n = Number(e.key);
  if (n >= 1 && n <= 9 && order[n - 1]) VIEWS[order[n - 1]]();
});

function frame() {
  camera.position.set(
    target.x + Math.sin(yaw) * Math.cos(pitch) * dist,
    target.y + Math.sin(pitch) * dist,
    target.z + Math.cos(yaw) * Math.cos(pitch) * dist,
  );
  camera.lookAt(target);

  const place = (light: DirectionalLight, offset: number, height: number) => {
    light.position.set(
      target.x + Math.sin(yaw + offset) * 4,
      target.y + height,
      target.z + Math.cos(yaw + offset) * 4,
    );
    light.target.position.copy(target);
    light.target.updateMatrixWorld();
  };
  place(key, -0.6, 2.6);
  place(fill, 1.4, 0.6);
  place(rim, Math.PI + 0.6, 2.2);

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
