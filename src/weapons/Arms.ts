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
  upperKit.add('sleeve', gloveDark, place(limb(0.052, 0.044, 0.26), 0, 0, 0));
  upperKit.flushInto(upper, true, ARM_UV_SCALE);
  root.add(upper);

  // --- Forearm ---
  const elbow = new Group();
  elbow.name = 'elbow';
  elbow.position.y = -0.26;
  root.add(elbow);

  const foreKit = new MeshKit();
  foreKit.add('sleeve', gloveDark, place(limb(0.044, 0.032, 0.24), 0, 0, 0));
  // Rolled cuff where the sleeve meets the glove.
  foreKit.add('glove', glove, place(limb(0.036, 0.034, 0.05), 0, -0.215, 0));
  foreKit.flushInto(elbow, true, ARM_UV_SCALE);

  // --- Wrist / hand ---
  const wrist = new Group();
  wrist.name = 'wrist';
  wrist.position.y = -0.24;
  elbow.add(wrist);

  const palmKit = new MeshKit();
  // Palm: a chamfered slab, slightly wedge-shaped.
  palmKit.add('glove', glove, place(box(0.028, 0.085, 0.072, 0.014, 3), side * 0.004, -0.04, 0.004));
  // Knuckle pad — the raised armour panel on tactical gloves.
  palmKit.add('glove', gloveDark, place(box(0.03, 0.03, 0.05, 0.008, 3), side * 0.005, -0.072, -0.012));
  // Thenar mass at the base of the thumb.
  palmKit.add('glove', glove, place(new SphereGeometry(0.019, 12, 10), side * -0.008, -0.03, 0.022));
  palmKit.flushInto(wrist, true, ARM_UV_SCALE);

  // --- Fingers: four, each with proximal + distal segments ---
  const fingers: Object3D[] = [];
  const fingerLengths = [0.036, 0.039, 0.036, 0.03];
  const fingerRadii = [0.0105, 0.011, 0.0105, 0.0092];

  for (let i = 0; i < 4; i++) {
    const base = new Group();
    base.name = `finger${i}`;
    base.position.set(side * 0.004, -0.084, 0.026 - i * 0.019);
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
  }

  // --- Thumb, angled across the grip ---
  const thumb = new Group();
  thumb.name = 'thumb';
  thumb.position.set(side * -0.012, -0.052, 0.03);
  thumb.rotation.set(-0.5, 0, side * 0.85);
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

  return { root, elbow, wrist, triggerFinger: fingers[1], fingers };
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
