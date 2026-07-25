import { Vector2 } from 'three';

/**
 * Final colour grade.
 *
 * Adds the things that separate "a Three.js scene" from "a game frame":
 * a filmic contrast/saturation push, chromatic aberration at the edges, animated
 * sensor grain, a vignette, and a blood-pulse overlay driven by player health.
 */
export const GradePass = {
  name: 'GradePass',
  uniforms: {
    tDiffuse: { value: null as unknown },
    uTime: { value: 0 },
    /** 0..1 — how hurt the player is. Drives the red pulse and desaturation. */
    uDamage: { value: 0 },
    uVignette: { value: 1 },
    uResolution: { value: new Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uDamage;
    uniform float uVignette;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    void main() {
      vec2 uv = vUv;
      vec2 centered = uv - 0.5;
      float r2 = dot(centered, centered);

      // Chromatic aberration scales with distance from centre, and swells when
      // the player is hurt.
      float ca = (0.0016 + uDamage * 0.006) * r2;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + centered * ca).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - centered * ca).b;

      // Filmic S-curve: lifts contrast without crushing the shadow detail that
      // carries the map's atmosphere.
      col = clamp(col, 0.0, 4.0);
      col = mix(col, col * col * (3.0 - 2.0 * col), 0.28);

      // Slight cool shadows / warm highlights split-tone.
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col += vec3(-0.012, -0.004, 0.02) * (1.0 - luma);
      col += vec3(0.02, 0.008, -0.012) * luma;

      // Saturation, pulled down as the player nears death.
      col = mix(vec3(luma), col, 1.12 - uDamage * 0.55);

      // Vignette.
      float vig = 1.0 - uVignette * smoothstep(0.18, 0.78, r2);
      col *= vig;

      // Damage overlay: arterial red creeping in from the edges, pulsing.
      if (uDamage > 0.001) {
        float pulse = 0.72 + 0.28 * sin(uTime * 7.0);
        float edge = smoothstep(0.02, 0.42, r2);
        col = mix(col, vec3(0.34, 0.015, 0.015), uDamage * edge * pulse * 0.85);
      }

      // Animated sensor grain — breaks up banding in the dark areas.
      float grain = hash(uv * 1024.0 + fract(uTime) * 173.0) - 0.5;
      col += grain * (0.022 + uDamage * 0.03);

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};
