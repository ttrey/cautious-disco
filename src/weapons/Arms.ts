import {
  BufferGeometry,
  CapsuleGeometry,
  CylinderGeometry,
  Group,
  Material,
  Object3D,
  TorusGeometry,
} from 'three';
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
 * The gloves are constructed, not painted. At viewmodel distance (250–600 mm)
 * a hand is one of the largest objects on screen, so it carries the same
 * construction story as the weapons: hard knuckle plates sitting proud of a
 * soft shell, stitch dashes framing every plate, padded palm zones that swell
 * where pressure actually lands, crease rings where fabric bunches at each
 * joint, and a flared cuff collar closed by a retention strap. All of it is
 * geometry — silhouette and highlight survive any lighting rig, which a normal
 * map alone cannot promise at this distance.
 *
 * Materials come in per-hand sets. Palm leather is deliberately the shiniest
 * fabric in the set (wear polishes it); the woven back stays matte. Left and
 * right sets drift apart in tint and wear because two hands are never equally
 * worn — the weapon hand shows more polished pressure points, the support hand
 * runs a taller cuff and a cooler dust tone.
 *
 * Bone lengths here (0.285 upper, 0.265 forearm) are duplicated as constants in
 * `ViewModel.ts`, which is what the IK solves against. They have to agree: the
 * solver places the wrist by trigonometry on its own numbers, so a mesh that is
 * shorter or longer than the solver believes leaves the hand detached from the
 * arm that is supposedly holding the weapon. Every joint offset below
 * (`elbow.position.y`, `wrist.position.y`, the knuckle row spacing) is
 * load-bearing for that contract and must not move.
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

/**
 * One hand's glove materials.
 *
 * Per-hand rather than shared so the two hands can wear differently. The
 * contrast that does the work at viewmodel distance: matte woven back
 * (`glove`) against polished palm (`glovePalm`), with hard `gloveDark` plates
 * and `gloveAccent` stitching sitting between them.
 */
interface GloveSet {
  glove: Material;
  gloveDark: Material;
  gloveAccent: Material;
  glovePalm: Material;
  cuffFabric: Material;
  wristSkin: Material;
}

/**
 * Builds the material set for one hand.
 *
 * The weapon hand (`right`) is the more worn of the pair — its palm leather is
 * polished smoother and its shell carries a warmer, sweat-darkened tone. The
 * support hand keeps more of its factory finish and picks up a cooler, dustier
 * cast. Neither drift is large enough to read as a different garment; they only
 * break the symmetry that screams "mirrored asset".
 */
function makeGloveSet(hand: 'left' | 'right'): GloveSet {
  const right = hand === 'right';
  return {
    // Matte woven shell — back of hand, knuckle plate covers, finger bodies.
    glove: makeSurface('zombieCloth', {
      repeat: 1.4,
      tint: right ? 0x786a55 : 0x70675b,
      roughness: 0.94,
      metalness: 0,
      normalScale: 0.95,
    }),
    // Hard armour plates, bindings, strap hardware.
    gloveDark: makeSurface('polymer', {
      repeat: 1.8,
      tint: right ? 0x2b2b2b : 0x27292b,
      roughness: 0.95,
      metalness: 0,
      normalScale: 0.82,
    }),
    // Stitching and reinforced trim — a half-step between shell and plate so
    // the sewn edges catch their own highlight line.
    gloveAccent: makeSurface('polymer', {
      repeat: 2.2,
      tint: 0x55503f,
      roughness: 0.82,
      metalness: 0.02,
      normalScale: 0.7,
    }),
    // Worn palm leather. Lower roughness plus a faint clearcoat reads as
    // fabric polished by years of grip pressure — the classic tell of a real
    // shooting glove under a key light.
    glovePalm: makeSurface('zombieCloth', {
      repeat: 1.6,
      tint: right ? 0x8a7a60 : 0x837663,
      roughness: right ? 0.52 : 0.6,
      metalness: 0,
      normalScale: 0.6,
      clearcoat: 0.22,
      clearcoatRoughness: 0.5,
    }),
    cuffFabric: makeSurface('cordura', {
      repeat: 2.4,
      tint: right ? 0x3c403d : 0x383c3e,
      roughness: 0.96,
      metalness: 0,
      normalScale: 1.05,
    }),
    wristSkin: makeSurface('soldierSkin', {
      repeat: 1.6,
      tint: 0xb4775e,
      roughness: 0.68,
      metalness: 0,
      normalScale: 0.85,
    }),
  };
}

function buildHand(side: -1 | 1, set: GloveSet): HandRig {
  const { glove, gloveDark, gloveAccent, glovePalm, cuffFabric, wristSkin } = set;
  const root = new Group();
  root.name = side < 0 ? 'leftArm' : 'rightArm';

  // --- Upper arm (mostly off-screen, but its shadow and the sleeve read) ---
  const upper = new Group();
  const upperKit = new MeshKit();
  upperKit.add('sleeve', cuffFabric, place(limb(0.052, 0.044, 0.285), 0, 0, 0));
  upperKit.flushInto(upper, true, ARM_UV_SCALE);
  root.add(upper);

  // --- Forearm ---
  // This offset is half of the IK reach budget (UPPER_ARM in ViewModel.ts).
  const elbow = new Group();
  elbow.name = 'elbow';
  elbow.position.y = -0.285;
  root.add(elbow);

  // Support hand wears its cuff a touch taller — it does the bracing work and
  // real support gloves run longer wrists. Small numbers, but together with the
  // tint drift they stop the two arms reading as mirror copies.
  const collarHeight = side < 0 ? 0.023 : 0.019;

  const foreKit = new MeshKit();
  foreKit.add('sleeve', cuffFabric, place(limb(0.044, 0.032, 0.265), 0, 0, 0));
  // Rolled cuff where the sleeve meets the glove.
  foreKit.add('glove', glove, place(limb(0.036, 0.034, 0.05), 0, -0.240, 0));
  // Flared cuff collar replacing the plain band: it widens toward the forearm
  // like the gathered mouth of a real glove, giving the wrist a hard rim of
  // light instead of a smooth capsule blend.
  foreKit.add(
    'gloveDark',
    gloveDark,
    place(new CylinderGeometry(0.0415, 0.0375, collarHeight, 12), 0, -0.2455, 0),
  );
  // Retention strap nub on the outboard flank — the hook-and-loop tab's backing,
  // plus an accent keeper bar across it. At 300–500 mm this is what says
  // "adjustable cuff" without needing its own texture.
  foreKit.add(
    'gloveDark',
    gloveDark,
    place(box(0.011, collarHeight * 0.5, 0.0035, 0.0012), side * 0.041, -0.2435, 0),
  );
  foreKit.add(
    'gloveAccent',
    gloveAccent,
    place(box(0.0135, 0.0032, 0.005, 0.0009), side * 0.041, -0.2435, 0),
  );
  // A hairline of healthy skin at the cuff keeps the wrist from reading as a
  // sleeve welded directly into the glove. It is mostly occluded by the welt,
  // but catches a warm highlight when the support hand reaches during reload.
  foreKit.add(
    'wristSkin',
    wristSkin,
    place(new TorusGeometry(0.0345, 0.0015, 6, 16), 0, -0.227, 0, Math.PI / 2),
  );
  // A raised textile welt on either side of the cuff catches the key light and
  // makes the sleeve-to-glove transition read as a sewn assembly, not one
  // continuous capsule. The torus is kept shallow so it cannot clip during
  // the IK poses or reload reach.
  foreKit.add(
    'cuffWelt',
    gloveAccent,
    place(new TorusGeometry(0.0395, 0.0018, 6, 18), 0, -0.238, 0, Math.PI / 2),
  );
  foreKit.flushInto(elbow, true, ARM_UV_SCALE);

  // --- Wrist / hand ---
  // This offset is the other half of the IK reach budget (FOREARM), plus the
  // PALM_REACH grip math downstream depends on where the fingers start.
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

  // Palm slab: chamfered, slightly wedge-shaped. Matte shell — the shine lives
  // in the padded zones layered on top of it.
  palmKit.add('glove', glove, place(box(0.074, 0.086, 0.030, 0.012, 3), 0, -0.042, 0.002));

  // Padded palm zones (the "puff"). Real gloves pad exactly three places —
  // centre palm, thenar heel and the pinky-edge blade — because those are
  // where a grip presses. Slightly proud of the slab, in the shinier worn
  // leather, so the palm catches its own soft highlight distinct from the
  // matte back. All three are chamfered slabs rather than swept spheres: a
  // sphere swells equally in every direction and reads as a ball whenever it
  // clears the silhouette, while a padded panel keeps its edges honest.
  palmKit.add('glovePalm', glovePalm, place(box(0.052, 0.056, 0.0075, 0.0032, 2), 0, -0.044, 0.0145));
  // Thenar mass at the base of the thumb, following the palm's slope.
  palmKit.add('glovePalm', glovePalm, place(box(0.02, 0.028, 0.009, 0.003, 2), side * -0.022, -0.032, 0.008));
  // Hypothenar blade along the pinky edge.
  palmKit.add('glovePalm', glovePalm, place(box(0.016, 0.03, 0.0075, 0.0028, 2), side * 0.021, -0.054, 0.006));
  // Palm heel reinforcement keeps the hand from reading as a soft mitten at
  // the fire-control grip, especially during the inspect and reload poses.
  palmKit.add('gloveDark', gloveDark, place(box(0.044, 0.024, 0.010, 0.004, 3), 0, -0.018, 0.018));

  // Knuckle armour, built as a segmented assembly rather than one slab:
  // a dark under-plate spans the row, then one hard plate sits over each MCP
  // joint, each framed by stitch dashes. Segmented plates flex visually where
  // a single slab cannot, and the gaps between them are what make the row read
  // as armour bolted onto fabric.
  palmKit.add('gloveDark', gloveDark, place(box(0.058, 0.036, 0.006, 0.0022, 2), 0, -0.074, -0.0165));
  const knuckleX = (i: number) => side * (-0.026 + i * 0.0185);
  // Per-plate heights follow real hand proportions — middle fingers tallest.
  const plateHeights = [0.02, 0.023, 0.023, 0.019];
  for (let i = 0; i < 4; i++) {
    // The weapon hand's index plate is larger: that knuckle does the most
    // work against a receiver and wears a bigger cap. Left/right asymmetry
    // again, kept inside the silhouette of the under-plate.
    const widen = side > 0 && i === 0 ? 1.25 : 1;
    const pw = 0.0118 * widen;
    const ph = plateHeights[i];
    const px = knuckleX(i);
    palmKit.add('glove', glove, place(box(pw, ph, 0.007, 0.0022, 2), px, -0.074, -0.021));
    // Stitch dashes framing the plate — two per long edge. Continuous strips
    // read as moulded seams; interrupted dashes read as thread.
    for (const dy of [-1, 1]) {
      for (const dx of [-1, 1]) {
        palmKit.add(
          'gloveAccent',
          gloveAccent,
          place(
            box(pw * 0.4, 0.0021, 0.0022, 0.0007, 1),
            px + dx * pw * 0.25,
            -0.074 + dy * (ph * 0.5 + 0.0024),
            -0.0195,
          ),
        );
      }
    }
  }
  // Fine dorsal seams and a palm-heel patch give the glove a construction
  // story at the scale visible beside the receiver and trigger guard.
  palmKit.add('gloveAccent', gloveAccent, place(box(0.056, 0.004, 0.003, 0.0008, 2), 0, -0.058, -0.024));
  palmKit.add('gloveAccent', gloveAccent, place(box(0.042, 0.005, 0.002, 0.0007, 2), 0, -0.026, 0.020));
  // Weapon-hand wear callus: a small polished patch on the radial corner next
  // to the index knuckle, where a rifle's charging track rubs. Support hand
  // gets none — its wear shows as the taller cuff instead.
  if (side > 0) {
    palmKit.add('glovePalm', glovePalm, place(box(0.007, 0.03, 0.004, 0.0015, 1), side * -0.033, -0.066, -0.011));
  }
  palmKit.flushInto(wrist, true, ARM_UV_SCALE);

  // --- Fingers: four, each with proximal + distal segments ---
  const fingers: Object3D[] = [];
  const fingerTips: Object3D[] = [];
  const fingerLengths = [0.036, 0.039, 0.036, 0.03];
  const fingerRadii = [0.0105, 0.011, 0.0105, 0.0092];

  // Fabric crease ring: a shallow torus squeezed just proud of the segment
  // surface where cloth bunches at a joint. Geometry rather than texture,
  // because at viewmodel distance the highlight breaking over the ring is the
  // detail that sells it.
  const creaseRing = (radius: number) =>
    place(new TorusGeometry(radius, 0.0011, 5, 10), 0, 0, 0, Math.PI / 2);

  for (let i = 0; i < 4; i++) {
    const base = new Group();
    base.name = `finger${i}`;
    // Index (i = 0) sits on the thumb side; pinky on the outside.
    base.position.set(knuckleX(i), -0.086, 0.002);
    // Fingers splay slightly and curl in by default.
    base.rotation.x = -0.35;
    base.rotation.z = side * (i - 1.5) * 0.045;
    wrist.add(base);

    const proximal = new MeshKit();
    proximal.add('glove', glove, place(limb(fingerRadii[i], fingerRadii[i] * 0.88, fingerLengths[i]), 0, 0, 0));
    // Mid-segment crease where the finger bends.
    proximal.add('gloveDark', gloveDark, place(creaseRing(fingerRadii[i] * 1.05), 0, -fingerLengths[i] * 0.48, 0));
    proximal.flushInto(base, true, ARM_UV_SCALE);

    const distal = new Group();
    distal.name = `finger${i}Tip`;
    distal.position.y = -fingerLengths[i];
    distal.rotation.x = -0.5;
    base.add(distal);

    const tipKit = new MeshKit();
    tipKit.add(
      'gloveAccent',
      gloveAccent,
      place(limb(fingerRadii[i] * 0.88, fingerRadii[i] * 0.72, fingerLengths[i] * 0.82), 0, 0, 0),
    );
    // Crease at the second joint, on the thinner distal taper.
    tipKit.add('gloveDark', gloveDark, place(creaseRing(fingerRadii[i] * 0.93), 0, -0.006, 0));
    tipKit.flushInto(distal, true, ARM_UV_SCALE);

    fingers.push(base);
    fingerTips.push(distal);
  }

  // --- Thumb, angled across the grip ---
  // Base transform is load-bearing: ViewModel's poseWrist re-targets these
  // Euler angles every frame for the thumb-forward support grip.
  const thumb = new Group();
  thumb.name = 'thumb';
  thumb.position.set(side * -0.032, -0.044, 0.012);
  thumb.rotation.set(-0.45, 0, side * -0.95);
  wrist.add(thumb);
  const thumbKit = new MeshKit();
  thumbKit.add('glove', glove, place(limb(0.013, 0.011, 0.034), 0, 0, 0));
  thumbKit.add('gloveDark', gloveDark, place(creaseRing(0.0135), 0, -0.016, 0));
  thumbKit.flushInto(thumb, true, ARM_UV_SCALE);

  const thumbTip = new Group();
  thumbTip.position.y = -0.034;
  thumbTip.rotation.x = -0.55;
  thumb.add(thumbTip);
  const thumbTipKit = new MeshKit();
  thumbTipKit.add('gloveAccent', gloveAccent, place(limb(0.011, 0.0095, 0.028), 0, 0, 0));
  thumbTipKit.flushInto(thumbTip, true, ARM_UV_SCALE);
  fingers.push(thumb);

  // fingers[0] is the index finger — the one that reaches the trigger.
  return { root, elbow, wrist, triggerFinger: fingers[0], fingers, fingerTips };
}

let cachedLeft: GloveSet | null = null;
let cachedRight: GloveSet | null = null;

export function buildArms(): { left: HandRig; right: HandRig } {
  if (!cachedRight || !cachedLeft) {
    // Reuse the procedural surface library, but give each garment a distinct
    // response: matte woven shell, grippy worn palm, dense reinforced trim and
    // a woven sleeve. Shared across the whole roster, so the same authored hand
    // construction survives every weapon swap.
    cachedRight = makeGloveSet('right');
    cachedLeft = makeGloveSet('left');
  }
  return {
    left: buildHand(-1, cachedLeft),
    right: buildHand(1, cachedRight),
  };
}
