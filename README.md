# NECROPOLIS

A first-person, wave-based zombie survival game in the classic *Call of Duty:
Zombies* shape — survive rounds, earn points by hitting things, spend them on
doors, wall weapons, a mystery box, perks and a weapon upgrade station.

Built with Three.js, Rapier and TypeScript on Vite.

Up to four players co-operatively, over a LAN or across the internet, from a
server you run yourself.

```bash
npm install
npm run dev          # solo, http://localhost:5173
npm run host         # co-op: build + serve the game and lobbies on :8080
npm run host:public  # same, plus a public URL for friends on other networks
npm run build        # production build into dist/
npm run typecheck
```

See [Multiplayer](#multiplayer) for the lobby flow and how to invite people.

| | |
|---|---|
| **WSAD** | Move |
| **Shift / Ctrl / Space** | Sprint / crouch / jump |
| **Mouse** | Look · left fire · right aim down sights |
| **R** | Reload |
| **1 / 2 / Q** | Switch weapon |
| **E** | Buy · hold to repair a barrier |
| **F** | Inspect weapon |

---

## The map

**Ashgate Terminal** — a derelict railway terminal, ten areas, laid out for up
to four players.

```
                  ┌──────── signal box ────────┐        Pack-a-Punch
                  └──────────┬────┬────────────┘
     ┌──────────────── train shed ──────────────┐        the big arena
     └──────┬───────────────────────────────┬───┤
     ┌───────────── service corridor ───────────┤
     │ plant  │ ░ court ░ │    warehouse    │   │
     ├────────┤  ┌─hall─┐ ├─────────────────┤ y │
     │        └──┤      ├─┘                 │ a │
     ├── canteen ┤ lobby├──── concourse ────┤ r │
     └───────────┴──────┴───────────────────┴─d─┘
```

The shape is doubled on purpose. One loop is enough for one player; four
players training the same circle run into each other, so there is an inner ring
(hall → warehouse → corridor → plant → hall) and an outer one (concourse → yard
→ corridor → plant → canteen → lobby), plus two arenas — the train shed and the
open-air loading yard — wide enough for two players to hold separate trains in
the same room. Every large area has at least two exits; the signal box is the
only dead end on the map, which is why Pack-a-Punch is in it.

Progression pulls outward from the start room: two cheap wings either side of
the lobby, the two workhorse rooms behind the classic doors, then the yard, the
shed and the signal box. Areas reachable from more than one room have a doorway
in each, and those are **one** purchase — buying the warehouse from the hall
also opens the concourse's door into it, because the alternative doorway is the
same purchase seen from another room. Six perks and seven wall buys are spread
so an east-side player and a west-side player are never queuing for the same
machine.

The service court in the middle is not a room. It is an enclosed light well no
player can reach, walled in on four sides, that six windows look into — a shared
spawn yard feeding the hall, the warehouse, the plant and the corridor at once.

There is also an asset turntable at **`/preview.html`** — keys `1`–`8`, `0`,
`U`, and `I` cycle through the eleven weapons, `Shift` + those keys shows the
selected live first-person viewmodel, `9` revisits that viewmodel, `Z` shows a zombie and
`A` the first-person arms. In a live viewmodel, `F` fires its visual action and
`R` runs its actual reload choreography under camera-relative studio lighting.
It exists because judging a normal map, a bevel or a hand pose inside a dark
running game is guesswork. Characters get their own harnesses —
**`/zlab.html`** for the zombie and **`/slab.html`** for the four operators —
because a turntable is the wrong tool for a face: judging one needs the *same*
framing before and after an edit, at the exposure the game actually renders at.
Both drive from the console (`__zlab`, `__slab`) with fixed camera presets, mesh
isolation and single-frame animation stepping; `__slab.pose(state)` additionally
drives an operator from the same `PlayerVisualState` a network snapshot
produces, so a walk cycle or a reload can be inspected one frame at a time.

Weapons get a third harness, **`/glab.html`**, because the turntable answers
"is the model right" and never "is it *framed* right". Every complaint about a
viewmodel — sitting too far back, sights off the crosshair, a hand holding air
beside the handguard — is a statement about the shipping first-person pass, so
this reproduces that pass exactly: the engine's viewmodel camera and light rig,
the real `ViewModel` driven by the real definitions, over a backdrop with range
markers at known distances and a screen-centre reticle marking where the sight
line has to land. `__glab.set(id, aiming)` and `__glab.freeze()` make successive
screenshots directly comparable; `__glab.vm` exposes the live viewmodel, which
is how grip-to-hand error is measured rather than eyeballed.

The lobby mystery box costs 950 points to spin, then
reveals a weapon for the player to claim. Its exclusive pool contains the Desert
Eagle, Barrett M82A1, SPAS-12, M240, FN SCAR-H, and two ultra-rare wonder
weapons: the explosive-plasma **Aether-9** and chain-lightning **Stormweaver**.
The conventional box weapons have weight 1; Aether-9 has weight 0.15 and
Stormweaver 0.10, making either markedly less likely than every standard box
weapon. All seven are intentionally absent from `WALL_WEAPONS` and every
wall-buy placement.

---

## Where the assets come from

**Everything you see is generated in code.** This build has no reachable
licensed model or texture library — Sketchfab and Poly Pizza are auth- and
licence-gated from here — so rather than ship pink placeholders or boxes
standing in for guns, the assets are authored procedurally. These are final
assets, not stand-ins; there is no "replace later" list.

Concretely:

- **`src/assets/TextureForge.ts`** bakes complete PBR map sets — albedo,
  roughness, metalness, ambient occlusion, and a normal map derived from a
  height field via a wrapped Sobel filter — for 13 surfaces (concrete, brick,
  plaster, tile, asphalt, two woods, gunmetal, polymer, rusted and painted
  metal, flesh, cloth) plus six for the player operators — four printed
  camouflage patterns on ripstop, 1000-denier Cordura webbing and living skin.
  Every surface is a per-texel function over tileable FBM noise, so the maps
  repeat seamlessly and the materials read as materials rather than as tinted
  plastic.
- **`src/weapons/GunSmith.ts`** assembles eleven weapons from chamfered solids,
  lathed muzzle devices and bevel-extruded receiver profiles at real
  proportions, with picatinny rails, slide serrations, handguard vents, curved
  magazines, tube magazines, an animated M240 feed cover and iron sights.
- **`src/zombies/ZombieMesh.ts`** builds a skinned humanoid against measured
  anthropometry: a 19-bone skeleton, tapered elliptical limb tubes with
  hand-authored radius profiles, a torso carrying rib, sternum and scapular
  relief, and a lofted skull with carved orbits, brow ridge, hollow cheeks and
  a real mandible line — plus separate eyes, lids, nose, lips, gums, teeth,
  ears and matted hair. The uniform is torn *geometrically*: garment panels are
  grids whose cells are dropped by a noise field and whose surviving boundary is
  snapped onto the iso-line, so holes are real holes with decaying flesh behind
  them and frayed, blood-darkened edges.
- **`src/characters/SoldierMesh.ts`** builds the four player operators on the
  same skeleton and the same primitives — both live in
  `src/characters/CharacterGeometry.ts` — but held to a higher bar, because a
  teammate is in frame for a whole round at conversational distance while a
  zombie is looked at for a second and a half in bad light. Faces are alive
  rather than decayed (orbital fat, zygomatic mass, lids that actually cover the
  globe, brows, per-operator beards); hands are four three-segment fingers and a
  thumb wrapped around a rod, so a weapon put in the fist is held rather than
  intersected; and the kit is layered the way real kit is — uniform, then
  armour, then what is mounted on the armour — across four materials so a
  helmet shell does not shade like a pouch.
- **`src/audio/AudioEngine.ts`** synthesises every sound through Web Audio —
  layered gunshots, formant-swept groans, impacts, perk jingles, round
  stingers, and an ambient bed — spatialised through panners into a generated
  convolution reverb. A gunshot is three layers, and *every parameter of all
  three* comes from the weapon's own `GunAudioSpec`: the action transient's
  pitch and its tone rolloff, the crack's centre frequency and where it sweeps
  to, the body's fundamental, low-pass corner and pitch drop. Sharing even one
  of them across the roster is enough to undo the rest — a fixed transient
  stamps the same tick on every weapon in the game, and the ear locks onto a
  sharp onset far harder than onto a low body tone.

Two techniques do most of the visual work and are worth calling out:

1. **Everything is chamfered.** `RoundedBoxGeometry` and bevelled extrusions
   put a highlight line on every edge. Sharp-cornered boxes read as programmer
   art precisely because they have none.
2. **Uniform texel density.** Generated parts come from sources whose native
   UVs disagree wildly — an `ExtrudeGeometry` emits UVs in shape units, so a
   0.1 m grip samples a 0.1 × 0.1 slice of its texture and renders as flat
   colour. Weapons are box-projected at a fixed tiles-per-metre; character
   meshes use arc-length UVs (box projection leaves visible seams on curved
   anatomy). See `boxProjectUV` in `src/util/geometry.ts`.

---

## Architecture

```
src/
  core/        Engine, Physics, Input, Nav, Effects, Environment, GradePass, Game
  entities/    Player
  weapons/     GunSmith, Arms, ViewModel, WeaponDefs, WeaponSystem
  zombies/     ZombieMesh, ZombieAnimations, Zombie, ZombieManager
  characters/  CharacterGeometry, SoldierMesh, SoldierAnimations,
               RemotePlayer, RemotePlayerManager, DemoSquad
  net/         Protocol, NetClient, NetSession
  map/         Level, Props
  ui/          HUD, Menu, Nametags
server/        index (http + websocket), lobby (rooms, codes, host migration)
  audio/       AudioEngine
  assets/      TextureForge, Materials, SpriteTextures
  util/        math, geometry, ik
  dev/         preview (asset turntable), zlab, slab (character harnesses),
               glab (first-person weapon framing)
```

`characters/CharacterGeometry.ts` is the floor under every humanoid: the
skeleton, the tapered limb tubes, the ring loft, the marching-squares grid
surface, the superelliptical skull and the automatic skinning. `ZombieMesh` and
`SoldierMesh` are two very different characters built out of the same box.

`Game` is the only place systems know about each other. It owns the round loop,
the economy, perks and the interaction probe, and contains no rendering,
geometry or AI. Everything else is independently constructible — you can build
a weapon, a zombie or the whole level without a `Game`.

### Notable decisions

**Rapier over cannon-es.** Two reasons. It is a Rust/WASM build, so the
broadphase and query pipeline are an order of magnitude faster once two dozen
agents are querying the world every frame. More importantly it ships
`KinematicCharacterController` with autostep, ground snapping and slope limits;
with cannon-es all of that is hand-rolled, and hand-rolled character
controllers are where FPS games get stuck on doorframes.

**Physics scope is deliberately narrow.** Static level geometry plus one
character controller. Zombies steer on a navigation grid instead of simulating
rigid bodies — two dozen dynamic capsules jostling each other is both slower
and far less predictable than explicit separation steering.

**Flow field, not per-agent A\*.** Every zombie wants to reach the same place,
so running A\* per agent solves one problem twenty-four times. A single
Dijkstra sweep from the player produces a distance field over the map and each
zombie descends the gradient — `O(cells)` once per player-cell-change instead of
`O(agents × path length)` every frame. Pathing also stays coherent when a door
opens. Steering then blends flow-field pursuit with neighbour separation and
wall avoidance; flow alone marches everyone down one grid line, separation
alone lets them walk through walls.

**The viewmodel renders in its own scene** through a narrow-FOV camera with a
cleared depth buffer, so weapons never clip into geometry, and it carries its
own three-point light rig (world lights are not visible to it). Its motion is
entirely procedural and *layered* — sway, bob, breathing, a recoil spring, ADS
blend, sprint pose and a reload timeline all contribute offsets to one base
transform. Layering rather than baking animations means every weapon inherits
the same weight for free, and adding a gun costs only data plus two grip points
(the arms are placed by analytic two-bone IK).

**Levels are compiled from one description.** Walls are declared as segments
with holes and compiled in a single pass into render geometry, physics
colliders *and* nav-grid blocking. Keeping the three in lockstep from one
source is what prevents the classic bug where a wall you can see is one you can
walk through.

**Zombie animation goes through `AnimationMixer`.** Clips are authored here as
keyframed pose data and compiled into real `AnimationClip`s, then cross-faded
properly. The shamble is deliberately asymmetric — one leg drags, the right
shoulder leads, the head lags a beat behind the torso. Symmetric walk cycles
read as a person, not as something that has stopped caring.

**Hitboxes are capsules evaluated from the live skeleton**, not a static box
around the model origin, so a headshot lands where the head actually is
mid-lunge. Limbs carry reduced damage multipliers.

**Contact occlusion is baked into vertex colours**, because the renderer cannot
see any of the detail that gives a character form. The shadow map is 2048 texels
over a 14 m frustum — roughly seven millimetres a texel — and a brow ridge, an
eye socket, a nostril, the fold under a collar and the inside of a hole torn in
a uniform are all smaller than that. The geometry is there and it lights exactly
like the flat surface beside it.

So `bakeVertexOcclusion` measures it once at build time, per vertex, from two
quantities over the same neighbourhood: what fraction of nearby points lie in
front of the surface (creases, sockets, folds) and what fraction lie *above* it
(the shadow a brow throws on a lid, a collar on a throat, a hem on a boot).
Both are expressed as fractions rather than counts, because a head is
tessellated an order of magnitude finer than a thigh and any absolute measure
reads the head as uniformly buried. Both also subtract a baseline first: a
character's surface is relief all the way down, so even a flat cheek measures a
steady occlusion, and mapping that straight through dims the whole model by a
constant instead of shaping it.

Meshes are passed each other as occluders, which is the part that matters most
on the horde: the uniform shades the body under it, so a tear reads as a hole
into a corpse rather than as a shape cut out of a decal.

**Other players are driven by snapshots, not by the animation system.** A
remote player is a stream of `PlayerSnapshot`s — position, yaw, pitch, weapon
id, a flag word, and *cumulative* shot and melee counters — and everything
visible is derived from that. Three decisions follow from it and are worth
stating:

- **The character is drawn 100 ms in the past.** Buffering two send intervals
  means there are almost always two real snapshots bracketing the moment being
  drawn, so the motion between them is interpolated rather than guessed.
  Extrapolating instead is smooth right up until the player changes direction,
  and then it visibly snaps back.
- **Velocity is measured from the interpolated positions rather than sent.** The
  legs have to match the movement actually being *drawn*; a velocity from the
  sender describes movement that has not been drawn yet, and feet that disagree
  with the ground they are crossing is the most recognisable artefact there is.
- **Events are counters, not booleans.** A `firing` flag sampled at 20 Hz misses
  shots from a 600 rpm weapon and misses every shot in a dropped packet. The
  difference between the last count seen and the newest is exactly how many
  rounds to play, however the packets arrived.

**The operators' weapon is a socket, not a prop in a hand.** Their upper body is
built the way `ViewModel` is, because it has to agree with what that player is
seeing on their own screen: carry poses — ready, shouldered, sprint, reload,
melee — blend into one transform on a socket hung off the rig root, the aim
pitch rotates it about the firing shoulder, and *then* both arms are solved onto
the weapon's `leftGrip`/`rightGrip` by the same two-bone IK the first-person
arms use. One set of grip data drives both views, so a weapon added later is
held correctly in third person for free — and the muzzle points where the player
is actually aiming, which a hand animation can only ever approximate.

**Eight-way movement without eight cycles.** The legs are yawed toward the
direction of travel and the spine counter-rotates back onto the aim, which is
what a person does when they strafe. Two gait cycles then cover every direction
with the upper body locked to the weapon throughout. The pelvis height is not
authored at all: `plantedDrop` solves it from the leg pose every keyframe, so
any set of gait parameters produces a cycle with the boots on the floor rather
than one that needs a hand-tuned drop value per clip.

### Performance

Budget is a stable 60 FPS on mid-range hardware.

- Geometry is batched per material — a finished rifle is ~50 pieces but four
  draw calls; the whole level is a handful.
- Zombie rigs are pooled and built once at load. Building a skinned character
  costs tens of milliseconds, so spawning one mid-round would visibly hitch.
- Operator rigs are pooled for the same reason and it matters more: one costs
  ~110 ms to assemble, and a player joining mid-round is exactly when a hitch is
  least affordable. Four rigs exist, one per operator, handed out as players
  join and taken back when they leave. Each is 4 draw calls (skin, uniform,
  webbing, hard composite) and ~33 k triangles, and is distance-culled at 55 m —
  the meshes have `frustumCulled` off, because an animated character reaching
  out leaves the bounding sphere it was bound in.
- Particles live in two `Points` systems (additive and alpha-blended) with
  per-particle colour, size and alpha as vertex attributes: one draw call each,
  written in place, zero allocation per spawn.
- Shadow-casting lights are rationed to three keys for the whole map — the
  hall, the warehouse and the train shed, the only rooms with enough vertical
  geometry for a cast shadow to earn its cost.
- **The lamp rig roams.** Every light in a scene costs every lit fragment,
  whether or not it reaches it, so live lights are a per-frame budget rather
  than a memory one. The map has twenty-four fixtures across ten rooms and ten
  live lights, reassigned to the nearest fixtures as the player moves —
  set-based, so a slot keeps its lamp for as long as it stays in range and
  walking the map never re-points lights that were already correct. Fixtures
  are always drawn, so a distant lamp still reads as a lit bulb.
- **The flow field is rate-limited.** It rebuilds when the player leaves a cell,
  which on a 0.5 m grid is up to fourteen times a second at a sprint; a sweep of
  the terminal's 27k cells costs a little over 2 ms, so it is capped at eight a
  second. The field goes at most an eighth of a second stale, which moves the
  goal and not the topology.
- Adaptive resolution scaling drops the internal render scale when the frame
  time slips and recovers it when there is headroom.

---

## Multiplayer

### The squad

Four operators, because the map is laid out for four. They are told apart by
**silhouette first** — recognising a teammate across a dark train shed is a
shape problem long before it is a colour one, and a helmet, a bare head with ear
cups, a boonie brim and a patrol cap read at any range and in any light.

| | Role | Head | Kit | Uniform |
|---|---|---|---|---|
| **Sgt. Vance** *(ACTUAL)* | assault | ballistic helmet, NVG shroud, counterweight | full carrier, antenna, drop-leg holster, knee pads | arid |
| **Cpl. Novak** *(HAMMER)* | breacher | shaved, comms headset and boom mic | heaviest build, full carrier, dump pouch | woodland |
| **Spc. Ito** *(KESTREL)* | recon | boonie hat, shemagh over the nose | lightest, chest rig not carrier, sleeves down | desert |
| **Pfc. Rook** *(TOOLBOX)* | engineer | patrol cap, goggles pushed up, single-ear headset | tool belt, dump pouch, knee pads | urban digital |

Each also carries a squad colour on the shoulder, the chest panel and the
headgear — the same colour a scoreboard or a map marker would use.

### Running a game

The game and the lobby server are one process on one port, so an invite is a
single link that works the same on a LAN or through a tunnel.

```bash
npm run host          # build, then serve the game + lobbies on :8080
```

It prints every address a teammate could reach you at:

```
  💻 This laptop:           http://localhost:8080
  🏠 Same network (LAN):    http://192.168.1.24:8080
```

Anyone on your network opens the LAN address. Pick **Multi Player → Create
Lobby**, enter a callsign, and the lobby screen gives you a six-character code
and a copyable invite link. Friends either paste the link — which takes them
straight to the callsign prompt with the code already filled in — or type the
code under **Join Lobby**. Nothing starts until the host presses **Start Game**,
so there is no rush to get everybody in.

**Friends on other networks** need a way in from outside, and the tunnel is the
option that needs nothing from them and nothing from your router:

```bash
brew install cloudflared
npm run host:public   # same as above, plus a public https URL
```

That prints a `https://….trycloudflare.com` link that terminates at this
process. Share it exactly like the LAN one; the game socket rides the same
tunnel, which is the reason it shares a port with the page. The URL lasts as
long as the server runs.

The alternative — forwarding port 8080 on the router to this laptop and sharing
your public IP — also works and is faster, but it means exposing a port, so the
tunnel is the default recommendation.

For live editing while a teammate is connected, run Vite and the server side by
side; the server proxies everything that is not the game socket, HMR included:

```bash
npm run dev           # terminal 1
npm run server:dev    # terminal 2 — teammates connect to :8080 and see your edits
```

### How it is put together

Three parts, and the split between them is the load-bearing decision.

**`server/`** is not a game server. It knows who is in which lobby, who holds
the host role, and which operator each player was handed — and nothing else.
Every gameplay message is an opaque blob it forwards without looking inside.
That keeps the rules in one language, next to the single-player code that
already implements them, instead of written twice and drifting apart.

**Each player owns their own body.** Position, aim, health and going down are
reported, never requested. Nobody can be shoved or killed by a peer's
assertion, and the local player never waits on the network to move — which is
the one thing that would make the game feel broken over a tunnel.

**The host owns the horde and the round clock.** One machine runs the zombie AI
and broadcasts the result at 12 Hz; everyone else runs `ZombieManager` in
`remote` authority, where the pool is driven entirely by packets. The
alternative — every machine simulating the same seed — drifts apart within
seconds, because the AI is driven by player positions that arrive late and
interpolated.

Damage crosses that line carefully. A client raycasts against its own
replicated bodies and shows blood and a hitmarker immediately, then tells the
host what it hit; the host applies it and broadcasts the kill. So two players
shooting the same zombie cannot both be paid for killing it, and nobody waits a
round trip to see their gun do something. The payout arithmetic is deliberately
split to match: the shooter already paid itself for the hit, so the host sends
the *bonus*, and a client's kill is worth exactly what the host's is.

| | Rate | Carries |
|---|---|---|
| `snap` | 20 Hz | one player's body — position, aim, weapon, cumulative shot count |
| `horde` | 12 Hz | every live zombie, six quantised integers each |
| `round` / `barrier` | 4 Hz | round number and phase, plank counts |
| `hit` / `kill` / `door` | on event | damage reported to the host, kills and purchases back out |

A full 28-zombie wave costs the host about 95 kbps upstream, which the server
fans out to each peer.

Two details that are easy to get wrong and are worth naming:

- **Player order is by operator slot, never join order.** The server hands
  operators out from a fixed list and never reassigns one while its holder is
  connected, so sorting by it gives every machine the same sequence — which is
  what lets a zombie's target travel as one small integer that means the same
  person on all four screens.
- **The nav grid is seeded from every player at once.** `NavGrid.rebuild` takes
  a list and runs a multi-source sweep, so the field that comes out is the
  distance to the *nearest* player and a zombie descending it walks toward
  whoever is genuinely closest through the map. A field per player would be four
  sweeps to answer a question one already answers, and a Euclidean
  nearest-player test picks the teammate three metres away through a wall.

**Host migration** is handled: if the host drops, the server promotes the next
player and their client adopts the bodies already on screen rather than
deleting them, restoring health from the round curve since health never crossed
the wire. A wave inherited mid-round is slightly tougher than it was a second
earlier, which nobody notices, where the alternative is a horde that dies to one
bullet each.

### Going down

Solo, running out of health ends the run. In co-op it does not, and treating it
the same way breaks the lobby in a way that is not obvious until it happens —
the round clock lives on the host, so a host who is "dead" stops advancing it
and freezes the game for three people who are still fighting.

So co-op takes the rule the genre already settled on. Going down takes you out
of the round — no control, no weapon, no damage, but you keep the camera — and
the next round puts you back on your feet. The run ends when the whole squad is
down, which each machine decides independently from the server's roster rather
than waiting on an announcement from a host who is quite possibly one of the
corpses.

### In the world

Every teammate carries a **nametag** above their head that tracks them, dims and
shrinks with distance, and fades out when a wall comes between you — a nametag
drawn through masonry is a wallhack. It sits on the head rather than a fixed
offset from the origin, so a crouching operator's label follows them down. A
slim health bar under the name goes amber then red, and reads `DOWN` when they
are out of the round.

The **bottom-left corner** carries the squad: every player's callsign and
points, stacked directly above your own points counter so the whole economy
reads as one block. Your own row is brightest, a downed teammate's dims, and the
pip beside each name is that operator's squad colour — the same colour they are
wearing. In single player the list is hidden entirely, since a one-row list of
yourself says nothing the counter below it does not.

### Local bots

`src/characters/DemoSquad.ts` predates the transport and still stands in when
you want to look at the operator models in motion without three other machines.
It is worth being precise about what it is: three bots that walk the lobby,
engage zombies, fire in bursts and reload — and which are **not allowed to touch
a rig, an animator or a bone**. They emit snapshots at a fixed 20 Hz exactly as
a peer does, so everything downstream is the same code a real connection drives.

```
http://localhost:5173/?squad=3
```

Off by default, because building three more skinned characters costs real load
time and a solo run does not need it.

---

## Known limitations

- **No lag compensation on client hits.** A client raycasts against bodies it is
  drawing about a sixth of a second in the past, so on a high-latency connection
  a shot at a sprinter can miss where it visually connected. Zombies are large
  and slow enough that this is rarely felt on a LAN; rewinding the host's horde
  to the shooter's view would fix it properly.
- **Damage numbers from clients are taken on trust.** This is a co-op game
  between people who were handed the lobby code personally, and the validation
  that would matter costs more than the problem. The *payout* is computed on the
  host, so the worst a bad actor can do is kill things early, not mint points.
- **Zombies do not climb through windows with an animation** — they are held
  outside a boarded barrier while they tear planks off, then walk through the
  opening. A vault animation would sell it better.
- **No revive interaction.** A downed player is out until the next round rather
  than being picked up by a teammate, so the Quick Revive perk still only does
  its solo job of speeding regeneration.
- **Dismemberment is not implemented**; hits produce blood bursts, a flinch and
  a material flash rather than removing limbs.
- The production bundle is dominated by Rapier, whose `-compat` build inlines
  its WASM as base64 (~2 MB, 760 kB gzipped). Switching to the non-compat build
  with a separately fetched `.wasm` would cut that substantially at the cost of
  a slightly more involved boot.
