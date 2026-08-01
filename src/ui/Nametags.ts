import { PerspectiveCamera, Vector3 } from 'three';
import { Physics } from '../core/Physics';
import { clamp } from '../util/math';

/**
 * Names floating above teammates.
 *
 * DOM projected through the camera rather than sprites in the scene, for the
 * reason the HUD gives for being DOM: text stays crisp at any resolution and
 * costs no draw calls. A `Sprite` with a baked canvas texture would need
 * re-baking whenever a name changed, would go soft the moment a player walked
 * closer than the texture was authored for, and would have to be sorted against
 * transparent geometry it has no business fighting with.
 *
 * Two things make the difference between a label that reads and one that does
 * not:
 *
 *  - **Occlusion.** A nametag drawn through a wall is a wallhack. Every tag
 *    raycasts from the eye to the head it belongs to, and a tag with masonry in
 *    the way fades out. Not off — *out*, over about a fifth of a second, or a
 *    teammate crossing a doorframe strobes their own name at you.
 *  - **The anchor is the head, not the origin.** A player's transform is the
 *    point between their feet. Anchoring there and nudging up by a constant
 *    puts the label through the chest of a crouching operator; the crouch has
 *    to be read from the pose.
 */

const CSS = `
#nametags { position: fixed; inset: 0; pointer-events: none; z-index: 4; overflow: hidden;
  font-family: 'Rajdhani','DIN Alternate','Oswald',system-ui,sans-serif; }
.nametag { position: absolute; left: 0; top: 0; transform-origin: 50% 100%;
  will-change: transform, opacity; transition: opacity .18s linear; }
.nametag .inner { transform: translate(-50%, -100%); text-align: center; white-space: nowrap; }
.nametag .name { font-size: 15px; font-weight: 700; letter-spacing: .1em; color: #efe6d4;
  text-shadow: 0 0 8px rgba(0,0,0,.95), 0 2px 5px rgba(0,0,0,.9); text-transform: uppercase; }
.nametag .bar { width: 62px; height: 3px; margin: 4px auto 0; border-radius: 2px;
  background: rgba(0,0,0,.55); box-shadow: 0 0 5px rgba(0,0,0,.8); overflow: hidden; }
.nametag .bar i { display: block; height: 100%; width: 100%; background: #6fd08a;
  transition: width .2s linear, background .2s linear; }
.nametag.hurt .bar i { background: #ffcf6b; }
.nametag.critical .bar i { background: #ff6a55; }
.nametag.down .name { color: #ff6a55; }
.nametag .state { font-size: 10px; letter-spacing: .28em; color: #ff6a55; margin-top: 2px;
  text-shadow: 0 0 8px rgba(0,0,0,.95); }
`;

/** Nobody's name is drawn past this. Beyond it the body is a few pixels anyway. */
const MAX_DISTANCE = 46;
/** Below this the label is at full size; past it it shrinks toward MIN_SCALE. */
const FULL_SIZE_DISTANCE = 9;
const MIN_SCALE = 0.62;

export interface NametagState {
  id: string;
  name: string;
  /** Point between the feet, in world space. */
  position: Vector3;
  /** Height of the top of the head above `position`, so crouching reads. */
  height: number;
  health: number;
  maxHealth: number;
  downed: boolean;
}

interface Tag {
  root: HTMLElement;
  nameEl: HTMLElement;
  fill: HTMLElement;
  state: HTMLElement;
  lastName: string;
  lastHealth: number;
  /** Smoothed 0..1 visibility, so occlusion fades rather than flickers. */
  shown: number;
}

const _world = new Vector3();
const _toTag = new Vector3();
const _eye = new Vector3();

export class Nametags {
  private readonly root: HTMLDivElement;
  private readonly tags = new Map<string, Tag>();
  private readonly physics: Physics;

  constructor(container: HTMLElement, physics: Physics) {
    this.physics = physics;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.id = 'nametags';
    container.appendChild(this.root);
  }

  private tagFor(id: string): Tag {
    let tag = this.tags.get(id);
    if (tag) return tag;

    const root = document.createElement('div');
    root.className = 'nametag';
    root.innerHTML = `
      <div class="inner">
        <div class="name"></div>
        <div class="bar"><i></i></div>
        <div class="state"></div>
      </div>`;
    this.root.appendChild(root);

    tag = {
      root,
      nameEl: root.querySelector('.name') as HTMLElement,
      fill: root.querySelector('.bar i') as HTMLElement,
      state: root.querySelector('.state') as HTMLElement,
      lastName: '',
      lastHealth: -1,
      shown: 0,
    };
    this.tags.set(id, tag);
    return tag;
  }

  /**
   * Repositions every tag. Called once a frame, after the camera has been
   * written for this frame — projecting against last frame's camera is a
   * half-frame of lag that reads as the label swimming behind its owner
   * whenever the player turns.
   */
  update(
    dt: number,
    camera: PerspectiveCamera,
    eye: Vector3,
    players: readonly NametagState[],
    excludeCollider?: Parameters<Physics['raycast']>[3],
  ) {
    const width = window.innerWidth;
    const height = window.innerHeight;

    // Retire tags for players who are no longer here.
    for (const [id, tag] of this.tags) {
      if (players.some((p) => p.id === id)) continue;
      tag.root.remove();
      this.tags.delete(id);
    }

    _eye.copy(eye);

    for (const player of players) {
      const tag = this.tagFor(player.id);

      if (player.name !== tag.lastName) {
        // textContent, never innerHTML — this string arrived over the network.
        tag.nameEl.textContent = player.name;
        tag.lastName = player.name;
      }

      _world.set(player.position.x, player.position.y + player.height, player.position.z);

      _toTag.copy(_world).sub(_eye);
      const distance = _toTag.length();

      let wanted = 1;
      if (distance > MAX_DISTANCE) wanted = 0;

      // Behind the camera, or clipped by the near plane.
      _world.project(camera);
      if (_world.z > 1) wanted = 0;

      // Line of sight. The ray stops a little short of the head so a teammate
      // standing flat against a wall does not occlude themselves against it.
      if (wanted > 0 && distance > 1.2) {
        _toTag.divideScalar(distance);
        const blocked = this.physics.raycast(_eye, _toTag, distance - 0.6, excludeCollider);
        if (blocked) wanted = 0;
      }

      // Fade rather than switch. An exponential approach is frame-rate
      // independent, which matters because this runs at whatever the renderer
      // manages rather than a fixed tick.
      const rate = wanted > tag.shown ? 14 : 9;
      tag.shown += (wanted - tag.shown) * (1 - Math.exp(-rate * dt));
      if (tag.shown < 0.01) {
        if (tag.root.style.display !== 'none') tag.root.style.display = 'none';
        continue;
      }
      if (tag.root.style.display === 'none') tag.root.style.display = '';

      const x = (_world.x * 0.5 + 0.5) * width;
      const y = (-_world.y * 0.5 + 0.5) * height;
      const scale = clamp(
        1 - (distance - FULL_SIZE_DISTANCE) / (MAX_DISTANCE - FULL_SIZE_DISTANCE),
        MIN_SCALE,
        1,
      );

      tag.root.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${scale.toFixed(3)})`;
      // Distant tags dim as well as shrink, so a crowded far wall does not turn
      // into a wall of equally loud text.
      tag.root.style.opacity = (tag.shown * clamp(scale + 0.18, 0, 1)).toFixed(3);

      const fraction = clamp(player.health / Math.max(1, player.maxHealth), 0, 1);
      if (Math.abs(fraction - tag.lastHealth) > 0.01) {
        tag.fill.style.width = `${(fraction * 100).toFixed(0)}%`;
        tag.lastHealth = fraction;
      }
      tag.root.classList.toggle('hurt', fraction <= 0.6 && fraction > 0.28);
      tag.root.classList.toggle('critical', fraction <= 0.28);
      tag.root.classList.toggle('down', player.downed);
      const label = player.downed ? 'DOWN' : '';
      if (tag.state.textContent !== label) tag.state.textContent = label;
    }
  }

  clear() {
    for (const tag of this.tags.values()) tag.root.remove();
    this.tags.clear();
  }

  dispose() {
    this.clear();
    this.root.remove();
  }
}
