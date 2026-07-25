import RAPIER from '@dimforge/rapier3d-compat';
import { Euler, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { Physics } from '../core/Physics';
import { Input } from '../core/Input';
import { TAU, clamp, damp, lerp } from '../util/math';

const STAND_HALF_HEIGHT = 0.62; // capsule cylinder half-height, excludes caps
const CROUCH_HALF_HEIGHT = 0.26;
const RADIUS = 0.32;
const STAND_EYE = 1.63;
const CROUCH_EYE = 1.02;

const WALK_SPEED = 4.3;
const SPRINT_SPEED = 7.1;
const CROUCH_SPEED = 2.1;
const ACCEL_GROUND = 62;
const ACCEL_AIR = 11;
const FRICTION = 13;
const JUMP_VELOCITY = 6.4;
const GRAVITY = -22;

const PITCH_LIMIT = Math.PI / 2 - 0.02;

/**
 * First-person locomotion.
 *
 * Movement is velocity-based with explicit acceleration and friction rather
 * than direct position setting — that is what gives the controller weight and
 * makes strafing feel like a shooter instead of a viewer orbit. The capsule is
 * driven through Rapier's kinematic character controller, which resolves
 * sliding, stepping and slopes for us.
 *
 * The class also produces the procedural camera motion (bob, sway, landing dip,
 * breathing) that the viewmodel later inherits.
 */
export class Player {
  readonly position = new Vector3();
  readonly velocity = new Vector3();

  yaw = 0;
  pitch = 0;

  grounded = false;
  crouching = false;
  sprinting = false;

  /** Multiplies movement speed — Stamin-Up style perks hook in here. */
  speedMultiplier = 1;
  /** Set false during the death sequence so input stops driving the capsule. */
  controlEnabled = true;

  /** 0..1 how much the player is currently moving, for weapon sway. */
  moveIntensity = 0;
  /** Continuous distance travelled, drives the bob phase. */
  private bobPhase = 0;
  private bobAmount = 0;
  private landingDip = 0;
  private landingVelocity = 0;
  private eyeHeight = STAND_EYE;
  private crouchBlend = 0;
  private leanRoll = 0;
  private stepDistance = 0;

  /** Fired each time a footfall lands, so audio can play a step. */
  onFootstep?: (running: boolean) => void;
  onLand?: (impact: number) => void;

  private readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private readonly controller: RAPIER.KinematicCharacterController;

  private readonly desiredMove = new Vector3();
  private readonly wishDir = new Vector3();
  private readonly tmpQuat = new Quaternion();
  private readonly tmpEuler = new Euler(0, 0, 0, 'YXZ');

  constructor(
    private readonly physics: Physics,
    private readonly input: Input,
    spawn: Vector3,
  ) {
    this.position.copy(spawn);
    const char = physics.createCharacter(spawn, RADIUS, STAND_HALF_HEIGHT);
    this.body = char.body;
    this.collider = char.collider;
    this.controller = char.controller;
  }

  get eyePosition(): Vector3 {
    return new Vector3(
      this.position.x,
      this.position.y + this.eyeHeight - this.landingDip,
      this.position.z,
    );
  }

  /** Horizontal forward vector, for spawn logic and weapon aim. */
  forward(target = new Vector3()): Vector3 {
    return target.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  teleport(to: Vector3) {
    this.position.copy(to);
    this.body.setNextKinematicTranslation({ x: to.x, y: to.y, z: to.z });
    this.body.setTranslation({ x: to.x, y: to.y, z: to.z }, true);
    this.velocity.set(0, 0, 0);
  }

  update(dt: number) {
    this.updateLook(dt);
    this.updateCrouch(dt);
    this.updateMovement(dt);
    this.updateProceduralMotion(dt);
  }

  private updateLook(dt: number) {
    if (!this.controlEnabled) return;
    this.yaw -= this.input.lookX;
    this.pitch -= this.input.lookY;
    this.pitch = clamp(this.pitch, -PITCH_LIMIT, PITCH_LIMIT);
    this.yaw = ((this.yaw % TAU) + TAU) % TAU;

    // Subtle counter-roll when strafing — reads as body lean, not a camera trick.
    const [strafe] = this.input.moveAxis();
    const targetRoll = this.controlEnabled ? -strafe * 0.022 : 0;
    this.leanRoll = damp(this.leanRoll, targetRoll, 7, dt);
  }

  private updateCrouch(dt: number) {
    const wantsCrouch = this.controlEnabled && this.input.isDown('ControlLeft');
    // Only stand back up if there is clearance overhead.
    if (!wantsCrouch && this.crouching && this.blockedAbove()) {
      this.crouching = true;
    } else {
      this.crouching = wantsCrouch;
    }

    this.crouchBlend = damp(this.crouchBlend, this.crouching ? 1 : 0, 13, dt);

    const halfHeight = lerp(STAND_HALF_HEIGHT, CROUCH_HALF_HEIGHT, this.crouchBlend);
    this.collider.setHalfHeight(halfHeight);
    this.eyeHeight = lerp(STAND_EYE, CROUCH_EYE, this.crouchBlend);
  }

  private blockedAbove(): boolean {
    const origin = new Vector3(this.position.x, this.position.y + 0.4, this.position.z);
    const hit = this.physics.raycast(origin, new Vector3(0, 1, 0), 1.5, this.collider);
    return hit !== null && hit.distance < 1.35;
  }

  private updateMovement(dt: number) {
    const [strafeAxis, forwardAxis] = this.controlEnabled ? this.input.moveAxis() : [0, 0];
    const moving = strafeAxis !== 0 || forwardAxis !== 0;

    this.sprinting =
      this.controlEnabled &&
      moving &&
      forwardAxis > 0.1 &&
      !this.crouching &&
      this.input.isDown('ShiftLeft');

    const baseSpeed = this.crouching ? CROUCH_SPEED : this.sprinting ? SPRINT_SPEED : WALK_SPEED;
    const maxSpeed = baseSpeed * this.speedMultiplier;

    // Convert input axes into a world-space wish direction.
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    this.wishDir.set(
      strafeAxis * cos - forwardAxis * sin,
      0,
      -strafeAxis * sin - forwardAxis * cos,
    );
    if (this.wishDir.lengthSq() > 0) this.wishDir.normalize();

    const accel = this.grounded ? ACCEL_GROUND : ACCEL_AIR;

    // Accelerate toward the target velocity, then apply ground friction to the
    // component that is not being commanded. Separating the two is what keeps
    // direction changes crisp while still coasting to a stop.
    const targetX = this.wishDir.x * maxSpeed;
    const targetZ = this.wishDir.z * maxSpeed;
    this.velocity.x += (targetX - this.velocity.x) * Math.min(1, accel * dt * 0.32);
    this.velocity.z += (targetZ - this.velocity.z) * Math.min(1, accel * dt * 0.32);

    if (this.grounded && !moving) {
      const decay = Math.max(0, 1 - FRICTION * dt);
      this.velocity.x *= decay;
      this.velocity.z *= decay;
      if (Math.abs(this.velocity.x) < 0.02) this.velocity.x = 0;
      if (Math.abs(this.velocity.z) < 0.02) this.velocity.z = 0;
    }

    // Jump / gravity.
    if (this.grounded && this.controlEnabled && this.input.wasPressed('Space') && !this.crouching) {
      this.velocity.y = JUMP_VELOCITY;
      this.grounded = false;
    } else if (!this.grounded) {
      this.velocity.y += GRAVITY * dt;
    } else if (this.velocity.y < 0) {
      // Small downward bias keeps the controller in contact with the floor.
      this.velocity.y = -2;
    }
    this.velocity.y = Math.max(this.velocity.y, -55);

    this.desiredMove.copy(this.velocity).multiplyScalar(dt);

    this.controller.computeColliderMovement(this.collider, {
      x: this.desiredMove.x,
      y: this.desiredMove.y,
      z: this.desiredMove.z,
    });
    const corrected = this.controller.computedMovement();

    const wasGrounded = this.grounded;
    this.grounded = this.controller.computedGrounded();

    if (!wasGrounded && this.grounded) {
      const impact = clamp(-this.landingVelocity / 14, 0, 1);
      if (impact > 0.06) {
        this.landingDip = impact * 0.24;
        this.onLand?.(impact);
      }
      this.velocity.y = 0;
    }
    this.landingVelocity = this.velocity.y;

    // If we were stopped by geometry, zero the blocked component so we do not
    // build up phantom velocity pressing into a wall.
    if (Math.abs(corrected.x) < Math.abs(this.desiredMove.x) * 0.5) this.velocity.x *= 0.4;
    if (Math.abs(corrected.z) < Math.abs(this.desiredMove.z) * 0.5) this.velocity.z *= 0.4;
    if (this.grounded && this.velocity.y < 0) this.velocity.y = 0;

    this.position.x += corrected.x;
    this.position.y += corrected.y;
    this.position.z += corrected.z;

    this.body.setNextKinematicTranslation({
      x: this.position.x,
      y: this.position.y,
      z: this.position.z,
    });
  }

  private updateProceduralMotion(dt: number) {
    const horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    const normalized = clamp(horizontalSpeed / SPRINT_SPEED, 0, 1);
    this.moveIntensity = damp(this.moveIntensity, this.grounded ? normalized : 0, 9, dt);

    // Bob phase advances with distance travelled, not time, so the rhythm
    // matches the stride at any speed.
    if (this.grounded) {
      this.bobPhase += horizontalSpeed * dt * 3.4;
      this.stepDistance += horizontalSpeed * dt;
      const stride = this.sprinting ? 1.85 : this.crouching ? 1.25 : 1.55;
      if (this.stepDistance >= stride) {
        this.stepDistance -= stride;
        this.onFootstep?.(this.sprinting);
      }
    }
    this.bobAmount = damp(this.bobAmount, this.grounded ? normalized : 0, 8, dt);
    this.landingDip = damp(this.landingDip, 0, 8, dt);
  }

  /** Writes the final camera transform. Called after update, before render. */
  applyToCamera(camera: PerspectiveCamera, dt: number) {
    const bobY = Math.sin(this.bobPhase * 2) * 0.032 * this.bobAmount;
    const bobX = Math.cos(this.bobPhase) * 0.042 * this.bobAmount;
    // Idle breathing keeps the frame alive when the player stands still.
    const breathe = Math.sin(performance.now() * 0.00085) * 0.006 * (1 - this.bobAmount);

    camera.position.set(
      this.position.x + bobX * 0.4,
      this.position.y + this.eyeHeight - this.landingDip + bobY + breathe,
      this.position.z,
    );

    this.tmpEuler.set(this.pitch, this.yaw, this.leanRoll + bobX * 0.35);
    this.tmpQuat.setFromEuler(this.tmpEuler);
    // Very light rotational smoothing: removes single-frame mouse spikes
    // without introducing perceptible input lag.
    camera.quaternion.slerp(this.tmpQuat, 1 - Math.exp(-42 * dt));
  }

  /** Exposes the bob state so the viewmodel can move in sympathy. */
  get bob() {
    return { phase: this.bobPhase, amount: this.bobAmount, dip: this.landingDip };
  }
}
