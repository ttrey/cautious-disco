import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  Fog,
  HalfFloatType,
  HemisphereLight,
  LinearFilter,
  LinearSRGBColorSpace,
  PCFShadowMap,
  PerspectiveCamera,
  PointLight,
  Scene,
  SRGBColorSpace,
  Texture,
  Vector2,
  WebGLRenderTarget,
  WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { buildEnvironment } from './Environment';
import { GradePass } from './GradePass';
import { QualitySettings } from './Quality';

export interface Updatable {
  update(dt: number, elapsed: number): void;
}

/**
 * Owns the renderer, the scene graph root, the camera rig and the frame loop.
 *
 * Deliberately thin: it knows how to draw and how to tick registered systems,
 * and nothing about zombies, weapons or rounds. Gameplay systems register
 * themselves and are ticked in insertion order.
 */
export class Engine {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  /** Second camera pass for the viewmodel so weapons never clip into geometry. */
  readonly viewCamera: PerspectiveCamera;
  readonly viewScene = new Scene();
  readonly composer: EffectComposer;
  /**
   * Frame timing. Three's `Clock` is deprecated in this version and its
   * replacement is not part of the shipped addons, so the loop keeps its own —
   * it is four lines and removes a dependency.
   */
  private lastFrameTime = 0;
  private elapsedTime = 0;

  /**
   * Off-screen view for a telescopic sight.
   *
   * Square on purpose: the target lands on a circular disc at the optic's
   * ocular, so a widescreen buffer would only waste the sides that the disc
   * crops away. Its tiered resolution is drawn straight rather than through the composer — an
   * optic looks through glass, not through the player's own bloom and grade,
   * and a second composer chain for a 640 px buffer would not earn its cost.
   */
  private scopeTarget: WebGLRenderTarget | null = null;
  private readonly scopeCamera = new PerspectiveCamera(30, 1, 0.05, 260);
  private scopeFrame = 0;

  private readonly bloom: UnrealBloomPass;
  private readonly grade: ShaderPass;
  private readonly systems: Updatable[] = [];
  private readonly renderPass: RenderPass;
  private running = false;
  private accumulatedFps = 0;
  private fpsSamples = 0;
  private resolutionScale = 1;

  /** Rolling average frame time, exposed for the adaptive resolution logic. */
  fps = 60;

  constructor(container: HTMLElement, readonly quality: QualitySettings) {
    this.renderer = new WebGLRenderer({
      antialias: quality.antialias,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.maxPixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = SRGBColorSpace;
    // ACES gives the highlight rolloff that keeps muzzle flashes and perk neon
    // from clipping to flat white.
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = quality.shadows;
    this.renderer.shadowMap.type = PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera = new PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.05, 260);
    // Narrow near/far range for the viewmodel maximises depth precision on the
    // weapon, which is the object the player stares at all game.
    this.viewCamera = new PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.008, 12);

    // The far plane of the fog has to clear the longest interior sightline or
    // the back wall of a big room fades to flat haze: the train shed is 44 m
    // across and the loading yard 55 m long.
    this.scene.fog = new Fog(0x11141d, 12, 104);
    // Open-air areas look straight up at this. Without a background the sky is
    // the clear colour — pure black — and the fogged skyline silhouettes have
    // nothing to sit against. Slightly darker than the fog so distant mass
    // still reads lighter than the sky.
    this.scene.background = new Color(0x090c13);
    this.scene.environment = buildEnvironment(this.renderer);
    this.scene.environmentIntensity = 0.85;
    this.viewScene.environment = this.scene.environment;
    this.viewScene.environmentIntensity = 0.9;
    this.lightViewModel();

    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.bloom = new UnrealBloomPass(
      new Vector2(window.innerWidth, window.innerHeight),
      0.3, // strength — enough to bloom lamps and muzzle flash, not the walls
      0.7, // radius
      1.05, // threshold: only genuinely over-range pixels bloom
    );
    this.bloom.enabled = quality.bloom;
    this.composer.addPass(this.bloom);

    this.grade = new ShaderPass(GradePass);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());

    window.addEventListener('resize', this.onResize);
  }

  /**
   * The viewmodel renders in its own scene, so it needs its own lights — world
   * lights are not visible to it. A fixed three-point rig travelling with the
   * camera also means the weapon reads consistently everywhere on the map,
   * which is what you want for the object the player stares at all game.
   */
  private lightViewModel() {
    const key = new DirectionalLight(0xffe6c4, 2.6);
    key.position.set(0.6, 1.2, 0.4);
    this.viewScene.add(key);

    const fill = new DirectionalLight(0x9fc0ff, 1.1);
    fill.position.set(-0.9, -0.2, 0.6);
    this.viewScene.add(fill);

    // Rim from behind picks out the weapon's silhouette against dark rooms.
    const rim = new PointLight(0xffd0a0, 3.2, 4, 2);
    rim.position.set(-0.35, 0.3, -0.8);
    this.viewScene.add(rim);

    this.viewScene.add(new HemisphereLight(0x9fb4d8, 0x2a2622, 0.7));
  }

  add(system: Updatable) {
    this.systems.push(system);
    return system;
  }

  remove(system: Updatable) {
    const i = this.systems.indexOf(system);
    if (i >= 0) this.systems.splice(i, 1);
  }

  /**
   * Renders the world from the eye at the given vertical field of view and
   * hands back the resulting texture, for an optic to display at its ocular.
   *
   * The camera copies the player's own world transform, so the sight picture
   * tracks the view exactly — including recoil and sway — and only its field of
   * view differs. Call once per frame, before the main render.
   */
  renderScopeView(fovDegrees: number): Texture {
    this.scopeFrame++;
    if (this.scopeTarget && this.scopeFrame % this.quality.scopeCadence !== 0) {
      return this.scopeTarget.texture;
    }
    if (!this.scopeTarget) {
      // Half-float and linear, deliberately.
      //
      // Three only tone-maps when it is drawing to the canvas, so a scene
      // rendered into a target arrives as raw linear HDR: lamps and muzzle
      // flashes sit well above 1.0. An 8-bit sRGB buffer clips all of that on
      // the way in, and the optic ends up showing a flat, desaturated version
      // of a world the player can see correctly graded around the tube. Keeping
      // the buffer linear and floating leaves the highlights intact for the
      // ocular's own material to tone-map on the way out.
      this.scopeTarget = new WebGLRenderTarget(this.quality.scopeSize, this.quality.scopeSize, {
        minFilter: LinearFilter,
        magFilter: LinearFilter,
        type: HalfFloatType,
        colorSpace: LinearSRGBColorSpace,
        depthBuffer: true,
      });
    }
    this.camera.updateMatrixWorld();
    this.scopeCamera.matrixAutoUpdate = false;
    this.scopeCamera.matrixWorld.copy(this.camera.matrixWorld);
    this.scopeCamera.matrixWorldInverse.copy(this.scopeCamera.matrixWorld).invert();
    this.scopeCamera.fov = fovDegrees;
    this.scopeCamera.updateProjectionMatrix();

    const previous = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.scopeTarget);
    this.renderer.clear();
    this.renderer.render(this.scene, this.scopeCamera);
    this.renderer.setRenderTarget(previous);
    return this.scopeTarget.texture;
  }

  /** Drives the vignette/damage grade from gameplay. */
  setGrade(damage: number, vignette: number) {
    this.grade.uniforms.uDamage.value = damage;
    this.grade.uniforms.uVignette.value = vignette;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.renderer.setAnimationLoop(this.frame);
  }

  stop() {
    this.running = false;
    this.lastFrameTime = 0;
    this.renderer.setAnimationLoop(null);
  }

  private frame = () => {
    const now = performance.now() / 1000;
    if (this.lastFrameTime === 0) this.lastFrameTime = now;
    // Clamped so an alt-tab or a GC pause can't teleport entities through walls.
    const dt = Math.min(now - this.lastFrameTime, 0.05);
    this.lastFrameTime = now;
    this.elapsedTime += dt;
    const elapsed = this.elapsedTime;

    this.grade.uniforms.uTime.value = elapsed;

    for (let i = 0; i < this.systems.length; i++) this.systems[i].update(dt, elapsed);

    this.composer.render(dt);

    // The viewmodel is drawn afterwards with a cleared depth buffer so the
    // weapon is always in front of world geometry, exactly like a real FPS.
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.render(this.viewScene, this.viewCamera);
    this.renderer.autoClear = true;

    this.trackPerformance(dt);
  };

  /**
   * Adaptive resolution. If we sit under budget for a full second, drop the
   * internal render scale a notch; recover it when there is headroom. Keeps
   * mid-range hardware pinned at 60 without the player touching a setting.
   */
  private trackPerformance(dt: number) {
    if (dt <= 0) return;
    this.accumulatedFps += 1 / dt;
    this.fpsSamples++;
    if (this.fpsSamples < 60) return;

    this.fps = this.accumulatedFps / this.fpsSamples;
    this.accumulatedFps = 0;
    this.fpsSamples = 0;

    const before = this.resolutionScale;
    if (this.fps < 50 && this.resolutionScale > 0.62) this.resolutionScale -= 0.08;
    else if (this.fps > 72 && this.resolutionScale < 1) this.resolutionScale = Math.min(1, this.resolutionScale + 0.04);
    if (before !== this.resolutionScale) this.applySize();
  }

  private applySize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio, this.quality.maxPixelRatio) * this.resolutionScale;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(w, h);
    this.bloom.setSize(w * ratio, h * ratio);
  }

  private onResize = () => {
    const aspect = window.innerWidth / window.innerHeight;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = aspect;
    this.viewCamera.updateProjectionMatrix();
    this.applySize();
  };

  dispose() {
    this.stop();
    window.removeEventListener('resize', this.onResize);
    this.scopeTarget?.dispose();
    this.renderer.dispose();
  }
}
