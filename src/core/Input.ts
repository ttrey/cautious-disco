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
    this.element.requestPointerLock();
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
    this.lookX += e.movementX * this.sensitivity;
    this.lookY += e.movementY * this.sensitivity * (this.invertY ? -1 : 1);
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
