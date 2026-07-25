import { Object3D, Quaternion, Vector3 } from 'three';

/**
 * Analytic two-bone IK.
 *
 * The arms are authored once and then solved onto whichever weapon is held, so
 * adding a gun means specifying two grip points rather than hand-posing a new
 * set of arms. Both bones extend along their local -Y axis (see Arms.ts) and
 * the elbow bends about its local X.
 */

const _rootWorld = new Vector3();
const _target = new Vector3();
const _pole = new Vector3();
const _dir = new Vector3();
const _bend = new Vector3();
const _fwd = new Vector3();
const _q = new Quaternion();
const _qParent = new Quaternion();
const _mat = new Vector3();
const DOWN = new Vector3(0, -1, 0);

/**
 * @param root   Upper-bone joint (shoulder). Its world position is the anchor.
 * @param elbow  Lower-bone joint, a child of `root`.
 * @param targetWorld World-space position the end of the lower bone should reach.
 * @param poleWorld   World-space hint the elbow should point toward.
 */
export function solveTwoBoneIK(
  root: Object3D,
  elbow: Object3D,
  targetWorld: Vector3,
  poleWorld: Vector3,
  upperLength: number,
  lowerLength: number,
): void {
  root.updateWorldMatrix(true, false);
  _rootWorld.setFromMatrixPosition(root.matrixWorld);

  _target.copy(targetWorld).sub(_rootWorld);
  const reach = upperLength + lowerLength;
  // Clamp into the solvable annulus, leaving a margin so the arm never locks
  // dead straight (which reads as a mannequin) or folds through itself.
  const dist = Math.min(Math.max(_target.length(), Math.abs(upperLength - lowerLength) + 0.02), reach * 0.995);
  if (dist < 1e-5) return;
  _dir.copy(_target).normalize();

  // Law of cosines: interior angles of the shoulder-elbow-wrist triangle.
  const cosShoulder = (upperLength * upperLength + dist * dist - lowerLength * lowerLength) / (2 * upperLength * dist);
  const cosElbow = (upperLength * upperLength + lowerLength * lowerLength - dist * dist) / (2 * upperLength * lowerLength);
  const shoulderAngle = Math.acos(Math.min(1, Math.max(-1, cosShoulder)));
  const elbowAngle = Math.PI - Math.acos(Math.min(1, Math.max(-1, cosElbow)));

  // Bend axis: perpendicular to the limb plane defined by the pole hint.
  _pole.copy(poleWorld).sub(_rootWorld);
  _bend.copy(_pole).cross(_dir);
  if (_bend.lengthSq() < 1e-8) {
    // Degenerate pole (collinear) — fall back to a stable arbitrary axis.
    _bend.set(1, 0, 0).cross(_dir);
    if (_bend.lengthSq() < 1e-8) _bend.set(0, 0, 1).cross(_dir);
  }
  _bend.normalize();

  // Aim the upper bone's -Y down the chord, then rotate it up by the shoulder
  // angle so the wrist lands exactly on the target.
  _fwd.copy(_dir).applyAxisAngle(_bend, -shoulderAngle);

  // Convert the desired world direction into the root's parent space.
  root.parent?.updateWorldMatrix(true, false);
  if (root.parent) {
    root.parent.getWorldQuaternion(_qParent);
    _qParent.invert();
    _mat.copy(_fwd).applyQuaternion(_qParent);
    _bend.applyQuaternion(_qParent);
  } else {
    _mat.copy(_fwd);
  }
  _mat.normalize();

  _q.setFromUnitVectors(DOWN, _mat);
  root.quaternion.copy(_q);

  // Roll the upper bone so its local X coincides with the bend axis; the elbow
  // then hinges cleanly in the limb plane.
  _bend.normalize();
  const localBend = _bend.clone().applyQuaternion(_q.clone().invert());
  // Rotating about local +Y by θ shifts a vector's XZ angle by -θ, so rolling
  // by exactly `roll` brings the bend axis onto +X.
  const roll = Math.atan2(localBend.z, localBend.x);
  root.rotateY(roll);

  elbow.rotation.set(elbowAngle, 0, 0);
}
