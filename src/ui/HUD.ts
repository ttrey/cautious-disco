import { PERKS } from '../map/Props';
import { clamp } from '../util/math';

/**
 * HUD.
 *
 * Built from DOM rather than rendered into the scene: crisp text at any
 * resolution, free layout, and zero draw calls competing with the game. All
 * styling is injected once so the whole interface lives in one file.
 */

const CSS = `
#hud { position: fixed; inset: 0; pointer-events: none; z-index: 5;
  font-family: 'Rajdhani','DIN Alternate','Oswald',system-ui,sans-serif;
  color: #efe6d4; text-shadow: 0 2px 6px rgba(0,0,0,.85); user-select: none; }

#crosshair { position: absolute; left: 50%; top: 50%; width: 46px; height: 46px;
  transform: translate(-50%,-50%); }
#crosshair i { position: absolute; background: rgba(240,236,224,.92); display: block;
  box-shadow: 0 0 3px rgba(0,0,0,.9); transition: opacity .12s; }
#crosshair .h { width: 8px; height: 2px; top: 22px; }
#crosshair .v { width: 2px; height: 8px; left: 22px; }
#crosshair .dot { width: 2px; height: 2px; left: 22px; top: 22px; border-radius: 50%; opacity: .8; }

#hitmarker { position: absolute; left: 50%; top: 50%; width: 30px; height: 30px;
  transform: translate(-50%,-50%) rotate(45deg); opacity: 0; }
#hitmarker i { position: absolute; background: #fff; }
#hitmarker .a { width: 12px; height: 2px; top: 14px; left: 0; }
#hitmarker .b { width: 12px; height: 2px; top: 14px; right: 0; }
#hitmarker .c { width: 2px; height: 12px; left: 14px; top: 0; }
#hitmarker .d { width: 2px; height: 12px; left: 14px; bottom: 0; }
#hitmarker.kill i { background: #ff5a4a; }

.corner { position: absolute; padding: 20px 26px; }
#points { left: 0; bottom: 0; }
#points .value { font-size: 46px; font-weight: 700; letter-spacing: .02em; color: #ffcf6b;
  line-height: 1; font-variant-numeric: tabular-nums; }
#points .label { font-size: 13px; letter-spacing: .34em; opacity: .55; text-transform: uppercase; }
#points .delta { position: absolute; left: 26px; bottom: 74px; font-size: 22px; font-weight: 700;
  color: #ffe9a8; opacity: 0; transform: translateY(0); }

#ammo { right: 0; bottom: 0; text-align: right; }
#ammo .mag { font-size: 46px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
#ammo .mag.low { color: #ff6a55; }
#ammo .reserve { font-size: 24px; opacity: .6; font-variant-numeric: tabular-nums; }
#ammo .name { font-size: 14px; letter-spacing: .22em; opacity: .68; text-transform: uppercase;
  margin-top: 4px; }
#ammo .name.packed { color: #c79bff; }
#ammo .reloading { font-size: 14px; letter-spacing: .3em; color: #ffcf6b; opacity: 0; }

#round { right: 0; top: 0; text-align: right; }
#round .label { font-size: 12px; letter-spacing: .38em; opacity: .5; text-transform: uppercase; }
#round .value { font-size: 40px; font-weight: 700; color: #b3231f; line-height: 1;
  text-shadow: 0 0 22px rgba(179,35,31,.55), 0 2px 6px rgba(0,0,0,.9); }
#round .left { font-size: 13px; opacity: .55; letter-spacing: .1em; }

#perks { left: 0; top: 0; display: flex; gap: 10px; padding: 20px 26px; }
.perk { width: 42px; height: 42px; border-radius: 50%; display: grid; place-items: center;
  font-size: 11px; font-weight: 700; letter-spacing: .04em;
  border: 2px solid rgba(255,255,255,.28); background: rgba(0,0,0,.4); }

#prompt { position: absolute; left: 50%; top: 58%; transform: translateX(-50%); text-align: center;
  opacity: 0; transition: opacity .14s; }
#prompt .key { display: inline-grid; place-items: center; width: 30px; height: 30px;
  border: 2px solid rgba(255,255,255,.6); border-radius: 6px; font-weight: 700; font-size: 15px;
  margin-right: 10px; vertical-align: middle; }
#prompt .text { font-size: 19px; letter-spacing: .06em; vertical-align: middle; }
#prompt .cost { font-size: 19px; font-weight: 700; color: #ffcf6b; margin-left: 10px;
  vertical-align: middle; }
#prompt.poor .cost { color: #ff6a55; }

#banner { position: absolute; left: 50%; top: 34%; transform: translate(-50%,-50%); text-align: center;
  opacity: 0; }
#banner .big { font-size: 68px; font-weight: 700; letter-spacing: .12em; color: #b3231f;
  text-shadow: 0 0 40px rgba(179,35,31,.6), 0 4px 12px rgba(0,0,0,.9); }
#banner .sub { font-size: 17px; letter-spacing: .34em; opacity: .7; text-transform: uppercase; }

#damage { position: absolute; inset: 0; }
#damage div { position: absolute; left: 50%; top: 50%; width: 190px; height: 14px;
  margin-left: -95px; margin-top: -7px; transform-origin: 175px 7px;
  background: linear-gradient(90deg, rgba(255,60,40,0) 0%, rgba(255,60,40,.85) 100%);
  clip-path: polygon(60% 0, 100% 50%, 60% 100%); opacity: 0; }

#overlay { position: absolute; inset: 0; display: grid; place-items: center;
  background: rgba(4,5,9,.88); pointer-events: auto; opacity: 0; visibility: hidden;
  transition: opacity .35s; }
#overlay.show { opacity: 1; visibility: visible; }
#overlay .panel { text-align: center; max-width: 620px; padding: 40px; }
#overlay h1 { font-size: 62px; letter-spacing: .16em; color: #b3231f; margin-bottom: 6px; }
#overlay h2 { font-size: 22px; letter-spacing: .3em; opacity: .6; margin-bottom: 26px;
  text-transform: uppercase; font-weight: 400; }
#overlay p { font-size: 15px; line-height: 1.9; opacity: .74; margin-bottom: 8px; }
#overlay .stats { display: flex; gap: 34px; justify-content: center; margin: 26px 0 30px; }
#overlay .stat { min-width: 92px; }
#overlay .stat .v { font-size: 34px; font-weight: 700; color: #ffcf6b; }
#overlay .stat .k { font-size: 11px; letter-spacing: .26em; opacity: .5; text-transform: uppercase; }
#overlay button { pointer-events: auto; font: inherit; font-size: 17px; letter-spacing: .18em;
  text-transform: uppercase; padding: 14px 40px; color: #efe6d4; cursor: pointer;
  background: rgba(179,35,31,.22); border: 2px solid #b3231f; border-radius: 3px;
  transition: background .2s; }
#overlay button:hover { background: rgba(179,35,31,.5); }
#overlay .keys { display: grid; grid-template-columns: auto auto; gap: 6px 18px; justify-content: center;
  margin: 22px 0 6px; font-size: 14px; }
#overlay .keys b { color: #ffcf6b; font-weight: 700; text-align: right; }
#overlay .keys span { text-align: left; opacity: .72; }

#fps { position: absolute; right: 8px; top: 50%; font-size: 11px; opacity: .3; }
`;

export interface HudStats {
  round: number;
  kills: number;
  points: number;
}

export class HUD {
  private readonly root: HTMLDivElement;
  private readonly pointsValue: HTMLElement;
  private readonly pointsDelta: HTMLElement;
  private readonly ammoMag: HTMLElement;
  private readonly ammoReserve: HTMLElement;
  private readonly ammoName: HTMLElement;
  private readonly reloadingLabel: HTMLElement;
  private readonly roundValue: HTMLElement;
  private readonly roundLeft: HTMLElement;
  private readonly perkBar: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly promptText: HTMLElement;
  private readonly promptCost: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly bannerBig: HTMLElement;
  private readonly bannerSub: HTMLElement;
  private readonly hitmarker: HTMLElement;
  private readonly crosshairParts: HTMLElement[];
  private readonly damageArrows: HTMLElement[] = [];
  private readonly overlay: HTMLElement;
  private readonly fpsLabel: HTMLElement;

  private hitmarkerTimer = 0;
  private deltaTimer = 0;
  private bannerTimer = 0;
  private displayedPoints = 0;

  onRestart?: () => void;
  onStart?: () => void;

  constructor(container: HTMLElement) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.innerHTML = `
      <div id="crosshair">
        <i class="h" data-edge="left"></i><i class="h" data-edge="right"></i>
        <i class="v" data-edge="top"></i><i class="v" data-edge="bottom"></i>
        <i class="dot"></i>
      </div>
      <div id="hitmarker"><i class="a"></i><i class="b"></i><i class="c"></i><i class="d"></i></div>
      <div id="damage"></div>
      <div id="perks"></div>
      <div class="corner" id="round">
        <div class="label">Round</div><div class="value">1</div><div class="left">&nbsp;</div>
      </div>
      <div class="corner" id="points">
        <div class="delta"></div><div class="value">500</div><div class="label">Points</div>
      </div>
      <div class="corner" id="ammo">
        <div><span class="mag">15</span><span class="reserve"> / 90</span></div>
        <div class="name">M9 Sidearm</div>
        <div class="reloading">Reloading</div>
      </div>
      <div id="prompt"><span class="key">E</span><span class="text"></span><span class="cost"></span></div>
      <div id="banner"><div class="big"></div><div class="sub"></div></div>
      <div id="fps"></div>
      <div id="overlay"></div>
    `;
    container.appendChild(this.root);

    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector(sel) as T;
    this.pointsValue = q('#points .value');
    this.pointsDelta = q('#points .delta');
    this.ammoMag = q('#ammo .mag');
    this.ammoReserve = q('#ammo .reserve');
    this.ammoName = q('#ammo .name');
    this.reloadingLabel = q('#ammo .reloading');
    this.roundValue = q('#round .value');
    this.roundLeft = q('#round .left');
    this.perkBar = q('#perks');
    this.prompt = q('#prompt');
    this.promptText = q('#prompt .text');
    this.promptCost = q('#prompt .cost');
    this.banner = q('#banner');
    this.bannerBig = q('#banner .big');
    this.bannerSub = q('#banner .sub');
    this.hitmarker = q('#hitmarker');
    this.overlay = q('#overlay');
    this.fpsLabel = q('#fps');
    this.crosshairParts = Array.from(this.root.querySelectorAll('#crosshair .h, #crosshair .v'));

    const damage = q('#damage');
    for (let i = 0; i < 6; i++) {
      const arrow = document.createElement('div');
      damage.appendChild(arrow);
      this.damageArrows.push(arrow);
    }

    this.showStartScreen();
  }

  /* --- Live readouts --------------------------------------------------- */

  setPoints(points: number) {
    this.displayedPoints = points;
    this.pointsValue.textContent = String(points);
  }

  /** Floating "+100" above the points counter. */
  awardPoints(amount: number) {
    this.pointsDelta.textContent = `+${amount}`;
    this.deltaTimer = 0.9;
  }

  setAmmo(magazine: number, reserve: number, magSize: number, name: string, packed: boolean) {
    this.ammoMag.textContent = String(magazine);
    this.ammoReserve.textContent = ` / ${reserve}`;
    this.ammoName.textContent = name;
    this.ammoMag.classList.toggle('low', magazine <= Math.max(1, Math.ceil(magSize * 0.25)));
    this.ammoName.classList.toggle('packed', packed);
  }

  setReloading(reloading: boolean) {
    this.reloadingLabel.style.opacity = reloading ? '1' : '0';
  }

  setRound(round: number, remaining: number) {
    this.roundValue.textContent = String(round);
    this.roundLeft.textContent = remaining > 0 ? `${remaining} remaining` : 'Clear';
  }

  setPerks(owned: Set<string>) {
    this.perkBar.innerHTML = '';
    for (const id of owned) {
      const def = PERKS[id];
      if (!def) continue;
      const chip = document.createElement('div');
      chip.className = 'perk';
      chip.textContent = def.name.slice(0, 3);
      chip.style.borderColor = `#${def.color.toString(16).padStart(6, '0')}`;
      chip.style.color = `#${def.color.toString(16).padStart(6, '0')}`;
      chip.style.boxShadow = `0 0 14px #${def.color.toString(16).padStart(6, '0')}55`;
      chip.title = `${def.name} — ${def.tagline}`;
      this.perkBar.appendChild(chip);
    }
  }

  setPrompt(text: string | null, cost = 0, affordable = true, key = 'E') {
    if (!text) {
      this.prompt.style.opacity = '0';
      return;
    }
    this.prompt.style.opacity = '1';
    this.prompt.classList.toggle('poor', !affordable);
    (this.prompt.querySelector('.key') as HTMLElement).textContent = key;
    this.promptText.textContent = text;
    this.promptCost.textContent = cost > 0 ? `[${cost}]` : '';
  }

  /**
   * Crosshair gap follows the weapon's current cone, so the reticle actually
   * communicates accuracy rather than being decoration.
   */
  setSpread(spread: number) {
    // Each tick is 8px long inside a 46px box centred at 23px.
    const gap = clamp(4 + spread * 30, 3, 17);
    const offset = Math.round(23 - gap - 8);
    for (const part of this.crosshairParts) {
      part.style[part.dataset.edge as 'left' | 'right' | 'top' | 'bottom'] = `${offset}px`;
    }
  }

  setCrosshairVisible(visible: boolean) {
    (this.root.querySelector('#crosshair') as HTMLElement).style.opacity = visible ? '1' : '0';
  }

  hitmark(kill: boolean) {
    this.hitmarker.classList.toggle('kill', kill);
    this.hitmarkerTimer = kill ? 0.34 : 0.18;
  }

  /** Directional damage indicator. `angle` is radians relative to facing. */
  showDamage(angle: number) {
    const free = this.damageArrows.find((a) => a.style.opacity === '' || a.style.opacity === '0');
    const arrow = free ?? this.damageArrows[0];
    arrow.style.transform = `rotate(${angle}rad)`;
    arrow.style.opacity = '1';
    arrow.style.transition = 'none';
    // Force a reflow so the fade restarts even if this arrow was already lit.
    void arrow.offsetWidth;
    arrow.style.transition = 'opacity 1.1s ease-out';
    arrow.style.opacity = '0';
  }

  showBanner(big: string, sub: string, seconds = 2.4) {
    this.bannerBig.textContent = big;
    this.bannerSub.textContent = sub;
    this.bannerTimer = seconds;
  }

  setFps(fps: number) {
    this.fpsLabel.textContent = `${Math.round(fps)} fps`;
  }

  /* --- Screens ---------------------------------------------------------- */

  showStartScreen() {
    this.overlay.innerHTML = `
      <div class="panel">
        <h1>NECROPOLIS</h1>
        <h2>Ashgate Terminal</h2>
        <p>Survive the rounds. Every hit earns points; spend them on weapons, doors and perks.</p>
        <div class="keys">
          <b>WSAD</b><span>Move</span>
          <b>Shift</b><span>Sprint</span>
          <b>Ctrl</b><span>Crouch</span>
          <b>Space</b><span>Jump</span>
          <b>Mouse</b><span>Aim &middot; Left fire &middot; Right ADS</span>
          <b>R</b><span>Reload</span>
          <b>1 / 2 / Q</b><span>Switch weapon</span>
          <b>E</b><span>Buy &middot; hold to repair barriers</span>
          <b>F</b><span>Inspect weapon</span>
        </div>
        <button id="startBtn">Enter</button>
      </div>
    `;
    this.overlay.classList.add('show');
    (this.overlay.querySelector('#startBtn') as HTMLElement).onclick = () => {
      this.hideOverlay();
      this.onStart?.();
    };
  }

  showGameOver(stats: HudStats) {
    this.overlay.innerHTML = `
      <div class="panel">
        <h1>YOU DIED</h1>
        <h2>The terminal is quiet again</h2>
        <div class="stats">
          <div class="stat"><div class="v">${stats.round}</div><div class="k">Round</div></div>
          <div class="stat"><div class="v">${stats.kills}</div><div class="k">Kills</div></div>
          <div class="stat"><div class="v">${stats.points}</div><div class="k">Points</div></div>
        </div>
        <button id="restartBtn">Try again</button>
      </div>
    `;
    this.overlay.classList.add('show');
    (this.overlay.querySelector('#restartBtn') as HTMLElement).onclick = () => {
      this.hideOverlay();
      this.onRestart?.();
    };
  }

  showPaused() {
    this.overlay.innerHTML = `
      <div class="panel">
        <h1>PAUSED</h1>
        <h2>Click to resume</h2>
        <button id="resumeBtn">Resume</button>
      </div>
    `;
    this.overlay.classList.add('show');
    (this.overlay.querySelector('#resumeBtn') as HTMLElement).onclick = () => {
      this.hideOverlay();
      this.onStart?.();
    };
  }

  hideOverlay() {
    this.overlay.classList.remove('show');
  }

  get overlayVisible() {
    return this.overlay.classList.contains('show');
  }

  /* --- Per-frame -------------------------------------------------------- */

  update(dt: number) {
    if (this.hitmarkerTimer > 0) {
      this.hitmarkerTimer -= dt;
      const k = clamp(this.hitmarkerTimer / 0.18, 0, 1);
      this.hitmarker.style.opacity = String(k);
      this.hitmarker.style.transform = `translate(-50%,-50%) rotate(45deg) scale(${1.5 - k * 0.5})`;
    }

    if (this.deltaTimer > 0) {
      this.deltaTimer -= dt;
      const k = clamp(this.deltaTimer / 0.9, 0, 1);
      this.pointsDelta.style.opacity = String(k);
      this.pointsDelta.style.transform = `translateY(${-(1 - k) * 22}px)`;
    }

    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      // Snap in, hold, then fade.
      const k = this.bannerTimer > 0.7 ? 1 : this.bannerTimer / 0.7;
      this.banner.style.opacity = String(clamp(k, 0, 1));
      const scale = 1 + clamp((this.bannerTimer - 2.0) * 0.6, 0, 1) * 0.15;
      this.banner.style.transform = `translate(-50%,-50%) scale(${scale})`;
    }

    // Points counter rolls toward the true value instead of snapping.
    const current = Number(this.pointsValue.textContent ?? '0');
    if (current !== this.displayedPoints) {
      const step = Math.max(1, Math.ceil(Math.abs(this.displayedPoints - current) * 0.22));
      const next = current < this.displayedPoints
        ? Math.min(this.displayedPoints, current + step)
        : Math.max(this.displayedPoints, current - step);
      this.pointsValue.textContent = String(next);
    }
  }
}
