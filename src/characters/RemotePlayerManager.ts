import { Mesh, Object3D, Scene, Vector3 } from 'three';
import { OPERATOR_IDS, OperatorId, SoldierRig, buildSoldierMesh } from './SoldierMesh';
import { PlayerSnapshot, RemotePlayer } from './RemotePlayer';

/**
 * The other three players in the lobby.
 *
 * Four is the cap, and it is a design constant rather than an arbitrary one:
 * Ashgate Terminal's doubled loop, its two arenas and its perk spread are all
 * laid out for four. So this owns exactly four operator rigs, hands them out as
 * players join, and takes them back when they leave.
 *
 * Rigs are built once and pooled, for the same reason the zombie pool is: a
 * skinned character with a face on it costs tens of milliseconds to assemble,
 * and building one when somebody joins mid-round is a visible hitch at exactly
 * the moment the player can least afford one.
 */

/** Nobody is drawn past this. Beyond it a teammate is a few pixels of camo. */
const CULL_DISTANCE = 55;
/**
 * Local operator assignment. The first slot is the local player's, so remote
 * players are handed out from the second onward and everybody in the lobby sees
 * the same four characters in the same order.
 */
export const LOCAL_OPERATOR: OperatorId = 'vance';

interface Slot {
  operator: OperatorId;
  rig: SoldierRig;
  player: RemotePlayer | null;
}

const _tmp = new Vector3();

export class RemotePlayerManager {
  private readonly scene: Scene;
  private readonly slots: Slot[] = [];
  private readonly byId = new Map<string, Slot>();
  /** Monotonic clock the snapshots' timestamps are compared against. */
  private clock = 0;

  constructor(scene: Scene, prewarm = true) {
    this.scene = scene;
    if (prewarm) for (const id of OPERATOR_IDS) this.slotFor(id);
  }

  /** Builds (or finds) the pooled rig for an operator. */
  private slotFor(operator: OperatorId): Slot {
    let slot = this.slots.find((s) => s.operator === operator);
    if (slot) return slot;
    const rig = buildSoldierMesh(operator);
    rig.root.visible = false;
    // Shadows are set here rather than in the builder so the harness pages can
    // choose their own lighting policy.
    rig.root.traverse((o: Object3D) => {
      const m = o as Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    this.scene.add(rig.root);
    slot = { operator, rig, player: null };
    this.slots.push(slot);
    return slot;
  }

  get players(): RemotePlayer[] {
    return this.slots.map((s) => s.player).filter((p): p is RemotePlayer => p !== null);
  }

  /**
   * Admits a player. `operator` is normally decided by the host so everybody
   * agrees; left out, the first free slot that is not the local player's is
   * used.
   */
  join(id: string, operator?: OperatorId): RemotePlayer | null {
    const existing = this.byId.get(id);
    if (existing?.player) return existing.player;

    const wanted =
      operator ??
      OPERATOR_IDS.find(
        (o) => o !== LOCAL_OPERATOR && !this.slots.some((s) => s.operator === o && s.player),
      );
    if (!wanted) return null;

    const slot = this.slotFor(wanted);
    if (slot.player) return null;
    slot.player = new RemotePlayer(id, wanted, slot.rig);
    slot.rig.root.visible = true;
    this.byId.set(id, slot);
    return slot.player;
  }

  leave(id: string) {
    const slot = this.byId.get(id);
    if (!slot) return;
    slot.player?.recycle();
    slot.player = null;
    slot.rig.root.visible = false;
    this.byId.delete(id);
  }

  get(id: string): RemotePlayer | null {
    return this.byId.get(id)?.player ?? null;
  }

  /** Feeds a snapshot in. Unknown ids are ignored rather than auto-joined. */
  push(id: string, snapshot: PlayerSnapshot) {
    this.byId.get(id)?.player?.push(snapshot);
  }

  /** The clock snapshots should be stamped with when they are produced locally. */
  get now(): number {
    return this.clock;
  }

  update(dt: number, viewer: Vector3) {
    this.clock += dt;
    for (const slot of this.slots) {
      const player = slot.player;
      if (!player) continue;
      player.update(dt, this.clock);
      // Distance cull. The meshes have `frustumCulled` off — an animated
      // character reaching out leaves the bounding sphere it was bound in — so
      // this is the only thing keeping an off-map teammate off the GPU.
      _tmp.copy(player.position).sub(viewer);
      player.setVisible(_tmp.lengthSq() < CULL_DISTANCE * CULL_DISTANCE);
    }
  }

  clear() {
    for (const id of [...this.byId.keys()]) this.leave(id);
  }

  dispose() {
    this.clear();
    for (const slot of this.slots) {
      this.scene.remove(slot.rig.root);
      slot.player?.dispose();
    }
    this.slots.length = 0;
  }
}
