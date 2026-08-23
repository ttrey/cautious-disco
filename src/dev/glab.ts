import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  Fog,
  HalfFloatType,
  HemisphereLight,
  LinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  MeshStandardMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  SRGBColorSpace,
  Scene,
  WebGLRenderTarget,
  WebGLRenderer,
} from 'three';
import { buildEnvironment } from '../core/Environment';
import { ViewModel } from '../weapons/ViewModel';
import { WEAPONS } from '../weapons/WeaponDefs';
import { makeSurface } from '../assets/Materials';

/**
 * First-person weapon harness (`/glab.html`).
 *
 * The asset turntable in `/preview.html` orbits a weapon in isolation, which
 * answers "is the model right" but never "is it framed right". Every complaint
 * about a viewmodel — too far back, sights off the crosshair, a part poking
 * through a hand — is a statement about the *shipping* first-person pass, so
 * this harness reproduces that pass exactly: `Engine`'s viewmodel camera, its
 * viewmodel light rig, and the real `ViewModel` driven by the real weapon defs.
 *
 * A world backdrop is drawn behind it so the silhouette has something to read
 * against, and a screen-centre reticle marks where the sight line must land.
 */

const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFShadowMap;
document.body.appendChild(renderer.domElement);

/* --- Backdrop, standing in for the level ----------------------------- */
const world = new Scene();
world.background = new Color(0x101820);
world.fog = new Fog(0x11141d, 12, 104);
const env = buildEnvironment(renderer);
world.environment = env;
world.environmentIntensity = 0.85;

const worldCamera = new PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 260);
worldCamera.position.set(0, 1.6, 0);

const wall = new Mesh(
  new PlaneGeometry(40, 12),
  makeSurface('concrete', { repeat: 8, tint: 0x85898e }) as MeshStandardMaterial,
);
wall.position.set(0, 3, -30);
world.add(wall);
const floor = new Mesh(
  new PlaneGeometry(40, 40),
  makeSurface('concrete', { repeat: 10, tint: 0x454b52 }) as MeshStandardMaterial,
);
floor.rotation.x = -Math.PI / 2;
world.add(floor);
// Range markers at known distances, so magnification is judged against
// something that changes size rather than against flat concrete.
for (const [i, dist] of [4, 8, 14, 22].entries()) {
  const post = new Mesh(
    new PlaneGeometry(0.5, 1.8),
    makeSurface('concrete', { repeat: 1, tint: i % 2 ? 0xc8a05a : 0xa8c0d8 }) as MeshStandardMaterial,
  );
  post.position.set((i - 1.5) * 1.2, 0.9, -dist);
  world.add(post);
}
world.add(new HemisphereLight(0x9fb4d8, 0x2a2622, 1.35));
const sun = new DirectionalLight(0xffe6c4, 1.4);
sun.position.set(2, 6, 2);
world.add(sun);
const rangeFill = new DirectionalLight(0x9fbde3, 0.7);
rangeFill.position.set(-4, 3, -10);
world.add(rangeFill);

/* --- Viewmodel pass, identical to Engine ----------------------------- */
const viewScene = new Scene();
viewScene.environment = env;
viewScene.environmentIntensity = 0.9;
const viewCamera = new PerspectiveCamera(58, innerWidth / innerHeight, 0.008, 12);

{
  const key = new DirectionalLight(0xffe6c4, 2.6);
  key.position.set(0.6, 1.2, 0.4);
  viewScene.add(key);
  const fill = new DirectionalLight(0x9fc0ff, 1.1);
  fill.position.set(-0.9, -0.2, 0.6);
  viewScene.add(fill);
  const rim = new PointLight(0xffd0a0, 3.2, 4, 2);
  rim.position.set(-0.35, 0.3, -0.8);
  viewScene.add(rim);
  viewScene.add(new HemisphereLight(0x9fb4d8, 0x2a2622, 0.7));
}

const vm = new ViewModel(viewScene);
let weapon = 'rifle';
let aiming = false;
let animate = true;
let shotIndex = 0;

function label() {
  document.getElementById('label')!.textContent =
    `${WEAPONS[weapon].name} — ${aiming ? 'ADS' : 'hip'}${animate ? '' : ' (paused)'}`;
}

function equip(id: string, ads = aiming) {
  weapon = id;
  aiming = ads;
  vm.equip(WEAPONS[id]);
  vm.setAiming(aiming);
  settle();
  label();
}

/** Runs the viewmodel to its steady state so a screenshot is not mid-swap. */
function settle(frames = 150) {
  for (let i = 0; i < frames; i++) step(1 / 60);
}

function step(dt: number) {
  vm.update(dt, viewCamera, {
    lookX: 0,
    lookY: 0,
    moveIntensity: 0,
    bobPhase: 0,
    bobAmount: 0,
    sprinting: false,
    inspecting: false,
  });
  applyZoom();
}

/** Mirrors `WeaponSystem.applyAimZoom` so the harness frames what the game does. */
const BASE_FOV = 72;
const OPTIC_HOST_ZOOM = 1.1;
function applyZoom() {
  const zoom = vm.hasOptic ? OPTIC_HOST_ZOOM : WEAPONS[weapon].adsZoom ?? 1;
  const half = (BASE_FOV * Math.PI) / 360;
  const aimed = Math.atan(Math.tan(half) / zoom);
  const fov = ((half + (aimed - half) * vm.adsBlend) * 360) / Math.PI;
  if (Math.abs(worldCamera.fov - fov) > 1e-4) {
    worldCamera.fov = fov;
    worldCamera.updateProjectionMatrix();
  }
}

/** Mirrors the engine's off-screen optic pass. */
const scopeTarget = new WebGLRenderTarget(640, 640, {
  minFilter: LinearFilter,
  magFilter: LinearFilter,
  type: HalfFloatType,
  colorSpace: LinearSRGBColorSpace,
  depthBuffer: true,
});
const scopeCamera = new PerspectiveCamera(30, 1, 0.05, 260);

function renderOptic(): boolean {
  const zoom = WEAPONS[weapon].adsZoom ?? 1;
  if (!vm.hasOptic || vm.adsBlend < 0.15) {
    vm.setOpticView(null);
    return false;
  }
  worldCamera.updateMatrixWorld();
  scopeCamera.matrixAutoUpdate = false;
  scopeCamera.matrixWorld.copy(worldCamera.matrixWorld);
  scopeCamera.matrixWorldInverse.copy(scopeCamera.matrixWorld).invert();
  const half = Math.atan(Math.tan((BASE_FOV * Math.PI) / 360) / Math.max(zoom, 0.01));
  scopeCamera.fov = (half * 360) / Math.PI;
  scopeCamera.updateProjectionMatrix();
  renderer.setRenderTarget(scopeTarget);
  renderer.clear();
  renderer.render(world, scopeCamera);
  renderer.setRenderTarget(null);
  vm.setOpticView(scopeTarget.texture);
  return true;
}

const keys: Record<string, string> = {
  Digit1: 'pistol',
  Digit2: 'smg',
  Digit3: 'rifle',
  Digit4: 'shotgun',
  Digit5: 'desertEagle',
  Digit6: 'barrettM82A1',
  Digit7: 'spas12',
  Digit8: 'm240',
  Digit0: 'fnScar',
  KeyU: 'aether9',
  KeyI: 'stormweaver',
};

addEventListener('keydown', (e) => {
  if (keys[e.code]) return equip(keys[e.code]);
  if (e.code === 'Space') {
    aiming = !aiming;
    vm.setAiming(aiming);
    label();
  }
  if (e.code === 'KeyF') vm.fire(WEAPONS[weapon], ++shotIndex);
  if (e.code === 'KeyP') {
    animate = !animate;
    label();
  }
});

(window as unknown as Record<string, unknown>).__glab = {
  /** Equips a weapon and settles it, optionally aimed. */
  set: (id: string, ads = false) => equip(id, ads),
  /** Freezes the procedural idle so successive screenshots are comparable. */
  freeze: (on = true) => {
    animate = !on;
    label();
  },
  settle,
  fire: () => vm.fire(WEAPONS[weapon], ++shotIndex),
  /** Every weapon id, for sweeping the whole roster. */
  weapons: () => Object.keys(WEAPONS),
  /** The live viewmodel, for measuring part positions in page. */
  vm,
  viewCamera,
};

equip(weapon);

let last = performance.now();
function frame() {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (animate) step(dt);
  renderOptic();

  renderer.autoClear = true;
  renderer.render(world, worldCamera);
  renderer.autoClear = false;
  renderer.clearDepth();
  renderer.render(viewScene, viewCamera);
  renderer.autoClear = true;
  requestAnimationFrame(frame);
}
frame();

addEventListener('resize', () => {
  const aspect = innerWidth / innerHeight;
  worldCamera.aspect = aspect;
  worldCamera.updateProjectionMatrix();
  viewCamera.aspect = aspect;
  viewCamera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
