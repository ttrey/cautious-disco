import {
  ACESFilmicToneMapping,
  AmbientLight,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { buildEnvironment } from '../core/Environment';
import { OPERATOR_IDS, OperatorId, SoldierRig, buildSoldierMesh } from '../characters/SoldierMesh';
import { SoldierAnimator, SoldierAnimName } from '../characters/SoldierAnimations';
import { WEAPONS } from '../weapons/WeaponDefs';

/**
 * Operator inspection harness (`/slab.html`).
 *
 * The same argument as `/zlab.html`: judging a face, a helmet cut or a hand on
 * a grip needs the *same* framing before and after an edit, at the exposure the
 * game actually renders at. This one additionally holds a weapon, because half
 * of what is being judged is whether the hands are on it.
 *
 * From the console:
 *
 *   __slab.build(ids?, weapon?)   rebuild the row
 *   __slab.view(name)             fixed camera preset; 1-9 pick the first nine
 *   __slab.only(mesh|null)        isolate soldierSkin/Uniform/Gear/Hard
 *   __slab.pose(state)            drive the animator from a player state
 *   __slab.step(dt)               advance every animator by dt
 *   __slab.free(yaw, pitch, dist) orbit, keeping the current view's target
 */

const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
// Matches Engine.ts, so what looks right here looks right in the game.
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new Scene();
scene.environment = buildEnvironment(renderer);
scene.environmentIntensity = 0.9;

const camera = new PerspectiveCamera(34, innerWidth / innerHeight, 0.01, 60);

const key = new DirectionalLight(0xfff3e2, 2.4);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 0.1;
key.shadow.camera.far = 14;
key.shadow.bias = -0.0006;
scene.add(key);

const fill = new DirectionalLight(0xc8d8ff, 1.1);
scene.add(fill);
const rim = new DirectionalLight(0xbcd0ff, 1.6);
scene.add(rim);
scene.add(new AmbientLight(0x8894a8, 0.55));

const floor = new Mesh(
  new PlaneGeometry(24, 24),
  new MeshStandardMaterial({ color: 0x3a3c40, roughness: 0.95 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const stage = new Group();
scene.add(stage);

let current: Object3D | null = null;
let rigs: SoldierRig[] = [];
let animators: SoldierAnimator[] = [];

function build(ids: OperatorId[] = [...OPERATOR_IDS], weapon = 'rifle') {
  if (current) stage.remove(current);
  animators.forEach((a) => a.dispose());
  animators = [];
  rigs = [];

  const g = new Group();
  ids.forEach((id, i) => {
    const rig = buildSoldierMesh(id);
    rig.root.position.x = (i - (ids.length - 1) * 0.5) * 1.0;
    const animator = new SoldierAnimator(rig);
    if (weapon && WEAPONS[weapon]) animator.setWeapon(WEAPONS[weapon]);
    animator.update(0.016);
    animators.push(animator);
    rigs.push(rig);
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

/** Camera presets. The model faces -Z, so yaw = PI looks at its front. */
const VIEWS: Record<string, () => void> = {
  front: () => set(0, 0.92, 0, Math.PI, 0.02, 2.9),
  threeQuarter: () => set(0, 0.92, 0, Math.PI + 0.7, 0.06, 2.9),
  side: () => set(0, 0.92, 0, Math.PI * 0.5, 0.02, 2.9),
  back: () => set(0, 0.92, 0, 0, 0.02, 2.9),
  face: () => set(0, 1.66, -0.02, Math.PI, 0.0, 0.44),
  faceQuarter: () => set(0, 1.66, -0.02, Math.PI + 0.75, 0.05, 0.44),
  faceSide: () => set(0, 1.66, -0.02, Math.PI * 0.5, 0.0, 0.44),
  head: () => set(0, 1.7, -0.02, Math.PI + 0.5, 0.18, 0.62),
  torso: () => set(0, 1.26, 0, Math.PI, 0.03, 1.15),
  torsoQuarter: () => set(0, 1.26, 0, Math.PI + 0.8, 0.05, 1.15),
  torsoBack: () => set(0, 1.26, 0, 0, 0.05, 1.15),
  hands: () => set(-0.05, 1.15, -0.28, Math.PI + 0.6, 0.1, 0.62),
  weapon: () => set(0, 1.25, -0.35, Math.PI * 0.62, 0.08, 1.05),
  legs: () => set(0, 0.5, 0, Math.PI, 0.02, 1.35),
  boots: () => set(0, 0.16, 0, Math.PI + 0.5, 0.12, 0.6),
  row: () => set(0, 1.0, 0, Math.PI, 0.03, 5.0),
  rowBack: () => set(0, 1.0, 0, 0, 0.03, 5.0),
  rowQuarter: () => set(0, 1.0, 0, Math.PI + 0.6, 0.06, 5.0),
};

function set(tx: number, ty: number, tz: number, y: number, p: number, d: number) {
  target.set(tx, ty, tz);
  yaw = y;
  pitch = p;
  dist = d;
}

build();
VIEWS.row();

(window as unknown as Record<string, unknown>).__slab = {
  build: (ids?: OperatorId[], weapon?: string) => build(ids, weapon),
  view: (name: string) => VIEWS[name]?.(),
  free: (y: number, p: number, d: number) => {
    yaw = y;
    pitch = p;
    dist = d;
  },
  exposure: (v: number) => {
    renderer.toneMappingExposure = v;
  },
  /** Isolates one of soldierSkin / soldierUniform / soldierGear / soldierHard. */
  only: (name: string | null) => {
    current?.traverse((o) => {
      if (o.name.startsWith('soldier') && !o.name.startsWith('soldier:')) {
        o.visible = !name || o.name === name;
      }
    });
  },
  /** Drives every animator from one player state; see SoldierAnimations. */
  pose: (state: Record<string, unknown>) => {
    animators.forEach((a) => a.setState(state as never));
  },
  /** Plays a named locomotion clip directly, bypassing the state mapping. */
  clip: (name: SoldierAnimName) => animators.forEach((a) => a.play(name, 0)),
  step: (dt: number) => animators.forEach((a) => a.update(dt)),
  weapon: (id: string) => animators.forEach((a) => a.setWeapon(WEAPONS[id])),
  rigs: () => rigs,
};

// Keyboard: 1-9 pick a view, so the page is usable by hand as well.
const order = Object.keys(VIEWS);
addEventListener('keydown', (e) => {
  const n = Number(e.key);
  if (n >= 1 && n <= 9 && order[n - 1]) VIEWS[order[n - 1]]();
});

let last = performance.now();
function frame() {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  animators.forEach((a) => a.update(dt));

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
