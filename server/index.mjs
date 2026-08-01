#!/usr/bin/env node
/**
 * Necropolis co-op server.
 *
 * One process, one port, one URL. That constraint drives the whole file: an
 * invite link has to be a single thing you can paste into a chat window, and a
 * cross-network tunnel is far easier to reason about when there is exactly one
 * port behind it. So this serves the game itself *and* the WebSocket the game
 * talks over, and the invite link is just the page URL with the lobby code on
 * it.
 *
 * Two serving modes:
 *
 *   - **Built** (default). Serves `dist/`. This is what you run for a real
 *     session — the client is minified and there is no second process.
 *   - **Dev** (`--dev`). Proxies everything that is not the game socket through
 *     to the Vite dev server, HMR's own WebSocket included, so a teammate on
 *     another machine sees your edits live.
 *
 * Usage:
 *   node server/index.mjs                 # serve dist/ on :8080
 *   node server/index.mjs --dev           # proxy to Vite on :5173
 *   node server/index.mjs --port 9000
 *   node server/index.mjs --tunnel        # also open a public cloudflared URL
 */

import { createServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { WebSocketServer } from 'ws';
import { LobbyRegistry, MAX_PLAYERS, Player } from './lobby.mjs';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const DIST = join(ROOT, 'dist');

/* --- Arguments ---------------------------------------------------------- */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};

const PORT = Number(option('port', process.env.PORT ?? 8080));
const DEV = flag('dev');
const VITE_PORT = Number(option('vite-port', process.env.VITE_PORT ?? 5173));
const TUNNEL = flag('tunnel');
/** Path the game socket lives on. Everything else is the web server's. */
const WS_PATH = '/ws';

/* --- Static file serving ------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function serveStatic(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  // Contain the path inside dist/. `normalize` collapses the `..` segments a
  // crafted request would use to climb out; the prefix test is what actually
  // refuses it, since normalize alone happily produces a path above the root.
  const target = join(DIST, normalize(pathname));
  if (!target.startsWith(DIST + sep) && target !== DIST) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let file = target;
  if (!existsSync(file) || !statSync(file).isFile()) {
    // Unknown path: hand back the entry document so `/?lobby=ABC123` and any
    // future client-side route resolve instead of 404ing.
    file = join(DIST, 'index.html');
    if (!existsSync(file)) {
      res
        .writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
        .end('The client has not been built yet.\n\nRun:  npm run build\nOr for live editing:  npm run dev  (in one terminal)  +  npm run server:dev\n');
      return;
    }
  }

  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  // Hashed asset filenames are safe to cache hard; documents must not be, or a
  // teammate who reloads gets yesterday's client against today's protocol.
  const immutable = /\/assets\/.+-[A-Za-z0-9_-]{8,}\./.test(file.replace(/\\/g, '/'));
  res.writeHead(200, {
    'content-type': type,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}

/** Dev mode: hand the request to Vite and stream the answer back. */
function proxyToVite(req, res) {
  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port: VITE_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${VITE_PORT}` },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', () => {
    res
      .writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      .end(`Vite is not answering on :${VITE_PORT}.\n\nStart it with:  npm run dev\n`);
  });
  req.pipe(upstream);
}

const httpServer = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({ ok: true, lobbies: registry.lobbies.size }),
    );
    return;
  }
  if (DEV) proxyToVite(req, res);
  else serveStatic(req, res);
});

/* --- WebSocket routing -------------------------------------------------- */

const wss = new WebSocketServer({ noServer: true });
const registry = new LobbyRegistry();

httpServer.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');

  if (pathname === WS_PATH) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    return;
  }

  // Anything else upgrading in dev mode is Vite's HMR socket. It has to reach
  // Vite or the page reloads in a loop, so the raw connection is spliced
  // through rather than parsed — this server has no business reading it.
  if (DEV) {
    const upstream = netConnect(VITE_PORT, '127.0.0.1', () => {
      upstream.write(
        `${req.method} ${req.url} HTTP/1.1\r\n` +
          Object.entries(req.headers)
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
            .join('\r\n') +
          '\r\n\r\n',
      );
      if (head?.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    return;
  }

  socket.destroy();
});

/* --- Protocol ----------------------------------------------------------- */

const send = (socket, message) => {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
};

const fail = (socket, code, message) => send(socket, { t: 'error', code, message });

/**
 * Pushes the roster to everybody in a lobby. This is the only message the
 * server originates about game state, and it is the reason the scoreboard in
 * the corner of the screen agrees between machines even when a player is across
 * the map and out of snapshot range.
 */
function broadcastLobby(lobby) {
  const payload = {
    t: 'lobby',
    code: lobby.code,
    hostId: lobby.hostId,
    started: lobby.started,
    seed: lobby.seed,
    maxPlayers: MAX_PLAYERS,
    players: lobby.roster,
  };
  for (const player of lobby.players.values()) send(player.socket, payload);
}

/**
 * Trims a submitted name to something that fits above a head.
 *
 * Control and bidi characters are stripped rather than escaped. The name is
 * rendered into a canvas texture for the nametag and into the DOM for the
 * scoreboard, and the client writes it with `textContent`, so markup is inert —
 * but a zero-width space or a right-to-left override still lets one player make
 * another's nametag unreadable, and nobody needs those in a callsign.
 */
function cleanName(raw, fallback) {
  const name = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\ufeff]/g, '')
    .trim()
    .slice(0, 16);
  return name.length > 0 ? name : fallback;
}

wss.on('connection', (socket) => {
  /** @type {Player | null} */
  let player = null;
  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });

  const leave = () => {
    if (!player?.lobby) return;
    const lobby = player.lobby;
    const id = player.id;
    const wasHost = lobby.hostId === id;
    lobby.remove(id);
    for (const other of lobby.players.values()) {
      send(other.socket, { t: 'left', id, hostMigrated: wasHost ? lobby.hostId : null });
    }
    broadcastLobby(lobby);
    player = null;
  };

  const enter = (lobby, name) => {
    const joined = new Player(socket, cleanName(name, `Operator ${lobby.players.size + 1}`));
    if (!lobby.add(joined)) {
      fail(socket, 'full', 'That lobby is full.');
      return null;
    }
    player = joined;
    send(socket, {
      t: 'joined',
      code: lobby.code,
      seed: lobby.seed,
      started: lobby.started,
      hostId: lobby.hostId,
      maxPlayers: MAX_PLAYERS,
      you: joined.toPublic(),
      players: lobby.roster,
    });
    // Existing members learn about the arrival as an event as well as through
    // the roster: the client uses it to hand a pooled operator rig over, which
    // is not something a whole-roster diff should have to infer.
    for (const other of lobby.players.values()) {
      if (other !== joined) send(other.socket, { t: 'joinedPlayer', player: joined.toPublic() });
    }
    broadcastLobby(lobby);
    return joined;
  };

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return fail(socket, 'badjson', 'Message was not JSON.');
    }
    if (!message || typeof message.t !== 'string') return;
    if (player) player.lastSeen = Date.now();

    switch (message.t) {
      case 'create': {
        if (player?.lobby) return fail(socket, 'already', 'Already in a lobby.');
        enter(registry.create(), message.name);
        return;
      }

      case 'join': {
        if (player?.lobby) return fail(socket, 'already', 'Already in a lobby.');
        const lobby = registry.find(message.code);
        if (!lobby) return fail(socket, 'nolobby', 'No lobby with that code.');
        if (lobby.players.size >= MAX_PLAYERS) return fail(socket, 'full', 'That lobby is full.');
        enter(lobby, message.name);
        return;
      }

      case 'name': {
        if (!player?.lobby) return;
        player.name = cleanName(message.name, player.name);
        broadcastLobby(player.lobby);
        return;
      }

      case 'start': {
        const lobby = player?.lobby;
        if (!lobby) return;
        if (lobby.hostId !== player.id) return fail(socket, 'nothost', 'Only the host can start.');
        if (lobby.started) return;
        lobby.started = true;
        for (const other of lobby.players.values()) {
          send(other.socket, { t: 'started', seed: lobby.seed, players: lobby.roster });
        }
        broadcastLobby(lobby);
        return;
      }

      /**
       * Score, and only score. The server keeps a copy purely so the corner
       * scoreboard can show a teammate who is nowhere near you and therefore
       * outside the range snapshots are exchanged in.
       */
      case 'score': {
        if (!player?.lobby) return;
        if (Number.isFinite(message.points)) player.points = Math.trunc(message.points);
        if (Number.isFinite(message.kills)) player.kills = Math.trunc(message.kills);
        player.downed = Boolean(message.downed);
        player.alive = message.alive !== false;
        broadcastLobby(player.lobby);
        return;
      }

      /**
       * The relay. `data` is never inspected — it is the client's own protocol,
       * and the day it gains a field this file should not need to know.
       */
      case 'relay': {
        const lobby = player?.lobby;
        if (!lobby) return;
        const envelope = { t: 'msg', from: player.id, data: message.data };
        if (message.to === 'host') {
          const host = lobby.players.get(lobby.hostId);
          if (host && host !== player) send(host.socket, envelope);
          // A host relaying to 'host' is talking to itself; the client handles
          // that locally and never sends it, but dropping it here too means a
          // host migration mid-flight cannot echo a message back at its sender.
          return;
        }
        if (typeof message.to === 'string' && message.to !== 'all') {
          const target = lobby.players.get(message.to);
          if (target) send(target.socket, envelope);
          return;
        }
        for (const other of lobby.players.values()) {
          if (other !== player) send(other.socket, envelope);
        }
        return;
      }

      case 'leave': {
        leave();
        return;
      }

      case 'ping': {
        // Echoed straight back with the client's own stamp so it can measure
        // round-trip time without the server needing a synchronised clock.
        send(socket, { t: 'pong', at: message.at });
        return;
      }

      default:
        return;
    }
  });

  socket.on('close', leave);
  socket.on('error', leave);
});

/**
 * Dead-socket sweep. A laptop that sleeps or a phone that loses Wi-Fi leaves a
 * socket that is open as far as TCP is concerned but will never speak again;
 * without this the lobby keeps a ghost in it, holding an operator slot that a
 * real player then cannot have.
 */
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
  registry.sweep();
}, 15_000);
heartbeat.unref();

/* --- Startup banner ----------------------------------------------------- */

/** Every address a teammate on the same network could reach this laptop at. */
function lanAddresses() {
  const found = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) found.push(address.address);
    }
  }
  return found;
}

/**
 * Opens a public URL with cloudflared, if it is installed.
 *
 * This is what makes "invite someone on a different network" work without
 * touching the router. cloudflared makes an outbound connection and hands back
 * an https URL that terminates at this process, so the friend needs no account,
 * no client, and no knowledge of anybody's IP address. WebSockets ride the same
 * tunnel, which is the reason the game socket shares this port.
 */
function startTunnel() {
  const child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let announced = false;
  const scan = (chunk) => {
    const text = chunk.toString();
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (match && !announced) {
      announced = true;
      console.log(`\n  🌍 Public (any network):  ${match[0]}`);
      console.log('     Share that link with friends anywhere. It lasts as long as this server runs.\n');
    }
  };
  child.stdout.on('data', scan);
  child.stderr.on('data', scan);

  child.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.log('\n  ⚠ --tunnel needs cloudflared, which is not installed.');
      console.log('     brew install cloudflared    then run this again.\n');
    } else {
      console.log(`\n  ⚠ Tunnel failed: ${err.message}\n`);
    }
  });

  const stop = () => child.kill();
  process.on('exit', stop);
  process.on('SIGINT', () => {
    stop();
    process.exit(0);
  });
}

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.\n  Try:  npm run server -- --port ${PORT + 1}\n`);
    process.exit(1);
  }
  throw err;
});

httpServer.listen(PORT, '0.0.0.0', () => {
  const mode = DEV ? `dev (proxying Vite on :${VITE_PORT})` : 'built';
  console.log(`\n  NECROPOLIS co-op server — ${mode}`);
  if (!DEV && !existsSync(join(DIST, 'index.html'))) {
    console.log('\n  ⚠ dist/ is empty. Run  npm run build  first, or use  npm run server:dev\n');
  }
  console.log(`\n  💻 This laptop:           http://localhost:${PORT}`);
  for (const address of lanAddresses()) {
    console.log(`  🏠 Same network (LAN):    http://${address}:${PORT}`);
  }
  if (!TUNNEL) {
    console.log('\n     For friends on other networks, add  --tunnel  (needs cloudflared).');
  }
  console.log('');
  if (TUNNEL) startTunnel();
});
