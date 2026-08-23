import { PERKS } from '../map/Props';
import { clamp } from '../util/math';

/**
 * HUD.
 *
 * Built from DOM rather than rendered into the scene: crisp text at any
 * resolution, free layout, and zero draw calls competing with the game. All
 * styling is injected once so the whole interface lives in one file.
 *
 * Craft system, tuned to whisper (CS:GO-grade corner treatment): the HUD is
 * information, not signage — nothing in it may compete with the world for
 * attention, because every loud pixel reads as debug chrome.
 * - Type scale — every glyph is drawn at one of seven roles (10/12/14/18/24/
 *   32/34px, the `--t-*` tokens). Numerals are big enough to find in
 *   peripheral vision and no bigger: the old 48px stack read as an overlay.
 *   Tabular figures with slightly negative tracking keep digits from
 *   shimmering as they roll.
 * - Layered depth — text gets a 1px contact shadow plus a soft ambient layer
 *   (`--ink`) instead of heavy blur: crisp edges over muzzle flash without
 *   the haloed look.
 * - No panels — corner readouts float directly on the scene, carried by
 *   `--ink` alone. Backing cards, backdrop blurs and L-bracket ticks all
 *   frame a readout like an inspector widget, so they went. Accent colour is
 *   rationed: amber only on points, red only on the round numeral, both at
 *   reduced weight and with their glows removed.
 */

const CSS = `
#hud {
  --cream: #eff3eb; --muted: rgba(239,243,235,.72); --amber: #ffc568; --red: #db4e3c; --hot: #ff6b55;
  --font-condensed: 'Arial Narrow','Avenir Next Condensed','Rajdhani',system-ui,sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  /* The only type sizes the HUD draws. Numerals top out at 34px. */
  --t-10: 10px; --t-12: 12px; --t-14: 14px; --t-18: 18px; --t-24: 24px; --t-32: 32px; --t-34: 34px;
  /* 1px contact edge + short falloff + wide ambient lift. This is the ONLY
     depth device the corners get — no faces, no borders, no blur cards. */
  --ink: 0 1px 0 rgba(0,0,0,.85), 0 1px 2px rgba(0,0,0,.55), 0 10px 26px rgba(0,0,0,.35);
  position: fixed; inset: 0; pointer-events: none; z-index: 5;
  font-family: var(--font-condensed); color: var(--cream);
  text-shadow: var(--ink); user-select: none;
}
#hud::before { content: ''; position: absolute; inset: 0; pointer-events: none;
  /* Legibility scrim only — a faint darkening of top/bottom edges so white
     type survives a bright sky. Heavy enough to notice would tint the world;
     these alphas are half what they used to be for exactly that reason. */
  background: linear-gradient(180deg, rgba(0,0,0,.18), transparent 22%, transparent 78%, rgba(0,0,0,.24)),
    linear-gradient(90deg, rgba(0,0,0,.1), transparent 16%, transparent 84%, rgba(0,0,0,.1)); }

/* --- Corners: text on the scene, nothing else --------------------------
   The old gradient cards + backdrop blur + L-bracket ticks framed every
   readout like an inspector widget — the "debug overlay" tell in review.
   CS:GO ships corners as bare shadow-carried text and nobody misses the
   chrome, so neither do we: positioning and typography only. */
#points { position: absolute; left: 20px; bottom: 16px; }
#ammo { position: absolute; right: 20px; bottom: 16px; text-align: right; }
#round { position: absolute; right: 20px; top: 14px; text-align: right;
  transition: opacity .25s ease; }
/* While the banner is up it carries the same round number, so the corner
   fades to a quarter — the fact exists on screen exactly once. */
#hud.banner-live #round { opacity: .25; }
#perks { position: absolute; left: 20px; top: 14px; display: flex; gap: 8px; }

/* --- Reticle: CS-style four lines, dynamic gap, outlined for any backdrop */
#crosshair { position: absolute; left: 50%; top: 50%; width: 44px; height: 44px; transform: translate(-50%,-50%); }
#crosshair i { position: absolute; display: block; background: rgba(244,247,239,.96); border-radius: 1px;
  /* 1px black outline keeps the lines legible on snow, sky or muzzle flash. */
  box-shadow: 0 0 0 1px rgba(0,0,0,.55), 0 1px 3px rgba(0,0,0,.5);
  transition: opacity .12s; }
#crosshair .h { width: 9px; height: 2px; top: 21px; }
#crosshair .v { width: 2px; height: 9px; left: 21px; }
/* The centre dot is an option, not a default — add .dot-on to opt in. */
#crosshair .dot { width: 2px; height: 2px; left: 21px; top: 21px; border-radius: 50%; }
#crosshair:not(.dot-on) .dot { display: none; }

/* --- Hitmarker: white core, coloured edge glow, 60ms scale pop --------- */
#hitmarker { position: absolute; left: 50%; top: 50%; width: 30px; height: 30px;
  transform: translate(-50%,-50%) rotate(45deg); opacity: 0; --hm-glow: rgba(255,255,255,.55); }
#hitmarker i { position: absolute; background: #fff; border-radius: 1px;
  box-shadow: 0 0 0 1px rgba(0,0,0,.4), 0 0 7px var(--hm-glow); }
#hitmarker .a { width: 12px; height: 2px; top: 14px; left: 0; }
#hitmarker .b { width: 12px; height: 2px; top: 14px; right: 0; }
#hitmarker .c { width: 2px; height: 12px; left: 14px; top: 0; }
#hitmarker .d { width: 2px; height: 12px; left: 14px; bottom: 0; }
#hitmarker.kill { --hm-glow: rgba(255,107,85,.9); }
#hitmarker.kill i { background: #ffe4dd; }
#hitmarker.headshot { --hm-glow: rgba(255,197,104,.95); }
#hitmarker.headshot i { background: #fff3d8; }
/* Pop to overshoot inside ~60ms, settle, then fade the tail. Duration is
   driven per-hit through --hm-dur (kills linger longer). */
#hitmarker.show { animation: hit-pop var(--hm-dur, 180ms) cubic-bezier(.17,.84,.44,1) forwards; }
@keyframes hit-pop {
  0%   { opacity: 0; transform: translate(-50%,-50%) rotate(45deg) scale(.6); }
  33%  { opacity: 1; transform: translate(-50%,-50%) rotate(45deg) scale(1.22); }
  55%  { transform: translate(-50%,-50%) rotate(45deg) scale(1); }
  100% { opacity: 0; transform: translate(-50%,-50%) rotate(45deg) scale(1.05); }
}

/* --- Corners ----------------------------------------------------------- */
#points .value { font-size: var(--t-34); font-weight: 700; letter-spacing: -.01em; color: var(--amber);
  line-height: .95; font-variant-numeric: tabular-nums; }
#points .label, #ammo .name, #round .label, #ammo .reloading {
  font-family: var(--font-mono); font-size: var(--t-10); letter-spacing: .22em;
  color: rgba(239,243,235,.62); text-transform: uppercase; }
/* The "+100" is feedback, not a headline: it keeps the old scale but loses
   its halo so a kill streak doesn't strobe the corner. */
#points .delta { position: absolute; left: 2px; bottom: 58px; font-size: var(--t-24); font-weight: 700;
  color: #fff0b5; letter-spacing: .01em; font-variant-numeric: tabular-nums; opacity: 0;
  will-change: transform, opacity, filter;
  text-shadow: var(--ink), 0 0 10px rgba(255,197,104,.2); }

#squad { position: absolute; left: 20px; bottom: 92px; display: none;
  grid-auto-rows: min-content; gap: 4px; }
#squad.show { display: grid; }
#squad .row { display: flex; align-items: center; gap: 10px; min-width: 238px; padding: 4px 10px;
  border-radius: 8px; pointer-events: auto;
  background: linear-gradient(180deg, rgba(8,12,16,.42), rgba(8,12,16,0));
  transition: background .18s, box-shadow .18s, opacity .25s; }
#squad .row:hover { background: rgba(239,243,235,.07); box-shadow: inset 2px 0 0 currentColor; }
#squad .row .pip { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto;
  box-shadow: 0 0 7px currentColor; background: currentColor; }
#squad .row .name { flex: 1; font-size: var(--t-14); letter-spacing: .08em; text-transform: uppercase;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .84; }
#squad .row .score { font-size: var(--t-14); font-weight: 800; color: var(--amber);
  font-variant-numeric: tabular-nums; letter-spacing: .02em; }
#squad .row.self .name { opacity: 1; color: #fff; }
/* Downed: desaturate the readout, and swap the status dot for a skull pip so
   the roster still reads at a glance once the colour is gone. */
#squad .row.down .name, #squad .row.down .score { filter: grayscale(.7); opacity: .45; }
#squad .row.down .score { color: var(--hot); }
#squad .row.down .pip { opacity: .5; }
#squad .row.down .pip.skull { background: none; width: auto; height: auto; border-radius: 0;
  box-shadow: none; color: var(--hot); font-size: 11px; line-height: 1;
  text-shadow: 0 0 8px rgba(255,107,85,.8); opacity: 1; }

#ammo .mag { font-size: var(--t-34); font-weight: 700; line-height: .95; letter-spacing: -.01em;
  font-variant-numeric: tabular-nums; }
/* Low mag keeps its urgency but loses the flare: a tinted numeral reads fine
   once you know the colour; the old 22px halo read from across the room. */
#ammo .mag.low { color: var(--hot); text-shadow: var(--ink), 0 0 10px rgba(255,107,85,.3); }
/* Reserve rides the same baseline (inline flow aligns spans for free) at a
   touch over half the mag size — hierarchy without a second column. */
#ammo .reserve { font-size: var(--t-18); color: rgba(239,243,235,.62); letter-spacing: 0;
  font-variant-numeric: tabular-nums; }
/* Weapon name is a whisper: 10px at 60% opacity — there if you look for it,
   invisible if you don't. It must never be why a player notices a corner. */
#ammo .name { display: block; margin-top: 5px; color: rgba(239,243,235,.6); }
#ammo .name.packed { color: rgba(210,166,255,.78); }
#ammo .reloading { display: block; margin-top: 4px; color: var(--amber); letter-spacing: .26em;
  animation: reload-blink 1.1s ease-in-out infinite; }
@keyframes reload-blink { 0%, 100% { color: var(--amber); } 50% { color: #ffe9bd; } }

/* Red stays as the one drop of identity up here, but at 24px/700 with plain
   ink shadow — the old 32px numeral plus 26px red halo glowed like an alarm
   LED. The tint is one step lighter than --red: muted red on a near-black
   ceiling reads as brown unless lifted, and quiet must not mean unreadable.
   While the banner shows the same number, .banner-live dims this whole
   corner (see #hud.banner-live) so it never says "ROUND" twice at once. */
#round .label { display: block; margin-bottom: 3px; }
#round .value { font-size: var(--t-24); font-weight: 700; letter-spacing: 0; line-height: .95;
  color: #e86a55; font-variant-numeric: tabular-nums; }
#round .value.pulse { animation: round-pop .45s cubic-bezier(.2,.9,.3,1.2); }
@keyframes round-pop { 0% { transform: scale(1); } 35% { transform: scale(1.07); } 100% { transform: scale(1); } }
#round .left { display: block; margin-top: 2px; font-family: var(--font-mono); font-size: var(--t-10);
  color: rgba(239,243,235,.58); letter-spacing: .12em; text-transform: uppercase; }

#perks:empty { visibility: hidden; }
.perk { width: 40px; height: 40px; display: grid; place-items: center;
  font-size: var(--t-10); font-weight: 800; letter-spacing: .05em;
  border: 1px solid rgba(255,255,255,.38);
  background: linear-gradient(180deg, rgba(10,15,19,.72), rgba(10,15,19,.4));
  box-shadow: inset 0 1px 0 rgba(255,255,255,.08);
  clip-path: polygon(12% 0, 100% 0, 88% 100%, 0 100%);
  pointer-events: auto; cursor: default;
  transition: transform .16s ease-out, filter .16s ease-out; }
.perk:hover { transform: translateY(-1px); filter: brightness(1.25); }

/* --- Buy prompt: pill with key slot + cost chip ------------------------ */
#prompt { position: absolute; left: 50%; top: 58%;
  display: flex; align-items: center; gap: 12px; max-width: min(92vw, 560px);
  padding: 9px 18px 9px 9px; border-radius: 999px;
  background: linear-gradient(180deg, rgba(8,13,17,.78), rgba(8,13,17,.6));
  border: 1px solid rgba(255,197,104,.24);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.07), 0 14px 38px rgba(0,0,0,.5);
  -webkit-backdrop-filter: blur(6px) saturate(1.15);
  backdrop-filter: blur(6px) saturate(1.15);
  opacity: 0; transform: translate(-50%,-50%) translateY(7px);
  transition: opacity .16s ease-out, transform .16s ease-out; }
#prompt.on { opacity: 1; transform: translate(-50%,-50%); }
#prompt .key { display: grid; place-items: center; width: 30px; height: 30px; flex: 0 0 auto;
  border: 1px solid var(--amber); border-radius: 8px; color: var(--amber); text-shadow: none;
  background: linear-gradient(180deg, rgba(255,197,104,.2), rgba(255,197,104,.06));
  box-shadow: inset 0 1px 0 rgba(255,255,255,.14);
  font-family: var(--font-mono); font-weight: 800; font-size: var(--t-14); }
#prompt .text { font-size: var(--t-18); letter-spacing: .04em; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#prompt .cost { padding: 3px 11px; border-radius: 999px; flex: 0 0 auto;
  border: 1px solid rgba(255,197,104,.45); background: rgba(255,197,104,.13);
  color: var(--amber); text-shadow: none;
  font-family: var(--font-mono); font-size: var(--t-12); font-weight: 800;
  letter-spacing: .06em; font-variant-numeric: tabular-nums; }
#prompt.poor { border-color: rgba(255,107,85,.4); }
#prompt.poor .key { color: var(--hot); border-color: var(--hot); background: rgba(255,107,85,.1); }
#prompt.poor .cost { color: var(--hot); border-color: rgba(255,107,85,.55); background: rgba(255,107,85,.12); }

/* --- Banner: a quiet announcement, not a poster ------------------------
   Round changes used to arrive as poster-scale red-gradient type with a
   wipe entrance — the loudest "debug build" signal on screen. Now: caps at
   ≤5% of frame height (~38px at 1080p), cream fill carried by a 1px dark
   outline plus one soft drop shadow, quick fade-in with a 2% settle, plain
   fade-out. The sub-label is one smaller mono line beneath; no keylines,
   no glow, no theatrics. */
#banner { position: absolute; left: 50%; top: 30%; transform: translate(-50%,-50%);
  width: min(92vw, 640px); text-align: center; opacity: 0; pointer-events: none; }
#banner .big { font-size: clamp(24px, 3.6vh, 38px); font-weight: 600; line-height: 1.05;
  letter-spacing: .3em; margin-right: -.3em; text-transform: uppercase; color: var(--cream);
  /* The outline is four 1px offset shadows: -webkit-text-stroke centres its
     stroke and visibly thins glyphs at this size. The two soft layers below
     it are the drop shadow. Depth lives on the text itself — no container
     filter, which only existed to shield the old gradient fill from a
     Chromium background-clip compositing bug. */
  text-shadow: -1px 0 0 rgba(0,0,0,.9), 1px 0 0 rgba(0,0,0,.9),
    0 -1px 0 rgba(0,0,0,.9), 0 1px 0 rgba(0,0,0,.9),
    0 2px 5px rgba(0,0,0,.5), 0 8px 22px rgba(0,0,0,.42); }
/* One small mono line under the headline, and nothing else. */
#banner .sub { margin-top: 6px; font-family: var(--font-mono); font-size: var(--t-10);
  letter-spacing: .22em; color: rgba(239,243,235,.6); text-transform: uppercase; }
/* Entrance is 220ms of fade with a 2% scale settle — felt, not seen. */
#banner.in { animation: banner-in .22s ease-out forwards; }
@keyframes banner-in {
  from { opacity: 0; transform: translate(-50%,-50%) scale(1.02); }
  to   { opacity: 1; transform: translate(-50%,-50%) scale(1); }
}
#banner.out { animation: banner-out .3s ease-in forwards; }
@keyframes banner-out {
  from { opacity: 1; }
  to   { opacity: 0; }
}

/* --- Damage direction: curved arc segment, fading radially ------------- */
#damage { position: absolute; inset: 0; }
#damage div { position: absolute; left: 50%; top: 50%; width: 320px; height: 320px;
  margin: -160px 0 0 -160px; border-radius: 50%;
  border: 4px solid transparent; border-top-color: rgba(255,84,62,.92);
  filter: drop-shadow(0 0 8px rgba(255,60,40,.65));
  -webkit-mask: radial-gradient(circle, transparent 55%, #000 72%, rgba(0,0,0,.85) 84%, transparent 96%);
  mask: radial-gradient(circle, transparent 55%, #000 72%, rgba(0,0,0,.85) 84%, transparent 96%);
  opacity: 0; }

/* --- Overlay screens ---------------------------------------------------- */
#overlay { position: absolute; inset: 0; z-index: 10; display: grid; place-items: center;
  background: rgba(10,16,22,.99); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);
  pointer-events: auto; opacity: 0; visibility: hidden; transition: opacity .35s; }
#overlay.show { opacity: 1; visibility: visible; }
#overlay .panel { width: min(90vw, 620px); padding: 42px 48px; text-align: center; border-radius: 6px;
  border-top: 3px solid var(--red); border-bottom: 1px solid rgba(239,243,235,.2);
  background: rgba(21,30,38,.96); box-shadow: 0 24px 80px rgba(0,0,0,.42); }
#overlay h1 { font-size: clamp(44px, 7vw, 68px); letter-spacing: .12em; line-height: .95; margin-bottom: 9px;
  text-transform: uppercase; color: var(--red);
  text-shadow: 0 1px 0 rgba(0,0,0,.8), 0 1px 2px rgba(0,0,0,.5), 0 0 34px rgba(219,78,60,.42); }
#overlay h2 { font-family: var(--font-mono); font-size: var(--t-12); letter-spacing: .2em;
  color: var(--amber); margin-bottom: 23px; text-transform: uppercase; font-weight: 700; }
#overlay p { font-size: var(--t-14); color: var(--muted); line-height: 1.7; margin-bottom: 8px; }
#overlay .stats { display: flex; gap: 36px; justify-content: center; margin: 26px 0 30px; }
#overlay .stat { min-width: 92px; }
#overlay .stat .v { font-size: var(--t-32); font-weight: 800; letter-spacing: -.01em; color: var(--amber);
  font-variant-numeric: tabular-nums; }
#overlay .stat .k { font-family: var(--font-mono); font-size: 9px; letter-spacing: .18em;
  color: var(--muted); text-transform: uppercase; }
#overlay button { pointer-events: auto; font: inherit; font-size: var(--t-14); letter-spacing: .16em;
  text-transform: uppercase; min-height: 50px; padding: 13px 38px; color: #fff5e9; cursor: pointer;
  background: linear-gradient(180deg, #e65a46, var(--red)); border: 1px solid #ff9b7c; border-radius: 6px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.18), 0 10px 30px rgba(219,78,60,.25);
  transition: background .2s, box-shadow .2s; }
#overlay button:hover, #overlay button:focus-visible { background: #eb5d49;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.18), 0 0 0 2px rgba(255,197,104,.22); outline: none; }
#overlay .keys { display: grid; grid-template-columns: auto auto; gap: 7px 18px; justify-content: center;
  margin: 22px 0 6px; font-size: var(--t-14); text-align: left; }
#overlay .keys b { color: var(--amber); font-family: var(--font-mono); font-size: var(--t-12);
  font-weight: 800; text-align: right; }
#overlay .keys span { color: var(--muted); }

#fps { display: none; position: absolute; right: 8px; top: 50%;
  font-family: var(--font-mono); font-size: 9px; color: var(--muted); opacity: .34;
  font-variant-numeric: tabular-nums; }

@media (max-width: 560px) {
  #points { left: 12px; bottom: 10px; }
  #ammo { right: 12px; bottom: 10px; }
  #round { right: 12px; top: 10px; }
  #points .value, #ammo .mag { font-size: 26px; }
  #points .delta { font-size: var(--t-18); left: 0; bottom: 46px; }
  #points .label, #ammo .name, #ammo .reloading { font-size: 9px; letter-spacing: .13em; }
  #ammo .reserve { font-size: 15px; }
  #round .value { font-size: var(--t-18); }
  #round .label, #round .left { font-size: 9px; letter-spacing: .12em; }
  #perks { gap: 5px; left: 12px; top: 10px; }
  .perk { width: 32px; height: 32px; font-size: 8px; }
  #squad { left: 12px; bottom: 64px; gap: 3px; }
  #squad .row { min-width: 150px; gap: 7px; padding: 3px 8px; }
  #squad .row .name { font-size: 11px; letter-spacing: .05em; }
  #squad .row .score { font-size: var(--t-12); }
  #prompt { top: 56%; gap: 8px; padding: 7px 14px 7px 7px; }
  #prompt .key { width: 24px; height: 24px; border-radius: 6px; font-size: var(--t-12); }
  #prompt .text { font-size: var(--t-14); }
  #prompt .cost { font-size: 10px; padding: 2px 8px; }
  #banner { top: 26%; }
  #banner .big { font-size: clamp(18px, 4.2vh, 26px); letter-spacing: .22em; margin-right: -.22em; }
  #banner .sub { font-size: 9px; letter-spacing: .16em; }
  #damage div { width: 220px; height: 220px; margin: -110px 0 0 -110px; }
  #overlay { align-items: center; overflow: auto; padding: 20px 0; }
  #overlay .panel { width: min(94vw, 380px); padding: 28px 20px; }
  #overlay h1 { font-size: clamp(36px, 12vw, 50px); letter-spacing: .08em; overflow-wrap: anywhere; }
  #overlay h2 { font-size: 9px; letter-spacing: .14em; margin-bottom: 16px; }
  #overlay p { font-size: var(--t-12); line-height: 1.55; }
  #overlay .keys { gap: 5px 10px; margin: 16px 0 4px; font-size: var(--t-12); }
  #overlay button { font-size: var(--t-12); padding: 12px 28px; }
  #overlay .stats { gap: 12px; margin: 20px 0 24px; }
  #overlay .stat { min-width: 68px; }
  #overlay .stat .v { font-size: var(--t-24); }
  #fps { display: none; }
}
`;

export interface HudStats {
  round: number;
  kills: number;
  points: number;
}

/** One line of the co-op scoreboard in the bottom-left corner. */
export interface SquadEntry {
  id: string;
  name: string;
  points: number;
  /** CSS colour for the status pip — the operator's own accent. */
  color: string;
  self: boolean;
  downed: boolean;
  alive: boolean;
}

/** Reticle geometry: 44px box, arms 9px long, centre at 22px. */
const CROSSHAIR_CENTER = 22;
const CROSSHAIR_ARM = 9;

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
  private readonly squad: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly promptText: HTMLElement;
  private readonly promptCost: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly bannerBig: HTMLElement;
  private readonly bannerSub: HTMLElement;
  private readonly hitmarker: HTMLElement;
  private readonly crosshair: HTMLElement;
  private readonly crosshairParts: HTMLElement[];
  private readonly damageArrows: HTMLElement[] = [];
  private readonly overlay: HTMLElement;
  private readonly fpsLabel: HTMLElement;

  private deltaTimer = 0;
  private bannerTimer = 0;
  /** Time remaining at which the banner hands off from entrance to exit. */
  private bannerExitAt = 0;
  private displayedPoints = 0;
  /** Last weapon-cone spread, kept so hit-kick can re-place the arms. */
  private spread = 0;
  /** 1 right after a hit, decaying — flings the reticle open for a beat. */
  private crosshairKick = 0;
  /** Matches the markup's initial round so the spawn call doesn't pulse. */
  private lastRound = 1;

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
      <div id="squad"></div>
      <div class="corner" id="points">
        <div class="delta"></div><div class="value">500</div><div class="label">Points</div>
      </div>
      <div class="corner" id="ammo">
        <div><span class="mag">15</span><span class="reserve"> / 90</span></div>
        <div class="name">M9 Sidearm</div>
        <div class="reloading">Reloading</div>
      </div>
      <div id="prompt" aria-live="polite"><span class="key">E</span><span class="text"></span><span class="cost"></span></div>
      <div id="banner" aria-live="polite"><div class="big"></div><div class="sub"></div></div>
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
    this.squad = q('#squad');
    this.prompt = q('#prompt');
    this.promptText = q('#prompt .text');
    this.promptCost = q('#prompt .cost');
    this.banner = q('#banner');
    this.bannerBig = q('#banner .big');
    this.bannerSub = q('#banner .sub');
    this.hitmarker = q('#hitmarker');
    this.crosshair = q('#crosshair');
    this.overlay = q('#overlay');
    this.fpsLabel = q('#fps');
    this.crosshairParts = Array.from(this.root.querySelectorAll('#crosshair .h, #crosshair .v'));

    const damage = q('#damage');
    for (let i = 0; i < 6; i++) {
      const arrow = document.createElement('div');
      damage.appendChild(arrow);
      this.damageArrows.push(arrow);
    }

    // No screen is shown here any more. The front end (`Menu`) decides what the
    // player sees before a round: single player still gets `showStartScreen`,
    // but a co-op player goes from the lobby straight into the world, and a HUD
    // that put its own start screen up in the constructor would flash it behind
    // the menu on the way past.
  }

  /* --- Live readouts --------------------------------------------------- */

  setPoints(points: number) {
    this.displayedPoints = points;
    this.pointsValue.textContent = String(points);
  }

  /** Floating "+100" above the points counter — arcs up and blurs into focus. */
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
    if (round !== this.lastRound) {
      this.lastRound = round;
      // Restart the pulse: drop the class, force a reflow, re-add.
      this.roundValue.classList.remove('pulse');
      void this.roundValue.offsetWidth;
      this.roundValue.classList.add('pulse');
    }
  }

  /**
   * The squad list above the points counter.
   *
   * Rebuilt wholesale on each call. It is at most four rows and it changes only
   * when a score does, so the DOM churn is nothing next to the alternative —
   * diffing rows by id and keeping them in sync — and it cannot drift out of
   * step with the roster the way an incremental update can.
   */
  setSquad(entries: SquadEntry[]) {
    const list = this.squad;
    if (entries.length <= 1) {
      list.classList.remove('show');
      list.innerHTML = '';
      return;
    }
    list.classList.add('show');
    list.innerHTML = '';

    for (const entry of entries) {
      const down = entry.downed || !entry.alive;
      const row = document.createElement('div');
      row.className = `row${entry.self ? ' self' : ''}${down ? ' down' : ''}`;
      row.style.color = entry.color;

      const pip = document.createElement('div');
      // Downed operators trade the status dot for a skull pip: once the row
      // desaturates, a shape still says "down" where a grey dot would not.
      pip.className = down ? 'pip skull' : 'pip';
      if (down) pip.textContent = '☠';
      row.appendChild(pip);

      const name = document.createElement('div');
      name.className = 'name';
      // The name came off the network: never innerHTML.
      name.textContent = entry.name;
      // Colour is carried by the pip alone; the label stays legible cream.
      name.style.color = '';
      row.appendChild(name);

      const score = document.createElement('div');
      score.className = 'score';
      score.textContent = String(entry.points);
      row.appendChild(score);

      list.appendChild(row);
    }
  }

  setPerks(owned: Set<string>) {
    this.perkBar.innerHTML = '';
    for (const id of owned) {
      const def = PERKS[id];
      if (!def) continue;
      const chip = document.createElement('div');
      chip.className = 'perk';
      chip.textContent = def.name.slice(0, 3);
      const glow = `#${def.color.toString(16).padStart(6, '0')}55`;
      chip.style.borderColor = `#${def.color.toString(16).padStart(6, '0')}`;
      chip.style.color = `#${def.color.toString(16).padStart(6, '0')}`;
      // Keep the panel's inner top highlight under the coloured glow.
      chip.style.boxShadow = `inset 0 1px 0 rgba(255,255,255,.08), 0 0 14px ${glow}`;
      chip.title = `${def.name} — ${def.tagline}`;
      this.perkBar.appendChild(chip);
    }
  }

  setPrompt(text: string | null, cost = 0, affordable = true, key = 'E') {
    this.prompt.classList.toggle('on', !!text);
    this.prompt.classList.toggle('poor', !!text && !affordable);
    (this.prompt.querySelector('.key') as HTMLElement).textContent = key;
    this.promptText.textContent = text ?? '';
    // The chip frames the number; the old [brackets] would be redundant.
    this.promptCost.textContent = text && cost > 0 ? String(cost) : '';
  }

  /**
   * Crosshair gap follows the weapon's current cone, so the reticle actually
   * communicates accuracy rather than being decoration.
   */
  setSpread(spread: number) {
    this.spread = spread;
    this.applyCrosshair();
  }

  /** Re-places the four reticle arms for the current spread plus hit-kick. */
  private applyCrosshair() {
    // gap tracks the cone; a landing shot flings it open (crosshairKick) and
    // the per-frame decay in update() settles it back.
    const gap = clamp(4 + this.spread * 30, 3, 17) + this.crosshairKick * 5;
    for (const part of this.crosshairParts) {
      const edge = part.dataset.edge as 'left' | 'right' | 'top' | 'bottom';
      const leading = edge === 'left' || edge === 'top';
      const px = Math.round(leading ? CROSSHAIR_CENTER - gap - CROSSHAIR_ARM : CROSSHAIR_CENTER + gap);
      if (edge === 'left' || edge === 'right') part.style.left = `${px}px`;
      else part.style.top = `${px}px`;
    }
  }

  setCrosshairVisible(visible: boolean) {
    this.crosshair.style.opacity = visible ? '1' : '0';
  }

  /** Moves the reticle with the shot offset while leaving the world camera level. */
  setRecoilOffset(x: number, y: number) {
    this.crosshair.style.transform = `translate(calc(-50% + ${x.toFixed(2)}px), calc(-50% + ${y.toFixed(2)}px))`;
  }

  /**
   * `headshot` was already being computed by `WeaponSystem` and thrown away
   * here. It is worth showing: a headshot kill is the thing the player was
   * aiming for, and in co-op it is also the only marker that distinguishes a
   * kill the host confirmed for you from an ordinary hit.
   */
  hitmark(kill: boolean, headshot = false) {
    this.hitmarker.classList.toggle('kill', kill);
    this.hitmarker.classList.toggle('headshot', kill && headshot);
    // Restart the pop: drop the class, force a reflow, re-add. Kills ride a
    // longer tail so the beat reads even mid-firefight.
    this.hitmarker.classList.remove('show');
    void this.hitmarker.offsetWidth;
    this.hitmarker.style.setProperty('--hm-dur', kill ? '340ms' : '180ms');
    this.hitmarker.classList.add('show');
    this.crosshairKick = 1;
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

  /**
   * A quiet announcement, not a poster: default dwell is ~1.6s because a
   * banner is a status change, not a cutscene. Call sites tuned before the
   * de-debug pass still ask for 2-3.4s, so presentation time is clamped HERE
   * rather than trusting every caller to have been revisited.
   */
  showBanner(big: string, sub: string, seconds = 1.6) {
    this.bannerBig.textContent = big;
    this.bannerSub.textContent = sub;
    // The round numeral also lives top-right; while the banner says it, the
    // corner fades so the fact appears on screen exactly once.
    this.root.classList.add('banner-live');
    this.banner.classList.remove('in', 'out');
    // Force a reflow so back-to-back banners replay the fade from scratch.
    void this.banner.offsetWidth;
    this.banner.classList.add('in');
    this.bannerTimer = clamp(seconds, 1.2, 1.8);
    // Hand off to the exit fade so it finishes right at cutoff: the exit
    // animation runs 300ms, and this loop ticks at frame rate.
    this.bannerExitAt = Math.min(this.bannerTimer * 0.5, 0.3);
  }

  setFps(fps: number) {
    this.fpsLabel.textContent = `${Math.round(fps)} fps`;
  }

  /* --- Screens ---------------------------------------------------------- */

  showStartScreen() {
    this.overlay.innerHTML = `
      <div class="panel">
        <h1>NECROPOLIS</h1>
        <h2>Operations briefing // Ashgate Terminal</h2>
        <p>Survive the rounds. Every hit earns points; spend them on weapons, doors and perks.</p>
        <div class="keys">
          <b>WASD</b><span>Move</span>
          <b>Shift</b><span>Sprint</span>
          <b>Ctrl</b><span>Crouch</span>
          <b>Space</b><span>Jump</span>
          <b>Mouse</b><span>Aim &middot; Left fire &middot; Right ADS</span>
          <b>R</b><span>Reload</span>
          <b>1 / 2 / Q</b><span>Switch weapon</span>
          <b>E</b><span>Buy &middot; hold to repair barriers</span>
          <b>F</b><span>Inspect weapon</span>
        </div>
        <button id="startBtn">Enter Sector</button>
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
    // Hit-kick: widen the reticle for a beat after a landed shot.
    if (this.crosshairKick > 0) {
      this.crosshairKick = Math.max(0, this.crosshairKick - dt * 8);
      this.applyCrosshair();
    }

    if (this.deltaTimer > 0) {
      this.deltaTimer -= dt;
      // k runs 1 → 0 over the life; t is the elapsed fraction.
      const k = clamp(this.deltaTimer / 0.9, 0, 1);
      const t = 1 - k;
      // Arc rise: decelerating lift with a rightward curl, and the blur
      // burns off in the first fifth so the number snaps into focus.
      const rise = 38 * (1 - (1 - t) * (1 - t));
      const drift = 16 * t * t;
      const blur = Math.max(0, 1 - t / 0.2) * 5;
      this.pointsDelta.style.opacity = String(Math.min(1, t / 0.06) * Math.pow(k, 1.1));
      this.pointsDelta.style.transform = `translate(${drift.toFixed(1)}px, ${(-rise).toFixed(1)}px)`;
      this.pointsDelta.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : 'none';
    }

    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      // Entrance/exit are CSS fades; this loop only schedules the exit and
      // clears state once the banner is done so it can't re-trigger.
      if (this.bannerTimer <= this.bannerExitAt && this.banner.classList.contains('in')) {
        this.banner.classList.remove('in');
        this.banner.classList.add('out');
      }
      if (this.bannerTimer <= 0) {
        this.banner.classList.remove('out');
        // Banner's gone — hand the round numeral its corner back.
        this.root.classList.remove('banner-live');
      }
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
