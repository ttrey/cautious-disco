/** No legitimate single mouse event moves more than this many pixels. */
const MAX_MOVEMENT_PER_EVENT = 180;
const clampDelta = (v: number) =>
  Number.isFinite(v) ? Math.max(-MAX_MOVEMENT_PER_EVENT, Math.min(MAX_MOVEMENT_PER_EVENT, v)) : 0;

/**
 * Keyboard / mouse input with pointer lock.
 *
 * Exposes both *state* (held keys, accumulated look delta) and *edges*
 * (pressed-this-frame), because weapon and UI logic needs to distinguish
 * "trigger held" from "trigger pulled".
 */
export class Input {
  private readonly held = new Set<string>();
  private readonly pressedThisFrame = new Set<string>();
  private readonly releasedThisFrame = new Set<string>();

  /** Accumulated mouse movement since the last consume, in radians. */
  lookX = 0;
  lookY = 0;
  wheel = 0;

  mouseHeld = false;
  mousePressed = false;
  rightHeld = false;

  locked = false;
  sensitivity = 0.0022;
  invertY = false;

  private readonly element: HTMLElement;
  private onLockChange?: (locked: boolean) => void;

  constructor(element: HTMLElement) {
    this.element = element;
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    document.addEventListener('pointerlockchange', this.handleLockChange);
    document.addEventListener('mousemove', this.handleMouseMove);
    document.addEventListener('mousedown', this.handleMouseDown);
    document.addEventListener('mouseup', this.handleMouseUp);
    document.addEventListener('wheel', this.handleWheel, { passive: true });
    window.addEventListener('blur', this.handleBlur);
    document.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  onPointerLockChange(cb: (locked: boolean) => void) {
    this.onLockChange = cb;
  }

  requestLock() {
    // Pointer lock can reject (no user gesture, another element holds it, or
    // the browser is between transitions). It must never take the caller down
    // with it — the game is perfectly playable while the request retries.
    try {
      const result = this.element.requestPointerLock() as unknown as Promise<void> | undefined;
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      /* ignored — handleLockChange reports the real state */
    }
  }

  releaseLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  isDown(code: string) {
    return this.held.has(code);
  }

  wasPressed(code: string) {
    return this.pressedThisFrame.has(code);
  }

  wasReleased(code: string) {
    return this.releasedThisFrame.has(code);
  }

  /** Movement axes in local space: x = strafe, y = forward. */
  moveAxis(): [number, number] {
    let x = 0;
    let y = 0;
    if (this.isDown('KeyW') || this.isDown('ArrowUp')) y += 1;
    if (this.isDown('KeyS') || this.isDown('ArrowDown')) y -= 1;
    if (this.isDown('KeyD') || this.isDown('ArrowRight')) x += 1;
    if (this.isDown('KeyA') || this.isDown('ArrowLeft')) x -= 1;
    const len = Math.hypot(x, y);
    return len > 1 ? [x / len, y / len] : [x, y];
  }

  /** Must be called once at the end of every frame. */
  endFrame() {
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
    this.mousePressed = false;
    this.lookX = 0;
    this.lookY = 0;
    this.wheel = 0;
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    this.held.add(e.code);
    this.pressedThisFrame.add(e.code);
    // Stop the browser scrolling / quick-finding underneath the game.
    if (['Space', 'Tab', 'KeyR', 'Slash'].includes(e.code)) e.preventDefault();
  };

  private handleKeyUp = (e: KeyboardEvent) => {
    this.held.delete(e.code);
    this.releasedThisFrame.add(e.code);
  };

  private handleMouseMove = (e: MouseEvent) => {
    if (!this.locked) return;
    // Browsers routinely emit one enormous delta on the frame pointer lock
    // engages (the jump from the cursor's screen position to the lock origin).
    // Unclamped, that single event snaps the player's view to the ceiling.
    const dx = clampDelta(e.movementX);
    const dy = clampDelta(e.movementY);
    this.lookX += dx * this.sensitivity;
    this.lookY += dy * this.sensitivity * (this.invertY ? -1 : 1);
  };

  private handleMouseDown = (e: MouseEvent) => {
    if (!this.locked) return;
    if (e.button === 0) {
      this.mouseHeld = true;
      this.mousePressed = true;
    }
    if (e.button === 2) this.rightHeld = true;
  };

  private handleMouseUp = (e: MouseEvent) => {
    if (e.button === 0) this.mouseHeld = false;
    if (e.button === 2) this.rightHeld = false;
  };

  private handleWheel = (e: WheelEvent) => {
    if (!this.locked) return;
    this.wheel += Math.sign(e.deltaY);
  };

  private handleLockChange = () => {
    this.locked = document.pointerLockElement === this.element;
    // Drop any look delta banked across the transition.
    this.lookX = 0;
    this.lookY = 0;
    if (!this.locked) this.handleBlur();
    this.onLockChange?.(this.locked);
  };

  /** Losing focus mid-sprint must not leave the key latched down. */
  private handleBlur = () => {
    this.held.clear();
    this.mouseHeld = false;
    this.rightHeld = false;
  };
}
