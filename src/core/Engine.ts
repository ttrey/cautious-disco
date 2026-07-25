import {
  ACESFilmicToneMapping,
  Clock,
  Fog,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector2,
  WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { buildEnvironment } from './Environment';
import { GradePass } from './GradePass';

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
  readonly clock = new Clock();

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

  constructor(container: HTMLElement) {
    this.renderer = new WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = SRGBColorSpace;
    // ACES gives the highlight rolloff that keeps muzzle flashes and perk neon
    // from clipping to flat white.
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera = new PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.05, 260);
    // Narrow near/far range for the viewmodel maximises depth precision on the
    // weapon, which is the object the player stares at all game.
    this.viewCamera = new PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.008, 12);

    this.scene.fog = new Fog(0x0a0c12, 6, 78);
    this.scene.environment = buildEnvironment(this.renderer);
    this.scene.environmentIntensity = 0.55;
    this.viewScene.environment = this.scene.environment;
    this.viewScene.environmentIntensity = 0.9;

    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.bloom = new UnrealBloomPass(
      new Vector2(window.innerWidth, window.innerHeight),
      0.42, // strength — enough to bloom lamps and muzzle flash, not the walls
      0.72, // radius
      0.82, // threshold
    );
    this.composer.addPass(this.bloom);

    this.grade = new ShaderPass(GradePass);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());

    window.addEventListener('resize', this.onResize);
  }

  add(system: Updatable) {
    this.systems.push(system);
    return system;
  }

  remove(system: Updatable) {
    const i = this.systems.indexOf(system);
    if (i >= 0) this.systems.splice(i, 1);
  }

  /** Drives the vignette/damage grade from gameplay. */
  setGrade(damage: number, vignette: number) {
    this.grade.uniforms.uDamage.value = damage;
    this.grade.uniforms.uVignette.value = vignette;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this.renderer.setAnimationLoop(this.frame);
  }

  stop() {
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  private frame = () => {
    // Clamped so an alt-tab or a GC pause can't teleport entities through walls.
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const elapsed = this.clock.elapsedTime;

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
    const ratio = Math.min(window.devicePixelRatio, 2) * this.resolutionScale;
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
    this.renderer.dispose();
  }
}
