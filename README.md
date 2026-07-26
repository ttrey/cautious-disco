# NECROPOLIS

A first-person, wave-based zombie survival game in the classic *Call of Duty:
Zombies* shape — survive rounds, earn points by hitting things, spend them on
doors, wall weapons, perks and a weapon upgrade station.

Built with Three.js, Rapier and TypeScript on Vite.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build into dist/
npm run typecheck
```

| | |
|---|---|
| **WSAD** | Move |
| **Shift / Ctrl / Space** | Sprint / crouch / jump |
| **Mouse** | Look · left fire · right aim down sights |
| **R** | Reload |
| **1 / 2 / Q** | Switch weapon |
| **E** | Buy · hold to repair a barrier |
| **F** | Inspect weapon |

There is also an asset turntable at **`/preview.html`** — keys `1`–`6` cycle
through the four weapons, a zombie and the first-person arms under
camera-relative studio lighting. It exists because judging a normal map or a
bevel inside a dark running game is guesswork.

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
  metal, flesh, cloth). Every surface is a per-texel function over tileable FBM
  noise, so the maps repeat seamlessly and the materials read as materials
  rather than as tinted plastic.
- **`src/weapons/GunSmith.ts`** assembles four firearms from chamfered solids,
  lathed muzzle devices and bevel-extruded receiver profiles at real
  proportions, with picatinny rails, slide serrations, handguard vents, curved
  magazines and iron sights.
- **`src/zombies/ZombieMesh.ts`** builds a skinned humanoid: a 19-bone
  skeleton, tapered elliptical limb tubes with hand-authored radius profiles,
  and a skull produced by displacing a sphere (brow ridge, sunken eye sockets,
  hollow cheeks, dropped mandible).
- **`src/audio/AudioEngine.ts`** synthesises every sound through Web Audio —
  layered gunshots, formant-swept groans, impacts, perk jingles, round
  stingers, and an ambient bed — spatialised through panners into a generated
  convolution reverb.

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
  core/      Engine, Physics, Input, Nav, Effects, Environment, GradePass, Game
  entities/  Player
  weapons/   GunSmith, Arms, ViewModel, WeaponDefs, WeaponSystem
  zombies/   ZombieMesh, ZombieAnimations, Zombie, ZombieManager
  map/       Level, Props
  ui/        HUD
  audio/     AudioEngine
  assets/    TextureForge, Materials, SpriteTextures
  util/      math, geometry, ik
  dev/       preview (asset turntable)
```

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

### Performance

Budget is a stable 60 FPS on mid-range hardware.

- Geometry is batched per material — a finished rifle is ~50 pieces but four
  draw calls; the whole level is a handful.
- Zombie rigs are pooled and built once at load. Building a skinned character
  costs tens of milliseconds, so spawning one mid-round would visibly hitch.
- Particles live in two `Points` systems (additive and alpha-blended) with
  per-particle colour, size and alpha as vertex attributes: one draw call each,
  written in place, zero allocation per spawn.
- Shadow-casting lights are rationed to one key per major space; the rest are
  unshadowed point lights with visible fixtures.
- Adaptive resolution scaling drops the internal render scale when the frame
  time slips and recovers it when there is headroom.

---

## Known limitations

- **Zombies do not climb through windows with an animation** — they are held
  outside a boarded barrier while they tear planks off, then walk through the
  opening. A vault animation would sell it better.
- **No mystery box.** Wall buys and Pack-a-Punch cover the weapon economy.
- **Dismemberment is not implemented**; hits produce blood bursts, a flinch and
  a material flash rather than removing limbs.
- The production bundle is dominated by Rapier, whose `-compat` build inlines
  its WASM as base64 (~2 MB, 760 kB gzipped). Switching to the non-compat build
  with a separately fetched `.wasm` would cut that substantially at the cost of
  a slightly more involved boot.
