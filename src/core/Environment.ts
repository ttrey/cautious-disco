import {
  BackSide,
  BoxGeometry,
  Color,
  Mesh,
  MeshBasicMaterial,
  PMREMGenerator,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Texture,
  WebGLRenderer,
} from 'three';

/**
 * Builds the image-based lighting environment.
 *
 * Metal reads as metal only when it has something to reflect. Rather than ship
 * an HDRI, we render a tiny synthetic night-city room — layered storm sky dome,
 * sodium city-glow horizon, cold window slabs at several heights, warm interiors
 * at two colour temperatures, tiny distant strips for tight speculars, and wet
 * ground smears — through PMREMGenerator. Cheap, dependency-free, and gives
 * weapons a believable premium specular response while keeping the terminal's
 * deep-blue-vs-sodium identity.
 */

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = /* glsl */ `
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform vec3 uGround;
  varying vec3 vDir;

  // Cheap hash-based value noise: no texture fetches, runs once during the
  // PMREM bake. Every input is derived from the raw dome direction, so the
  // field is continuous around the whole ring and through the zenith — no
  // seam for reflections to pick up.
  float hash21(vec2 p) {
    p = fract(p * vec2(233.34, 851.73));
    p += dot(p, p + 23.45);
    return fract(p.x * p.y);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  void main() {
    vec3 dir = normalize(vDir);
    float h = dir.y;
    float az = atan(dir.z, dir.x);

    // Unchanged vertical contract: cold storm zenith, sodium-warm horizon,
    // near-black ground fall-off. Everything below modulates this base; it
    // never replaces it.
    vec3 col = h > 0.0
      ? mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.55))
      : mix(uHorizon, uGround, pow(clamp(-h, 0.0, 1.0), 0.35));

    // --- Layered cloud sheets ---------------------------------------------
    // The noise lives on the dome's horizontal footprint, so it dies out
    // naturally overhead where the sky clears. Two slow vertical sine bands,
    // torn up by the noise, give the overcast structure without surviving as
    // a readable pattern through the PMREM blur.
    float n1 = vnoise(dir.xz * 2.3);
    float n2 = vnoise(dir.xz * 4.9 + 19.7);
    float sheetA = sin(h * 21.0 - 1.3 + n1 * 4.5) * 0.5 + 0.5;
    float sheetB = sin(h * 38.0 + 0.9 - n2 * 3.2) * 0.5 + 0.5;
    float clouds = sheetA * 0.62 + sheetB * 0.38;
    // Gone by mid-dome; patchy coverage so the ring is never uniformly banded.
    clouds *= 1.0 - smoothstep(0.06, 0.75, h);
    clouds *= 0.45 + 0.55 * n1;
    // Clouds shave a little blue off the zenith scatter and catch a faint
    // warm underlight from the city below — micro-contrast, not decoration.
    col = mix(col, col * vec3(0.84, 0.89, 1.0), clouds * 0.5);
    col += vec3(0.50, 0.26, 0.09) * clouds * 0.12;

    // --- Sodium city glow ---------------------------------------------------
    // Structured rather than a flat ramp: a tight hot core line hugging eye
    // level plus a broad haze climbing into the cloud base, both weighted
    // toward the south-west where the city stands. Only integer harmonics of
    // the azimuth enter cos(), keeping the horizon ring seamless.
    float citySide = 0.55 + 0.30 * cos(az - 2.25) + 0.15 * cos(az * 2.0 + 1.3);
    float core = exp(-abs(h) * 26.0);
    float haze = exp(-max(h, 0.0) * 4.8) * step(0.0, h);
    col += vec3(1.0, 0.50, 0.185) * core * 0.60 * citySide;
    col += vec3(1.0, 0.56, 0.26) * haze * 0.20 * citySide;

    // Gentle equatorial anisotropy: the horizon ring is deliberately not
    // uniform, so IBL reflections drift warmer/cooler as a weapon rotates.
    col *= 1.0 + exp(-abs(h) * 3.2) * 0.08 * cos(az - 2.25);

    // Wet-ground mottle below the horizon: slow blotches in the bounce read
    // as puddled sheen once rough materials mix them with the smear cards.
    float mottle = vnoise(dir.xz * 2.6 + 47.0);
    col *= 1.0 + (mottle - 0.5) * 0.12 * smoothstep(0.02, 0.4, -h);

    gl_FragColor = vec4(col, 1.0);
  }
`;

export function buildEnvironment(renderer: WebGLRenderer): Texture {
  const scene = new Scene();

  const sky = new Mesh(
    new SphereGeometry(60, 48, 28),
    new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: {
        // A cold, storm-lit night: blue above, sodium-tinged at the horizon.
        // Keep the ground bounce above black so rough concrete and skin retain
        // shape between the authored fixtures in the first viewport.
        uZenith: { value: new Color(0x101925).multiplyScalar(1.0) },
        uHorizon: { value: new Color(0x342b20).multiplyScalar(1.0) },
        uGround: { value: new Color(0x0b0d12) },
      },
    }),
  );
  scene.add(sky);

  // Emissive cards. These are what actually show up in a gun barrel's
  // reflection, so the roster is built like a lighting plot: cold slabs at
  // three heights, warm interiors at two colour temperatures, tiny distant
  // strips for tight specular hits, and dim wet-ground smears.
  const panel = (
    w: number,
    h: number,
    d: number,
    color: number,
    intensity: number,
    x: number,
    y: number,
    z: number,
  ) => {
    const m = new Mesh(
      new BoxGeometry(w, h, d),
      new MeshBasicMaterial({ color: new Color(color).multiplyScalar(intensity) }),
    );
    m.position.set(x, y, z);
    scene.add(m);
  };

  // Cold daylight-blue window slabs at multiple heights: the dominant metal
  // tint comes from these, and the height spread keeps reflections changing
  // as the weapon sweeps instead of pinning to one elevation.
  panel(14, 9, 0.4, 0x9fc4ff, 3.2, -16, 7, -6);
  panel(10, 7, 0.4, 0x9fc4ff, 2.4, 15, 6, 8);
  panel(7, 4, 0.4, 0xa9ccff, 2.9, -5, 13, -21); // high clerestory band
  panel(12, 2.4, 0.4, 0x8fb2e6, 1.5, 21, 2.4, -3); // low platform-edge glazing

  // Warm interiors at two colour temperatures: 2700K sodium (amber, domestic)
  // against 4000K working light (neutral-warm) separates "lamp" from "room".
  panel(6, 0.6, 6, 0xffb066, 4.5, 0, 11, 0); // 2700K ceiling sodium
  panel(8, 5, 0.4, 0xffe2bd, 2.1, 23, 8, 13); // 4000K booking hall
  panel(3.5, 1.2, 0.3, 0xff9548, 5.2, -22, 5.5, 7); // deep-amber corridor

  // Broad, restrained bounce cards keep metal reflections legible without
  // flattening the local lamps into a uniformly lit room.
  panel(18, 3.5, 0.25, 0xffc083, 1.1, -9, 3.4, 18);
  panel(16, 2.8, 0.25, 0x86a9d8, 0.85, 12, 3.0, -18);

  // Tiny, far, intense strips: sub-degree sources that survive the PMREM blur
  // as compact highlights, giving polished metal tight specular hits instead
  // of broad smears. Mixed temperatures so the sparkle isn't monochrome.
  // Intensities are pushed high on purpose — after the PMREM's angular blur a
  // sub-degree card lands as only a modest lobe, and gunmetal needs to catch
  // 2-3 crisp hits per revolution to read as metal rather than plastic.
  panel(0.5, 3.4, 0.25, 0xcfe4ff, 24, -33, 6, -13);
  panel(3.0, 0.45, 0.25, 0xffc27d, 20, 29, 4.0, -21);
  panel(0.45, 2.4, 0.25, 0xdcebff, 22, 7, 9.5, -35);
  panel(0.4, 1.8, 0.25, 0xffd9a8, 17, -28, 3.4, 24);
  // Fifth strip fills the south-east azimuthal gap: without it a weapon held
  // facing that way sweeps a dead quarter-turn with no highlight at all.
  panel(0.5, 2.6, 0.25, 0xe8f2ff, 21, 26, 10.5, 19);

  // Ground bounce stays dark — the floor must never become a second lamp — but
  // hovering smear cards (dim, vertically crushed echoes of the main slabs)
  // encode a reflective-wet sheen into the downward hemisphere.
  panel(20, 0.4, 20, 0x22242b, 0.72, 0, -6, 0);
  panel(12, 1.6, 0.15, 0x8fb4e8, 0.5, -15, -5.55, -6);
  panel(8, 1.2, 0.15, 0xffb87d, 0.42, 14, -5.55, 9);
  panel(5, 0.9, 0.15, 0xffa05c, 0.5, -2, -5.55, -20);

  const pmrem = new PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  // Stay within Three's 20-sample PMREM budget; sigma 0.04 softens the big
  // cards while the distant strips still survive as compact speculars.
  const target = pmrem.fromScene(scene, 0.04);
  pmrem.dispose();

  scene.traverse((o) => {
    const mesh = o as Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    if (mesh.material) (mesh.material as ShaderMaterial).dispose();
  });

  return target.texture;
}
