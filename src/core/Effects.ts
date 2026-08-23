import {
  AdditiveBlending,
  BufferGeometry,
  Camera,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  PlaneGeometry,
  Points,
  Scene,
  ShaderMaterial,
  Texture,
  Vector3,
} from 'three';
import {
  bloodPoolTexture,
  bloodSplatTexture,
  bulletHoleTexture,
  glowTexture,
  smokeTexture,
  sparkTexture,
} from '../assets/SpriteTextures';
import { Rng, clamp } from '../util/math';

/**
 * World-space effects: impact debris, blood, smoke, tracers and decals.
 *
 * Particles live in two `Points` systems (one additive for anything hot, one
 * alpha-blended for anything made of matter) with per-particle colour, size and
 * alpha as vertex attributes. One draw call each, no per-particle objects, and
 * the buffers are written in place — spawning a hundred sparks allocates
 * nothing.
 */

const MAX_PARTICLES = 1400;
const MAX_DECALS = 96;

const PARTICLE_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vAlpha = aAlpha;
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // Perspective size attenuation, clamped so near particles stay sane.
    gl_PointSize = min(aSize * 320.0 / max(-mv.z, 0.2), 260.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const PARTICLE_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec4 tex = texture2D(uMap, gl_PointCoord);
    if (tex.a * vAlpha < 0.004) discard;
    gl_FragColor = vec4(vColor * tex.rgb, tex.a * vAlpha);
  }
`;

interface ParticleState {
  vx: Float32Array;
  vy: Float32Array;
  vz: Float32Array;
  life: Float32Array;
  maxLife: Float32Array;
  size0: Float32Array;
  size1: Float32Array;
  gravity: Float32Array;
  drag: Float32Array;
  active: Uint8Array;
}

class ParticleSystem {
  readonly points: Points;
  private readonly geo = new BufferGeometry();
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly posAttribute: Float32BufferAttribute;
  private readonly colAttribute: Float32BufferAttribute;
  private readonly sizeAttribute: Float32BufferAttribute;
  private readonly alphaAttribute: Float32BufferAttribute;
  private readonly state: ParticleState;
  private cursor = 0;
  private colorDirtyMin: number;
  private colorDirtyMax = -1;

  constructor(map: Texture, additive: boolean, private readonly capacity: number) {
    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.colorDirtyMin = capacity;

    this.posAttribute = new Float32BufferAttribute(this.pos, 3);
    this.colAttribute = new Float32BufferAttribute(this.col, 3);
    this.sizeAttribute = new Float32BufferAttribute(this.size, 1);
    this.alphaAttribute = new Float32BufferAttribute(this.alpha, 1);
    this.geo.setAttribute('position', this.posAttribute);
    this.geo.setAttribute('aColor', this.colAttribute);
    this.geo.setAttribute('aSize', this.sizeAttribute);
    this.geo.setAttribute('aAlpha', this.alphaAttribute);
    this.geo.setDrawRange(0, 0);
    // Particles move far from the origin; a stale bounding sphere would cull
    // the whole system.
    this.geo.boundingSphere = null;

    this.points = new Points(
      this.geo,
      new ShaderMaterial({
        uniforms: { uMap: { value: map } },
        vertexShader: PARTICLE_VERT,
        fragmentShader: PARTICLE_FRAG,
        transparent: true,
        depthWrite: false,
        blending: additive ? AdditiveBlending : NormalBlending,
      }),
    );
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 12 : 10;

    this.state = {
      vx: new Float32Array(capacity),
      vy: new Float32Array(capacity),
      vz: new Float32Array(capacity),
      life: new Float32Array(capacity),
      maxLife: new Float32Array(capacity),
      size0: new Float32Array(capacity),
      size1: new Float32Array(capacity),
      gravity: new Float32Array(capacity),
      drag: new Float32Array(capacity),
      active: new Uint8Array(capacity),
    };
  }

  spawn(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    color: Color,
    size0: number, size1: number,
    life: number,
    gravity: number,
    drag: number,
  ) {
    // Ring-buffer allocation: the oldest particle is recycled under pressure,
    // which is always preferable to dropping the newest (most visible) one.
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const safeLife = Math.max(0.02, life);

    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.col[i * 3] = color.r;
    this.col[i * 3 + 1] = color.g;
    this.col[i * 3 + 2] = color.b;
    this.colorDirtyMin = Math.min(this.colorDirtyMin, i);
    this.colorDirtyMax = Math.max(this.colorDirtyMax, i);

    const s = this.state;
    s.vx[i] = vx;
    s.vy[i] = vy;
    s.vz[i] = vz;
    s.life[i] = safeLife;
    s.maxLife[i] = safeLife;
    s.size0[i] = size0;
    s.size1[i] = size1;
    s.gravity[i] = gravity;
    s.drag[i] = drag;
    s.active[i] = 1;
    this.size[i] = size0;
    this.alpha[i] = 1;
  }

  update(dt: number) {
    const s = this.state;
    const step = clamp(dt, 0, 0.05);
    let dirtyMin = this.capacity;
    let dirtyMax = -1;
    let highestActive = -1;
    for (let i = 0; i < this.capacity; i++) {
      if (!s.active[i]) continue;
      dirtyMin = Math.min(dirtyMin, i);
      dirtyMax = i;
      s.life[i] -= step;
      if (s.life[i] <= 0) {
        s.active[i] = 0;
        this.alpha[i] = 0;
        this.size[i] = 0;
        continue;
      }
      highestActive = i;
      const decay = Math.max(0, 1 - s.drag[i] * step);
      s.vx[i] *= decay;
      s.vz[i] *= decay;
      s.vy[i] = s.vy[i] * decay + s.gravity[i] * step;

      this.pos[i * 3] += s.vx[i] * step;
      this.pos[i * 3 + 1] += s.vy[i] * step;
      this.pos[i * 3 + 2] += s.vz[i] * step;

      const t = 1 - s.life[i] / s.maxLife[i];
      this.size[i] = s.size0[i] + (s.size1[i] - s.size0[i]) * t;
      // Fade in fast, out slowly — reads as energy dissipating.
      this.alpha[i] = t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.88;
    }
    this.geo.setDrawRange(0, highestActive + 1);
    this.markUpdate(this.posAttribute, dirtyMin, dirtyMax, 3);
    this.markUpdate(this.sizeAttribute, dirtyMin, dirtyMax, 1);
    this.markUpdate(this.alphaAttribute, dirtyMin, dirtyMax, 1);
    this.markUpdate(this.colAttribute, this.colorDirtyMin, this.colorDirtyMax, 3);
    this.colorDirtyMin = this.capacity;
    this.colorDirtyMax = -1;
  }

  /** Drops transient particles after a long background/GC stall. */
  clear() {
    this.state.active.fill(0);
    this.size.fill(0);
    this.alpha.fill(0);
    this.geo.setDrawRange(0, 0);
    this.posAttribute.needsUpdate = true;
    this.sizeAttribute.needsUpdate = true;
    this.alphaAttribute.needsUpdate = true;
  }

  private markUpdate(
    attribute: Float32BufferAttribute,
    firstParticle: number,
    lastParticle: number,
    itemSize: number,
  ) {
    if (lastParticle < firstParticle) return;
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(
      firstParticle * itemSize,
      (lastParticle - firstParticle + 1) * itemSize,
    );
    attribute.needsUpdate = true;
  }
}

interface Decal {
  mesh: Mesh;
  life: number;
  maxLife: number;
  baseOpacity: number;
}

/** Tracers are stretched, camera-facing quads — a line primitive has no width. */
interface Tracer {
  mesh: Mesh;
  life: number;
  maxLife: number;
  opacity: number;
}

const COL_SPARK = new Color(0xffb257);
const COL_SPARK_CORE = new Color(0xffe4bd);
const COL_BLOOD = new Color(0x6e0d0d);
const COL_BLOOD_DARK = new Color(0x3a0606);
const COL_SMOKE = new Color(0x6f6a63);
const COL_PLASMA = new Color(0x62f4ff);
const COL_PLASMA_EDGE = new Color(0x227bff);
const COL_ARC = new Color(0xb29aff);
const COL_SCREEN_BLOOD = new Color(0x8f1118);
const COL_SCREEN_ENERGY = new Color(0x2f8dff);

export class Effects {
  private readonly additive: ParticleSystem;
  private readonly alphaBlended: ParticleSystem;
  private readonly smoke: ParticleSystem;

  private readonly decals: Decal[] = [];
  private readonly decalPool: Mesh[] = [];
  private readonly tracers: Tracer[] = [];
  private readonly tracerPool: Mesh[] = [];

  private readonly quad = new PlaneGeometry(1, 1);
  private readonly rng = new Rng(0x51ee7);
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly screenOffset = new Vector3();

  private readonly reducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private readonly detailScale = this.reducedMotion ? 0.58 : 1;
  private screenFeedback: Mesh | null = null;
  private screenPulse = 0;
  private readonly screenColor = new Color(0x8f1118);

  private readonly holeTexture = bulletHoleTexture();
  private readonly bloodTextures = [bloodSplatTexture(0), bloodSplatTexture(1), bloodPoolTexture()];

  constructor(private readonly scene: Scene) {
    this.additive = new ParticleSystem(sparkTexture(), true, 500);
    this.alphaBlended = new ParticleSystem(bloodSplatTexture(0), false, MAX_PARTICLES - 700);
    this.smoke = new ParticleSystem(smokeTexture(), false, 200);
    scene.add(this.additive.points, this.alphaBlended.points, this.smoke.points);
  }

  /** Bullet striking world geometry. */
  impact(point: Vector3, normal: Vector3, hard: boolean) {
    const n = Math.max(3, Math.round((hard ? 9 : 5) * this.detailScale));
    for (let i = 0; i < n; i++) {
      // Spray into the hemisphere around the surface normal.
      this.tmp
        .set(this.rng.range(-1, 1), this.rng.range(-1, 1), this.rng.range(-1, 1))
        .normalize()
        .addScaledVector(normal, 1.4)
        .normalize()
        .multiplyScalar(this.rng.range(1.6, 5.4));
      this.additive.spawn(
        point.x, point.y, point.z,
        this.tmp.x, this.tmp.y, this.tmp.z,
        COL_SPARK,
        this.rng.range(0.012, 0.03), 0.002,
        this.rng.range(0.18, 0.42),
        -12, 2.2,
      );
    }

    // A hot core keeps masonry impacts legible against the dark map even when
    // the longer orange sparks are hidden by fog or bloom.
    this.additive.spawn(
      point.x, point.y, point.z,
      normal.x * 1.8, normal.y * 1.8, normal.z * 1.8,
      COL_SPARK_CORE,
      0.024, 0.003,
      0.11,
      -4, 3.8,
    );

    // Dust puff kicked off the surface.
    for (let i = 0; i < Math.max(1, Math.round(4 * this.detailScale)); i++) {
      this.tmp
        .set(this.rng.range(-1, 1), this.rng.range(-1, 1), this.rng.range(-1, 1))
        .normalize()
        .addScaledVector(normal, 1.1)
        .multiplyScalar(this.rng.range(0.3, 1.1));
      this.smoke.spawn(
        point.x, point.y, point.z,
        this.tmp.x, this.tmp.y, this.tmp.z,
        COL_SMOKE,
        this.rng.range(0.06, 0.13), this.rng.range(0.3, 0.5),
        this.rng.range(0.45, 0.9),
        0.35, 2.6,
      );
    }

    this.addDecal(point, normal, this.holeTexture, this.rng.range(0.07, 0.12), 26, 0.95);
  }

  /** Bullet striking a zombie. */
  bloodBurst(point: Vector3, direction: Vector3, intensity = 1) {
    const n = Math.max(3, Math.round(9 * intensity * this.detailScale));
    for (let i = 0; i < n; i++) {
      this.tmp
        .copy(direction)
        .multiplyScalar(this.rng.range(1.2, 4.2))
        .add(
          this.tmp2
            .set(this.rng.range(-1, 1), this.rng.range(-0.4, 1), this.rng.range(-1, 1))
            .multiplyScalar(this.rng.range(0.6, 2.2)),
        );
      this.alphaBlended.spawn(
        point.x, point.y, point.z,
        this.tmp.x, this.tmp.y, this.tmp.z,
        this.rng.chance(0.6) ? COL_BLOOD : COL_BLOOD_DARK,
        this.rng.range(0.03, 0.1) * intensity, this.rng.range(0.02, 0.06),
        this.rng.range(0.35, 0.8),
        -11, 1.4,
      );
    }
    // A fine mist behind the impact reads as spray rather than as droplets.
    for (let i = 0; i < Math.max(1, Math.round(4 * this.detailScale)); i++) {
      this.tmp
        .copy(direction)
        .multiplyScalar(this.rng.range(0.5, 2))
        .add(this.tmp2.set(this.rng.range(-0.6, 0.6), this.rng.range(0, 0.7), this.rng.range(-0.6, 0.6)));
      this.alphaBlended.spawn(
        point.x, point.y, point.z,
        this.tmp.x, this.tmp.y, this.tmp.z,
        COL_BLOOD_DARK,
        0.16 * intensity, 0.32,
        this.rng.range(0.2, 0.45),
        -1.5, 3.4,
      );
    }
    this.pulseScreen(Math.min(0.045, 0.012 * intensity), COL_SCREEN_BLOOD);
  }

  /** Larger burst plus a ground pool, played when a zombie dies. */
  gib(point: Vector3, direction: Vector3, groundY: number) {
    this.bloodBurst(point, direction, 2.2);
    this.pulseScreen(0.022, COL_SCREEN_BLOOD);
    this.tmp.set(point.x + this.rng.range(-0.3, 0.3), groundY + 0.012, point.z + this.rng.range(-0.3, 0.3));
    this.tmp2.set(0, 1, 0);
    this.addDecal(this.tmp, this.tmp2, this.bloodTextures[2], this.rng.range(0.5, 0.95), 34, 0.8);
  }

  /** Blood spatter thrown onto a nearby surface. */
  bloodDecal(point: Vector3, normal: Vector3) {
    this.addDecal(
      point,
      normal,
      this.bloodTextures[this.rng.int(0, 1)],
      this.rng.range(0.22, 0.5),
      30,
      0.75,
    );
  }

  /**
   * Visible round in flight. Ballistic weapons call this on a minority of
   * shots; wonder weapons pass their own colour, width and lifetime so their
   * projectiles read as energy without needing a second effect system.
   */
  tracer(from: Vector3, to: Vector3, color = 0xffd9a0, width = 0.05, life = 0.055) {
    let mesh = this.tracerPool.pop();
    if (!mesh) {
      mesh = new Mesh(
        this.quad,
        new MeshBasicMaterial({
          map: glowTexture(),
          color: new Color(0xffd9a0),
          transparent: true,
          blending: AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
          side: DoubleSide,
        }),
      );
      mesh.frustumCulled = false;
    }
    const length = from.distanceTo(to);
    mesh.position.copy(from).add(to).multiplyScalar(0.5);
    mesh.scale.set(width, length, 1);
    // Orient the quad's +Y along the shot line.
    this.tmp.copy(to).sub(from).normalize();
    mesh.quaternion.setFromUnitVectors(this.tmp2.set(0, 1, 0), this.tmp);
    const mat = mesh.material as MeshBasicMaterial;
    mat.color.setHex(color);
    mat.opacity = 0.92;
    this.scene.add(mesh);
    this.tracers.push({ mesh, life, maxLife: life, opacity: 0.92 });
  }

  /** Heavy cyan bolt and ionised impact for the Aether-9. */
  plasmaBolt(from: Vector3, to: Vector3) {
    this.tracer(from, to, 0x62f4ff, 0.105, 0.13);
  }

  /**
   * A short-lived radial burst used both when plasma impacts scenery and when
   * it catches a group. It lives in the shared particle batch, so a crowd hit
   * does not allocate meshes or add draw calls.
   */
  plasmaBurst(point: Vector3, intensity = 1) {
    const n = Math.max(5, Math.round(16 * intensity * this.detailScale));
    for (let i = 0; i < n; i++) {
      this.tmp
        .set(this.rng.range(-1, 1), this.rng.range(-0.45, 1), this.rng.range(-1, 1))
        .normalize()
        .multiplyScalar(this.rng.range(1.8, 5.8) * intensity);
      this.additive.spawn(
        point.x, point.y, point.z,
        this.tmp.x, this.tmp.y, this.tmp.z,
        this.rng.chance(0.72) ? COL_PLASMA : COL_PLASMA_EDGE,
        this.rng.range(0.018, 0.052) * intensity, 0.003,
        this.rng.range(0.22, 0.46),
        -0.5, 2.3,
      );
    }
    this.pulseScreen(Math.min(0.035, 0.008 * intensity), COL_SCREEN_ENERGY);
  }

  /**
   * Jagged violet bolt assembled from a handful of short additive tracers.
   * The offsets are kept around the direct line, so the arc still clearly
   * communicates which zombie is passing the charge to which neighbour.
   */
  lightningArc(from: Vector3, to: Vector3) {
    const direction = new Vector3().subVectors(to, from);
    const distance = direction.length();
    if (distance < 0.001) return;
    direction.divideScalar(distance);
    const side = new Vector3().crossVectors(direction, new Vector3(0, 1, 0));
    if (side.lengthSq() < 1e-5) side.crossVectors(direction, new Vector3(1, 0, 0));
    side.normalize();
    const up = new Vector3().crossVectors(side, direction).normalize();
    const segments = this.reducedMotion ? this.rng.int(3, 4) : this.rng.int(4, 7);
    const previous = from.clone();

    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const next = i === segments
        ? to.clone()
        : from.clone()
          .addScaledVector(direction, distance * t)
          .addScaledVector(side, this.rng.range(-0.19, 0.19))
          .addScaledVector(up, this.rng.range(-0.19, 0.19));
      this.tracer(previous, next, 0xb29aff, 0.026, 0.105);
      previous.copy(next);
    }
  }

  /** Compact electric impact, used at each successful chain link. */
  electricBurst(point: Vector3) {
    for (let i = 0; i < Math.max(3, Math.round(9 * this.detailScale)); i++) {
      this.tmp
        .set(this.rng.range(-1, 1), this.rng.range(-0.2, 1), this.rng.range(-1, 1))
        .normalize()
        .multiplyScalar(this.rng.range(0.7, 2.7));
      this.additive.spawn(
        point.x, point.y, point.z,
        this.tmp.x, this.tmp.y, this.tmp.z,
        COL_ARC,
        this.rng.range(0.012, 0.032), 0.002,
        this.rng.range(0.11, 0.25),
        -0.2, 3.1,
      );
    }
    this.pulseScreen(0.008, COL_SCREEN_ENERGY);
  }

  private pulseScreen(amount: number, color: Color) {
    if (this.reducedMotion) return;
    this.screenPulse = Math.max(this.screenPulse, clamp(amount, 0, 0.06));
    this.screenColor.copy(color);
  }

  private updateScreenFeedback(dt: number, camera?: Camera) {
    if (!camera || this.reducedMotion) return;
    if (!this.screenFeedback && this.screenPulse <= 0) return;

    if (!this.screenFeedback) {
      this.screenFeedback = new Mesh(
        this.quad,
        new MeshBasicMaterial({
          color: this.screenColor,
          transparent: true,
          opacity: 0,
          depthTest: false,
          depthWrite: false,
          toneMapped: false,
          side: DoubleSide,
        }),
      );
      this.screenFeedback.frustumCulled = false;
      this.screenFeedback.renderOrder = 1000;
      // The scope camera remains on layer 0, so a hit pulse belongs to the
      // player's main frame and cannot appear inside an optic render target.
      this.screenFeedback.layers.set(1);
      this.scene.add(this.screenFeedback);
    }

    camera.layers.enable(1);
    const perspective = camera as Camera & { aspect?: number; fov?: number };
    const distance = 0.12;
    const fov = ((perspective.fov ?? 72) * Math.PI) / 180;
    const height = 2 * distance * Math.tan(fov * 0.5) * 1.06;
    const aspect = perspective.aspect ?? 1;
    this.screenFeedback.position.copy(camera.position);
    this.screenFeedback.quaternion.copy(camera.quaternion);
    this.screenOffset.set(0, 0, -distance).applyQuaternion(camera.quaternion);
    this.screenFeedback.position.add(this.screenOffset);
    this.screenFeedback.scale.set(height * aspect, height, 1);

    const mat = this.screenFeedback.material as MeshBasicMaterial;
    mat.color.copy(this.screenColor);
    mat.opacity = this.screenPulse;
    this.screenFeedback.visible = this.screenPulse > 0.001;
    this.screenPulse = Math.max(0, this.screenPulse - dt * 0.24);
  }

  private addDecal(
    point: Vector3,
    normal: Vector3,
    map: Texture,
    size: number,
    life: number,
    opacity: number,
  ) {
    let mesh = this.decalPool.pop();
    if (!mesh) {
      mesh = new Mesh(
        this.quad,
        new MeshBasicMaterial({
          transparent: true,
          depthWrite: false,
          // Decals sit flush on geometry; the offset stops them z-fighting.
          polygonOffset: true,
          polygonOffsetFactor: -4,
          polygonOffsetUnits: -4,
          side: DoubleSide,
        }),
      );
    }
    const mat = mesh.material as MeshBasicMaterial;
    mat.map = map;
    mat.opacity = opacity;
    mat.needsUpdate = true;

    mesh.position.copy(point).addScaledVector(normal, 0.012);
    this.tmp.set(0, 0, 1);
    mesh.quaternion.setFromUnitVectors(this.tmp, normal);
    mesh.rotateZ(this.rng.range(0, Math.PI * 2));
    mesh.scale.setScalar(size);
    this.scene.add(mesh);

    this.decals.push({ mesh, life, maxLife: life, baseOpacity: opacity });
    if (this.decals.length > MAX_DECALS) {
      const oldest = this.decals.shift()!;
      this.scene.remove(oldest.mesh);
      this.decalPool.push(oldest.mesh);
    }
  }

  update(dt: number, camera?: Camera) {
    // Engine already clamps frame time, but Effects is also used by the local
    // preview harnesses. Do not let a background tab resurrect a cloud of stale
    // sparks/tracers or turn a one-frame pause into a particle teleport.
    if (dt > 0.25) {
      this.additive.clear();
      this.alphaBlended.clear();
      this.smoke.clear();
      for (const t of this.tracers) {
        this.scene.remove(t.mesh);
        if (this.tracerPool.length < 16) this.tracerPool.push(t.mesh);
      }
      this.tracers.length = 0;
      this.screenPulse = 0;
    }
    this.additive.update(dt);
    this.alphaBlended.update(dt);
    this.smoke.update(dt);

    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      const mat = t.mesh.material as MeshBasicMaterial;
      mat.opacity = clamp(t.life / t.maxLife, 0, 1) * t.opacity;
      if (t.life <= 0) {
        this.scene.remove(t.mesh);
        this.tracers.splice(i, 1);
        if (this.tracerPool.length < 16) this.tracerPool.push(t.mesh);
      }
    }

    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i];
      d.life -= dt;
      const mat = d.mesh.material as MeshBasicMaterial;
      // Hold full opacity, then fade over the last few seconds.
      mat.opacity = d.baseOpacity * clamp(d.life / 4, 0, 1);
      if (d.life <= 0) {
        this.scene.remove(d.mesh);
        this.decals.splice(i, 1);
        this.decalPool.push(d.mesh);
      }
    }
    this.updateScreenFeedback(dt, camera);
  }
}
