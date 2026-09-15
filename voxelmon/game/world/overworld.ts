import { grantItem, GYM_REWARDS } from "./rewards.ts";
import { PartyFollower } from "./follower.ts";
import { trainerHeader } from "./trainers.ts";
import { physicalExit } from "./warp.ts";
// The overworld controller SLICE. Ports the world-facing core of gen1recomp
// src/world/OverworldController.lua: map entry and connections, grid
// movement, ledges, warps (arrival / collision / edge), NPC wander,
// scripted movement, sign/talk interaction, and the completed-step
// land-triggers with wild-encounter rolls.
//
// UPDATE ORDER MATTERS and mirrors OverworldController.lua:883 update():
// script runner -> emote hold -> NPC wander -> scripted movement -> input
// (gated on scripted/transitioning) -> player animation -> warp-entry
// staleness -> land-triggers (onStepComplete, suppressed on scripted
// steps). Trainer sight, surf, bikes, boulders, spinners, Safari, poison,
// menus and the hand-ported map scripts are outside this slice.

import type { EncounterDef, MapObject, VoxelmonData } from "../data.ts";
import type { Rng } from "../rng.ts";
import { roll as encounterRoll } from "../rules/encounter.ts";
import { WARP_FADE_OUT } from "../rules/timing.ts";
import { canMove, occupied, target, type Dir, type Mover, type TilePairs } from "./collision.ts";
import { defPassable, GameMap, isOutside } from "./map.ts";
import { NPC } from "./npc.ts";
import { WildPopulation } from "./wild.ts";
import { Player } from "./player.ts";
import { talkScript } from "./mapscripts.ts";
import { ScriptRunner, type ScriptWorld } from "./script.ts";
import {
  destination,
  onArrive,
  onCollision,
  onEdge,
  type LastOutdoor,
  type WarpCarpets,
} from "./warp.ts";
import type { MapWarp } from "../data.ts";
import {
  placeDirectNeighbour,
  type ConnectionDirection,
} from "../../shared/connections.ts";

// OverworldController.lua:37
const COMPASS: Record<Dir, "north" | "south" | "east" | "west"> = {
  up: "north",
  down: "south",
  left: "west",
  right: "east",
};

export interface SaveSlice {
  party?: { hp: number; species?: string; nickname?: string; moves?: { id: string }[] }[];
  flags: Record<string, boolean>;
  inventory: Record<string, number>;
  bagOrder?: string[];
  money?: number;
  player: { name: string; rival: string };
  lastOutdoor?: LastOutdoor;
  lastHeal?: { map: string; x: number; y: number };
}

/** What the overworld needs from the game shell (game.ts implements it). */
export interface OverworldShell {
  data: VoxelmonData;
  save: SaveSlice;
  input: {
    isDown(btn: "up" | "down" | "left" | "right" | "a" | "b" | "start" | "select"): boolean;
    wasPressed(btn: "up" | "down" | "left" | "right" | "a" | "b" | "start" | "select"): boolean;
  };
  /** Encounter/battle roll stream (the guest owns the RNG). */
  rng: Rng;
  /** NPC wander stream, separate so ambience can't perturb encounters. */
  npcRng: Rng;
  /** Sound.lua:190 play — the field cues the overworld itself triggers. */
  audio: { playSfx(name: string): void };
  /** Pokemon.lua:90 heal over the party (Commands.lua:587 heal_party). */
  healParty(): void;
  /** Music.lua:383 playOnce — a jingle; Music.lua:407 restoreMap after it. */
  playOnce(song: string): void;
  restoreMapMusic(): void;
  /** Music.lua:339 playMap, called where the reference calls it. */
  startMapMusic(mapId: string): void;
  showText(text: string, onDone?: () => void): void;
  showChoice(text: string, choice: (yes: boolean) => void): void;
  /** Bedroom OpenRedsPC hidden event, owned by the game-state stack. */
  openBedroomComputer(): void;
  openStartMenu(): void;
  openDaycare?(): void;
  openBikeShop?(): void;
  openFanClub?(): void;
  onFieldStep?(): void;
  chooseStarter(species: "BULBASAUR" | "CHARMANDER" | "SQUIRTLE"): void;
  buyMagikarp(): "bought" | "money" | "party-full" | "already-bought";
  pushWarpFade(frames: number, midpoint: () => void, onDone?: () => void): void;
  pushStubBattle(species: string, level: number): void;
  pushTrainerBattle(
    name: string,
    trainerClass: string,
    party: readonly { species: string; level: number }[],
    onWin: () => void,
  ): void;
  openMart(stock: readonly { item: string; price: number }[]): void;
}

interface ScriptMove {
  entity: Player | NPC;
  dir?: Dir;
  remaining: number;
  onDone?: () => void;
  inPlace?: boolean;
}

export interface EmoteHold {
  entity: Player | NPC;
  kind: number;
  frames: number;
  onDone?: () => void;
}

// OverworldController.lua:164 computeNeighbors — walk the connection graph
// `hops` out, composing the strip offsets, deduped by map id (BFS, so a
// direct connection always wins over a two-hop path). Offsets are world
// pixels; connection offsets are in blocks (32 px). The view-reach widening
// (reachW/reachH) is a renderer concern and stays out of the port.
export function computeNeighbors(
  maps: NonNullable<VoxelmonData["maps"]>,
  rootId: string,
  hops: number,
): { id: string; ox: number; oy: number }[] {
  const out: { id: string; ox: number; oy: number }[] = [];
  const rootDef = maps[rootId];
  if (!rootDef) return out;
  const placed = new Set([rootId]);
  const queue: { def: typeof rootDef; ox: number; oy: number; hops: number }[] = [
    { def: rootDef, ox: 0, oy: 0, hops: 0 },
  ];
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi];
    qi += 1;
    for (const [dir, conn] of Object.entries(cur.def.connections ?? {})) {
      const destDef = maps[conn.map];
      if (!destDef || placed.has(conn.map)) continue;
      placed.add(conn.map);
      const direct = placeDirectNeighbour(
        dir as ConnectionDirection,
        conn,
        cur.def,
        destDef,
      );
      const ox = direct.ox + cur.ox;
      const oy = direct.oy + cur.oy;
      if (cur.hops + 1 <= hops) {
        out.push({ id: conn.map, ox, oy });
        if (cur.hops + 1 < hops) {
          queue.push({ def: destDef, ox, oy, hops: cur.hops + 1 });
        }
      }
    }
  }
  return out;
}

/** PSP-1000 memory boundary: these two outdoor maps must never coexist. */
export class Overworld implements ScriptWorld {
  /** The content-boundary test: a map outside the pak's cooked set exists
   * as DATA (warp targets, connection math) but must never be entered —
   * the pak has no geometry for it, so warps bump and connections neither
   * show nor cross. Old gamedata without the list means "everything". */
  isCooked(mapId: string): boolean {
    if (mapId === "LAST_MAP") return true; // resolves to a map we came from
    const list = this.shell.data.cookedMaps;
    return !list || list.includes(mapId);
  }

  readonly shell: OverworldShell;
  map!: GameMap;
  player!: Player;
  npcs: NPC[] = [];
  readonly wild = new WildPopulation();
  readonly follower = new PartyFollower();
  entities: Mover[] = [];
  runner: ScriptRunner;
  scriptMoves: ScriptMove[] = [];
  emote?: EmoteHold;
  lastOutdoor?: LastOutdoor;
  standingOnWarp = false;
  warpEntryCell?: { x: number; y: number };
  transitioning = false;
  private doorWarp = false;
  /** OverworldController.lua:1221 — 16 ticks between wall-bonk cues. */
  private bumpCooldown = 0;
  /** A play_once jingle is in flight (Music.lua:389 pendingRestore). */
  private oneShotPending = false;
  private oakEventRunning = false;
  /** OverworldController.lua:1455 — the map whose theme the seam step owes. */
  pendingSeamMusic: string | null = null;
  private joyLatch?: { a?: boolean };
  private npcPool = new Map<string, NPC>();
  readonly tilePairs: TilePairs;
  readonly carpets?: WarpCarpets;
  /** Battle-port seam bookkeeping the tests and the sim read. */
  encounterCount = 0;
  lastEncounter?: { species: string; level: number };

  constructor(shell: OverworldShell) {
    this.shell = shell;
    const field = shell.data.field as
      | { tilePairs?: TilePairs; warpCarpets?: WarpCarpets }
      | undefined;
    // Collision.load equivalent (Collision.lua:36)
    this.tilePairs = field?.tilePairs ?? { land: [], water: [] };
    this.carpets = field?.warpCarpets;
    this.runner = new ScriptRunner(this);
  }

  get data(): VoxelmonData {
    return this.shell.data;
  }

  get save(): SaveSlice {
    return this.shell.save;
  }

  // OverworldController.lua:209 enter
  enter(mapId: string, x: number, y: number, facing?: Dir): void {
    // survives save/load: a loaded game may start inside a building whose
    // exit mat is a LAST_MAP warp
    this.lastOutdoor = this.shell.save.lastOutdoor;
    this.setMap(mapId, x, y, facing, { via: "boot" });
    // boot/load: derive the flag from the tile the save left us standing on
    // (MapEntryAfterBattle's IsPlayerStandingOnWarp — issue #378)
    this.refreshStandingOnWarp();
  }

  // OverworldController.lua:283 setMap — the single choke point for every
  // map-id change, warps and seamless connection crossings alike.
  setMap(
    mapId: string,
    x: number,
    y: number,
    facing?: Dir,
    opts?: { via?: string; seamless?: boolean },
  ): void {
    const def = this.shell.data.maps?.[mapId];
    if (!def) throw new Error(`unknown map ${mapId}`);
    // crossConnection re-arms this right after; clearing here is what keeps a
    // warp or a reload from leaving a stale deferred PlayMapMusic pending
    // (OverworldController.lua:437-439).
    this.pendingSeamMusic = null;
    const tileset = this.shell.data.tilesets?.[def.tileset];
    if (!tileset) throw new Error(`unknown tileset ${def.tileset} for ${mapId}`);
    this.map = new GameMap(def, tileset);
    this.wild.clear();
    // NPC instances persist across connection crossings in the pool (keyed
    // by NPC.id) so nothing snaps back to its spawn point at a seam; warps
    // rebuild from scratch, like the original's per-entry sprite init
    // (OverworldController.lua:376-385).
    if (!(opts?.seamless && this.npcPool.size > 0)) {
      this.npcPool = new Map();
    }
    // Repair saves stranded on the front doorstep behind the old guard.
    if (mapId === "CERULEAN_CITY" && x === 27 && y === 11) {
      this.shell.save.flags.EVENT_CERULEAN_HOUSE_OPEN = true;
    }
    this.npcs = [];
    for (const obj of def.objects ?? []) {
      if (this.objectVisible(obj)) {
        const npc = this.pooledNPC(mapId, obj);
        npc.frozen = false;
        this.npcs.push(npc);
      }
    }
    if (this.player) {
      this.player.cellX = x;
      this.player.cellY = y;
      this.player.px = x * 16;
      this.player.py = y * 16;
      this.player.facing = facing ?? this.player.facing;
      this.player.moving = false;
      this.player.targetX = undefined;
      this.player.targetY = undefined;
    } else {
      this.player = new Player(x, y, facing);
    }
    this.entities = [this.player, ...this.npcs];
    this.follower.reset(this.player);
  }

  // OverworldController.lua:110 objectVisible — the spawn filter. The slice
  // carries only the `hidden` gate (toggles/items-taken/defeated need save
  // machinery outside this slice).
  private objectVisible(obj: MapObject): boolean {
    const chosen = this.shell.save.flags;
    if (obj.name === "OAKSLAB_BULBASAUR_POKE_BALL" && (chosen.EVENT_CHOSE_BULBASAUR || chosen.EVENT_RIVAL_CHOSE_BULBASAUR)) return false;
    if (obj.name === "OAKSLAB_CHARMANDER_POKE_BALL" && (chosen.EVENT_CHOSE_CHARMANDER || chosen.EVENT_RIVAL_CHOSE_CHARMANDER)) return false;
    if (obj.name === "OAKSLAB_SQUIRTLE_POKE_BALL" && (chosen.EVENT_CHOSE_SQUIRTLE || chosen.EVENT_RIVAL_CHOSE_SQUIRTLE)) return false;
    if (chosen[`EVENT_TAKEN_${obj.name}`] || (!obj.trainerClass && chosen[`EVENT_BEAT_${obj.name}`])) return false;
    if ((obj.name === "MTMOONB2F_DOME_FOSSIL" || obj.name === "MTMOONB2F_HELIX_FOSSIL") && chosen.EVENT_MT_MOON_FOSSIL_TAKEN) return false;
    const houseOpen = !!(chosen.EVENT_CERULEAN_HOUSE_OPEN || chosen.EVENT_MET_BILL || chosen.EVENT_GOT_SS_TICKET ||
      this.shell.save.inventory.SS_TICKET || chosen.EVENT_BEAT_CERULEAN_ROCKET_THIEF ||
      chosen.EVENT_GOT_TM28 || chosen.EVENT_BEAT_CERULEANCITY_ROCKET);
    if (obj.name === "CERULEANCITY_GUARD1") return houseOpen;
    if (obj.name === "CERULEANCITY_GUARD2") return !houseOpen;
    if (obj.name === "CERULEANCITY_ROCKET" && chosen.EVENT_GOT_TM28) return false;
    if (obj.name === "SSANNE2F_RIVAL") return !chosen.EVENT_BEAT_SS_ANNE_RIVAL;
    return !(obj as MapObject & { hidden?: boolean }).hidden;
  }

  // OverworldController.lua:131 pooledNPC
  private pooledNPC(mapId: string, obj: MapObject): NPC {
    const key = `${mapId}_obj_${obj.index}`;
    let npc = this.npcPool.get(key);
    if (!npc) {
      npc = new NPC(mapId, obj, this.shell.npcRng);
      this.npcPool.set(key, npc);
    }
    return npc;
  }

  // OverworldController.lua:883 update
  update(): void {
    if (this.bumpCooldown > 0) this.bumpCooldown -= 1;
    this.runner.update();
    // the emotion-bubble pause holds the world for a beat
    // (OverworldController.lua:1018); only the player animates through it
    if (this.emote) {
      this.emote.frames -= 1;
      if (this.emote.frames <= 0) {
        const done = this.emote.onDone;
        this.emote = undefined;
        done?.();
      }
      this.player.update();
      return;
    }
    for (const npc of this.npcs) {
      npc.update(this.map, this.entities, this.shell.npcRng, this.tilePairs);
    }
    this.updateScriptMoves();
    // emote is included: a hold queued from a scriptMove onDone is assigned
    // mid-frame, after the early emote return above already missed it
    // (OverworldController.lua:1045-1052)
    const scripted =
      this.runner.isRunning() || this.scriptMoves.length > 0 || this.emote !== undefined;
    if (!scripted && !this.transitioning) {
      if (this.shell.save.party?.some(mon => mon.hp > 0)) {
        this.wild.update(this.shell.data, this.map, this.player, this.entities, this.tilePairs, this.shell.data.followerSprites ? 1 : 0);
      }
      this.handleInput();
    }
    const stepped = this.player.update();
    this.follower.update(this.player, this.shell.save.party?.[0]);
    // the warp-arrival cell goes stale the instant the player's real cell
    // leaves it, scripted walk-outs included (OverworldController.lua:1071)
    const entry = this.warpEntryCell;
    if (entry && (this.player.cellX !== entry.x || this.player.cellY !== entry.y)) {
      this.warpEntryCell = undefined;
    }
    // OverworldController.lua:1075 — the seam step landed, so the deferred
    // PlayMapMusic runs now (and only if we are still on the map it was
    // armed for; a warp taken mid-step drops it).
    if (stepped && this.pendingSeamMusic) {
      const pending = this.pendingSeamMusic;
      this.pendingSeamMusic = null;
      if (pending === this.map.id) this.shell.startMapMusic(pending);
    }
    if (stepped && !scripted) {
      this.onStepComplete();
    }
  }

  // OverworldController.lua:1113 dirHeld (hJoyHeld & PAD_CTRL_PAD)
  dirHeld(): boolean {
    const input = this.shell.input;
    return (
      input.isDown("up") || input.isDown("down") || input.isDown("left") || input.isDown("right")
    );
  }

  // OverworldController.lua:1131 — BIT_STANDING_ON_WARP: the warp under the
  // player's feet may only fire from a collision (blocked step / map edge)
  // while this flag is set.
  canCollisionWarp(): boolean {
    return this.standingOnWarp;
  }

  // OverworldController.lua:1138 refreshStandingOnWarp — a door tile keeps
  // the flag, a stair/ladder warp tile clears it (issues #230/#378).
  refreshStandingOnWarp(): void {
    const p = this.player;
    this.standingOnWarp = false;
    if (
      this.map.warpAtCell(p.cellX, p.cellY) &&
      !(this.map.isWarpTileCell(p.cellX, p.cellY) && !this.map.isDoorTileCell(p.cellX, p.cellY))
    ) {
      this.standingOnWarp = true;
    }
  }

  // OverworldController.lua:1148 handleInput — gated on the walk counter:
  // A and direction initiation are only acted on standing on a tile (#286).
  handleInput(): void {
    const input = this.shell.input;
    if (this.player.moving) {
      // OverworldController.lua:1177: a button pressed mid-step and STILL
      // HELD when the step lands reads as a fresh press at the next poll
      // (hJoyLast frozen for the animation, #525); one released before then
      // is genuinely lost.
      if (input.wasPressed("a")) {
        this.joyLatch = { ...this.joyLatch, a: true };
      }
      return;
    }
    const latch = this.joyLatch;
    this.joyLatch = undefined;
    if (input.wasPressed("a") || (latch?.a === true && input.isDown("a"))) {
      this.interact();
      return;
    }
    // START menu: outside the slice (the early return still skips the
    // turn re-arm below, like the original's jump to .displayDialogue)
    if (input.wasPressed("start")) {
      this.shell.openStartMenu();
      return;
    }
    for (const dir of ["up", "down", "left", "right"] as Dir[]) {
      if (!input.isDown(dir)) continue;
      if (!this.player.moving && this.player.facing === dir) {
        if (this.checkEdgeExit(dir)) return;
        if (this.checkLedgeHop(dir)) return;
        if (this.touchWild(dir)) return;
        // boulder pushes: outside the slice
      }
      // Content boundary, standing case: a warp TILE whose destination map
      // is not in the cooked set must not even be stepped on (the real game
      // warps the instant you land — with the warp locked, landing would
      // leave the player standing inside the doorway's geometry, e.g. the
      // Diglett's Cave mouth on Route 2). Bump instead.
      {
        const [tx, ty] = target(this.player.cellX, this.player.cellY, dir);
        const w = this.map.warpAtCell(tx, ty);
        if (w && this.map.isWarpTileCell(tx, ty) && !this.isCooked(w.def.destMap)) {
          this.player.facing = dir;
          this.player.bumpFrames = this.player.stepFrames;
          // ENDS the poll, like every other outcome here (:1224 returns the
          // tryMove result): a poll handles ONE held direction, so a held
          // diagonal must not walk on the other axis, and falling through to
          // the turn re-arm below would hand back a turn window the original
          // never grants while a direction is down.
          return;
        }
      }
      const result = this.player.tryMove(dir, this.map, this.entities, this.tilePairs);
      // a collision while standing on a warp square fires the warp when
      // the extra check passes (CheckWarpsCollision), only while
      // BIT_STANDING_ON_WARP is set (issue #230)
      if (result === "blocked" && this.canCollisionWarp()) {
        const w = onCollision(this.map, this.carpets, this.player.cellX, this.player.cellY, dir);
        if (w) {
          this.takeWarp(w.def);
          return;
        }
      }
      // OverworldController.lua:1218-1223: the bonk. Bumping another entity
      // is silent, and the 16-frame cooldown is what keeps a held direction
      // into a wall from machine-gunning the cue.
      if (
        result === "blocked" &&
        this.player.lastBlockReason !== "entity" &&
        this.bumpCooldown <= 0
      ) {
        this.shell.audio.playSfx("Collision");
        this.bumpCooldown = 16;
      }
      return;
    }
    // OverworldController.lua:1233: a poll that found no direction held is
    // what re-arms the next turn in place (#415); the early returns above
    // skip it exactly as the original's jumps do.
    this.player.turnArmed = true;
  }

  // OverworldController.lua:1322 checkLedgeHop — standing tile + ledge tile
  // in front + matching input direction -> jump two cells.
  checkLedgeHop(dir: Dir): boolean {
    const p = this.player;
    const tileset = this.map.def.tileset;
    const standing = this.map.cellTile(p.cellX, p.cellY);
    const [fx, fy] = target(p.cellX, p.cellY, dir);
    if (!this.map.inBounds(fx, fy)) return false;
    const front = this.map.cellTile(fx, fy);
    const ledges = (this.shell.data.field as { ledges?: Array<Record<string, unknown>> })
      ?.ledges;
    for (const ledge of ledges ?? []) {
      if (
        ((ledge.tileset as string | undefined) ?? "OVERWORLD") === tileset &&
        ledge.facing === dir &&
        ledge.input === dir &&
        ledge.standingTile === standing &&
        ledge.ledgeTile === front
      ) {
        const [lx, ly] = target(fx, fy, dir);
        if (!this.map.inBounds(lx, ly)) {
          // OverworldController.lua:1337: the landing is on the CONNECTED
          // map (issue #223) — validate the seam cell like crossConnection,
          // hop the first cell, hand the second to checkEdgeExit.
          const landing = this.connectionLanding(dir);
          if (!landing) return false;
          const { dest, ts, x, y } = landing;
          if (!defPassable(dest, ts, x, y, p.surfing)) return false;
          this.shell.audio.playSfx("Ledge"); // OverworldController.lua:1352
          p.hopFrames = 32;
          p.hopTotal = 32;
          this.scriptMove(p, dir, 1, () => this.checkEdgeExit(dir));
          return true;
        }
        if (!occupied(this.entities, lx, ly, p) && this.map.isWalkableCell(lx, ly)) {
          this.shell.audio.playSfx("Ledge"); // OverworldController.lua:1359
          p.hopFrames = 32; // jump arc (cosmetic; entities can't collide mid-hop
          p.hopTotal = 32; // because the hop is a scripted move that owns input)
          this.scriptMove(p, dir, 2);
          return true;
        }
      }
    }
    return false;
  }

  // OverworldController.lua:1370 checkEdgeExit — walking off the map edge:
  // connection crossing or edge warp (exit mats).
  checkEdgeExit(dir: Dir): boolean {
    const p = this.player;
    const [tx, ty] = target(p.cellX, p.cellY, dir);
    if (this.map.inBounds(tx, ty)) return false;
    const w = onEdge(this.map, p.cellX, p.cellY, dir);
    if (w) {
      // only with BIT_STANDING_ON_WARP set: pushing into the edge beside a
      // staircase bonks instead of bouncing floors (issue #230), while the
      // door mat you warped in on keeps it and exits (issue #378)
      if (!this.canCollisionWarp()) return false;
      this.takeWarp(w.def);
      return true;
    }
    const conn = this.map.connection(COMPASS[dir]);
    if (conn) {
      return this.crossConnection(dir, conn);
    }
    return false;
  }

  // OverworldController.lua:1396 connectionLanding — landing cell on the
  // connected map for a step off this map's edge (destX = curX - offset*2).
  connectionLanding(dir: Dir) {
    const conn = this.map.connection(COMPASS[dir]);
    if (!conn) return null;
    const dest = this.shell.data.maps?.[conn.map];
    if (!dest) return null;
    const ts = this.shell.data.tilesets?.[dest.tileset];
    if (!ts) return null;
    const p = this.player;
    const destW = dest.width * 2;
    const destH = dest.height * 2;
    let x: number;
    let y: number;
    if (dir === "up") {
      x = p.cellX - conn.offset * 2;
      y = destH - 1;
    } else if (dir === "down") {
      x = p.cellX - conn.offset * 2;
      y = 0;
    } else if (dir === "left") {
      x = destW - 1;
      y = p.cellY - conn.offset * 2;
    } else {
      x = 0;
      y = p.cellY - conn.offset * 2;
    }
    x = Math.max(0, Math.min(destW - 1, x));
    y = Math.max(0, Math.min(destH - 1, y));
    return { dest, ts, x, y, conn };
  }

  // OverworldController.lua:1425 crossConnection — the map data swaps while
  // the player is placed one cell before the entry point (their old world
  // position, which the neighbor strips render identically) and walks the
  // seam step. pokered's collision check reads the NEIGHBOR strip's tiles,
  // so stepping onto a solid tile of the connected map bumps like a wall.
  crossConnection(dir: Dir, _conn: { map: string; offset: number }): boolean {
    if (!this.isCooked(_conn.map)) return false; // content boundary: a wall
    // PewterCityScript: the east road does not open until Brock is beaten.
    // The original youngster escorts Red back to the Gym; at the hard-load
    // seam we keep the same progression invariant without staging him across
    // a map boundary.
    if (
      this.map.id === "PEWTER_CITY" &&
      dir === "right" &&
      _conn.map === "ROUTE_3" &&
      !this.shell.save.flags.EVENT_BEAT_BROCK
    ) {
      this.shell.showText("You have to beat\nBROCK before going\non to ROUTE 3!");
      return true;
    }
    const landing = this.connectionLanding(dir);
    if (!landing) return false;
    const { dest, ts, x, y } = landing;
    const p = this.player;
    if (!defPassable(dest, ts, x, y, p.surfing)) {
      return false;
    }
    // Every connection is a hard PSP-1000 scene boundary. Hold the old scene
    // through the standard load fade, replace it at the midpoint, and enter
    // directly on the validated destination cell. No neighbour geometry or
    // atlas pages remain resident while the destination streams.
    if (dest.id !== this.map.id) {
      this.transitioning = true;
      this.shell.pushWarpFade(
        WARP_FADE_OUT,
        () => {
          this.setMap(dest.id, x, y, dir);
          // The boundary traversal is still one logical walking cell even
          // though no interpolated seam step survives the load screen.
          this.player.landedCount += 1;
          this.refreshStandingOnWarp();
          this.shell.startMapMusic(dest.id);
          // Preserve the seamless path's landing semantics (including its
          // encounter RNG draw) after the destination has been installed.
          this.onStepComplete();
        },
        () => {
          this.transitioning = false;
        },
      );
      return true;
    }
    this.setMap(dest.id, x, y, p.facing, { seamless: true });
    // place the player one cell before the seam and start the step into the
    // new map RIGHT NOW so there is no one-frame stall at the boundary
    const d: Record<Dir, [number, number]> = {
      up: [0, -1],
      down: [0, 1],
      left: [-1, 0],
      right: [1, 0],
    };
    p.cellX = x - d[dir][0];
    p.cellY = y - d[dir][1];
    p.px = p.cellX * 16;
    p.py = p.cellY * 16;
    p.facing = dir;
    p.targetX = x;
    p.targetY = y;
    p.moving = true;
    p.progress = 0;
    // fresh walk-cycle clock so the seam step always shows leg frames
    p.animClock = 0;
    p.stepFramesCur = p.stepFrames;
    // OverworldController.lua:1455 — the new map's theme is DEFERRED to the
    // frame the seam step lands (issue #93). Starting it here would swap the
    // song while the player is still visibly on the old map's last cell.
    this.pendingSeamMusic = dest.id;
    // FixedStep:discardCatchup (OverworldController.lua:1477) is a no-op
    // here: the voxel host runs exactly one tick per frame, so there is no
    // catch-up accumulator to discard.
    return true;
  }

  // OverworldController.lua:1729 interact — the A press: NPC (with the
  // counter-tile reach-across), sign, then the bedroom OpenRedsPC event.
  // Card-key doors and the other hidden-object families remain outside the
  // slice; the PC stays data-driven through field.hiddenExtras.pcTiles.
  interact(): void {
    if (this.touchWild(this.player.facing)) return;
    const p = this.player;
    const [fx, fy] = p.facingCell();
    let npc = this.npcAtCell(fx, fy);
    if (!npc && this.map.isCounterCell(fx, fy)) {
      // talk across counters (mart clerks, nurses)
      const [fx2, fy2] = target(fx, fy, p.facing);
      npc = this.npcAtCell(fx2, fy2);
    }
    if (npc) {
      if (!npc.moving) {
        this.talkTo(npc);
      }
      return;
    }
    if (this.tryCut(fx, fy)) return;
    const sign = this.map.signAtCell(fx, fy);
    if (sign) {
      this.showMapText(sign.text);
      return;
    }
    if (this.isBedroomComputer(fx, fy)) {
      this.shell.openBedroomComputer();
    }
  }

  private tryCut(x: number, y: number): boolean {
    if (!this.map.inBounds(x, y)) return false;
    const tile = this.map.cellTile(x, y);
    if (!((this.map.def.tileset === "OVERWORLD" && tile === 0x3d) ||
          (this.map.def.tileset === "GYM" && tile === 0x50))) return false;
    const field = this.shell.data.field as { cutTreeSwaps?: { before: number; after: number }[] } | undefined;
    const bx = Math.floor(x / 2), by = Math.floor(y / 2);
    const swap = field?.cutTreeSwaps?.find(s => s.before === this.map.blockAt(bx, by));
    if (!swap) return false;
    const mon = this.shell.save.party?.find(mon => mon.moves?.some(move => move.id === "CUT"));
    if (!this.shell.save.inventory.CASCADEBADGE || !mon) {
      this.shell.showText("A small tree!\fTeach HM01 CUT to a\nPOKéMON and earn the\nCASCADEBADGE to cut it.");
      return true;
    }
    const map = this.map;
    this.shell.showText(`${mon.nickname || mon.species || "POKéMON"} used CUT!`, () => {
      if (this.map !== map) return;
      map.cutBlock(bx, by, swap.after);
      this.shell.audio.playSfx("Cut");
    });
    return true;
  }

  private isBedroomComputer(fx: number, fy: number): boolean {
    if (this.map.id !== "REDS_HOUSE_2F") return false;
    const field = this.shell.data.field as
      | {
          hiddenExtras?: {
            pcTiles?: Record<string, { x: number; y: number; facing?: Dir }[]>;
          };
        }
      | undefined;
    const tiles = field?.hiddenExtras?.pcTiles?.[this.map.id] ?? [];
    return tiles.some(
      (tile) =>
        tile.x === fx && tile.y === fy && (!tile.facing || tile.facing === this.player.facing),
    );
  }

  // OverworldController.lua:2520 talkTo — freeze, then dispatch the object's
  // TEXT_* constant. Item balls, static encounters, trainer engagement and
  // TX_SCRIPT marts/nurses are the battle/menu ports' seams.
  talkTo(npc: NPC): void {
    if (this.tryChooseStarter(npc)) return;
    if (this.tryChapterInteraction(npc)) return;
    npc.frozen = true;
    const unfreeze = () => {
      npc.frozen = false;
    };
    this.showMapText(npc.def.text, npc, unfreeze);
  }

  /** Pallet-to-Brock chapter interactions whose original pointers are
   * TX_SCRIPT rather than plain text: centers, marts, item balls and the
   * first trainer roster. */
  private tryChapterInteraction(npc: NPC): boolean {
    const name = npc.def.name ?? "";
    if (name === "DAYCARE_GENTLEMAN") { this.shell.openDaycare?.(); return true; }
    if (name === "BIKESHOP_CLERK") { this.shell.openBikeShop?.(); return true; }
    if (name === "POKEMONFANCLUB_CHAIRMAN") { this.shell.openFanClub?.(); return true; }
    if (name === "MTMOONPOKECENTER_MAGIKARP_SALESMAN") {
      this.shell.showChoice("A MAGIKARP for just\n¥500! Want it?", (yes) => {
        if (!yes) {
          this.shell.showText("No? Only ¥500...", () => { npc.frozen = false; });
          return;
        }
        const result = this.shell.buyMagikarp();
        const text = result === "bought"
          ? "You bought MAGIKARP!"
          : result === "money"
            ? "You don't have\nenough money."
            : result === "party-full"
              ? "Your party is full."
              : "I already sold you\nthat MAGIKARP.";
        this.shell.showText(text, () => { npc.frozen = false; });
      });
      return true;
    }
    if (name === "CERULEANCITY_ROCKET") {
      const flags = this.shell.save.flags;
      const finish = () => {
        const reward = grantItem(this.shell.save, this.shell.data, "EVENT_GOT_TM28", "TM_DIG");
        flags.EVENT_BEAT_CERULEAN_ROCKET_THIEF = true;
        if (reward === "full") { this.shell.showText("Your BAG is full.\nMake room for TM28."); return; }
        this.shell.showText("You received TM28\n- DIG!", () => {
          this.npcs = this.npcs.filter(n => n !== npc && this.objectVisible(n.def));
          const guard = this.map.def.objects.find(o => o.name === "CERULEANCITY_GUARD1");
          if (guard && !this.npcs.some(n => n.def === guard)) this.npcs.push(this.pooledNPC(this.map.id, guard));
          this.entities = [this.player, ...this.npcs];
        });
      };
      if (flags.EVENT_BEAT_CERULEAN_ROCKET_THIEF || flags.EVENT_BEAT_CERULEANCITY_ROCKET) finish();
      else {
        const party = this.shell.data.trainers?.OPP_ROCKET?.parties[4];
        if (!party) return false;
        this.shell.showText("Hey! Stay out!\nIt's not your yard!", () =>
          this.shell.pushTrainerBattle("ROCKET", "OPP_ROCKET", party, finish));
      }
      return true;
    }
    if (name === "ROUTE24_COOLTRAINER_M1" && !this.shell.save.flags.EVENT_GOT_NUGGET) {
      if (!this.bridgeComplete()) {
        this.shell.showText("Beat our five contest\ntrainers for a prize!");
        return true;
      }
      this.awardNugget(() => this.talkTo(npc));
      return true;
    }
    if (name === "BILLSHOUSE_BILL_POKEMON") {
      this.shell.save.flags.EVENT_MET_BILL = true;
      this.shell.save.flags.EVENT_GOT_SS_TICKET = true;
      this.shell.save.inventory.SS_TICKET = 1;
      this.shell.showText("BILL is back to normal!\fBILL gave you the\nS.S.TICKET!");
      return true;
    }
    if (name === "SSANNECAPTAINSROOM_CAPTAIN") {
      if (!this.shell.save.flags.EVENT_GOT_HM01) {
        this.shell.save.flags.EVENT_GOT_HM01 = true;
        this.shell.save.inventory.HM_CUT = 1;
        this.shell.showText("The CAPTAIN feels\nmuch better!\fYou received HM01\n- CUT!");
      } else {
        this.shell.showText("CAPTAIN: CUT can\nchop down small trees.");
      }
      return true;
    }
    if (name === "SSANNE2F_RIVAL") {
      const starter = this.rivalStarter();
      const index = starter === "SQUIRTLE" ? 1 : starter === "BULBASAUR" ? 2 : 3;
      const party = this.shell.data.trainers?.OPP_RIVAL2?.parties[index - 1];
      if (!party) return false;
      this.shell.showText(`${this.shell.save.player.rival}: Bonjour!\nImagine seeing you here!`, () => {
        this.shell.pushTrainerBattle(`RIVAL ${this.shell.save.player.rival}`, "OPP_RIVAL2", party, () => {
          this.shell.save.flags.EVENT_BEAT_SS_ANNE_RIVAL = true;
          this.npcs = this.npcs.filter((candidate) => candidate !== npc);
          this.entities = [this.player, ...this.npcs];
          this.shell.showText(`${this.shell.save.player.rival}: Smell ya!`);
        });
      });
      return true;
    }
    if (name.endsWith("POKECENTER_NURSE")) {
      npc.frozen = true;
      npc.facePlayer(this.player);
      this.shell.showChoice("Welcome to our\nPOKéMON CENTER!\nHeal your POKéMON?", (yes) => {
        if (yes) {
          this.shell.healParty();
          this.shell.save.lastHeal = { map: this.map.id, x: 3, y: 6 };
          this.shell.showText("Your POKéMON are\nfighting fit!", () => { npc.frozen = false; });
        } else {
          npc.frozen = false;
        }
      });
      return true;
    }
    if (name.endsWith("MART_CLERK")) {
      const pointers = this.shell.data.text_pointers as
        | Record<string, Record<string, { mart?: string[] }>>
        | undefined;
      const ids = pointers?.[this.map.def.label]?.[npc.def.text]?.mart ?? [];
      const stock = ids.flatMap((item) => {
        const def = this.shell.data.items?.[item];
        return def ? [{ item, price: def.price }] : [];
      });
      this.shell.openMart(stock);
      return true;
    }
    const itemBalls: Record<string, string> = {
      VIRIDIANFOREST_ANTIDOTE: "ANTIDOTE",
      VIRIDIANFOREST_POTION: "POTION",
      VIRIDIANFOREST_POKE_BALL: "POKE_BALL",
      ROUTE2_MOON_STONE: "MOON_STONE",
      ROUTE2_HP_UP: "HP_UP",
      MTMOON1F_POTION1: "POTION",
      MTMOON1F_MOON_STONE: "MOON_STONE",
      MTMOON1F_RARE_CANDY: "RARE_CANDY",
      MTMOON1F_ESCAPE_ROPE: "ESCAPE_ROPE",
      MTMOON1F_POTION2: "POTION",
      MTMOON1F_TM_WATER_GUN: "TM_WATER_GUN",
      MTMOONB2F_HP_UP: "HP_UP",
      MTMOONB2F_TM_MEGA_PUNCH: "TM_MEGA_PUNCH",
      ROUTE4_TM_WHIRLWIND: "TM_WHIRLWIND",
    };
    // Mt. Moon's two fossil sprites are a single story choice.  The ROM
    // leaves both objects on the floor until the Super Nerd has been beaten;
    // taking either one awards exactly one fossil and clears the blocking
    // event so the player can leave the cave.
    if (name === "MTMOONB2F_DOME_FOSSIL" || name === "MTMOONB2F_HELIX_FOSSIL") {
      if (!this.shell.save.flags.EVENT_BEAT_MT_MOON_3_SUPER_NERD) {
        this.shell.showText("The fossils are guarded by\na SUPER NERD.");
        return true;
      }
      this.shell.showChoice("Take the DOME FOSSIL\nor the HELIX FOSSIL?", (dome) => {
        const item = dome ? "DOME_FOSSIL" : "HELIX_FOSSIL";
        this.shell.save.inventory[item] = (this.shell.save.inventory[item] ?? 0) + 1;
        this.shell.save.flags[dome ? "EVENT_GOT_DOME_FOSSIL" : "EVENT_GOT_HELIX_FOSSIL"] = true;
        this.shell.save.flags.EVENT_MT_MOON_FOSSIL_TAKEN = true;
        this.npcs = this.npcs.filter((candidate) =>
          candidate.def.name !== "MTMOONB2F_DOME_FOSSIL" && candidate.def.name !== "MTMOONB2F_HELIX_FOSSIL");
        this.entities = [this.player, ...this.npcs];
        this.shell.showText(`You got the ${item.replaceAll("_", " ")}!`);
      });
      return true;
    }
    const item = itemBalls[name] ?? npc.def.item;
    if (item) {
      const reward = grantItem(this.shell.save, this.shell.data, `EVENT_TAKEN_${name}`, item);
      if (reward === "full") { this.shell.showText("Your BAG is full."); return true; }
      if (reward === "already") return true;
      this.npcs = this.npcs.filter((candidate) => candidate !== npc);
      this.entities = [this.player, ...this.npcs];
      this.shell.showText(`${this.shell.save.player.name} found\n${item.replaceAll("_", " ")}!`);
      return true;
    }
    const trainers: Record<string, { label?: string; trainerClass: string; party?: { species: string; level: number }[]; partyIndex?: number; range?: number; event?: string }> = {
      VIRIDIANFOREST_YOUNGSTER2: { label: "BUG CATCHER RICK", trainerClass: "OPP_BUG_CATCHER", party: [{ species: "WEEDLE", level: 6 }, { species: "CATERPIE", level: 6 }] },
      VIRIDIANFOREST_YOUNGSTER3: { label: "BUG CATCHER DOUG", trainerClass: "OPP_BUG_CATCHER", party: [{ species: "WEEDLE", level: 7 }, { species: "KAKUNA", level: 7 }, { species: "WEEDLE", level: 7 }] },
      VIRIDIANFOREST_YOUNGSTER4: { label: "BUG CATCHER SAMMY", trainerClass: "OPP_BUG_CATCHER", party: [{ species: "WEEDLE", level: 9 }] },
      PEWTERGYM_COOLTRAINER_M: { label: "JR.TRAINER♂ LIAM", trainerClass: "OPP_JR_TRAINER_M", party: [{ species: "DIGLETT", level: 11 }, { species: "SANDSHREW", level: 11 }] },
      PEWTERGYM_BROCK: { label: "BROCK", trainerClass: "OPP_BROCK", party: [{ species: "GEODUDE", level: 12 }, { species: "ONIX", level: 14 }] },
      ROUTE3_YOUNGSTER1: { trainerClass: "OPP_BUG_CATCHER", partyIndex: 4, range: 2, event: "EVENT_BEAT_ROUTE_3_TRAINER_0" },
      ROUTE3_YOUNGSTER2: { trainerClass: "OPP_YOUNGSTER", partyIndex: 1, range: 3, event: "EVENT_BEAT_ROUTE_3_TRAINER_1" },
      ROUTE3_COOLTRAINER_F1: { trainerClass: "OPP_LASS", partyIndex: 1, range: 2, event: "EVENT_BEAT_ROUTE_3_TRAINER_2" },
      ROUTE3_YOUNGSTER3: { trainerClass: "OPP_BUG_CATCHER", partyIndex: 5, range: 1, event: "EVENT_BEAT_ROUTE_3_TRAINER_3" },
      ROUTE3_COOLTRAINER_F2: { trainerClass: "OPP_LASS", partyIndex: 2, range: 4, event: "EVENT_BEAT_ROUTE_3_TRAINER_4" },
      ROUTE3_YOUNGSTER4: { trainerClass: "OPP_YOUNGSTER", partyIndex: 2, range: 3, event: "EVENT_BEAT_ROUTE_3_TRAINER_5" },
      ROUTE3_YOUNGSTER5: { trainerClass: "OPP_BUG_CATCHER", partyIndex: 6, range: 3, event: "EVENT_BEAT_ROUTE_3_TRAINER_6" },
      ROUTE3_COOLTRAINER_F3: { trainerClass: "OPP_LASS", partyIndex: 3, range: 2, event: "EVENT_BEAT_ROUTE_3_TRAINER_7" },
      MTMOON1F_HIKER: { trainerClass: "OPP_HIKER", partyIndex: 1, range: 2, event: "EVENT_BEAT_MT_MOON_1_TRAINER_0" },
      MTMOON1F_YOUNGSTER1: { trainerClass: "OPP_YOUNGSTER", partyIndex: 3, range: 3, event: "EVENT_BEAT_MT_MOON_1_TRAINER_1" },
      MTMOON1F_COOLTRAINER_F1: { trainerClass: "OPP_LASS", partyIndex: 5, range: 3, event: "EVENT_BEAT_MT_MOON_1_TRAINER_2" },
      MTMOON1F_SUPER_NERD: { trainerClass: "OPP_SUPER_NERD", partyIndex: 1, range: 3, event: "EVENT_BEAT_MT_MOON_1_TRAINER_3" },
      MTMOON1F_COOLTRAINER_F2: { trainerClass: "OPP_LASS", partyIndex: 6, range: 3, event: "EVENT_BEAT_MT_MOON_1_TRAINER_4" },
      MTMOON1F_YOUNGSTER2: { trainerClass: "OPP_BUG_CATCHER", partyIndex: 7, range: 3, event: "EVENT_BEAT_MT_MOON_1_TRAINER_5" },
      MTMOON1F_YOUNGSTER3: { trainerClass: "OPP_BUG_CATCHER", partyIndex: 8, range: 3, event: "EVENT_BEAT_MT_MOON_1_TRAINER_6" },
      MTMOONB2F_SUPER_NERD: { trainerClass: "OPP_SUPER_NERD", partyIndex: 2, event: "EVENT_BEAT_MT_MOON_3_SUPER_NERD" },
      MTMOONB2F_ROCKET1: { trainerClass: "OPP_ROCKET", partyIndex: 1, range: 4, event: "EVENT_BEAT_MT_MOON_3_TRAINER_0" },
      MTMOONB2F_ROCKET2: { trainerClass: "OPP_ROCKET", partyIndex: 2, range: 4, event: "EVENT_BEAT_MT_MOON_3_TRAINER_1" },
      MTMOONB2F_ROCKET3: { trainerClass: "OPP_ROCKET", partyIndex: 3, range: 4, event: "EVENT_BEAT_MT_MOON_3_TRAINER_2" },
      MTMOONB2F_ROCKET4: { trainerClass: "OPP_ROCKET", partyIndex: 4, range: 4, event: "EVENT_BEAT_MT_MOON_3_TRAINER_3" },
      ROUTE4_COOLTRAINER_F2: { trainerClass: "OPP_LASS", partyIndex: 4, range: 3, event: "EVENT_BEAT_ROUTE_4_TRAINER_0" },
      CERULEANGYM_COOLTRAINER_F: { trainerClass: "OPP_JR_TRAINER_F", partyIndex: 1, range: 3, event: "EVENT_BEAT_CERULEAN_GYM_TRAINER_0" },
      CERULEANGYM_SWIMMER: { trainerClass: "OPP_SWIMMER", partyIndex: 1, range: 3, event: "EVENT_BEAT_CERULEAN_GYM_TRAINER_1" },
      VERMILIONGYM_LT_SURGE: { label: "LT. SURGE", trainerClass: "OPP_LT_SURGE", partyIndex: 1, event: "EVENT_BEAT_LT_SURGE" },
      CELADONGYM_ERIKA: { label: "ERIKA", trainerClass: "OPP_ERIKA", partyIndex: 1, event: "EVENT_BEAT_ERIKA" },
      CERULEANGYM_MISTY: { label: "MISTY", trainerClass: "OPP_MISTY", partyIndex: 1, event: "EVENT_BEAT_MISTY" },
    };
    const header = trainerHeader(this.shell.data, this.map.def, npc.def.index);
    const trainer = trainers[name] ?? (npc.def.trainerClass && npc.def.trainerParty
      ? {
          trainerClass: npc.def.trainerClass,
          partyIndex: npc.def.trainerParty,
          event: header?.event ?? `EVENT_BEAT_${name}`,
        }
      : undefined);
    if (!trainer) return false;
    const trainerDef = this.shell.data.trainers?.[trainer.trainerClass];
    const party = trainer.party ?? trainerDef?.parties[(trainer.partyIndex ?? 1) - 1];
    if (!party?.length) return false;
    const label = trainer.label ?? trainerDef?.name ?? "TRAINER";
    const forestFlag: Record<string, string> = {
      VIRIDIANFOREST_YOUNGSTER2: "EVENT_BEAT_VIRIDIAN_FOREST_TRAINER_0",
      VIRIDIANFOREST_YOUNGSTER3: "EVENT_BEAT_VIRIDIAN_FOREST_TRAINER_1",
      VIRIDIANFOREST_YOUNGSTER4: "EVENT_BEAT_VIRIDIAN_FOREST_TRAINER_2",
      PEWTERGYM_COOLTRAINER_M: "EVENT_BEAT_PEWTER_GYM_TRAINER_0",
    };
    const beatFlag = header?.event ?? trainer.event ?? (name === "PEWTERGYM_BROCK" ? "EVENT_BEAT_BROCK" : (forestFlag[name] ?? `EVENT_BEAT_${name}`));
    if (this.shell.save.flags[beatFlag] || this.shell.save.flags[`EVENT_BEAT_${name}`]) {
      if (GYM_REWARDS[name] && !this.shell.save.flags[GYM_REWARDS[name].event]) { this.giveGymReward(name); return true; }
      if (name === "PEWTERGYM_BROCK") {
        this.shell.showText("Go to the GYM in\nCERULEAN and test\nyour abilities!");
        return true;
      }
      const afterKey = header?.won ?? header?.after;
      const after = afterKey && (this.shell.data.text as Record<string, string> | undefined)?.[afterKey];
      this.shell.showText(after || `${label} was defeated!`);
      return true;
    }
    npc.frozen = true;
    npc.facePlayer(this.player);
    const pre = (header?.battle && (this.shell.data.text as Record<string, string> | undefined)?.[header.battle]) || this.resolveText(npc.def.text) || `${label} wants\nto battle!`;
    this.shell.showText(pre, () => this.shell.pushTrainerBattle(label, trainer.trainerClass, party, () => {
      this.shell.save.flags[beatFlag] = true;
      npc.frozen = false;
      if (GYM_REWARDS[name]) {
        this.giveGymReward(name);
      } else if (this.map.id === "ROUTE_24" && this.bridgeComplete() && !this.shell.save.flags.EVENT_GOT_NUGGET) {
        this.awardNugget();
      } else {
        this.shell.showText(`${label} was\ndefeated!`);
      }
    }));
    return true;
  }

  private giveGymReward(name: string): void {
    const reward = GYM_REWARDS[name];
    this.shell.save.inventory[reward.badge] = 1;
    const result = grantItem(this.shell.save, this.shell.data, reward.event, reward.tm);
    this.shell.showText(result === "full"
      ? `You earned the\n${reward.badge}!\fYour BAG is full.\nCome back for your TM.`
      : `You received the\n${reward.badge}!\fYou received\n${reward.tm.replaceAll("_", " ")}!`);
  }

  private bridgeComplete(): boolean {
    return [3, 4, 5, 6, 7].every(index => {
      const obj = this.map.def.objects.find(o => o.index === index);
      const header = trainerHeader(this.shell.data, this.map.def, index);
      return !!(header && this.shell.save.flags[header.event] ||
        obj && this.shell.save.flags[`EVENT_BEAT_${obj.name}`]);
    });
  }

  private awardNugget(done?: () => void): void {
    if (!this.shell.save.flags.EVENT_GOT_NUGGET) {
      this.shell.save.inventory.NUGGET = (this.shell.save.inventory.NUGGET ?? 0) + 1;
      this.shell.save.flags.EVENT_GOT_NUGGET = true;
    }
    this.shell.showText("You beat all five!\fYou received a NUGGET!", done);
  }

  private tryChooseStarter(npc: NPC): boolean {
    if (this.map.id !== "OAKS_LAB" || this.shell.save.flags.EVENT_GOT_STARTER) return false;
    const species = npc.def.name?.match(/^OAKSLAB_(BULBASAUR|CHARMANDER|SQUIRTLE)_POKE_BALL$/)?.[1] as
      | "BULBASAUR"
      | "CHARMANDER"
      | "SQUIRTLE"
      | undefined;
    if (!species) return false;
    const kind = species === "BULBASAUR" ? "plant" : species === "CHARMANDER" ? "fire" : "water";
    this.shell.showChoice(`So! You want the\n${kind} POKéMON,\n${species}?`, (yes) => {
      if (!yes) return;
      this.shell.chooseStarter(species);
      this.shell.showText(`${this.shell.save.player.name} received\na ${species}!`);
      this.npcs = this.npcs.filter((candidate) => this.objectVisible(candidate.def));
      this.entities = [this.player, ...this.npcs];
    });
    return true;
  }

  // OverworldController.lua:3241 showMapText — a TEXT_* constant goes to the
  // map's hand-ported script if it has one (MapScripts.lua:239 talkScript),
  // and to the plain extracted line otherwise. The scripted path is what
  // makes a text_asm branch branch: the extracted text of one of those
  // pointers is only ever its FIRST case, so without the script Mom reads the
  // wake-up line forever and Oak never stops warning you about the grass.
  showMapText(textConst: string, npc?: NPC, onDone?: () => void): void {
    const script = talkScript(this.map.id, textConst);
    if (script && !this.runner.isRunning()) {
      if (npc) npc.frozen = true;
      this.runner.run(script, {
        npc,
        onDone: () => {
          if (this.oneShotPending) {
            // Music.lua:403 oneShotPlaying holds the script until the jingle
            // ends and Music.update restores the theme; this surface cannot
            // ask, so the theme comes back when the script does.
            this.oneShotPending = false;
            this.shell.restoreMapMusic();
          }
          onDone?.();
        },
      });
      return;
    }
    const text = this.resolveText(textConst);
    if (text !== null) {
      if (npc) npc.facePlayer(this.player);
      this.shell.showText(text, onDone);
    } else {
      onDone?.();
    }
  }

  // ScriptWorld (script.ts) — the services a command reaches -------------

  /** Commands.lua:587 heal_party. */
  healParty(): void {
    this.shell.healParty();
  }

  /** Commands.lua:533 play_once — see showMapText's restore note. */
  playOnce(songId: string, onDone: () => void): void {
    this.oneShotPending = true;
    this.shell.playOnce(songId);
    onDone();
  }

  /**
   * Commands.lua:1216 fade — the overlay ramps to the colour and back. The
   * voxel surface has no overlay op, so the port spends the ramp's frames the
   * way it spends every other fade's (game.ts WarpFadeState holds the world).
   */
  fade(_dir: "in" | "out", frames: number, onDone: () => void): void {
    this.shell.pushWarpFade(frames, () => {}, onDone);
  }

  /** Commands.lua:162 face_player. */
  facePlayer(npc: NPC): void {
    npc.facePlayer(this.player);
  }

  // src/core/Data.lua:304 resolveText — map label + TEXT_* const through
  // text_pointers; a text_asm entry falls back to its extracted _Label
  // string when one exists (#318).
  resolveText(textConst: string): string | null {
    const pointers = this.shell.data.text_pointers as
      | Record<string, Record<string, { label?: string; text?: string; asm?: boolean }>>
      | undefined;
    const texts = this.shell.data.text as Record<string, string> | undefined;
    const entry = pointers?.[this.map.def.label]?.[textConst];
    if (!entry || !texts) return null;
    if (entry.text) {
      const s = texts[entry.text];
      if (s) return s;
    }
    if (entry.label) {
      const s = texts[`_${entry.label}`];
      if (s) return s;
    }
    return null;
  }

  // OverworldController.lua:1713
  npcAtCell(cx: number, cy: number): NPC | undefined {
    return this.npcs.find(
      (npc) =>
        (npc.cellX === cx && npc.cellY === cy) || (npc.targetX === cx && npc.targetY === cy),
    );
  }

  private touchWild(dir: Dir): boolean {
    if (!this.shell.data.partyIcons || !this.shell.save.party?.some(mon => mon.hp > 0)) return false;
    const [x, y] = target(this.player.cellX, this.player.cellY, dir);
    const wild = this.wild.atCell(x, y);
    if (!wild || !canMove(this.map, this.entities, this.player, dir, this.tilePairs).ok) return false;
    const enc = this.wild.consume(wild);
    this.encounterCount++;
    this.lastEncounter = enc;
    this.shell.pushStubBattle(enc.species, enc.level);
    return true;
  }

  // OverworldController.lua:3361 onStepComplete — the completed-step
  // land-triggers, in the original's order: warp-entry staleness, the
  // standing-on-warp refresh, arrival/held-collision warps, then the wild
  // encounter roll. (Spinners, badge gates, forced movement, Safari,
  // poison and repel are outside the slice.)
  onStepComplete(): void {
    this.shell.onFieldStep?.();
    const p = this.player;
    if (this.tryLabExitGate()) return;
    if (this.tryLabRivalEvent()) return;
    if (this.tryPalletOakEvent()) return;
    if (this.tryRoute22RivalEvent()) return;
    if (this.tryCeruleanRivalEvent()) return;
    if (this.tryTrainerSight()) return;
    // The arrival disable is POSITIONAL (issue #265): the cell we warped in
    // on is inert until we step off it; pokered has no one-shot counter —
    // every completed step runs CheckWarpsNoCollision.
    let entry = this.warpEntryCell;
    if (entry && (p.cellX !== entry.x || p.cellY !== entry.y)) {
      this.warpEntryCell = undefined;
      entry = undefined;
    }
    // BIT_STANDING_ON_WARP maintenance: cleared before the check, set again
    // on a warp square, cleared once more when the square is warp-activating
    // but not a door (home/overworld.asm:324 + player_state.asm).
    this.refreshStandingOnWarp();
    if (!entry) {
      // CheckWarpsNoCollision: door/warp tiles fire immediately; otherwise
      // ExtraWarpCheck must pass AND a d-pad is held.
      let w = onArrive(this.map, p.cellX, p.cellY);
      if (!w && this.dirHeld()) {
        w = onCollision(this.map, this.carpets, p.cellX, p.cellY, p.facing);
      }
      if (w) {
        this.takeWarp(w.def);
        return;
      }
    }
    // Cooked icon-enabled builds use contact encounters. Legacy/raw packs
    // without icon assets retain step encounters instead of invisible wilds.
    if (this.shell.data.partyIcons) return;
    // wild encounters in grass, on water while surfing, or — on indoor maps
    // whose tileset is not FOREST — on EVERY tile (wild_encounters.asm)
    const encDef = this.shell.data.encounters[this.map.id] as EncounterDef | undefined;
    const indoor = (this.shell.data.field as {
      indoorEncounters?: { firstIndoorMap: number; excludedTileset: string };
    })?.indoorEncounters;
    let enc: { species: string; level: number } | null = null;
    if (p.surfing && encDef?.water && this.map.isWaterCell(p.cellX, p.cellY)) {
      enc = encounterRoll({ grass: encDef.water }, this.shell.rng);
    } else if (this.map.isGrassCell(p.cellX, p.cellY)) {
      enc = encounterRoll(encDef, this.shell.rng);
    } else if (
      indoor &&
      this.map.def.index >= indoor.firstIndoorMap &&
      this.map.def.tileset !== indoor.excludedTileset
    ) {
      enc = encounterRoll(encDef, this.shell.rng);
    }
    if (enc) {
      this.encounterCount += 1;
      this.lastEncounter = enc;
      // BATTLE-PORT SEAM: the real battle state machine replaces this push
      // in a later task (BattleState.newWild in the reference).
      this.shell.pushStubBattle(enc.species, enc.level);
    }
  }

  /** All cooked trainers use their imported sight range and defeat flag. */
  private tryTrainerSight(): boolean {
    const dirs: Record<string, Dir> = {
      LEFT: "left", RIGHT: "right", UP: "up", DOWN: "down",
    };
    for (const npc of this.npcs) {
      const header = trainerHeader(this.shell.data, this.map.def, npc.def.index);
      const range = header?.range ?? 0;
      const dir = dirs[npc.def.range ?? ""];
      if (!npc.def.trainerClass || !header || range <= 0 || !dir ||
          this.shell.save.flags[header.event] || this.shell.save.flags[`EVENT_BEAT_${npc.def.name}`]) continue;
      const dx = this.player.cellX - npc.cellX;
      const dy = this.player.cellY - npc.cellY;
      const distance = Math.abs(dx) + Math.abs(dy);
      const aligned =
        (dir === "left" && dy === 0 && dx < 0) ||
        (dir === "right" && dy === 0 && dx > 0) ||
        (dir === "up" && dx === 0 && dy < 0) ||
        (dir === "down" && dx === 0 && dy > 0);
      if (!aligned || distance > range) continue;
      let clear = true;
      for (let step = 1; step < distance; step++) {
        const x = npc.cellX + (dx === 0 ? 0 : Math.sign(dx) * step);
        const y = npc.cellY + (dy === 0 ? 0 : Math.sign(dy) * step);
        if (!this.map.isWalkableCell(x, y) || this.npcAtCell(x, y)) { clear = false; break; }
      }
      if (!clear) continue;
      npc.frozen = true;
      npc.facing = dir;
      this.shell.showText("!", () => {
        this.scriptMove(npc, dir, Math.max(0, distance - 1), () => this.talkTo(npc));
      });
      return true;
    }
    return false;
  }

  private tryLabExitGate(): boolean {
    const flags = this.shell.save.flags;
    if (
      this.map.id !== "OAKS_LAB" || this.player.cellY < 6 ||
      !flags.EVENT_FOLLOWED_OAK_INTO_LAB || flags.EVENT_GOT_STARTER
    ) return false;
    const text = this.shell.data.text as Record<string, string> | undefined;
    this.shell.showText(text?._OaksLabOakDontGoAwayYetText ?? "OAK: Wait!\nDon't go away yet!", () => {
      this.scriptMove(this.player, "up", 1);
    });
    return true;
  }

  private tryLabRivalEvent(): boolean {
    const flags = this.shell.save.flags;
    if (
      this.map.id !== "OAKS_LAB" || this.player.cellY < 6 ||
      !flags.EVENT_GOT_STARTER || flags.EVENT_BATTLED_RIVAL_IN_OAKS_LAB
    ) return false;
    const rivalSpecies = flags.EVENT_CHOSE_BULBASAUR
      ? "CHARMANDER"
      : flags.EVENT_CHOSE_CHARMANDER
        ? "SQUIRTLE"
        : "BULBASAUR";
    const text = this.shell.data.text as Record<string, string> | undefined;
    this.shell.showText(
      text?._OaksLabRivalIllTakeYouOnText ?? "BLUE: Wait!\nLet's check out our\nPOKéMON!",
      () => {
        flags.EVENT_BATTLED_RIVAL_IN_OAKS_LAB = true;
        this.shell.pushTrainerBattle("RIVAL BLUE", "OPP_RIVAL1", [{ species: rivalSpecies, level: 5 }], () => {});
      },
    );
    return true;
  }

  private rivalStarter(): "BULBASAUR" | "CHARMANDER" | "SQUIRTLE" {
    const flags = this.shell.save.flags;
    return flags.EVENT_CHOSE_BULBASAUR ? "CHARMANDER"
      : flags.EVENT_CHOSE_CHARMANDER ? "SQUIRTLE" : "BULBASAUR";
  }

  /** Route22.asm first rival encounter at (29,4)/(29,5), parties 4..6. */
  private tryRoute22RivalEvent(): boolean {
    const flags = this.shell.save.flags;
    const p = this.player;
    if (this.map.id !== "ROUTE_22" || !flags.EVENT_GOT_STARTER ||
        flags.EVENT_BEAT_ROUTE22_RIVAL_1ST_BATTLE ||
        !((p.cellX === 29 && p.cellY === 4) || (p.cellX === 29 && p.cellY === 5))) return false;
    const starter = this.rivalStarter();
    const index = starter === "SQUIRTLE" ? 4 : starter === "BULBASAUR" ? 5 : 6;
    const party = this.shell.data.trainers?.OPP_RIVAL1?.parties[index - 1];
    if (!party) return false;
    this.shell.showText(`${this.shell.save.player.rival}: Hey!\nYou're going to the\nPOKéMON LEAGUE?`, () => {
      this.shell.pushTrainerBattle(`RIVAL ${this.shell.save.player.rival}`, "OPP_RIVAL1", party, () => {
        flags.EVENT_BEAT_ROUTE22_RIVAL_1ST_BATTLE = true;
        this.shell.showText(`${this.shell.save.player.rival}: Smell you later!`);
      });
    });
    return true;
  }

  /** CeruleanCity.asm bridge approach at (20,6)/(21,6), parties 7..9. */
  private tryCeruleanRivalEvent(): boolean {
    const flags = this.shell.save.flags;
    const p = this.player;
    if (this.map.id !== "CERULEAN_CITY" || flags.EVENT_BEAT_CERULEAN_RIVAL ||
        !((p.cellX === 20 || p.cellX === 21) && p.cellY === 6)) return false;
    const starter = this.rivalStarter();
    const index = starter === "SQUIRTLE" ? 7 : starter === "BULBASAUR" ? 8 : 9;
    const party = this.shell.data.trainers?.OPP_RIVAL1?.parties[index - 1];
    if (!party) return false;
    const def = this.map.def.objects.find(o => o.name === "CERULEANCITY_RIVAL");
    const rival = def ? new NPC(this.map.id, def, this.shell.npcRng) : undefined;
    if (rival) {
      rival.cellX = p.cellX; rival.cellY = p.cellY - 1;
      rival.px = rival.cellX * 16; rival.py = rival.cellY * 16;
      rival.frozen = true;
      this.npcs.push(rival); this.entities = [p, ...this.npcs];
    }
    p.facing = "up";
    this.shell.showText(`${this.shell.save.player.rival}: Yo!\nYou're still struggling\nalong back here?`, () => {
      this.shell.pushTrainerBattle(`RIVAL ${this.shell.save.player.rival}`, "OPP_RIVAL1", party, () => {
        flags.EVENT_BEAT_CERULEAN_RIVAL = true;
        this.shell.showText(`${this.shell.save.player.rival}: I went to see\nBILL! Smell ya!`, () => {
          if (!rival) return;
          this.scriptMove(rival, rival.cellX === 20 ? "right" : "left", 1, () =>
            this.scriptMove(rival, "down", 6, () => {
              this.npcs = this.npcs.filter(n => n !== rival);
              this.entities = [this.player, ...this.npcs];
            }));
        });
      });
    });
    return true;
  }

  /** PalletTownOakHeyWaitScript, before warp and encounter processing. */
  private tryPalletOakEvent(): boolean {
    const flags = this.shell.save.flags;
    if (
      this.map.id !== "PALLET_TOWN" ||
      this.player.cellY !== 1 ||
      flags.EVENT_FOLLOWED_OAK_INTO_LAB ||
      this.oakEventRunning
    ) {
      return false;
    }
    this.oakEventRunning = true;
    this.player.facing = "down";
    const text = this.shell.data.text as Record<string, string> | undefined;
    const walkPath = (entity: Player | NPC, steps: Dir[], done?: () => void): void => {
      const next = (i: number): void => {
        const dir = steps[i];
        if (!dir) { done?.(); return; }
        this.scriptMove(entity, dir, 1, () => next(i + 1));
      };
      next(0);
    };
    this.shell.showText(
      text?._PalletTownOakHeyWaitDontGoOutText ?? "OAK: Hey! Wait!\nDon't go out!",
      () => {
        const oakDef = this.map.def.objects.find((obj) => obj.name === "PALLETTOWN_OAK");
        if (!oakDef) { this.oakEventRunning = false; return; }
        const oak = new NPC(this.map.id, oakDef, this.shell.npcRng);
        oak.frozen = true;
        // Keep the escort synchronized with the current player setting.
        // Music-on mode deliberately lengthens player steps, so Oak must use
        // that same duration instead of the NPC default or he pulls ahead.
        oak.stepFrames = this.player.stepFrames;
        this.npcs.push(oak);
        this.entities = [this.player, ...this.npcs];
        const approach: Dir[] = [];
        while (oak.cellX + approach.filter((d) => d === "right").length - approach.filter((d) => d === "left").length !== this.player.cellX) {
          const projected = oak.cellX + approach.filter((d) => d === "right").length - approach.filter((d) => d === "left").length;
          approach.push(projected < this.player.cellX ? "right" : "left");
        }
        approach.push("up", "up", "up");
        walkPath(oak, approach, () => this.shell.showText(
          text?._PalletTownOakItsUnsafeText ?? "OAK: It's unsafe!\nWild POKéMON live\nin tall grass!",
          () => {
            const oakSteps: Dir[] = ["down", "down", "down", "down", "down", "left", "down", "down", "down", "down", "down", "right", "right", "right", "up"];
            const playerSteps: Dir[] = ["down", ...oakSteps];
            walkPath(oak, oakSteps);
            walkPath(this.player, playerSteps, () => {
              // This is a fully scripted entrance. Do not arm the generic
              // door walk-out: it would queue a south step at the same time
              // as the escort queues its northbound lab path. The desktop
              // scheduler happened to serialize those moves, but the PSP
              // could stall on that conflicting transition-frame pair.
              this.doorWarp = false;
              this.shell.audio.playSfx("Go_Inside");
              this.startWarpTo("OAKS_LAB", 5, 11, "up", () => {
                const labOakDef = this.map.def.objects.find((obj) => obj.name === "OAKSLAB_OAK2");
                if (labOakDef) {
                  const labOak = new NPC(this.map.id, labOakDef, this.shell.npcRng);
                  labOak.frozen = true;
                  this.npcs.push(labOak);
                  this.entities = [this.player, ...this.npcs];
                  walkPath(labOak, ["up", "up", "up"]);
                }
                // Seven north steps from y=11 reaches the same y=4 endpoint
                // as the old automatic south step followed by eight north.
                walkPath(this.player, ["up", "up", "up", "up", "up", "up", "up"], () => {
                  flags.EVENT_FOLLOWED_OAK_INTO_LAB = true;
                  flags.EVENT_FOLLOWED_OAK_INTO_LAB_2 = true;
                  flags.EVENT_OAK_ASKED_TO_CHOOSE_MON = true;
                  this.shell.showText(text?._OaksLabOakChooseMonText ?? "OAK: Choose a POKéMON!", () => {
                    this.oakEventRunning = false;
                  });
                });
              });
            });
          },
        ));
      },
    );
    return true;
  }

  // OverworldController.lua:3907 takeWarp
  takeWarp(warpDef: MapWarp): void {
    let last = this.lastOutdoor;
    if (warpDef.destMap === "LAST_MAP" && !last) {
      // old saves / unexpected states: never crash on an exit mat — fall
      // back to the remembered heal point (OverworldController.lua:3909)
      const heal = this.shell.save.lastHeal;
      if (heal) last = { id: heal.map, x: heal.x, y: heal.y };
    }
    if (warpDef.destMap === "LAST_MAP") {
      last = physicalExit(this.shell.data, this.map.id, warpDef, last) ?? last;
    }
    const dest = destination(this.shell.data, warpDef, last);
    // A player already inside must always be able to leave, including old
    // saves that entered through the rear before meeting Bill.
    if (this.map.id === "CERULEAN_TRASHED_HOUSE" && dest.map === "CERULEAN_CITY") {
      this.shell.save.flags.EVENT_CERULEAN_HOUSE_OPEN = true;
    }
    // VermilionDockScript: the sailor checks the S.S.TICKET before admitting
    // Red. Once HM01 has been collected and the ship has been exited, it
    // departs and cannot be boarded again.
    if (this.map.id === "VERMILION_CITY" && dest.map === "VERMILION_DOCK") {
      if (this.shell.save.flags.EVENT_SS_ANNE_LEFT) {
        this.shell.showText("The S.S.ANNE has\nset sail!");
        return;
      }
      if (!this.shell.save.inventory.SS_TICKET) {
        this.shell.showText("You need an\nS.S.TICKET to board!");
        return;
      }
    }
    if (
      this.map.id === "SS_ANNE_1F" &&
      dest.map === "VERMILION_DOCK" &&
      this.shell.save.flags.EVENT_GOT_HM01
    ) {
      this.shell.save.flags.EVENT_SS_ANNE_LEFT = true;
    }
    // facing carries across the warp (leaving a gate sideways keeps you
    // walking sideways; house exit mats are stepped onto facing down)
    const facing = this.player.facing;
    // warp pads and fall-through holes are not doors (WarpFound2
    // .indoorMaps): no door SFX, no walk-out step
    const pad = this.map.warpPadOrHoleAt(this.player.cellX, this.player.cellY);
    if (pad === undefined) {
      this.doorWarp = true; // door SFX + PlayerStepOutFromDoor walk-out
    }
    this.startWarpTo(dest.map, dest.x, dest.y, facing);
  }

  // OverworldController.lua:3949 rememberOutdoor (pokered's wLastMap)
  rememberOutdoor(id: string, x: number, y: number): void {
    this.lastOutdoor = { id, x, y };
    this.shell.save.lastOutdoor = this.lastOutdoor;
  }

  // OverworldController.lua:4004 startWarpTo — the fade out (32 ticks,
  // Timing WARP_FADE_OUT), the map switch at the midpoint, no fade back in
  // (LoadGBPal restores the palettes in one write).
  startWarpTo(
    mapId: string,
    x: number,
    y: number,
    facing?: Dir,
    onDone?: () => void,
    rememberSource = true,
  ): void {
    if (!this.isCooked(mapId)) {
      // The door is locked: a warp into a map the pak has no geometry for
      // would land the player in an invisible world. The warp never happens,
      // so nothing it staged may survive it — a doorWarp left armed here
      // would spend itself on the NEXT warp, walking the player out of a
      // door they did not enter — and a parked script must be resumed or the
      // runner never wakes (ScriptRunner.lua:197 resume).
      this.doorWarp = false;
      onDone?.();
      return;
    }
    // ANY transition off an outdoor map remembers the outdoor side, so
    // LAST_MAP exits keep working (CheckIfInOutsideMap includes PLATEAU).
    if (rememberSource && isOutside(this.map.def) && mapId !== this.map.id) {
      this.rememberOutdoor(this.map.id, this.player.cellX, this.player.cellY);
    }
    this.transitioning = true;
    const doorWarp = this.doorWarp;
    this.doorWarp = false;
    this.shell.pushWarpFade(
      WARP_FADE_OUT,
      () => {
        this.setMap(mapId, x, y, facing ?? "down");
        // Entering the lab voluntarily means Oak no longer needs to fetch
        // the player from Pallet's grass. It does not grant a starter.
        if (mapId === "OAKS_LAB") {
          this.shell.save.flags.EVENT_FOLLOWED_OAK_INTO_LAB = true;
          this.shell.save.flags.EVENT_FOLLOWED_OAK_INTO_LAB_2 = true;
        }
        // The warp we land ON stays inert until we physically step off it,
        // so a warp whose destination cell is itself a warp cannot bounce
        // us straight back. BIT_STANDING_ON_WARP is deliberately NOT
        // touched here: the flag the departing tile set rides through the
        // warp (issue #378).
        this.warpEntryCell = { x, y };
        if (doorWarp) {
          // OverworldController.lua:4053: the cue is chosen by where you
          // LANDED, and it plays for every door warp — the door-tile test
          // below only gates the walk-out step.
          this.shell.audio.playSfx(isOutside(this.map.def) ? "Go_Outside" : "Go_Inside");
        }
        if (doorWarp && this.map.isDoorTileCell(this.player.cellX, this.player.cellY)) {
          // PlayerStepOutFromDoor: any warp landing on a door tile
          // auto-steps south once. The walk-out is a simulated d-pad press,
          // so it obeys collision; a blocked landing keeps the player on
          // the door with the arrival disable intact.
          if (canMove(this.map, this.entities, this.player, "down", this.tilePairs).ok) {
            this.warpEntryCell = undefined;
            this.scriptMove(this.player, "down", 1);
          } else {
            this.player.facing = "down";
          }
        }
      },
      () => {
        this.transitioning = false;
        onDone?.();
      },
    );
  }

  // OverworldController.lua:4172 scriptMove
  scriptMove(entity: Player | NPC, dir: Dir, tiles: number, onDone?: () => void): void {
    this.scriptMoves.push({ entity, dir, remaining: tiles, onDone });
  }

  // OverworldController.lua:4195 updateScriptMoves — two phases so a
  // chained step begins the SAME frame the previous one ends: phase 1
  // retires finished moves (which may chain new ones); phase 2 starts
  // every not-yet-moving move.
  updateScriptMoves(): void {
    let i = 0;
    while (i < this.scriptMoves.length) {
      const mv = this.scriptMoves[i];
      if (!mv.entity.moving && mv.remaining <= 0) {
        this.scriptMoves.splice(i, 1);
        mv.onDone?.();
        // don't advance i: a move chained by onDone may now sit at i
      } else {
        i += 1;
      }
    }
    for (const mv of this.scriptMoves) {
      const e = mv.entity;
      if (!e.moving && mv.remaining > 0) {
        if (mv.inPlace) {
          e.moving = true;
          (e as NPC).marching = true;
          e.progress = 0;
        } else {
          e.facing = mv.dir!;
          const [tx, ty] = target(e.cellX, e.cellY, mv.dir!);
          e.targetX = tx;
          e.targetY = ty;
          e.moving = true;
          e.progress = 0;
          if (e instanceof Player) {
            e.stepFramesCur = e.stepFrames;
          }
        }
        mv.remaining -= 1;
      }
    }
  }

  // ScriptWorld surface for the runner's verbs -------------------------------

  showText(text: string, onDone?: () => void): void {
    this.shell.showText(text, onDone);
  }

  showChoice(text: string, choice: (yes: boolean) => void): void {
    this.shell.showChoice(text, choice);
  }

  setEmote(entity: unknown, kind: number, frames: number, onDone: () => void): void {
    this.emote = { entity: entity as Player | NPC, kind, frames, onDone };
  }
}
