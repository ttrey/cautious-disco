/**
 * Lobby registry.
 *
 * The server is deliberately not a game server. It knows about *membership* —
 * who is in which lobby, who is the host, which operator each player was handed
 * — and about nothing else. Every gameplay message is an opaque blob it
 * forwards without looking inside.
 *
 * That split is the whole design. The simulation rules live in the TypeScript
 * client where they can share code with the single-player game; putting them
 * here would mean writing every rule twice, in two languages, and keeping them
 * in agreement forever. What the server owns instead is the small set of facts
 * that genuinely cannot be decided by any one peer: which codes exist, who
 * holds a slot, and who inherits the host role when the host's laptop lid
 * closes mid-round.
 */

/**
 * Code alphabet, with the characters people confuse when reading a code aloud
 * removed: no O/0, no I/1/L, no S/5, no Z/2. What is left is unambiguous over a
 * voice call, which is how these codes actually get shared.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRTUVWXY346789';
const CODE_LENGTH = 6;

/**
 * Four is the cap, and it is a level-design constant rather than a network one:
 * Ashgate Terminal's spawn spread, its two arenas and its perk placement are all
 * laid out for four. The client's `RemotePlayerManager` pools exactly four
 * operator rigs for the same reason.
 */
export const MAX_PLAYERS = 4;

/**
 * Operator assignment order. The server hands these out rather than letting
 * clients pick, so every machine in the lobby draws the same four characters in
 * the same order and a nametag always sits above the body it belongs to.
 */
const OPERATORS = ['vance', 'novak', 'ito', 'rook'];

/** A lobby with nobody in it is swept this long after the last player leaves. */
const EMPTY_LOBBY_TTL_MS = 60_000;

let nextPlayerId = 1;

export class Lobby {
  constructor(code) {
    this.code = code;
    /** @type {Map<string, Player>} */
    this.players = new Map();
    this.hostId = null;
    this.started = false;
    /**
     * Shared RNG seed, fixed when the lobby is created rather than when the
     * game starts. Anything a late joiner has to agree with the host about —
     * cosmetic scatter, variant choice — derives from this.
     */
    this.seed = (Math.random() * 0xffffffff) >>> 0;
    this.emptySince = Date.now();
  }

  get roster() {
    return [...this.players.values()].map((p) => p.toPublic());
  }

  /** The operator slots nobody is holding, in canonical order. */
  freeOperators() {
    const taken = new Set([...this.players.values()].map((p) => p.operator));
    return OPERATORS.filter((o) => !taken.has(o));
  }

  add(player) {
    const operator = this.freeOperators()[0];
    if (!operator) return false;
    player.operator = operator;
    player.lobby = this;
    this.players.set(player.id, player);
    if (!this.hostId) this.hostId = player.id;
    this.emptySince = 0;
    return true;
  }

  remove(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    this.players.delete(playerId);
    player.lobby = null;

    // Host migration. Without it, a lobby whose host drops keeps running but
    // nothing owns the horde any more: zombies freeze where they stand and the
    // round never ends. The next player in join order takes over, and the
    // client-side handover re-seeds its horde from its own pool.
    if (this.hostId === playerId) {
      const next = this.players.keys().next();
      this.hostId = next.done ? null : next.value;
    }
    if (this.players.size === 0) this.emptySince = Date.now();
  }

  isExpired(now) {
    return this.players.size === 0 && this.emptySince > 0 && now - this.emptySince > EMPTY_LOBBY_TTL_MS;
  }
}

export class Player {
  constructor(socket, name) {
    this.id = `p${nextPlayerId++}`;
    this.socket = socket;
    this.name = name;
    this.operator = null;
    /** @type {Lobby | null} */
    this.lobby = null;
    this.points = 500;
    this.kills = 0;
    this.downed = false;
    this.alive = true;
    /** Last time anything arrived from this socket, for the idle sweep. */
    this.lastSeen = Date.now();
  }

  get isHost() {
    return this.lobby?.hostId === this.id;
  }

  toPublic() {
    return {
      id: this.id,
      name: this.name,
      operator: this.operator,
      points: this.points,
      kills: this.kills,
      downed: this.downed,
      alive: this.alive,
      host: this.isHost,
    };
  }
}

export class LobbyRegistry {
  constructor() {
    /** @type {Map<string, Lobby>} */
    this.lobbies = new Map();
  }

  /** Six characters is 27^6 ≈ 387 million; collisions are re-rolled anyway. */
  #freshCode() {
    for (let attempt = 0; attempt < 500; attempt++) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
      if (!this.lobbies.has(code)) return code;
    }
    throw new Error('could not allocate a lobby code');
  }

  create() {
    const lobby = new Lobby(this.#freshCode());
    this.lobbies.set(lobby.code, lobby);
    return lobby;
  }

  /**
   * Codes are matched case-insensitively and with separators stripped, because
   * people type them out of a chat message where they may have been wrapped in
   * punctuation or pasted with the surrounding URL.
   */
  find(code) {
    if (typeof code !== 'string') return null;
    const normalised = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return this.lobbies.get(normalised) ?? null;
  }

  sweep() {
    const now = Date.now();
    for (const [code, lobby] of this.lobbies) {
      if (lobby.isExpired(now)) this.lobbies.delete(code);
    }
  }
}

export { CODE_ALPHABET, CODE_LENGTH, OPERATORS };
