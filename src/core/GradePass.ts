import { Vector2 } from 'three';

/**
 * Final colour grade.
 *
 * Adds the things that separate "a Three.js scene" from "a game frame":
 * a filmic S-curve with crisp midtones and protected highlight roll-off,
 * a shadow floor so darkness carries information instead of crushing to
 * black, minimal chromatic aberration at the edges, animated sensor grain,
 * a vignette, and a blood-pulse overlay driven by player health.
 *
 * The night look lives here: the world is NOT brightened toward day — the
 * floor lift sculpts the darkness so shadowed planes keep readable shape
 * while staying unambiguously night.
 */
export const GradePass = {
  name: 'GradePass',
  uniforms: {
    tDiffuse: { value: null as unknown },
    uTime: { value: 0 },
    /** 0..1 — how hurt the player is. Drives the red pulse and desaturation. */
    uDamage: { value: 0 },
    uVignette: { value: 0.58 },
    uResolution: { value: new Vector2(1, 1) },
    /**
     * Shadow floor, in linear light. Additive lift masked to the dark end so
     * crushed blacks land around 0.04-0.06 in the final sRGB frame instead of
     * 0 — shadowed plaster keeps shape, but nothing here approaches a midtone.
     */
    uShadowFloor: { value: 0.017 },
    /** Width of the falloff above black over which the floor lift fades out. */
    uShadowKnee: { value: 0.13 },
    /**
     * 0..1 — how much of the S-curve contrast is applied. The curve pivots on
     * midtone luminance: below it darkens, above it lifts, so mids stay crisp
     * while the floor lift (not the curve) owns the bottom of the range.
     */
    uContrast: { value: 0.6 },
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
    uniform float uShadowFloor;
    uniform float uShadowKnee;
    uniform float uContrast;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    void main() {
      vec2 uv = vUv;
      vec2 centered = uv - 0.5;
      float r2 = dot(centered, centered);

      // Chromatic aberration scales with distance from centre, and swells when
      // the player is hurt. The total coefficient is hard-clamped at 0.0015:
      // past that the RGB split stops reading as lens artefact and starts
      // smearing edges into colour mud, so the hurt swell saturates at the
      // same subtle ceiling as the base film look.
      float ca = min(0.0009 + uDamage * 0.0035, 0.0015) * r2;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + centered * ca).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - centered * ca).b;

      // Tonal shaping.
      //
      // This pass runs BEFORE OutputPass, so the colour here is linear HDR and
      // routinely exceeds 1.0 around lamps, muzzle flashes and perk signage.
      // A naive S-curve sends those values negative — x*x*(3-2x) < 0 for every
      // x above 1.5, which is what produces black-cored lights ringed in
      // rainbow fringing. So the curve is applied to the 0..1 portion only and
      // HDR energy above 1.0 passes through untouched for ACES to roll off.
      col = max(col, vec3(0.0));
      vec3 base = min(col, vec3(1.0));
      vec3 hdr = col - base;

      // Luminance-ratio S-curve: shape the luminance, scale RGB by the ratio.
      // Scaling rather than curving per channel keeps hue stable (no red/blue
      // drift at the ends of the ramp) and keeps the curve HDR-safe by
      // construction. smoothstep() is the S: it pivots at 0.5, darkening the
      // lower half and lifting the upper half, so midtones gain separation
      // while the shadow floor below re-opens the crushed bottom end.
      float l = dot(base, vec3(0.2126, 0.7152, 0.0722));
      float shaped = mix(l, smoothstep(0.0, 1.0, l), uContrast);
      col = base * (shaped / max(l, 1e-4)) + hdr;

      // Split-tone: cool shadows / warm highlights, recomputed on shaped light.
      l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      float shadowMask = 1.0 - smoothstep(0.04, 0.58, min(l, 1.0));
      float highlightMask = smoothstep(0.34, 1.0, min(l, 1.0));
      col += vec3(-0.003, -0.001, 0.006) * shadowMask;
      col += vec3(0.006, 0.002, -0.003) * highlightMask;

      // Saturation, pulled down as the player nears death.
      col = max(mix(vec3(l), col, 1.08 - uDamage * 0.55), 0.0);

      // Vignette. uVignette is clamped to 0..1 and the multiplier is capped
      // at 0.25, so the worst-case corner falloff — ADS plus full hurt
      // pushing the uniform to 1.0 — is a 25% darkening, and the resting
      // state (~0.55) sits near 14%. Subtle film framing, not a tunnel.
      float vig = 1.0 - clamp(uVignette, 0.0, 1.0) * 0.25 * smoothstep(0.28, 0.92, r2);
      col *= vig;

      // Damage overlay: arterial red creeping in from the edges, pulsing.
      if (uDamage > 0.001) {
        float pulse = 0.72 + 0.28 * sin(uTime * 7.0);
        float edge = smoothstep(0.02, 0.42, r2);
        col = mix(col, vec3(0.34, 0.015, 0.015), uDamage * edge * pulse * 0.85);
      }

      // Shadow floor — applied last of the tonal stages so it is exactly what
      // it claims to be: nothing in the frame lands below it. The mask fades
      // the lift out over the knee so midtones are untouched and only the
      // crushed bottom end gains information. This is what keeps the night
      // readable: blacks at ~0.04-0.06 sRGB carry plaster texture and depth
      // cueing instead of cutting to empty black.
      float floorLuma = min(dot(col, vec3(0.2126, 0.7152, 0.0722)), 1.0);
      float floorMask = 1.0 - smoothstep(0.0, uShadowKnee, floorLuma);
      col += uShadowFloor * floorMask * vec3(1.0);

      // Animated sensor grain — breaks up banding in the dark areas. Damped
      // where the floor lift dominates so lifted blacks read as graded shadow
      // rather than blotchy noise; full strength everywhere else. The total
      // amplitude is clamped at 0.02: enough texture to kill banding, never
      // enough to read as sensor mud even at full hurt.
      float grain = hash(uv * 1024.0 + fract(uTime) * 173.0) - 0.5;
      col += grain * min(0.009 + uDamage * 0.011, 0.02) * (1.0 - 0.45 * floorMask);

      // Re-assert the floor after grain: grain's negative swing must not dig
      // holes back below the information floor the lift just established.
      col = max(col, vec3(uShadowFloor * floorMask));

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};
