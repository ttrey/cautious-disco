import { Engine } from './core/Engine';
import { Physics } from './core/Physics';
import { Game } from './core/Game';

/**
 * Entry point.
 *
 * Boot order matters: Rapier's WASM has to finish initialising before any
 * collider exists, and the procedural texture bakes are synchronous and take a
 * moment, so a loading screen goes up first and comes down once the first
 * frame is genuinely ready to draw.
 */

const container = document.getElementById('app')!;

function showLoader(): HTMLElement {
  const loader = document.createElement('div');
  loader.style.cssText = `
    position: fixed; inset: 0; display: grid; place-items: center; z-index: 20;
    background: #05060a; color: #efe6d4; font-family: 'Rajdhani', system-ui, sans-serif;
    transition: opacity .5s;`;
  loader.innerHTML = `
    <div style="text-align:center">
      <div style="font-size:52px;letter-spacing:.18em;color:#b3231f;font-weight:700">NECROPOLIS</div>
      <div style="font-size:13px;letter-spacing:.36em;opacity:.5;margin-top:10px">
        GENERATING ASSETS
      </div>
      <div style="margin-top:26px;width:220px;height:2px;background:rgba(255,255,255,.12);
                  overflow:hidden;margin-left:auto;margin-right:auto">
        <div id="loadbar" style="width:0;height:100%;background:#b3231f;transition:width .3s"></div>
      </div>
      <div id="loadstep" style="font-size:11px;letter-spacing:.24em;opacity:.35;margin-top:14px">
        STARTING
      </div>
    </div>`;
  document.body.appendChild(loader);
  return loader;
}

async function boot() {
  const loader = showLoader();
  const bar = loader.querySelector<HTMLElement>('#loadbar')!;
  const step = loader.querySelector<HTMLElement>('#loadstep')!;

  // Yields to the browser so the loader actually paints between stages —
  // otherwise the whole boot runs inside one frame and the bar never moves.
  const stage = async (label: string, progress: number, work: () => void | Promise<void>) => {
    step.textContent = label;
    bar.style.width = `${progress}%`;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await work();
  };

  let engine!: Engine;
  let physics!: Physics;

  await stage('INITIALISING RENDERER', 12, () => {
    engine = new Engine(container);
  });

  await stage('STARTING PHYSICS', 26, async () => {
    physics = await Physics.init();
  });

  await stage('BUILDING TERMINAL', 52, () => {
    // The Game constructor bakes textures, builds the level and pre-builds the
    // zombie pool — by far the longest stage.
  });

  let game!: Game;
  await stage('RAISING THE DEAD', 88, () => {
    game = new Game(container, engine, physics);
  });

  await stage('READY', 100, () => {
    engine.start();
  });

  // Expose for debugging in the console; harmless in production.
  (window as unknown as Record<string, unknown>).__necropolis = { engine, physics, game };

  loader.style.opacity = '0';
  setTimeout(() => loader.remove(), 600);
}

boot().catch((err) => {
  console.error(err);
  const message = document.createElement('div');
  message.style.cssText = `position:fixed;inset:0;display:grid;place-items:center;
    background:#05060a;color:#ff6a55;font-family:monospace;padding:40px;text-align:center`;
  message.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
  document.body.appendChild(message);
});
