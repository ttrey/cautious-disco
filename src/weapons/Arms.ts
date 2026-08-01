import { BufferGeometry, CapsuleGeometry, Group, Material, Object3D, SphereGeometry } from 'three';
import { makeSurface } from '../assets/Materials';
import { MeshKit, box, place } from './GunSmith';

/**
 * First-person arms.
 *
 * Built as a real joint hierarchy — shoulder → elbow → wrist → finger segments —
 * rather than a single rigid mesh, so reload animations can actually open the
 * hand, drop the magazine and reach for a fresh one. Each segment is a capsule
 * (never a box), which is what gives limbs a believable round silhouette under
 * rim lighting.
 *
 * Materials: tactical glove uses the cloth bake, forearm sleeve uses the same
 * bake at a different tiling and tint, exposed skin uses the flesh bake with a
 * healthy (rather than necrotic) tint applied by the caller.
 *
 * Bone lengths here (0.285 upper, 0.265 forearm) are duplicated as constants in
 * `ViewModel.ts`, which is what the IK solves against. They have to agree: the
 * solver places the wrist by trigonometry on its own numbers, so a mesh that is
 * shorter or longer than the solver believes leaves the hand detached from the
 * arm that is supposedly holding the weapon.
 */

export interface HandRig {
  /** Root of the arm — parent this to the weapon or the viewmodel. */
  root: Group;
  elbow: Object3D;
  wrist: Object3D;
  /** Index finger base joint, animated onto and off the trigger. */
  triggerFinger: Object3D;
  /** All finger base joints, for open/close grip poses. */
  fingers: Object3D[];
  /**
   * Second joint of each of the four fingers, index-first.
   *
   * Closing a hand around a grip takes roughly 180 degrees of travel between
   * knuckle and tip, and a single joint cannot deliver it: bending only the
   * base joint sweeps the fingers past the grip as four straight rods. The
   * second joint has to be posed too, so it is exposed rather than baked.
   */
  fingerTips: Object3D[];
}

/** Texture tiles per metre for gloves and sleeves. */
const ARM_UV_SCALE = 9;

/** Capsule oriented along +Y (limb length), origin at the joint. */
function limb(radiusTop: number, radiusBottom: number, length: number): BufferGeometry {
  // CapsuleGeometry has a single radius; taper is applied by scaling the
  // geometry along its length after the fact.
  const r = (radiusTop + radiusBottom) * 0.5;
  const g = new CapsuleGeometry(r, Math.max(length - r * 2, 0.001), 4, 14);
  g.translate(0, -length / 2, 0);
  // Gentle taper toward the far end, matching real limb proportions.
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = Math.min(Math.max(-y / length, 0), 1);
    const scale = (radiusTop + (radiusBottom - radiusTop) * t) / r;
    pos.setX(i, pos.getX(i) * scale);
    pos.setZ(i, pos.getZ(i) * scale);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

function buildHand(side: -1 | 1, glove: Material, gloveDark: Material): HandRig {
  const root = new Group();
  root.name = side < 0 ? 'leftArm' : 'rightArm';

  // --- Upper arm (mostly off-screen, but its shadow and the sleeve read) ---
  const upper = new Group();
  const upperKit = new MeshKit();
  upperKit.add('sleeve', gloveDark, place(limb(0.052, 0.044, 0.285), 0, 0, 0));
  upperKit.flushInto(upper, true, ARM_UV_SCALE);
  root.add(upper);

  // --- Forearm ---
  const elbow = new Group();
  elbow.name = 'elbow';
  elbow.position.y = -0.285;
  root.add(elbow);

  const foreKit = new MeshKit();
  foreKit.add('sleeve', gloveDark, place(limb(0.044, 0.032, 0.265), 0, 0, 0));
  // Rolled cuff where the sleeve meets the glove.
  foreKit.add('glove', glove, place(limb(0.036, 0.034, 0.05), 0, -0.240, 0));
  foreKit.flushInto(elbow, true, ARM_UV_SCALE);

  // --- Wrist / hand ---
  const wrist = new Group();
  wrist.name = 'wrist';
  wrist.position.y = -0.265;
  elbow.add(wrist);

  // Hand axes: +X across the knuckles, -Y down the fingers, +Z out of the palm.
  //
  // The knuckle row therefore runs along X and the fingers curl about X toward
  // +Z, which is the axis `rotation.x` on each finger already turns. Spreading
  // the knuckles along Z instead — the palm's *thickness* — stacks the four
  // fingers front-to-back, and curling then fans them within that same stack:
  // the hand reads as a pile of sausages rather than a fist.
  const palmKit = new MeshKit();
  // Palm: a chamfered slab, slightly wedge-shaped.
  palmKit.add('glove', glove, place(box(0.074, 0.086, 0.030, 0.012, 3), 0, -0.042, 0.002));
  // Knuckle pad — the raised armour panel on tactical gloves, on the back.
  palmKit.add('glove', gloveDark, place(box(0.056, 0.030, 0.016, 0.006, 3), 0, -0.074, -0.013));
  // Thenar mass at the base of the thumb.
  palmKit.add('glove', glove, place(new SphereGeometry(0.019, 12, 10), side * -0.024, -0.030, 0.010));
  palmKit.flushInto(wrist, true, ARM_UV_SCALE);

  // --- Fingers: four, each with proximal + distal segments ---
  const fingers: Object3D[] = [];
  const fingerTips: Object3D[] = [];
  const fingerLengths = [0.036, 0.039, 0.036, 0.03];
  const fingerRadii = [0.0105, 0.011, 0.0105, 0.0092];

  for (let i = 0; i < 4; i++) {
    const base = new Group();
    base.name = `finger${i}`;
    // Index (i = 0) sits on the thumb side; pinky on the outside.
    base.position.set(side * (-0.026 + i * 0.0185), -0.086, 0.002);
    // Fingers splay slightly and curl in by default.
    base.rotation.x = -0.35;
    base.rotation.z = side * (i - 1.5) * 0.045;
    wrist.add(base);

    const proximal = new MeshKit();
    proximal.add('glove', glove, place(limb(fingerRadii[i], fingerRadii[i] * 0.88, fingerLengths[i]), 0, 0, 0));
    proximal.flushInto(base, true, ARM_UV_SCALE);

    const distal = new Group();
    distal.name = `finger${i}Tip`;
    distal.position.y = -fingerLengths[i];
    distal.rotation.x = -0.5;
    base.add(distal);

    const tipKit = new MeshKit();
    tipKit.add(
      'glove',
      glove,
      place(limb(fingerRadii[i] * 0.88, fingerRadii[i] * 0.72, fingerLengths[i] * 0.82), 0, 0, 0),
    );
    tipKit.flushInto(distal, true, ARM_UV_SCALE);

    fingers.push(base);
    fingerTips.push(distal);
  }

  // --- Thumb, angled across the grip ---
  const thumb = new Group();
  thumb.name = 'thumb';
  thumb.position.set(side * -0.032, -0.044, 0.012);
  thumb.rotation.set(-0.45, 0, side * -0.95);
  wrist.add(thumb);
  const thumbKit = new MeshKit();
  thumbKit.add('glove', glove, place(limb(0.013, 0.011, 0.034), 0, 0, 0));
  thumbKit.flushInto(thumb, true, ARM_UV_SCALE);

  const thumbTip = new Group();
  thumbTip.position.y = -0.034;
  thumbTip.rotation.x = -0.55;
  thumb.add(thumbTip);
  const thumbTipKit = new MeshKit();
  thumbTipKit.add('glove', glove, place(limb(0.011, 0.0095, 0.028), 0, 0, 0));
  thumbTipKit.flushInto(thumbTip, true, ARM_UV_SCALE);
  fingers.push(thumb);

  // fingers[0] is the index finger — the one that reaches the trigger.
  return { root, elbow, wrist, triggerFinger: fingers[0], fingers, fingerTips };
}

let cachedGlove: Material | null = null;
let cachedGloveDark: Material | null = null;

export function buildArms(): { left: HandRig; right: HandRig } {
  if (!cachedGlove) {
    // Reuse the cloth bake but tint it to coyote-brown tactical glove leather
    // rather than the zombies' filthy workwear.
    cachedGlove = makeSurface('zombieCloth', {
      repeat: 1,
      tint: 0x6d6255,
      roughness: 0.92,
      metalness: 0,
      normalScale: 0.8,
    });
    cachedGloveDark = makeSurface('polymer', {
      repeat: 1,
      tint: 0x33302c,
      roughness: 1,
      metalness: 0,
      normalScale: 0.7,
    });
  }
  return {
    left: buildHand(-1, cachedGlove!, cachedGloveDark!),
    right: buildHand(1, cachedGlove!, cachedGloveDark!),
  };
}
