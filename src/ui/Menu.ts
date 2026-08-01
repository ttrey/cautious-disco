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
#menu { position: fixed; inset: 0; z-index: 30; display: none; place-items: center;
  background:
    radial-gradient(ellipse at 50% 0%, rgba(179,35,31,.16), transparent 62%),
    linear-gradient(180deg, #07080d 0%, #04050a 100%);
  font-family: 'Rajdhani','DIN Alternate','Oswald',system-ui,sans-serif;
  color: #efe6d4; user-select: none; overflow-y: auto; padding: 24px 0; }
#menu.show { display: grid; }

/* A slow drift of grain over the panel, so a static menu does not read as a
   frozen frame while the level loads behind it. */
#menu::after { content: ''; position: absolute; inset: 0; pointer-events: none; opacity: .05;
  background-image: repeating-linear-gradient(0deg, #fff 0 1px, transparent 1px 3px);
  animation: menuScan 9s linear infinite; }
@keyframes menuScan { from { transform: translateY(0); } to { transform: translateY(3px); } }

#menu .screen { position: relative; z-index: 1; width: min(92vw, 560px); text-align: center;
  padding: 8px 24px; display: none; }
#menu .screen.active { display: block; animation: menuIn .28s ease-out; }
@keyframes menuIn { from { opacity: 0; transform: translateY(9px); } to { opacity: 1; transform: none; } }

#menu .title { font-size: clamp(44px, 9vw, 76px); font-weight: 700; letter-spacing: .17em;
  color: #b3231f; line-height: 1;
  text-shadow: 0 0 46px rgba(179,35,31,.5), 0 4px 14px rgba(0,0,0,.9); }
#menu .subtitle { font-size: 13px; letter-spacing: .42em; opacity: .45; margin-top: 12px;
  text-transform: uppercase; }
#menu h2 { font-size: 26px; letter-spacing: .2em; font-weight: 700; text-transform: uppercase;
  margin-bottom: 6px; }
#menu .hint { font-size: 13.5px; letter-spacing: .04em; opacity: .55; line-height: 1.7;
  margin-bottom: 22px; }

#menu .stack { display: grid; gap: 12px; margin-top: 34px; }
#menu .quality { margin: 24px auto 0; width: min(100%, 280px); text-align: left; }
#menu .quality label { margin-bottom: 7px; }
#menu .quality select { width: 100%; font: inherit; color: #efe6d4; background: #11131a;
  border: 1px solid rgba(255,255,255,.2); border-radius: 3px; padding: 10px 12px;
  letter-spacing: .12em; text-transform: uppercase; }

#menu button { font: inherit; font-size: 17px; letter-spacing: .2em; text-transform: uppercase;
  font-weight: 700; padding: 17px 28px; color: #efe6d4; cursor: pointer; width: 100%;
  background: rgba(255,255,255,.045); border: 2px solid rgba(255,255,255,.17); border-radius: 3px;
  transition: background .18s, border-color .18s, color .18s, transform .06s; }
#menu button:hover:not(:disabled) { background: rgba(255,255,255,.1); border-color: rgba(255,255,255,.4); }
#menu button:active:not(:disabled) { transform: translateY(1px); }
#menu button:disabled { opacity: .34; cursor: not-allowed; }
#menu button.primary { background: rgba(179,35,31,.24); border-color: #b3231f; color: #ffd9b8; }
#menu button.primary:hover:not(:disabled) { background: rgba(179,35,31,.52); }
#menu button.ghost { font-size: 13px; letter-spacing: .24em; padding: 11px 20px; font-weight: 400;
  border-color: transparent; opacity: .6; }
#menu button.ghost:hover { opacity: 1; border-color: rgba(255,255,255,.2); }
#menu .row { display: flex; gap: 10px; }
#menu .row button { width: auto; flex: 1; }

#menu label { display: block; font-size: 11px; letter-spacing: .3em; opacity: .5;
  text-transform: uppercase; margin-bottom: 9px; text-align: left; }
#menu input { font: inherit; width: 100%; font-size: 21px; letter-spacing: .1em; padding: 15px 17px;
  color: #efe6d4; background: rgba(0,0,0,.5); border: 2px solid rgba(255,255,255,.2);
  border-radius: 3px; outline: none; transition: border-color .18s; }
#menu input:focus { border-color: #ffb347; }
#menu input::placeholder { color: rgba(239,230,212,.24); letter-spacing: .06em; }
#menu input.code { text-transform: uppercase; letter-spacing: .5em; text-align: center;
  font-size: 30px; font-weight: 700; font-family: 'DIN Alternate', ui-monospace, monospace; }
#menu .field { margin-bottom: 18px; }
#menu .error { color: #ff6a55; font-size: 13.5px; letter-spacing: .06em; min-height: 20px;
  margin-top: 12px; }

/* --- Lobby ------------------------------------------------------------- */

#menu .codebox { margin: 4px 0 20px; }
#menu .code-digits { display: flex; gap: 8px; justify-content: center; margin-bottom: 12px; }
#menu .code-digits span { width: 46px; height: 60px; display: grid; place-items: center;
  font-size: 32px; font-weight: 700; letter-spacing: 0; color: #ffcf6b;
  font-family: 'DIN Alternate', ui-monospace, monospace;
  background: rgba(255,207,107,.07); border: 2px solid rgba(255,207,107,.34); border-radius: 4px;
  text-shadow: 0 0 18px rgba(255,207,107,.45); }

#menu .linkrow { display: flex; gap: 8px; align-items: stretch; }
#menu .linkrow input { font-size: 13px; letter-spacing: .01em; padding: 12px 14px; opacity: .82;
  font-family: ui-monospace, monospace; }
#menu .linkrow button { width: auto; flex: 0 0 auto; font-size: 12px; letter-spacing: .16em;
  padding: 12px 18px; }

#menu .roster { display: grid; gap: 8px; margin: 22px 0 6px; text-align: left; }
#menu .slot { display: flex; align-items: center; gap: 13px; padding: 12px 15px;
  border: 2px solid rgba(255,255,255,.1); border-radius: 3px; background: rgba(255,255,255,.03); }
#menu .slot.empty { border-style: dashed; opacity: .4; }
#menu .slot .pip { width: 11px; height: 11px; border-radius: 50%; background: #4ad07a;
  box-shadow: 0 0 11px #4ad07a; flex: 0 0 auto; }
#menu .slot.empty .pip { background: rgba(255,255,255,.22); box-shadow: none; }
#menu .slot .who { font-size: 17px; letter-spacing: .05em; flex: 1; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
#menu .slot .op { font-size: 11px; letter-spacing: .22em; opacity: .45; text-transform: uppercase; }
#menu .slot .badge { font-size: 10px; letter-spacing: .18em; padding: 4px 9px; border-radius: 2px;
  background: rgba(255,207,107,.16); color: #ffcf6b; border: 1px solid rgba(255,207,107,.42); }
#menu .slot .badge.you { background: rgba(255,255,255,.1); color: #efe6d4;
  border-color: rgba(255,255,255,.3); }

#menu .status { font-size: 12.5px; letter-spacing: .2em; opacity: .5; text-transform: uppercase;
  margin-top: 16px; min-height: 18px; }
#menu .status .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%;
  background: #4ad07a; margin-right: 8px; vertical-align: middle;
  animation: pulse 1.8s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .25; } }

#menu .keys { display: grid; grid-template-columns: auto auto; gap: 7px 20px; justify-content: center;
  margin: 24px 0 8px; font-size: 14px; text-align: left; }
#menu .keys b { color: #ffcf6b; font-weight: 700; text-align: right; }
#menu .keys span { opacity: .7; }

@media (max-width: 560px) {
  #menu .screen { padding: 8px 16px; }
  #menu .title { letter-spacing: .1em; }
  #menu button { font-size: 14px; padding: 14px 18px; letter-spacing: .14em; }
  #menu .code-digits span { width: 38px; height: 50px; font-size: 25px; }
  #menu input { font-size: 17px; }
  #menu input.code { font-size: 23px; letter-spacing: .34em; }
  #menu .keys { font-size: 12px; gap: 5px 12px; }
  #menu .linkrow { flex-direction: column; }
  #menu .linkrow button { width: 100%; }
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
        <div class="title">NECROPOLIS</div>
        <div class="subtitle">Ashgate Terminal</div>
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
    }
    this.root.classList.add('show');
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
