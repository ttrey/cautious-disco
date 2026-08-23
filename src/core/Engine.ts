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
    // Night-sculpting exposure: the high tier sits at 0.90 so the Main Hall
    // doorway path keeps graded detail through ACES' shoulder instead of
    // landing as flat white, and so the GradePass shadow floor (not raw
    // gain) defines where blacks live. Lower tiers stay at 1.0 — they lose
    // bloom/shadow resolution elsewhere and need the extra stop.
    this.renderer.toneMappingExposure = quality.preset === 'high' ? 0.9 : 1.0;
    this.renderer.shadowMap.enabled = quality.shadows;
    // Three 0.185 folds the legacy soft-shadow mode into PCFShadowMap and
    // warns when PCFSoftShadowMap is selected, so keep the stable supported
    // mode across tiers.
    this.renderer.shadowMap.type = PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera = new PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.05, 260);
    // Narrow near/far range for the viewmodel maximises depth precision on the
    // weapon, which is the object the player stares at all game.
    this.viewCamera = new PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.008, 12);

    // Depth layering over flat distance falloff: lifting the near plane keeps
    // the sodium pools right around the player crisp while mid-distance gains
    // a readable haze gradient, so lit areas separate from the dark between
    // them. FogExp2 was considered (0.02+) but at those densities the 44 m
    // train-shed back wall sits ~60% fogged — exactly the flat mid-ground
    // haze the identity avoids — so linear with a lifted start layers better.
    // The near start sits just past the pool radius (13 m) so pools stay
    // crisp while everything from there to the shed wall climbs a gentle,
    // slightly lifted haze ramp: pools → haze → dark, three readable layers.
    this.scene.fog = new Fog(0x1b2233, 13, 110);
    // Open-air areas look straight up at this. Without a background the sky is
    // the clear colour — pure black — and the fogged skyline silhouettes have
    // nothing to sit against. Tuned a touch bluer/lifted so it reads as the
    // base of the horizon glow rather than a hole, yet stays clearly darker
    // than the fog so distant mass still reads lighter than the sky.
    this.scene.background = new Color(0x0a0e17);
    this.scene.environment = buildEnvironment(this.renderer);
    // A little neutral bounce keeps rough plaster and the underside of the
    // ceiling from collapsing into black while the local sodium fixtures keep
    // the terminal's warm/cool contrast.
    this.scene.environmentIntensity = 0.9;
    // Directional fill so shadow SIDES carry shape, not just shadow floors:
    // IBL is view-dependent and dies on surfaces facing away from the env
    // strips, which is how shadow sides crushed to flat black (key:fill far
    // past 4:1). The cool blue-grey sky term models night air; the warm
    // asphalt-brown ground term fakes sodium bounce off the yard surface.
    // At 0.30 it lands key:fill ≈4:1 — blacks lift enough that a wall's
    // unlit face still reads as a plane at an angle, while the pools stay
    // unambiguously night.
    this.scene.add(new HemisphereLight(0x44546c, 0x2b2118, 0.3));
    this.viewScene.environment = this.scene.environment;
    // Richer IBL on the weapon, held just under 1.0: the far specular strips
    // give gunmetal its life, but a full 1.0 stacked on the strengthened rim
    // starts to flatten the three-point rig's modelling.
    this.viewScene.environmentIntensity = 0.95;
    this.lightViewModel();

    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    // Restraint pass: the previous rig (0.18 / 0.34 / 1.08) bloomed every
    // practical past silhouette into white/red haze — everything glowed,
    // nothing read. Now the mip chain only catches true emitters (bulb cards
    // sit at ~1.5 linear) and spreads a tight halo, so tube and sign SHAPES
    // survive their own glow instead of smearing over their housings.
    this.bloom = new UnrealBloomPass(
      new Vector2(window.innerWidth, window.innerHeight),
      0.10, // faint halo only: strong enough to sell emission, too weak to wash the fixture around it
      0.32, // tight spread stops at the fixture edge instead of bleeding onto the housing
      1.4,  // well above lit plaster (~<1.0) yet under the bulb cards (~1.5): only real emitters qualify
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
    // Warm-neutral key: bright enough to model the receiver with ACES headroom
    // but pulled toward white so brass/wood stay honest rather than orange.
    const key = new DirectionalLight(0xffe0ba, 2.3);
    key.position.set(0.65, 1.25, 0.45);
    this.viewScene.add(key);

    // Cool fill, dialed back so the warm/cool split across the weapon reads as
    // intentional cinematography instead of flat ambient.
    const fill = new DirectionalLight(0x9fc0ff, 0.85);
    fill.position.set(-0.9, -0.2, 0.6);
    this.viewScene.add(fill);

    // Rim from behind-above in colder blue: separates the silhouette from dark
    // rooms and makes gunmetal read premium against the sodium world. 3.3 so
    // edge highlights on the receiver stay crisp even when the strengthened
    // IBL strips sit at unfavourable angles for the current pose. Pulled left
    // of dead-behind and given range to spare: verified in the ADS pose, where
    // the weapon rides lower and closer to the camera — a rim parked straight
    // behind it only lights faces the camera can't see, so its hot core has to
    // land on the upper-LEFT silhouette to register.
    const rim = new PointLight(0xa8ccff, 3.3, 6, 2);
    rim.position.set(-0.55, 0.7, -0.7);
    this.viewScene.add(rim);

    // Second rim as a directional from behind-LEFT: the point rim only
    // grazes surfaces near its position, so on wide receivers (shotgun,
    // rifle) the left edge could fall back into the wall behind it. A
    // directional hits every frame pose identically, so the receiver's
    // left/back edges always carry a cool #9fb6d8 highlight that separates
    // them from dark walls — viewmodel separation is an edge job, and this
    // guarantees the edge exists. 2.6 rather than a token 1.6: pixel-sampled
    // ADS verification showed 1.6 left the slide at background luminance
    // (gun mean 27/255 vs wall 34/255) — dark albedo through ACES at 0.9
    // exposure eats a weak rim whole. Angled well left so the light rakes
    // the left flank, the face the camera actually sees in ADS.
    const rimDir = new DirectionalLight(0x9fb6d8, 2.6);
    // Behind (-z) and hard left (-x), slightly above eye line: light rakes
    // along the weapon's left flank toward the camera.
    rimDir.position.set(-1.15, 0.5, -0.7);
    this.viewScene.add(rimDir);

    // Hemisphere ambient biased blue so shadowed metal carries sky colour, not
    // gray; the ground tint keeps just enough warmth for bounce continuity.
    this.viewScene.add(new HemisphereLight(0xaac6f0, 0x22262e, 0.66));
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
   * tracks the view exactly while weapon recoil remains a viewmodel/reticle
   * effect. Only its field of view differs. Call once per frame, before the
   * main render.
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
