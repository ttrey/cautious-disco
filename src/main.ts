import { NetClient } from './net/NetClient';
import { Menu } from './ui/Menu';
import { resolveQuality } from './core/Quality';
import type { Engine } from './core/Engine';
import type { Game } from './core/Game';
import type { Physics } from './core/Physics';
import type { NetSession } from './net/NetSession';
import type { SurfaceId } from './assets/TextureForge';

/**
 * The menu is the entry point. The renderer, Three.js, Rapier, the level and
 * character rigs are loaded only after a player commits to starting a match.
 */

const container = document.getElementById('app')!;

const GAME_SURFACES: readonly SurfaceId[] = [
  'concrete',
  'plaster',
  'brick',
  'woodPlank',
  'gunWood',
  'rustedMetal',
  'gunmetal',
  'polymer',
  'asphalt',
  'tile',
  'paintedMetal',
  'zombieSkin',
  'zombieCloth',
];

const OPERATOR_SURFACES: readonly SurfaceId[] = [
  'soldierSkin',
  'cordura',
  'camoWoodland',
  'camoArid',
  'camoDesert',
  'camoUrban',
];

interface Runtime {
  engine: Engine;
  physics: Physics;
  game: Game;
}

function showLoader() {
  const loader = document.createElement('div');
  loader.style.cssText = `
    position: fixed; inset: 0; display: grid; place-items: center; z-index: 40;
    background: #05060a; color: #efe6d4; font-family: 'Rajdhani', system-ui, sans-serif;
    transition: opacity .35s;`;
  loader.innerHTML = `
    <div style="text-align:center">
      <div style="font-size:52px;letter-spacing:.18em;color:#b3231f;font-weight:700">NECROPOLIS</div>
      <div style="font-size:13px;letter-spacing:.36em;opacity:.5;margin-top:10px">
        PREPARING MATCH
      </div>
      <div style="margin-top:26px;width:220px;height:2px;background:rgba(255,255,255,.12);
                  overflow:hidden;margin-left:auto;margin-right:auto">
        <div id="loadbar" style="width:0;height:100%;background:#b3231f;transition:width .2s"></div>
      </div>
      <div id="loadstep" style="font-size:11px;letter-spacing:.24em;opacity:.35;margin-top:14px">
        LOADING GAME CODE
      </div>
    </div>`;
  document.body.appendChild(loader);
  return {
    root: loader,
    bar: loader.querySelector<HTMLElement>('#loadbar')!,
    step: loader.querySelector<HTMLElement>('#loadstep')!,
  };
}

let runtimePromise: Promise<Runtime> | null = null;
let activeLoader: ReturnType<typeof showLoader> | null = null;

function loadRuntime(menu: Menu, includeOperators: boolean): Promise<Runtime> {
  if (runtimePromise) return runtimePromise;

  runtimePromise = (async () => {
    const loader = showLoader();
    activeLoader = loader;
    const stage = async (label: string, progress: number, work: () => void | Promise<void>) => {
      loader.step.textContent = label;
      loader.bar.style.width = `${progress}%`;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      await work();
    };

    let EngineClass!: typeof import('./core/Engine').Engine;
    let PhysicsClass!: typeof import('./core/Physics').Physics;
    let GameClass!: typeof import('./core/Game').Game;
    let textures!: typeof import('./assets/TextureForge');

    await stage('LOADING GAME CODE', 10, async () => {
      const modules = await Promise.all([
        import('./core/Engine'),
        import('./core/Physics'),
        import('./core/Game'),
        import('./assets/TextureForge'),
      ]);
      EngineClass = modules[0].Engine;
      PhysicsClass = modules[1].Physics;
      GameClass = modules[2].Game;
      textures = modules[3];
    });

    const quality = resolveQuality(menu.qualityPreference);
    textures.configureTextureQuality(quality.textureScale, quality.anisotropy);
    const surfaces = includeOperators ? [...GAME_SURFACES, ...OPERATOR_SURFACES] : GAME_SURFACES;

    await stage(`BAKING SURFACES · ${quality.preset.toUpperCase()}`, 22, async () => {
      await textures.prewarmSurfaces(surfaces, (completed, total) => {
        loader.bar.style.width = `${22 + (completed / total) * 48}%`;
        loader.step.textContent = `BAKING SURFACES ${completed}/${total}`;
      });
    });

    let engine!: Engine;
    await stage('INITIALISING RENDERER', 74, () => {
      engine = new EngineClass(container, quality);
    });

    let physics!: Physics;
    await stage('STARTING PHYSICS', 82, async () => {
      physics = await PhysicsClass.init();
    });

    let game!: Game;
    await stage('BUILDING TERMINAL', 90, () => {
      game = new GameClass(container, engine, physics);
    });

    await stage('READY', 100, () => undefined);
    loader.root.style.opacity = '0';
    setTimeout(() => loader.root.remove(), 400);
    activeLoader = null;

    const runtime = { engine, physics, game };
    const exposed = (window as unknown as Record<string, unknown>).__necropolis as
      | Record<string, unknown>
      | undefined;
    (window as unknown as Record<string, unknown>).__necropolis = { ...exposed, ...runtime, quality };
    return runtime;
  })().catch((error) => {
    runtimePromise = null;
    throw error;
  });

  return runtimePromise;
}

function showRuntimeError(menu: Menu, error: unknown) {
  console.error(error);
  activeLoader?.root.remove();
  activeLoader = null;
  if (!menu.visible) menu.show('main');
  menu.showError(error instanceof Error ? error.message : String(error));
}

/** Connects the immediately available menu to the lazily created game. */
function wireFrontEnd(): Menu {
  let net: NetClient | null = null;
  let session: NetSession | null = null;
  let callsign = '';

  const menu: Menu = new Menu(container, {
    onSinglePlayer: async () => {
      try {
        const { game } = await loadRuntime(menu, false);
        game.startSinglePlayer();
      } catch (error) {
        showRuntimeError(menu, error);
      }
    },

    onCreateLobby: async (name) => {
      callsign = name;
      const client = await openSocket();
      if (client) client.create(name);
    },

    onJoinLobby: async (name, code) => {
      callsign = name;
      const client = await openSocket();
      if (client) client.join(code, name);
    },

    onStartGame: () => net?.start(),

    onDropIn: () => {
      if (!session) return;
      void loadRuntime(menu, true)
        .then(({ game }) => game.startMultiplayer(session!, callsign))
        .catch((error) => showRuntimeError(menu, error));
    },

    onLeaveLobby: () => {
      net?.close();
      net = null;
      session = null;
    },
  });

  /** Opens the socket on demand, and reports a failure the player can act on. */
  const openSocket = async (): Promise<NetClient | null> => {
    if (net) return net;
    const client = new NetClient({
      onJoined: (code) => menu.showLobby(code, client.inviteLink()),
      onRoster: (roster) =>
        menu.setRoster(roster, client.selfId, client.isHost, client.maxPlayers, client.latency),
      onStarted: async () => {
        try {
          const { game } = await loadRuntime(menu, true);
          session = game.createSession(client);
          if (client.isHost) {
            menu.hide();
            game.startMultiplayer(session, callsign);
          } else {
            menu.showDropIn();
          }
        } catch (error) {
          showRuntimeError(menu, error);
        }
      },
      onError: (message) => menu.showError(message),
    });

    try {
      await client.connect();
    } catch (err) {
      menu.showError(err instanceof Error ? err.message : 'Could not reach the server.');
      return null;
    }
    net = client;
    return client;
  };

  const invited = new URLSearchParams(location.search).get('lobby');
  if (invited) menu.applyInviteCode(invited);
  else menu.show('main');
  return menu;
}

try {
  const menu = wireFrontEnd();
  (window as unknown as Record<string, unknown>).__necropolis = { menu };
} catch (err) {
  console.error(err);
  const message = document.createElement('div');
  message.style.cssText = `position:fixed;inset:0;display:grid;place-items:center;
    background:#05060a;color:#ff6a55;font-family:monospace;padding:40px;text-align:center`;
  message.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
  document.body.appendChild(message);
}
