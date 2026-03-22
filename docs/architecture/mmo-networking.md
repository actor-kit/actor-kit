# MMO Networking Architecture on Cloudflare

## The Two Types of Data

An MMO world has two fundamentally different data types:

```
STATIC (terrain, textures, meshes)          DYNAMIC (entities, positions, combat)
│                                           │
│ Never changes at runtime                  │ Changes 10x per second
│ Same for all players                      │ Different per player (spatial filtering)
│ Megabytes per zone                        │ Kilobytes per tick
│ Load once, cache forever                  │ Stream continuously
│                                           │
│ → CDN / R2 / Edge Cache                   │ → Durable Objects / WebSocket
```

These NEVER go through the same system.

## World Structure

```
World "Azeroth"
├── Continent: Eastern Kingdoms
│   ├── Zone: Elwynn Forest ──────────── Zone DO (entity state)
│   │   ├── Terrain Tiles (32x32 grid) ─ R2 bucket (static)
│   │   │   ├── tile_0_0.bin (heightmap + textures)
│   │   │   ├── tile_0_1.bin
│   │   │   └── ... 1024 tiles
│   │   └── Static Objects ───────────── R2 (trees, buildings, NPCs with no AI)
│   │
│   ├── Zone: Westfall ───────────────── Zone DO
│   │   └── Terrain Tiles ────────────── R2
│   │
│   └── Zone: Redridge ───────────────── Zone DO
│       └── Terrain Tiles ────────────── R2
│
└── Continent: Kalimdor
    └── ...
```

## Network Architecture

```
                    ┌──────────────────────────────────┐
                    │         Cloudflare Edge           │
                    │         (nearest PoP)             │
                    │                                   │
                    │  ┌─────────────┐                  │
                    │  │ Worker      │                  │
                    │  │ (Router)    │──── serves ────▶ R2 / KV Cache
                    │  │             │     terrain      (static tiles)
                    │  └──────┬──────┘                  │
                    │         │                         │
                    │    routes to DOs                  │
                    │    ┌────┴────┐                    │
                    │    ▼         ▼                    │
                    │  ┌────┐   ┌────┐                  │
                    │  │Zone│   │Sess│                  │
                    │  │ DO │   │ DO │                  │
                    │  └────┘   └────┘                  │
                    └──────────────────────────────────┘
                           ▲         ▲
                      WebSocket  WebSocket
                      (binary)   (JSON)
                           │         │
                    ┌──────┴─────────┴──────┐
                    │       Browser          │
                    │                        │
                    │  ┌──────────────────┐  │
                    │  │ Game Engine      │  │
                    │  │ (Three.js/Pixi)  │  │
                    │  │                  │  │
                    │  │ Terrain Loader ──│──│──▶ GET /tiles/zone/x_y.bin
                    │  │ Entity Renderer ─│──│──▶ WebSocket (Zone DO)
                    │  │ UI Layer ────────│──│──▶ WebSocket (Session DO)
                    │  └──────────────────┘  │
                    └────────────────────────┘
```

## Map Tiles for a Gigantic World

### Tile Grid

A zone is divided into a grid of terrain tiles. Each tile contains heightmap
data, texture indices, and static object placements. These are pre-built
at development time and never change at runtime.

```
Zone: Elwynn Forest (500m × 500m)
Tile size: 16m × 16m
Grid: 32 × 32 = 1024 tiles

    0   1   2   3   4   5   ... 31
  ┌───┬───┬───┬───┬───┬───┬───┬───┐
0 │   │   │   │   │   │   │   │   │
  ├───┼───┼───┼───┼───┼───┼───┼───┤
1 │   │   │░░░│░░░│░░░│   │   │   │
  ├───┼───┼░░░┼░░░┼░░░┼───┼───┼───┤  ░ = tiles currently loaded
2 │   │   │░░░│░P░│░░░│   │   │   │  P = player position
  ├───┼───┼░░░┼░░░┼░░░┼───┼───┼───┤
3 │   │   │░░░│░░░│░░░│   │   │   │  Load radius: 3 tiles
  ├───┼───┼───┼───┼───┼───┼───┼───┤  = 48m in each direction
4 │   │   │   │   │   │   │   │   │
  └───┴───┴───┴───┴───┴───┴───┴───┘
```

### Tile Loading (Client-Side, Static Data)

```
Player moves to tile (5, 8)
    │
    ▼
Calculate visible tiles: (3,6) to (7,10) — 5×5 = 25 tiles
    │
    ▼
Which tiles are NOT already loaded?
    │
    ├── tile_3_6.bin — not loaded → fetch from CDN
    ├── tile_7_10.bin — not loaded → fetch from CDN
    └── tile_5_8.bin — already loaded → skip
    │
    ▼
GET https://tiles.example.com/elwynn-forest/3_6.bin
    │
    ▼
Cloudflare CDN cache hit (or R2 origin)
    │
    ▼
Parse heightmap → build terrain mesh → render

Unload tiles more than 5 tiles away (memory management)
```

### Tile Data Format

```
tile_3_6.bin (binary, ~50KB per tile)
┌─────────────────────────────────────────┐
│ Header (16 bytes)                       │
│   tileX: u16, tileY: u16               │
│   heightmapResolution: u16 (e.g., 64)  │
│   objectCount: u16                      │
├─────────────────────────────────────────┤
│ Heightmap (resolution × resolution × 4) │
│   float32[] — height at each grid point │
│   64×64 = 4096 floats = 16KB           │
├─────────────────────────────────────────┤
│ Texture Map (resolution × resolution)   │
│   u8[] — texture index per grid point   │
│   64×64 = 4KB                          │
├─────────────────────────────────────────┤
│ Static Objects                          │
│   { modelId: u16, x: f32, y: f32,      │
│     z: f32, rotation: f32, scale: f32 } │
│   20 bytes per object                   │
│   ~100 objects per tile = 2KB           │
└─────────────────────────────────────────┘
```

### Tile Storage

```
R2 Bucket: "world-tiles"
│
├── elwynn-forest/
│   ├── 0_0.bin
│   ├── 0_1.bin
│   ├── ...
│   └── 31_31.bin
│
├── westfall/
│   └── ...
│
└── metadata.json    ← zone list, dimensions, spawn points
```

Tiles are served through Cloudflare CDN with aggressive caching.
`Cache-Control: public, max-age=31536000, immutable`
When terrain changes (game update), deploy new tiles with a version suffix.

## Entity Layer (Dynamic — Zone DOs)

This is completely separate from terrain. The Zone DO only manages entities:

```
Zone DO: "elwynn-forest"
┌─────────────────────────────────────────────────────┐
│                                                     │
│  State:                                             │
│  ┌──────────────────────────────────────────────┐   │
│  │ entities: ["player-1", "player-2", "mob-47"] │   │
│  │                                              │   │
│  │ position:                                    │   │
│  │   player-1: { x: 152, y: 10, z: 203 }       │   │
│  │   player-2: { x: 480, y: 5, z: 91 }         │   │
│  │   mob-47:   { x: 300, y: 8, z: 150 }        │   │
│  │                                              │   │
│  │ health:                                      │   │
│  │   player-1: { current: 95, max: 100 }        │   │
│  │   mob-47:   { current: 200, max: 200 }       │   │
│  │                                              │   │
│  │ spatialGrid:                                 │   │
│  │   ┌────┬────┬────┬────┐                      │   │
│  │   │    │ p1 │    │    │                       │   │
│  │   ├────┼────┼────┼────┤                       │   │
│  │   │    │    │m47 │    │                       │   │
│  │   ├────┼────┼────┼────┤                       │   │
│  │   │    │    │    │    │                       │   │
│  │   ├────┼────┼────┼────┤                       │   │
│  │   │ p2 │    │    │    │                       │   │
│  │   └────┴────┴────┴────┘                      │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  Connected WebSockets:                              │
│    player-1 ◄──── binary positions @ 100ms          │
│    player-2 ◄──── binary positions @ 100ms          │
│                                                     │
│  Each player only receives entities within          │
│  VIEW_RADIUS (120 units) of their position          │
│                                                     │
│  Tick (DO Alarm, every 100ms):                      │
│    1. Run mob AI (patrol, aggro)                    │
│    2. Update positions                              │
│    3. For each player:                              │
│       a. Query spatial grid for nearby entities     │
│       b. Pack positions into binary buffer          │
│       c. Send buffer over WebSocket                 │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### What Each Player Receives

```
Player 1 at (152, 10, 203)                Player 2 at (480, 5, 91)
VIEW_RADIUS = 120                         VIEW_RADIUS = 120

Sees:                                     Sees:
  mob-47 (distance: 155) — OUT            player-1 (distance: 340) — OUT
  player-2 (distance: 340) — OUT          mob-47 (distance: 187) — OUT

  npc-12 (distance: 30) — IN             npc-89 (distance: 45) — IN
  mob-23 (distance: 80) — IN             mob-61 (distance: 90) — IN

Binary output for Player 1:              Binary output for Player 2:
  2 entities × 16 bytes = 32 bytes         2 entities × 16 bytes = 32 bytes
  (completely different entities!)          (completely different entities!)
```

## Zone Boundaries and Transitions

```
                    Zone: Elwynn Forest
                    ┌─────────────────────────────┐
                    │                             │
                    │              Player ──▶     │
                    │                        ░░░░░│░░░░░
                    │                        ░ OVERLAP ░
                    │                        ░░░░░│░░░░░
                    │                             │
                    └─────────────────────────────┘
                                                  │
                                            Zone: Westfall
                                            ┌─────────────────────────────┐
                                            │                             │
                                            │                             │
                                            │                             │
                                            │                             │
                                            └─────────────────────────────┘

OVERLAP ZONE (100 units on each side of boundary):
  Player subscribes to BOTH Zone DOs simultaneously
  Receives entities from both zones
  Seamless visual transition — no loading screen

Timeline:
  ┌────────────────────────────────────────────────────────────────────┐
  │ Distance to boundary:                                             │
  │                                                                   │
  │  200    150    100    50     0     -50   -100                     │
  │   │      │      │      │     │      │      │                      │
  │   │      │   Connect  │  Cross   │   Disconnect                  │
  │   │      │   Zone B   │  border  │   Zone A                     │
  │   │      │      │      │     │      │      │                      │
  │   │  Zone A only │   Both zones  │  Zone B only                 │
  │   │◄────────────▶│◄─────────────▶│◄───────────▶                 │
  └────────────────────────────────────────────────────────────────────┘
```

## Zone Sharding (When One DO Isn't Enough)

If a zone has too many entities for one DO (200+), shard it into cells:

```
Zone: "The Crossroads" (500 × 500 units)
Sharded into 5×5 = 25 Cell DOs (100 × 100 units each)

  ┌──────┬──────┬──────┬──────┬──────┐
  │Cell  │Cell  │Cell  │Cell  │Cell  │
  │(0,0) │(1,0) │(2,0) │(3,0) │(4,0) │
  │ DO   │ DO   │ DO   │ DO   │ DO   │
  ├──────┼──────┼──────┼──────┼──────┤
  │(0,1) │(1,1) │(2,1) │(3,1) │(4,1) │
  │      │      │  P◄──│──────│      │  P = Player
  ├──────┼──────┼──────┼──────┼──────┤      subscribes to
  │(0,2) │(1,2) │(2,2) │(3,2) │(4,2) │      cells (1,0),(2,0),
  │      │      │      │      │      │      (1,1),(2,1),(1,2),(2,2)
  ├──────┼──────┼──────┼──────┼──────┤      = 6 Cell DOs
  │(0,3) │(1,3) │(2,3) │(3,3) │(4,3) │
  │      │      │      │      │      │  Each cell has ~10-20 entities
  ├──────┼──────┼──────┼──────┼──────┤  Much cheaper than one DO
  │(0,4) │(1,4) │(2,4) │(3,4) │(4,4) │  with 200+ entities
  └──────┴──────┴──────┴──────┴──────┘

  Cell boundary transitions use the same overlap
  pattern as zone boundaries — the player subscribes
  to adjacent cells as they move.
```

## Full Connection Map for One Player

```
Player "alice" in Elwynn Forest
│
├── WebSocket: Session DO ──────────── inventory, quests, gold, level
│   │                                  JSON Patch, on-change only
│   │                                  Persistent across zone changes
│   │
├── WebSocket: Zone DO ─────────────── entity positions, combat, chat
│   │                                  Binary positions @ 100ms
│   │                                  JSON metadata on-change
│   │                                  Disconnects on zone transfer
│   │
├── HTTPS: CDN ─────────────────────── terrain tiles, textures, models
│   │                                  Cached at edge, loaded on demand
│   │                                  GET /tiles/elwynn/5_8.bin
│   │
└── (Optional) WebSocket: Guild DO ─── guild chat, roster, bank
                                       JSON Patch, on-change only
                                       Persistent across zone changes

Total connections per player: 2-3 WebSockets + HTTP tile loading
```

## Data Flow Summary

```
┌──────────────────────────────────────────────────────────────┐
│                        STATIC DATA                           │
│                                                              │
│  Build time → R2 bucket → CDN edge cache → Client            │
│                                                              │
│  Terrain heightmaps, textures, 3D models, sound files        │
│  Zone metadata, NPC dialog trees, quest definitions          │
│  Spell data, item databases                                  │
│                                                              │
│  Frequency: load once per zone, cache forever                │
│  Size: megabytes                                             │
│  Protocol: HTTPS GET with cache headers                      │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                     DYNAMIC DATA — HOT                       │
│                                                              │
│  Player input → Zone DO → spatial filter → binary → Client   │
│                                                              │
│  Entity positions, rotations, animations                     │
│  Combat events (damage numbers, spell effects)               │
│                                                              │
│  Frequency: every 100ms (10 ticks/sec)                       │
│  Size: 16 bytes per entity × ~30 nearby = 480 bytes/tick     │
│  Protocol: WebSocket binary frames                           │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                     DYNAMIC DATA — WARM                      │
│                                                              │
│  State change → actor-kit → JSON Patch → Client              │
│                                                              │
│  Entity metadata (name, health bar, level, guild tag)        │
│  Zone state (weather, time of day, world events)             │
│  Nearby chat messages                                        │
│                                                              │
│  Frequency: on change (maybe 1-5x per second)                │
│  Size: ~100-500 bytes per patch                              │
│  Protocol: WebSocket JSON frames (actor-kit managed)         │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                     DYNAMIC DATA — COLD                      │
│                                                              │
│  State change → Session DO → JSON Patch → Client             │
│                                                              │
│  Inventory, equipment, quest log, achievements               │
│  Gold, XP, skill points                                      │
│  Social (friends list, guild roster)                          │
│                                                              │
│  Frequency: on change (maybe 0.1x per second)                │
│  Size: ~200 bytes per patch                                  │
│  Protocol: WebSocket JSON frames (actor-kit managed)         │
└──────────────────────────────────────────────────────────────┘
```
