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
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { buildEnvironment } from '../core/Environment';
import {
  buildBarrettM82A1,
  buildAether9,
  buildDesertEagle,
  buildPistol,
  buildRifle,
  buildScar,
  buildShotgun,
  buildSmg,
  buildSpas12,
  buildM240,
  buildStormweaver,
} from '../weapons/GunSmith';
import { buildArms } from '../weapons/Arms';
import { ViewModel } from '../weapons/ViewModel';
import { WEAPONS } from '../weapons/WeaponDefs';
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
renderer.shadowMap.type = PCFShadowMap;
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

/**
 * Live first-person viewmodel — the gun with both hands solved onto it by the
 * real `ViewModel`, not a static mock.
 *
 * A gun on its own says nothing about whether the player is *holding* it: the
 * grip is produced by IK and a hand basis that only exist in `ViewModel`, so a
 * mock would just reproduce whatever the mock's author believed. This runs the
 * shipping code and lets the turntable orbit the result.
 */
let vm: ViewModel | null = null;
let vmWeapon = 'pistol';
let previewShotIndex = 0;
const vmCamera = new PerspectiveCamera(58, 1, 0.01, 10);

function buildViewModel(): Object3D {
  vm?.dispose();
  vm = new ViewModel(scene);
  vm.equip(WEAPONS[vmWeapon]);
  previewShotIndex = 0;
  // Settle the springs and blends so the pose is the steady-state one rather
  // than whatever the first frame of a weapon swap looks like.
  for (let i = 0; i < 90; i++) {
    vm.update(1 / 60, vmCamera, {
      lookX: 0, lookY: 0, moveIntensity: 0, bobPhase: 0,
      bobAmount: 0, sprinting: false, inspecting: false,
    });
  }
  scene.remove(vm.root);
  return vm.root;
}

const builders: Record<string, [() => Object3D, string]> = {
  Digit1: [() => buildPistol().root, 'M9 Sidearm'],
  Digit2: [() => buildSmg().root, 'MP-40K SMG'],
  Digit3: [() => buildRifle().root, 'M4 Carbine'],
  Digit4: [() => buildShotgun().root, 'Trench Sweeper'],
  Digit5: [() => buildDesertEagle().root, 'Desert Eagle .50 AE'],
  Digit6: [() => buildBarrettM82A1().root, 'Barrett M82A1'],
  Digit7: [() => buildSpas12().root, 'SPAS-12'],
  Digit8: [() => buildM240().root, 'M240'],
  Digit0: [() => buildScar().root, 'FN SCAR-H'],
  KeyU: [() => buildAether9().root, 'Aether-9'],
  KeyI: [() => buildStormweaver().root, 'Stormweaver'],
  Digit9: [buildViewModel, 'Viewmodel — hands on the weapon'],
  KeyZ: [() => buildZombieMesh(0).root, 'Zombie'],
  KeyA: [
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

const viewmodelWeapons: Record<string, string> = {
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

show(builders.Digit3[0], builders.Digit3[1]);

addEventListener('keydown', (e) => {
  const viewmodelWeapon = viewmodelWeapons[e.code];
  if (e.shiftKey && viewmodelWeapon) {
    vmWeapon = viewmodelWeapon;
    show(buildViewModel, `Viewmodel — ${WEAPONS[vmWeapon].name}`);
    return;
  }
  // Turntable-only action checks. These call the shipping ViewModel methods so
  // a model review can catch a misplaced ejection port, feed cover or reload
  // pivot without introducing a debug purchase path into the game itself.
  if (e.code === 'KeyF' && vm?.root.parent === stage) {
    vm.fire(WEAPONS[vmWeapon], ++previewShotIndex);
    return;
  }
  if (e.code === 'KeyR' && vm?.root.parent === stage && !vm.reloading) {
    const def = WEAPONS[vmWeapon];
    if (def.shellReload) vm.startShellInsert(def.reloadTime);
    else vm.startReload(def.reloadTime + def.emptyReloadExtra, true);
    return;
  }
  const b = builders[e.code];
  if (b) show(b[0], b[1]);
});

// --- Orbit ---
let yaw = 0.9;
let pitch = 0.22;
let zoom = 1;
let dragging = false;
let lastFrame = performance.now();
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
  /**
   * Points the orbit at an explicit world position at an explicit distance.
   *
   * `setView` orbits the current asset's bounding-box centre, which for the
   * viewmodel is somewhere in the middle of a forearm — useless for judging a
   * grip 400 mm away at the far end of the assembly.
   */
  focus: (x: number, y: number, z: number, dist: number) => {
    target.set(x, y, z);
    radius = dist;
    zoom = 1;
  },
  /** Re-solves the viewmodel with a different weapon, or aiming down sights. */
  viewmodel: (weapon = 'pistol', aiming = false) => {
    vmWeapon = weapon;
    show(() => {
      const root = buildViewModel();
      vm!.setAiming(aiming);
      for (let i = 0; i < 60; i++) {
        vm!.update(1 / 60, vmCamera, {
          lookX: 0, lookY: 0, moveIntensity: 0, bobPhase: 0,
          bobAmount: 0, sprinting: false, inspecting: false,
        });
      }
      scene.remove(vm!.root);
      return root;
    }, `Viewmodel — ${WEAPONS[weapon].name}${aiming ? ' (ADS)' : ''}`);
  },
};

function frame() {
  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;
  if (vm?.root.parent === stage) {
    vm.update(dt, vmCamera, {
      lookX: 0, lookY: 0, moveIntensity: 0, bobPhase: 0,
      bobAmount: 0, sprinting: false, inspecting: false,
    });
  }
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
