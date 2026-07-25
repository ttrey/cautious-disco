import RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';

/**
 * Physics layer, built on Rapier.
 *
 * Rapier was chosen over cannon-es for two concrete reasons:
 *  1. It is a Rust/WASM build — the broadphase and query pipeline are an order
 *     of magnitude faster than the pure-JS alternative, which matters once two
 *     dozen zombies are querying the world every frame.
 *  2. It ships `KinematicCharacterController` with built-in autostep, snap-to-
 *     ground and slope limits. With cannon-es that is all hand-rolled, and
 *     hand-rolled character controllers are where FPS games get stuck on
 *     doorframes.
 *
 * Scope is deliberately narrow: the world is static geometry plus one character
 * controller for the player. Zombies steer on a navigation grid instead of
 * simulating rigid bodies — 24 dynamic capsules jostling each other is both
 * slower and less predictable than explicit boids-style separation.
 */

export interface RayHit {
  distance: number;
  point: Vector3;
  normal: Vector3;
}

const tmpVec = new Vector3();

export class Physics {
  world!: RAPIER.World;
  private static ready = false;

  /** Rapier's WASM must be initialised before any other call. */
  static async init(): Promise<Physics> {
    if (!Physics.ready) {
      await RAPIER.init();
      Physics.ready = true;
    }
    const p = new Physics();
    p.world = new RAPIER.World({ x: 0, y: -22, z: 0 });
    // 60 Hz fixed step; the engine feeds it a clamped delta.
    p.world.integrationParameters.dt = 1 / 60;
    return p;
  }

  /** Adds an immovable box collider — the workhorse for walls, floors, props. */
  addStaticBox(
    position: Vector3,
    halfExtents: Vector3,
    rotation?: Quaternion,
  ): RAPIER.Collider {
    const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(
      position.x,
      position.y,
      position.z,
    );
    if (rotation) {
      bodyDesc.setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w });
    }
    const body = this.world.createRigidBody(bodyDesc);
    const colliderDesc = RAPIER.ColliderDesc.cuboid(
      halfExtents.x,
      halfExtents.y,
      halfExtents.z,
    ).setFriction(0.4);
    return this.world.createCollider(colliderDesc, body);
  }

  removeCollider(collider: RAPIER.Collider) {
    const body = collider.parent();
    this.world.removeCollider(collider, false);
    if (body) this.world.removeRigidBody(body);
  }

  /**
   * Creates the player capsule. `halfHeight` excludes the hemispherical caps,
   * matching Rapier's capsule convention.
   */
  createCharacter(position: Vector3, radius: number, halfHeight: number) {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
        position.x,
        position.y,
        position.z,
      ),
    );
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.capsule(halfHeight, radius),
      body,
    );

    // 0.02 skin width stops the capsule from resting exactly on a surface,
    // which is what causes jittering contacts.
    const controller = this.world.createCharacterController(0.02);
    controller.setUp({ x: 0, y: 1, z: 0 });
    controller.setSlideEnabled(true);
    controller.enableAutostep(0.42, 0.24, true); // step over kerbs and debris
    controller.enableSnapToGround(0.4); // stay glued going down ramps
    controller.setMaxSlopeClimbAngle((52 * Math.PI) / 180);
    controller.setMinSlopeSlideAngle((38 * Math.PI) / 180);
    controller.setApplyImpulsesToDynamicBodies(false);

    return { body, collider, controller };
  }

  /** World-geometry raycast. Returns null when nothing is hit inside maxDist. */
  raycast(origin: Vector3, direction: Vector3, maxDist: number, exclude?: RAPIER.Collider): RayHit | null {
    const ray = new RAPIER.Ray(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: direction.x, y: direction.y, z: direction.z },
    );
    const hit = this.world.castRayAndGetNormal(ray, maxDist, true, undefined, undefined, exclude);
    if (!hit) return null;
    const distance = hit.timeOfImpact;
    return {
      distance,
      point: tmpVec.copy(origin).addScaledVector(direction, distance).clone(),
      normal: new Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
    };
  }

  step() {
    this.world.step();
  }
}

export { RAPIER };
