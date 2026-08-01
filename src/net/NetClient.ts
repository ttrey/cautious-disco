import {
  GameMessage,
  LobbyInbound,
  LobbyOutbound,
  RosterEntry,
} from './Protocol';

/**
 * The connection to the lobby server.
 *
 * Deliberately dumb about the game: it knows how to get a socket open, how to
 * hold the roster, and how to hand game messages to whoever asked for them.
 * Everything about what those messages *mean* lives in `NetSession`.
 *
 * The socket URL is derived from the page rather than configured, which is what
 * makes one invite link work everywhere. Load the page from
 * `http://192.168.50.28:8080` on the LAN and the socket goes to
 * `ws://192.168.50.28:8080/ws`; load the same page through an https tunnel and
 * it goes to `wss://<tunnel>/ws` with no setting to get wrong. A hard-coded
 * host would have to be edited for every one of those cases, and would be the
 * first thing to break when the tunnel URL changes.
 */

export type NetStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'error';

export interface NetEvents {
  onStatus?: (status: NetStatus, detail?: string) => void;
  onRoster?: (roster: RosterEntry[]) => void;
  onJoined?: (code: string, you: RosterEntry) => void;
  onStarted?: () => void;
  onPlayerJoined?: (player: RosterEntry) => void;
  onPlayerLeft?: (id: string, hostMigratedTo: string | null) => void;
  onGameMessage?: (from: string, data: GameMessage) => void;
  onError?: (message: string) => void;
}

/**
 * Where the game socket lives.
 *
 * In production the server serves the page too, so same-origin is right. In
 * `npm run dev` the page comes from Vite on 5173 while the game server is on
 * 8080, so the port is overridden — a dev convenience that must never be
 * allowed to apply to a real deployment, hence the explicit localhost test.
 */
export function defaultSocketUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const override = new URLSearchParams(location.search).get('server');
  if (override) {
    // `?server=` is for pointing a client at another machine's server by hand,
    // which is occasionally the fastest way to test two builds against each
    // other. Accepts a bare host:port as well as a full ws:// URL.
    return /^wss?:\/\//.test(override) ? override : `${scheme}//${override}/ws`;
  }
  const viteDev = location.port === '5173';
  const host = viteDev ? `${location.hostname}:8080` : location.host;
  return `${scheme}//${host}/ws`;
}

export class NetClient {
  private socket: WebSocket | null = null;
  private events: NetEvents;
  private readonly url: string;

  /** Everything the server has told us about the lobby. */
  roster: RosterEntry[] = [];
  code = '';
  selfId = '';
  hostId = '';
  seed = 0;
  started = false;
  maxPlayers = 4;
  status: NetStatus = 'idle';
  /** Smoothed round-trip time in milliseconds, for the lobby readout. */
  latency = 0;

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** Queued while the socket is still opening; flushed on open. */
  private readonly pending: LobbyOutbound[] = [];

  constructor(events: NetEvents = {}, url = defaultSocketUrl()) {
    this.events = events;
    this.url = url;
  }

  get isHost(): boolean {
    return this.selfId !== '' && this.selfId === this.hostId;
  }

  /**
   * Adds or replaces callbacks after construction.
   *
   * The lobby UI owns this socket while a player is choosing a callsign and
   * waiting in the waiting room; once the round starts the session takes over
   * the game-facing ones. Merging rather than replacing wholesale means the
   * handover does not have to restate the handlers it is not interested in —
   * the menu keeps getting roster updates so the lobby screen stays live if the
   * player backs out to it.
   */
  setHandlers(events: Partial<NetEvents>) {
    this.events = { ...this.events, ...events };
  }

  get self(): RosterEntry | null {
    return this.roster.find((p) => p.id === this.selfId) ?? null;
  }

  get others(): RosterEntry[] {
    return this.roster.filter((p) => p.id !== this.selfId);
  }

  connect(): Promise<void> {
    if (this.socket && this.status === 'connected') return Promise.resolve();
    this.setStatus('connecting');

    return new Promise((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.url);
      } catch (err) {
        this.setStatus('error', String(err));
        reject(err);
        return;
      }
      this.socket = socket;

      // A server that is not running fails as a plain close with no useful
      // detail, so the timeout is what turns "nothing happened" into a message
      // the player can act on.
      const timeout = setTimeout(() => {
        if (this.status !== 'connected') {
          socket.close();
          this.setStatus('error', 'timeout');
          reject(new Error(`No answer from ${this.url}. Is the server running?`));
        }
      }, 8000);

      socket.onopen = () => {
        clearTimeout(timeout);
        this.setStatus('connected');
        for (const message of this.pending.splice(0)) this.send(message);
        this.startPings();
        resolve();
      };

      socket.onmessage = (event) => {
        let message: LobbyInbound;
        try {
          message = JSON.parse(event.data as string);
        } catch {
          return;
        }
        this.handle(message);
      };

      socket.onerror = () => {
        clearTimeout(timeout);
        if (this.status !== 'connected') {
          this.setStatus('error', 'refused');
          reject(new Error(`Could not reach ${this.url}. Is the server running?`));
        }
      };

      socket.onclose = () => {
        clearTimeout(timeout);
        this.stopPings();
        if (this.status === 'connected') this.setStatus('closed');
      };
    });
  }

  private setStatus(status: NetStatus, detail?: string) {
    this.status = status;
    this.events.onStatus?.(status, detail);
  }

  private startPings() {
    this.stopPings();
    this.pingTimer = setInterval(() => this.send({ t: 'ping', at: performance.now() }), 3000);
  }

  private stopPings() {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private handle(message: LobbyInbound) {
    switch (message.t) {
      case 'joined':
        this.code = message.code;
        this.selfId = message.you.id;
        this.hostId = message.hostId;
        this.seed = message.seed;
        this.started = message.started;
        this.maxPlayers = message.maxPlayers;
        this.roster = message.players;
        this.events.onJoined?.(message.code, message.you);
        this.events.onRoster?.(this.roster);
        break;

      case 'lobby':
        this.code = message.code;
        this.hostId = message.hostId;
        this.seed = message.seed;
        this.started = message.started;
        this.maxPlayers = message.maxPlayers;
        this.roster = message.players;
        this.events.onRoster?.(this.roster);
        break;

      case 'joinedPlayer':
        this.events.onPlayerJoined?.(message.player);
        break;

      case 'left':
        this.events.onPlayerLeft?.(message.id, message.hostMigrated);
        break;

      case 'started':
        this.started = true;
        this.seed = message.seed;
        this.roster = message.players;
        this.events.onRoster?.(this.roster);
        this.events.onStarted?.();
        break;

      case 'msg':
        this.events.onGameMessage?.(message.from, message.data);
        break;

      case 'pong': {
        // Exponentially smoothed: a single scheduler hiccup should not make the
        // lobby claim the connection just got twice as bad.
        const sample = performance.now() - message.at;
        this.latency = this.latency === 0 ? sample : this.latency * 0.7 + sample * 0.3;
        break;
      }

      case 'error':
        this.events.onError?.(message.message);
        break;
    }
  }

  send(message: LobbyOutbound) {
    if (!this.socket || this.socket.readyState === WebSocket.CONNECTING) {
      this.pending.push(message);
      return;
    }
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  /* --- Convenience ------------------------------------------------------ */

  create(name: string) {
    this.send({ t: 'create', name });
  }

  join(code: string, name: string) {
    this.send({ t: 'join', code, name });
  }

  start() {
    this.send({ t: 'start' });
  }

  setName(name: string) {
    this.send({ t: 'name', name });
  }

  reportScore(points: number, kills: number, downed: boolean, alive: boolean) {
    this.send({ t: 'score', points, kills, downed, alive });
  }

  relay(data: GameMessage, to: 'all' | 'host' | string = 'all') {
    this.send({ t: 'relay', to, data });
  }

  /** The link a player pastes to a friend. Same page, lobby code attached. */
  inviteLink(): string {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('lobby', this.code);
    return url.toString();
  }

  close() {
    this.stopPings();
    this.send({ t: 'leave' });
    this.socket?.close();
    this.socket = null;
    this.status = 'idle';
  }
}
