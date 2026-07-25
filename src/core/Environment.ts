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
 * an HDRI, we render a tiny synthetic room — overcast sky dome plus a handful of
 * emissive panels standing in for windows and sodium lamps — through
 * PMREMGenerator. Cheap, dependency-free, and gives weapons a believable
 * specular response.
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

  void main() {
    float h = normalize(vDir).y;
    vec3 col = h > 0.0
      ? mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.55))
      : mix(uHorizon, uGround, pow(clamp(-h, 0.0, 1.0), 0.35));
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function buildEnvironment(renderer: WebGLRenderer): Texture {
  const scene = new Scene();

  const sky = new Mesh(
    new SphereGeometry(60, 32, 20),
    new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: {
        // A cold, storm-lit night: blue above, sodium-tinged at the horizon.
        uZenith: { value: new Color(0x0a1018).multiplyScalar(1.0) },
        uHorizon: { value: new Color(0x2a2418).multiplyScalar(1.0) },
        uGround: { value: new Color(0x05060a) },
      },
    }),
  );
  scene.add(sky);

  // Emissive panels: two cold window slabs and one warm interior source. These
  // are what actually show up in a gun barrel's reflection.
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

  panel(14, 9, 0.4, 0x9fc4ff, 3.2, -16, 7, -6);
  panel(10, 7, 0.4, 0x9fc4ff, 2.4, 15, 6, 8);
  panel(6, 0.6, 6, 0xffb066, 4.5, 0, 11, 0);
  panel(20, 0.4, 20, 0x1a1a20, 0.6, 0, -6, 0);

  const pmrem = new PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const target = pmrem.fromScene(scene, 0.04);
  pmrem.dispose();

  scene.traverse((o) => {
    const mesh = o as Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    if (mesh.material) (mesh.material as ShaderMaterial).dispose();
  });

  return target.texture;
}
