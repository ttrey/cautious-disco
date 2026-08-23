import type { RosterEntry } from '../net/Protocol';
import type { QualityPreference } from '../core/Quality';

/**
 * Front end: the main menu, the lobby flow, and the drop-in screen.
 *
 * A separate overlay from `HUD`, not a screen inside it. The HUD's overlay is
 * the in-game one — pause and game over — and it has to stay usable while a
 * round is running behind it. This one owns everything that happens before a
 * player is in the world, which is a different lifetime and a different set of
 * inputs (text fields, a clipboard, a code that has to be readable across the
 * room).
 *
 * Screen order follows what the player asked for literally: pick a mode, pick
 * create or join, *then* enter a callsign before anything touches the network,
 * then sit in a lobby with a code and a link until the host decides to start.
 */

const CSS = `
#menu { --ink: #101820; --surface: rgba(18,27,35,.96); --surface-raised: #1a2630;
  --line: rgba(224,232,228,.18); --muted: rgba(224,232,228,.66); --cream: #edf1e9;
  --amber: #ffc568; --red: #d64a38; position: fixed; inset: 0; z-index: 30;
  display: none; place-items: center; background:
  radial-gradient(ellipse at 50% 0%, rgba(214,74,56,.22), transparent 58%),
  linear-gradient(135deg, #1a2730 0%, #0d141b 55%, #101820 100%);
  font-family: 'Arial Narrow','Avenir Next Condensed','Rajdhani',system-ui,sans-serif;
  color: var(--cream); user-select: none; overflow-y: auto; padding: 24px 0; }
#menu.show { display: grid; }
#menu::before { content: ''; position: absolute; inset: 0; opacity: .28; pointer-events: none;
  background: linear-gradient(90deg, transparent 0 18%, rgba(255,255,255,.035) 18.1% 18.2%, transparent 18.3% 81.7%, rgba(255,255,255,.025) 81.8% 81.9%, transparent 82%),
    repeating-linear-gradient(0deg, rgba(255,255,255,.025) 0 1px, transparent 1px 5px); }
#menu::after { content: ''; position: absolute; left: 6vw; right: 6vw; top: 50%; height: 1px;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,.14), transparent); opacity: .5;
  pointer-events: none; }

#menu .screen { position: relative; z-index: 1; width: min(92vw, 560px); text-align: center;
  padding: 38px 48px 34px; display: none; background: var(--surface);
  border: 1px solid var(--line); border-top: 3px solid var(--red);
  box-shadow: 0 24px 70px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.025) inset; }
#menu .screen.active { display: block; animation: menuIn .24s ease-out; }
@keyframes menuIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

#menu .menu-line { display: flex; align-items: center; gap: 10px; margin-bottom: 32px; color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; letter-spacing: .16em;
  text-transform: uppercase; text-align: left; }
#menu .menu-line::before { content: ''; width: 8px; height: 8px; background: var(--red);
  box-shadow: 0 0 12px rgba(214,74,56,.75); transform: rotate(45deg); flex: 0 0 auto; }
#menu .menu-line .right { margin-left: auto; color: rgba(255,197,104,.8); }
#menu .title { font-size: clamp(44px, 9vw, 76px); font-weight: 800; letter-spacing: .13em;
  color: var(--red); line-height: .94; text-shadow: 0 0 34px rgba(214,74,56,.42); }
#menu .subtitle { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
  letter-spacing: .34em; color: var(--amber); margin-top: 15px; text-transform: uppercase; }
#menu .title-rule { height: 1px; margin: 24px 0 22px; background: linear-gradient(90deg, transparent, var(--line), transparent); }
#menu .screen:not([data-screen="main"])::before { content: 'ASHGATE TERMINAL / SECURE ACCESS'; display: block;
  margin-bottom: 25px; color: var(--amber); font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px; letter-spacing: .16em; text-align: left; opacity: .82; }
#menu h2 { font-size: 27px; letter-spacing: .14em; font-weight: 800; text-transform: uppercase; margin-bottom: 9px; }
#menu .hint { max-width: 410px; margin: 0 auto 22px; font-size: 14px; letter-spacing: .035em;
  color: var(--muted); line-height: 1.65; }

#menu .stack { display: grid; gap: 10px; margin-top: 28px; }
#menu .quality { margin: 25px auto 0; width: min(100%, 300px); text-align: left; }
#menu .quality label { margin-bottom: 7px; }
#menu .quality select { width: 100%; font: inherit; color: var(--cream); background: var(--surface-raised);
  border: 1px solid var(--line); border-radius: 2px; padding: 11px 12px; letter-spacing: .1em;
  text-transform: uppercase; outline: none; }
#menu .quality select:focus { border-color: var(--amber); box-shadow: 0 0 0 2px rgba(255,197,104,.16); }

#menu button { font: inherit; font-size: 17px; letter-spacing: .16em; text-transform: uppercase;
  font-weight: 800; min-height: 54px; padding: 14px 24px; color: var(--cream); cursor: pointer; width: 100%;
  background: rgba(226,236,230,.045); border: 1px solid rgba(226,236,230,.28); border-radius: 2px;
  transition: background .18s, border-color .18s, color .18s, transform .06s, box-shadow .18s; }
#menu button:hover:not(:disabled), #menu button:focus-visible { background: rgba(226,236,230,.12);
  border-color: rgba(226,236,230,.75); box-shadow: 0 0 0 2px rgba(255,197,104,.13); outline: none; }
#menu button:active:not(:disabled) { transform: translateY(1px); }
#menu button:disabled { opacity: .55; cursor: wait; }
#menu button.busy { color: var(--amber); border-color: rgba(255,197,104,.65); }
#menu button.busy::after { content: '  ·'; animation: busyDots 1s steps(3,end) infinite; }
@keyframes busyDots { 0% { content: '  ·'; } 33% { content: '  ··'; } 66%,100% { content: '  ···'; } }
#menu button.primary { background: var(--red); border-color: #ee6955; color: #fff5e9; box-shadow: 0 8px 24px rgba(214,74,56,.2); }
#menu button.primary:hover:not(:disabled), #menu button.primary:focus-visible { background: #eb5d49; border-color: #ffd0ae; }
#menu button.ghost { min-height: 38px; font-size: 12px; letter-spacing: .22em; padding: 9px 18px; font-weight: 700;
  border-color: transparent; color: var(--muted); background: transparent; box-shadow: none; }
#menu button.ghost:hover, #menu button.ghost:focus-visible { color: var(--cream); border-color: var(--line); background: rgba(226,236,230,.06); }
#menu .row { display: flex; gap: 10px; }
#menu .row button { width: auto; flex: 1; }

#menu label { display: block; font-size: 10px; letter-spacing: .24em; color: var(--muted);
  text-transform: uppercase; margin-bottom: 8px; text-align: left; }
#menu input { font: inherit; width: 100%; font-size: 21px; letter-spacing: .1em; padding: 14px 16px;
  color: var(--cream); background: #0e161d; border: 1px solid rgba(226,236,230,.34); border-radius: 2px;
  outline: none; transition: border-color .18s, box-shadow .18s; }
#menu input:focus { border-color: var(--amber); box-shadow: 0 0 0 2px rgba(255,197,104,.15); }
#menu input::placeholder { color: rgba(237,241,233,.38); letter-spacing: .06em; }
#menu input.code { text-transform: uppercase; letter-spacing: .44em; text-align: center; font-size: 30px;
  font-weight: 800; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
#menu .field { margin-bottom: 18px; }
#menu .error { color: #ff8b72; font-size: 13px; letter-spacing: .035em; min-height: 20px; margin-top: 12px; }

/* --- Lobby ------------------------------------------------------------- */
#menu .codebox { margin: 4px 0 20px; }
#menu .code-digits { display: flex; gap: 7px; justify-content: center; margin-bottom: 13px; }
#menu .code-digits span { width: 46px; height: 60px; display: grid; place-items: center; font-size: 32px;
  font-weight: 800; color: var(--amber); font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: rgba(255,197,104,.08); border: 1px solid rgba(255,197,104,.55); border-radius: 2px;
  text-shadow: 0 0 18px rgba(255,197,104,.42); }
#menu .linkrow { display: flex; gap: 8px; align-items: stretch; }
#menu .linkrow input { font-size: 12px; letter-spacing: .01em; padding: 11px 12px; color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
#menu .linkrow button { width: auto; flex: 0 0 auto; min-height: 0; font-size: 11px; letter-spacing: .13em; padding: 11px 16px; }
#menu .roster { display: grid; gap: 6px; margin: 22px 0 6px; text-align: left; }
#menu .slot { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--line);
  background: rgba(226,236,230,.035); }
#menu .slot.empty { opacity: .5; background: transparent; }
#menu .slot .pip { width: 8px; height: 8px; border-radius: 50%; background: #72df9b;
  box-shadow: 0 0 11px #72df9b; flex: 0 0 auto; }
#menu .slot.empty .pip { background: rgba(226,236,230,.35); box-shadow: none; }
#menu .slot .who { font-size: 17px; letter-spacing: .05em; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#menu .slot .op { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; letter-spacing: .14em; color: var(--muted); text-transform: uppercase; }
#menu .slot .badge { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9px; letter-spacing: .12em;
  padding: 4px 7px; color: var(--amber); border: 1px solid rgba(255,197,104,.45); }
#menu .slot .badge.you { color: var(--cream); border-color: rgba(226,236,230,.35); }
#menu .status { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; letter-spacing: .08em;
  color: var(--muted); margin-top: 16px; min-height: 18px; }
#menu .status .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #72df9b;
  margin-right: 8px; vertical-align: middle; animation: pulse 1.8s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .25; } }

#menu .keys { display: grid; grid-template-columns: auto minmax(0, auto); gap: 8px 18px; justify-content: center;
  margin: 24px 0 8px; font-size: 14px; text-align: left; }
#menu .keys b { color: var(--amber); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
  font-weight: 800; letter-spacing: .05em; text-align: right; }
#menu .keys span { color: var(--muted); }

@media (max-width: 560px) {
  #menu { align-items: start; padding: 12px 0; }
  #menu .screen { width: min(94vw, 420px); padding: 25px 20px 22px; }
  #menu .menu-line { margin-bottom: 24px; font-size: 8px; letter-spacing: .1em; }
  #menu .menu-line .right { display: none; }
  #menu .title { font-size: clamp(40px, 12vw, 58px); letter-spacing: .08em; }
  #menu .subtitle { font-size: 9px; letter-spacing: .22em; }
  #menu .screen:not([data-screen="main"])::before { font-size: 8px; margin-bottom: 19px; }
  #menu h2 { font-size: 22px; }
  #menu .hint { font-size: 13px; line-height: 1.55; }
  #menu button { min-height: 50px; font-size: 14px; padding: 13px 16px; letter-spacing: .12em; }
  #menu .code-digits { gap: 5px; }
  #menu .code-digits span { width: clamp(35px, 10vw, 42px); height: 48px; font-size: 24px; }
  #menu input { font-size: 17px; }
  #menu input.code { font-size: 22px; letter-spacing: .3em; }
  #menu .keys { font-size: 12px; gap: 6px 11px; }
  #menu .keys b { font-size: 9px; }
  #menu .linkrow { flex-direction: column; }
  #menu .linkrow button { width: 100%; }
  #menu .slot .op { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  #menu .screen.active, #menu button.busy::after, #menu .status .dot { animation: none; }
}
`;

export type MenuScreen = 'main' | 'mode' | 'name' | 'code' | 'lobby' | 'dropin';

export interface MenuHandlers {
  onSinglePlayer: () => void;
  /** Callsign chosen and a lobby requested. */
  onCreateLobby: (name: string) => void | Promise<void>;
  onJoinLobby: (name: string, code: string) => void | Promise<void>;
  onStartGame: () => void;
  /** Player clicked into the world; the click is the pointer-lock gesture. */
  onDropIn: () => void;
  onLeaveLobby: () => void;
}

/** Whether the callsign prompt is on its way to creating or to joining. */
type Intent = 'create' | 'join';

export class Menu {
  private readonly root: HTMLDivElement;
  private readonly screens = new Map<MenuScreen, HTMLElement>();
  private readonly handlers: MenuHandlers;

  private intent: Intent = 'create';
  /** Code carried in from an invite link, so a guest never types one. */
  private presetCode = '';
  private currentName = '';
  private quality: QualityPreference = 'auto';
  private busy = false;

  constructor(container: HTMLElement, handlers: MenuHandlers) {
    this.handlers = handlers;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.id = 'menu';
    this.root.innerHTML = this.markup();
    container.appendChild(this.root);

    for (const el of Array.from(this.root.querySelectorAll<HTMLElement>('.screen'))) {
      this.screens.set(el.dataset.screen as MenuScreen, el);
    }

    this.wire();
    this.restoreName();
  }

  private markup(): string {
    return `
      <div class="screen active" data-screen="main">
        <div class="menu-line"><span>ASHGATE TERMINAL / SECTOR 09</span><span class="right">LOCAL BUILD</span></div>
        <div class="title">NECROPOLIS</div>
        <div class="subtitle">Ashgate Terminal</div>
        <div class="title-rule"></div>
        <div class="stack">
          <button class="primary" id="btnSingle">Single Player</button>
          <button id="btnMulti">Multi Player</button>
        </div>
        <div class="quality">
          <label for="qualitySelect">Graphics quality</label>
          <select id="qualitySelect">
            <option value="auto">Auto</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
        <div class="error" id="mainError"></div>
      </div>

      <div class="screen" data-screen="mode">
        <h2>Multiplayer</h2>
        <div class="hint">Up to four operators. One machine hosts; everybody else
          joins with a code or an invite link.</div>
        <div class="stack">
          <button class="primary" id="btnCreate">Create Lobby</button>
          <button id="btnJoin">Join Lobby</button>
          <button class="ghost" data-back="main">Back</button>
        </div>
      </div>

      <div class="screen" data-screen="name">
        <h2 id="nameTitle">Your Callsign</h2>
        <div class="hint" id="nameHint">This is the name your squad sees above your head.</div>
        <div class="field">
          <label for="nameInput">Callsign</label>
          <input id="nameInput" maxlength="16" autocomplete="off" spellcheck="false"
                 placeholder="e.g. Trey" />
        </div>
        <div class="stack">
          <button class="primary" id="btnName">Continue</button>
          <button class="ghost" data-back="mode">Back</button>
        </div>
        <div class="error" id="nameError"></div>
      </div>

      <div class="screen" data-screen="code">
        <h2>Lobby Code</h2>
        <div class="hint">Six characters, from whoever created the lobby.</div>
        <div class="field">
          <label for="codeInput">Code</label>
          <input id="codeInput" class="code" maxlength="6" autocomplete="off"
                 spellcheck="false" placeholder="——————" />
        </div>
        <div class="stack">
          <button class="primary" id="btnCode">Join</button>
          <button class="ghost" data-back="mode">Back</button>
        </div>
        <div class="error" id="codeError"></div>
      </div>

      <div class="screen" data-screen="lobby">
        <h2>Lobby</h2>
        <div class="hint">Share the code or the link. Start when everyone is in.</div>
        <div class="codebox">
          <div class="code-digits" id="codeDigits"></div>
          <div class="linkrow">
            <input id="inviteLink" readonly />
            <button id="btnCopyLink">Copy Link</button>
          </div>
        </div>
        <div class="roster" id="roster"></div>
        <div class="status" id="lobbyStatus"></div>
        <div class="stack">
          <button class="primary" id="btnStart">Start Game</button>
          <button class="ghost" id="btnLeave">Leave Lobby</button>
        </div>
        <div class="error" id="lobbyError"></div>
      </div>

      <div class="screen" data-screen="dropin">
        <h2>Deploying</h2>
        <div class="hint">The host has started the round.</div>
        <div class="keys">
          <b>WASD</b><span>Move</span>
          <b>Shift</b><span>Sprint</span>
          <b>Ctrl</b><span>Crouch</span>
          <b>Space</b><span>Jump</span>
          <b>Mouse</b><span>Aim &middot; Left fire &middot; Right ADS</span>
          <b>R</b><span>Reload</span>
          <b>1 / 2 / Q</b><span>Switch weapon</span>
          <b>E</b><span>Buy &middot; hold to repair barriers</span>
        </div>
        <div class="stack">
          <button class="primary" id="btnDrop">Drop In</button>
        </div>
      </div>
    `;
  }

  private q<T extends HTMLElement>(selector: string): T {
    return this.root.querySelector(selector) as T;
  }

  private wire() {
    const nameInput = this.q<HTMLInputElement>('#nameInput');
    const codeInput = this.q<HTMLInputElement>('#codeInput');
    const qualitySelect = this.q<HTMLSelectElement>('#qualitySelect');

    this.q('#btnSingle').onclick = () => {
      this.hide();
      this.handlers.onSinglePlayer();
    };
    this.q('#btnMulti').onclick = () => this.show('mode');

    for (const button of Array.from(this.root.querySelectorAll<HTMLElement>('[data-back]'))) {
      button.onclick = () => this.show(button.dataset.back as MenuScreen);
    }

    // Create and Join both land on the callsign prompt first. Neither touches
    // the network until a name exists, so a player is never half-joined under
    // a placeholder that then has to be renamed in front of everybody.
    this.q('#btnCreate').onclick = () => this.askName('create');
    this.q('#btnJoin').onclick = () => this.askName('join');

    this.q('#btnName').onclick = () => this.submitName();
    nameInput.onkeydown = (e) => {
      if (e.key === 'Enter') this.submitName();
    };

    this.q('#btnCode').onclick = () => this.submitCode();
    codeInput.oninput = () => {
      // Codes get pasted out of chat messages with the invite URL around them,
      // so anything that is not a code character is dropped as it is typed.
      const url = codeInput.value.match(/[?&]lobby=([A-Za-z0-9]+)/);
      const raw = url ? url[1] : codeInput.value;
      codeInput.value = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      this.q('#codeError').textContent = '';
    };
    codeInput.onkeydown = (e) => {
      if (e.key === 'Enter') this.submitCode();
    };

    this.q('#btnStart').onclick = () => {
      this.setBusy(true, '#btnStart');
      this.handlers.onStartGame();
    };
    this.q('#btnDrop').onclick = () => {
      this.hide();
      this.handlers.onDropIn();
    };
    this.q('#btnLeave').onclick = () => {
      this.handlers.onLeaveLobby();
      this.show('main');
    };
    this.q('#btnCopyLink').onclick = () => this.copyInvite();
    qualitySelect.onchange = () => {
      const value = qualitySelect.value as QualityPreference;
      this.quality = value;
      try {
        localStorage.setItem('necropolis.quality', value);
      } catch {
        /* see restoreName */
      }
    };
  }

  /** Remembers the callsign between sessions — nobody wants to retype it. */
  private restoreName() {
    try {
      const saved = localStorage.getItem('necropolis.callsign');
      if (saved) {
        this.currentName = saved;
        this.q<HTMLInputElement>('#nameInput').value = saved;
      }
      const quality = localStorage.getItem('necropolis.quality');
      if (quality === 'auto' || quality === 'low' || quality === 'medium' || quality === 'high') {
        this.quality = quality;
        this.q<HTMLSelectElement>('#qualitySelect').value = quality;
      }
    } catch {
      // Private browsing denies storage; a forgotten name is not worth failing over.
    }
  }

  private rememberName(name: string) {
    try {
      localStorage.setItem('necropolis.callsign', name);
    } catch {
      /* see restoreName */
    }
  }

  private askName(intent: Intent) {
    this.intent = intent;
    const joiningKnownLobby = intent === 'join' && this.presetCode !== '';
    this.q('#nameHint').textContent = joiningKnownLobby
      ? `Joining lobby ${this.presetCode}. This is the name your squad sees above your head.`
      : 'This is the name your squad sees above your head.';
    this.q('#nameError').textContent = '';
    this.show('name');
  }

  private submitName() {
    if (this.busy) return;
    const input = this.q<HTMLInputElement>('#nameInput');
    const name = input.value.trim().slice(0, 16);
    if (name.length < 2) {
      this.q('#nameError').textContent = 'Pick a callsign of at least two characters.';
      input.focus();
      return;
    }
    this.currentName = name;
    this.rememberName(name);

    if (this.intent === 'create') {
      this.setBusy(true, '#btnName');
      void this.handlers.onCreateLobby(name);
      return;
    }
    // An invite link already carries the code, so a guest skips straight past
    // the code screen — the link is supposed to save exactly that step.
    if (this.presetCode) {
      this.setBusy(true, '#btnName');
      void this.handlers.onJoinLobby(name, this.presetCode);
      return;
    }
    this.show('code');
  }

  private submitCode() {
    if (this.busy) return;
    const input = this.q<HTMLInputElement>('#codeInput');
    const code = input.value.trim().toUpperCase();
    if (code.length !== 6) {
      this.q('#codeError').textContent = 'A lobby code is six characters.';
      input.focus();
      return;
    }
    this.setBusy(true, '#btnCode');
    void this.handlers.onJoinLobby(this.currentName, code);
  }

  private async copyInvite() {
    const input = this.q<HTMLInputElement>('#inviteLink');
    const button = this.q<HTMLButtonElement>('#btnCopyLink');
    const restore = () => {
      button.textContent = 'Copy Link';
    };
    try {
      // `navigator.clipboard` needs a secure context, which plain http on a LAN
      // address is not. The selection fallback is not a nicety here — it is the
      // path most LAN hosts will actually take.
      await navigator.clipboard.writeText(input.value);
      button.textContent = 'Copied';
    } catch {
      input.select();
      const ok = document.execCommand?.('copy');
      button.textContent = ok ? 'Copied' : 'Press ⌘C';
    }
    setTimeout(restore, 1800);
  }

  private setBusy(busy: boolean, selector?: string) {
    this.busy = busy;
    if (!selector) return;
    const button = this.q<HTMLButtonElement>(selector);
    button.disabled = busy;
    button.classList.toggle('busy', busy);
    button.setAttribute('aria-busy', String(busy));
    if (busy) {
      button.dataset.label = button.textContent ?? '';
      button.textContent = 'Working…';
    } else if (button.dataset.label) {
      button.textContent = button.dataset.label;
    }
  }

  /* --- Public API ------------------------------------------------------- */

  show(screen: MenuScreen) {
    this.setBusy(false);
    for (const button of Array.from(this.root.querySelectorAll<HTMLButtonElement>('button'))) {
      if (button.disabled && button.dataset.label) {
        button.disabled = false;
        button.textContent = button.dataset.label;
      }
      button.classList.remove('busy');
      button.removeAttribute('aria-busy');
    }
    this.root.classList.add('show');
    this.root.dataset.screen = screen;
    for (const [name, el] of this.screens) el.classList.toggle('active', name === screen);

    // Focusing the field the player is about to type into saves a click on
    // every single pass through this flow.
    if (screen === 'name') setTimeout(() => this.q<HTMLInputElement>('#nameInput').focus(), 40);
    if (screen === 'code') setTimeout(() => this.q<HTMLInputElement>('#codeInput').focus(), 40);
  }

  hide() {
    this.root.classList.remove('show');
  }

  get visible() {
    return this.root.classList.contains('show');
  }

  get qualityPreference(): QualityPreference {
    return this.quality;
  }

  /** Pre-loads a code from `?lobby=`, so an invite link goes straight to a name. */
  applyInviteCode(code: string) {
    this.presetCode = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    this.q<HTMLInputElement>('#codeInput').value = this.presetCode;
    if (this.presetCode.length === 6) this.askName('join');
  }

  showError(message: string) {
    this.setBusy(false);
    const active = [...this.screens.entries()].find(([, el]) => el.classList.contains('active'));
    const field = active?.[1].querySelector('.error');
    if (field) field.textContent = message;
    for (const button of Array.from(this.root.querySelectorAll<HTMLButtonElement>('button'))) {
      if (button.disabled && button.dataset.label) {
        button.disabled = false;
        button.textContent = button.dataset.label;
      }
      button.classList.remove('busy');
      button.removeAttribute('aria-busy');
    }
  }

  /** Called once the server has confirmed the lobby; switches to the waiting room. */
  showLobby(code: string, inviteLink: string) {
    const digits = this.q('#codeDigits');
    digits.innerHTML = '';
    for (const character of code) {
      const cell = document.createElement('span');
      cell.textContent = character;
      digits.appendChild(cell);
    }
    this.q<HTMLInputElement>('#inviteLink').value = inviteLink;
    this.show('lobby');
  }

  /**
   * Redraws the roster. Called on every membership or score change, so it is
   * written to be cheap and idempotent rather than incremental.
   */
  setRoster(roster: RosterEntry[], selfId: string, isHost: boolean, maxPlayers: number, latency: number) {
    const list = this.q('#roster');
    list.innerHTML = '';

    for (let i = 0; i < maxPlayers; i++) {
      const entry = roster[i];
      const slot = document.createElement('div');
      slot.className = entry ? 'slot' : 'slot empty';

      const pip = document.createElement('div');
      pip.className = 'pip';
      slot.appendChild(pip);

      const who = document.createElement('div');
      who.className = 'who';
      // textContent, never innerHTML: the name came off the network.
      who.textContent = entry ? entry.name : 'Open slot';
      slot.appendChild(who);

      if (entry) {
        const op = document.createElement('div');
        op.className = 'op';
        op.textContent = entry.operator;
        slot.appendChild(op);
      }
      if (entry?.host) {
        const badge = document.createElement('div');
        badge.className = 'badge';
        badge.textContent = 'Host';
        slot.appendChild(badge);
      }
      if (entry && entry.id === selfId) {
        const badge = document.createElement('div');
        badge.className = 'badge you';
        badge.textContent = 'You';
        slot.appendChild(badge);
      }
      list.appendChild(slot);
    }

    const start = this.q<HTMLButtonElement>('#btnStart');
    start.style.display = isHost ? '' : 'none';
    start.disabled = false;
    start.textContent = 'Start Game';

    const status = this.q('#lobbyStatus');
    const ping = latency > 0 ? ` · ${Math.round(latency)} ms` : '';
    status.innerHTML = '<span class="dot"></span>';
    status.append(
      isHost
        ? `${roster.length} of ${maxPlayers} in the lobby — start when ready${ping}`
        : `Waiting for the host to start${ping}`,
    );
  }

  /** Non-hosts get a click target so pointer lock and audio have a gesture. */
  showDropIn() {
    this.show('dropin');
  }
}
