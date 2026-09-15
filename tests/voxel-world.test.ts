// tests/voxel-world.test.ts — the gen1recomp overworld port under test.
//
// Layer 1 (ROM-free, always runs): the two-level input edge model and the
// textbox pagination/reveal machine over synthetic strings.
//
// Layer 2 (gated, skips with a printed reason when dist/voxelmon/gen is
// absent): cell-semantics ground truths from the reference
// tests/content_red/facts.lua, movement/ledge/warp/connection behavior,
// encounter slot mapping driven through the overworld path, and the
// story.tape determinism run (in-process twice + the real cli once).

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { VOX_BTN, VOX_OP } from "../contracts/spec/voxel-spec.ts";
import { DEFAULT_MAPS } from "../voxelmon/cook/core.ts";
import { loadGen, loadProfile, voxelmodDir } from "../voxelmon/cook/data-node.ts";
import { buildGamedata } from "../voxelmon/cook/gamedata.ts";
import { fromGenDir as loadAudioBanks } from "../voxelmon/game/audio/banks.ts";
import { newMon } from "../voxelmon/game/battle/mon.ts";
import {
  fromObject,
  loadRuntimeData,
  REQUIRED_MODULES,
  type MapDef,
  type TilesetDef,
  type VoxelmonData,
} from "../voxelmon/game/data.ts";
import { seqRng } from "../voxelmon/game/rng.ts";
import { effectiveRate, ENCOUNTER_BUCKETS } from "../voxelmon/game/rules/encounter.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { Input } from "../voxelmon/game/input.ts";
import { Scene, type SceneView } from "../voxelmon/game/scene.ts";
import { encodeGlyphs, glyphLen, MAX_COLS } from "../voxelmon/game/ui/tiles.ts";
import { GameMap, isOutdoor } from "../voxelmon/game/world/map.ts";
import { NPC } from "../voxelmon/game/world/npc.ts";
import { computeNeighbors } from "../voxelmon/game/world/overworld.ts";
import { Player } from "../voxelmon/game/world/player.ts";
import { paginate, Textbox } from "../voxelmon/game/world/textbox.ts";
import { parseTape, TapePlayer, TapeStallError } from "../voxelmon/game/sim/tape.ts";

const root = join(import.meta.dir, "..");
const genDir = join(root, "dist/voxelmon/gen");
const hasGen = REQUIRED_MODULES.every((m) => existsSync(join(genDir, `${m}.json`)));
if (!hasGen) {
  console.log("[voxel-world] dist/voxelmon/gen absent (run `bun tools/voxel.ts import`) — ROM-gated suites skipped");
}
const romData: VoxelmonData | null = hasGen ? await loadRuntimeData(genDir) : null;
const hasGroundProfile =
  hasGen &&
  existsSync(join(voxelmodDir(), "data/voxel_heights.lua")) &&
  Bun.which("luajit") !== null;

function entArgs(host: RecorderHost): number[][] {
  return host
    .text()
    .split("\n")
    .filter((line) => line.startsWith(`o ${VOX_OP.ent} `))
    .map((line) => line.split(" ").slice(2).map(Number));
}

function supportFixture(groundHeights?: number[]): { map: GameMap; def: MapDef } {
  const block = new Array(16).fill(0);
  block[4] = 0;
  block[6] = 1;
  block[12] = 2;
  block[14] = 3;
  const def: MapDef = {
    id: "SUPPORT_TEST",
    index: 1,
    label: "support test",
    tileset: "SUPPORT_TEST",
    width: 1,
    height: 1,
    blocks: [0],
    borderBlock: 0,
    connections: {},
    warps: [],
    objects: [],
    signs: [],
  };
  const tileset: TilesetDef = {
    id: "SUPPORT_TEST",
    blocks: [block],
    walkable: [true, true, true, true],
    counterTiles: [],
    doorTiles: [],
    warpTiles: [],
    groundHeights,
  };
  return { map: new GameMap(def, tileset), def };
}

function makeGame(seed = 1, legacyEncounters = false): VoxelmonGame {
  const data = legacyEncounters ? { ...romData!, partyIcons: undefined } : romData!;
  const game = new VoxelmonGame(data, new RecorderHost(), seed);
  game.newGame();
  game.chooseStarter("SQUIRTLE");
  game.save.flags.EVENT_FOLLOWED_OAK_INTO_LAB = true;
  return game;
}

/** Hold a button mask until pred() or maxTicks; returns ticks driven. */
function holdUntil(game: VoxelmonGame, mask: number, pred: () => boolean, maxTicks = 600): number {
  let t = 0;
  while (!pred() && t < maxTicks) {
    game.tick(mask);
    t += 1;
  }
  return t;
}

/** The tape walk rule in miniature: hold dir until `cells` land. */
function walk(game: VoxelmonGame, mask: number, cells: number, maxTicks = 2000): void {
  const p = game.overworld.player;
  const base = p.landedCount;
  let t = 0;
  while (p.landedCount - base < cells && t < maxTicks) {
    const inFlight = p.moving ? 1 : 0;
    game.tick(p.landedCount - base + inFlight >= cells ? 0 : mask);
    t += 1;
  }
  expect(p.landedCount - base).toBe(cells);
}

function idle(game: VoxelmonGame, ticks: number): void {
  for (let i = 0; i < ticks; i++) game.tick(0);
}

function tap(game: VoxelmonGame, mask: number): void {
  game.tick(mask);
  game.tick(0);
}

function openBedroomPcChoice(game: VoxelmonGame): void {
  game.overworld.setMap("REDS_HOUSE_2F", 0, 2, "up");
  game.overworld.refreshStandingOnWarp();
  tap(game, VOX_BTN.a);
  idle(game, 180);
  expect(game.stackKinds()).toEqual(["overworld", "textbox", "choice"]);
}

// ---------------------------------------------------------------------------
// Layer 1 — input: the two-level edge-per-step model (Input.lua)
// ---------------------------------------------------------------------------

describe("input edge model", () => {
  test("a press+release inside one step still edges (Input.lua:109-135)", () => {
    const input = new Input();
    input.sourcePress("a", "key:z");
    input.sourceRelease("a", "key:z");
    input.step();
    expect(input.wasPressed("a")).toBe(true);
    expect(input.isDown("a")).toBe(false);
  });

  test("edges are valid for the current step only (Input.lua:382)", () => {
    const input = new Input();
    input.sourcePress("a", "key:z");
    input.step();
    expect(input.wasPressed("a")).toBe(true);
    expect(input.isDown("a")).toBe(true);
    input.step();
    expect(input.wasPressed("a")).toBe(false);
    expect(input.isDown("a")).toBe(true); // still held by the live source
  });

  test("multi-source refcounting: one release does not clear another's hold", () => {
    const input = new Input();
    input.sourcePress("up", "key:w");
    input.sourcePress("up", "key:up");
    input.step();
    input.sourceRelease("up", "key:w");
    expect(input.isDown("up")).toBe(true);
    input.sourceRelease("up", "key:up");
    expect(input.isDown("up")).toBe(false);
  });

  test("host mask: a held bit edges once; a re-set bit edges again", () => {
    const input = new Input();
    input.setButtons(VOX_BTN.a);
    input.step();
    expect(input.wasPressed("a")).toBe(true);
    input.setButtons(VOX_BTN.a);
    input.step();
    expect(input.wasPressed("a")).toBe(false); // held, not re-pressed
    input.setButtons(0);
    input.step();
    input.setButtons(VOX_BTN.a);
    input.step();
    expect(input.wasPressed("a")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer 1 — textbox machine over synthetic text (TextBox.lua)
// ---------------------------------------------------------------------------

describe("textbox machine", () => {
  test("paginate wraps at 18 glyphs on space boundaries (TextBox.lua:108)", () => {
    const pages = paginate("aaaa bbbb cccc dddd eeee ffff");
    expect(pages.length).toBe(1);
    for (const line of pages[0].lines) {
      expect(glyphLen(line)).toBeLessThanOrEqual(MAX_COLS);
    }
    expect(pages[0].lines.join("")).toBe("aaaa bbbb cccc dddd eeee ffff");
  });

  test("apostrophe digraphs are single glyphs (charmap.asm)", () => {
    // "it's" = i,t,'s -> 3 glyphs, not 4
    expect(glyphLen("it's")).toBe(3);
    expect(encodeGlyphs("'d")).toEqual([0xbb]);
  });

  test("\\f splits pages, \\v marks a cont line (TextBox.lua:141-163)", () => {
    const pages = paginate("one\ntwothree\ffour");
    expect(pages.length).toBe(2);
    expect(pages[0].lines).toEqual(["one", "two", "three"]);
    expect(pages[0].contBefore).toEqual([false, false, true]);
    expect(pages[1].lines).toEqual(["four"]);
  });

  test("typewriter reveals one glyph per 3 idle frames, 1 while A held", () => {
    const input = new Input();
    const box = new Textbox("abcdef");
    for (let i = 0; i < 3; i++) box.update(input);
    expect(box.shown[0].revealed).toBe(1);
    for (let i = 0; i < 6; i++) box.update(input);
    expect(box.shown[0].revealed).toBe(3);
    input.setButtons(VOX_BTN.a);
    input.step();
    box.update(input);
    box.update(input);
    expect(box.shown[0].revealed).toBe(5);
  });

  test("a/b advance: preWait swallows the button, then the page turns", () => {
    const input = new Input();
    const box = new Textbox("one\ftwo");
    const tap = (btn: "a" | "b") => {
      input.setButtons(VOX_BTN[btn]);
      input.step();
      box.update(input);
      input.setButtons(0);
      input.step();
    };
    // type page 1 out (held-A fast path types + reaches waiting)
    input.setButtons(VOX_BTN.a);
    input.step();
    for (let i = 0; i < 8 && !box.waiting; i++) box.update(input);
    input.setButtons(0);
    input.step();
    expect(box.waiting).toBe(true);
    // TEXT_PRE_ADVANCE (Delay3): the arrow is up but the press is ignored
    tap("a");
    expect(box.waiting).toBe(true);
    box.update(input); // drain the remaining preWait
    box.update(input);
    tap("a");
    expect(box.waiting).toBe(false);
    expect(box.pageIndex).toBe(1);
    // TEXT_PAGE_CLEAR holds before the next page types
    expect(box.holdFrames).toBeGreaterThan(0);
    // drain hold + type page 2 with A held, then close on B
    input.setButtons(VOX_BTN.a);
    input.step();
    for (let i = 0; i < 40 && !box.done; i++) box.update(input);
    input.setButtons(0);
    input.step();
    expect(box.done).toBe(true);
    tap("b");
    expect(box.closed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — cell semantics vs the reference facts (content_red/facts.lua)
// ---------------------------------------------------------------------------

test("Map.isOutdoor honors explicit data before the legacy tileset fallback", () => {
  expect(isOutdoor({ tileset: "OVERWORLD", outdoor: false } as MapDef)).toBe(false);
  expect(isOutdoor({ tileset: "HOUSE", outdoor: true } as MapDef)).toBe(true);
  expect(isOutdoor({ tileset: "OVERWORLD" } as MapDef)).toBe(true);
  expect(isOutdoor({ tileset: "HOUSE" } as MapDef)).toBe(false);
});

describe("cell semantics (facts.lua ground truth)", () => {
  const map = (id: string): GameMap => {
    const def = romData!.maps![id];
    return new GameMap(def, romData!.tilesets![def.tileset]);
  };

  test.skipIf(!hasGen)("map dimensions in cells (facts.lua:25-29)", () => {
    expect(map("PALLET_TOWN").widthCells).toBe(20);
    expect(map("PALLET_TOWN").heightCells).toBe(18);
    expect(map("VIRIDIAN_CITY").widthCells).toBe(40);
    expect(map("VIRIDIAN_CITY").heightCells).toBe(36);
    expect(map("OAKS_LAB").widthCells).toBe(10);
    expect(map("OAKS_LAB").heightCells).toBe(12);
  });

  test.skipIf(!hasGen)("the four shipped rooms have no sky while surface maps do", () => {
    for (const id of ["REDS_HOUSE_1F", "REDS_HOUSE_2F", "OAKS_LAB", "BLUES_HOUSE"]) {
      expect(isOutdoor(romData!.maps![id]!)).toBe(false);
    }
    for (const id of ["PALLET_TOWN", "ROUTE_1", "VIRIDIAN_CITY"]) {
      expect(isOutdoor(romData!.maps![id]!)).toBe(true);
    }
  });

  test.skipIf(!hasGen)("Pallet walkability + warp + sign (facts.lua:32-38)", () => {
    const pallet = map("PALLET_TOWN");
    expect(pallet.isWalkableCell(5, 6)).toBe(true); // spawn
    expect(pallet.isWalkableCell(5, 5)).toBe(true); // the door cell walks
    expect(pallet.isWalkableCell(4, 4)).toBe(false);
    expect(pallet.isWalkableCell(0, 3)).toBe(false);
    const door = pallet.warpAtCell(5, 5);
    expect(door?.def.destMap).toBe("REDS_HOUSE_1F");
    expect(pallet.isDoorTileCell(5, 5)).toBe(true);
    const sign = pallet.signAtCell(13, 13);
    expect(sign?.text).toBe("TEXT_PALLETTOWN_OAKSLAB_SIGN");
  });

  test.skipIf(!hasGen)("grass detection + the off-map border guard (Map.lua:224, issue #217)", () => {
    const r1 = map("ROUTE_1");
    expect(r1.isGrassCell(10, 35)).toBe(true);
    expect(r1.isGrassCell(4, 2)).toBe(false);
    expect(r1.isGrassCell(10, -1)).toBe(false); // border filler never counts
    expect(map("PALLET_TOWN").isGrassCell(5, 6)).toBe(false);
  });

  test.skipIf(!hasGen)("stairs are warp tiles, mats and lab exits are not (Map.lua:256-263)", () => {
    const h2 = map("REDS_HOUSE_2F");
    expect(h2.isWarpTileCell(7, 1)).toBe(true);
    expect(h2.isDoorTileCell(7, 1)).toBe(false);
    const h1 = map("REDS_HOUSE_1F");
    expect(h1.isWarpTileCell(3, 7)).toBe(false); // exit mat: plain tile
    expect(h1.warpAtCell(3, 7)?.def.destMap).toBe("LAST_MAP");
    const lab = map("OAKS_LAB");
    expect(lab.isWarpTileCell(5, 11)).toBe(false);
    expect(lab.warpAtCell(5, 11)?.def.destMap).toBe("LAST_MAP");
  });
});

describe("entity terrain support (VoxelScene.groundAt)", () => {
  test("rejects off-map, missing, invalid, and non-positive support heights", () => {
    const { map } = supportFixture([5, Number.NaN, -2]);
    expect(map.groundAt(0, 0)).toBe(5);
    expect(map.groundAt(1, 0)).toBe(0); // non-finite
    expect(map.groundAt(0, 1)).toBe(0); // recessed/non-positive
    expect(map.groundAt(1, 1)).toBe(0); // tile index outside the table
    expect(map.groundAt(-1, 0)).toBe(0); // borderBlock must not lift a seam step
    expect(map.groundAt(0, 2)).toBe(0);
    expect(supportFixture().map.groundAt(0, 0)).toBe(0); // raw/old GAME data
  });

  test("scene adds hop lift to the source cell and anchors NPC/item cards", () => {
    const { map, def } = supportFixture([5, 6, 0, 0]);
    const player = new Player(0, 0, "right");
    player.hopFrames = 8;
    player.hopTotal = 16; // midpoint = 10 px hop
    player.moving = true;
    player.targetX = 1;
    player.targetY = 0;
    const npc = new NPC(
      def.id,
      {
        index: 1,
        name: "TABLE_ITEM",
        sprite: "SPRITE_POKE_BALL",
        movement: "STAY",
        range: "NONE",
        text: "TEXT_ITEM",
        x: 1,
        y: 0,
      },
      seqRng(0),
    );
    const host = new RecorderHost();
    const scene = new Scene(host);
    const view = {
      data: {
        maps: { [def.id]: def },
        cookedMaps: [def.id],
        sprites: { SPRITE_RED: { id: "SPRITE_RED", frames: 6 } },
        atlas: { sprites: { red: 2, poke_ball: 3 } },
      },
      overworld: { map, player, npcs: [npc], wild: { slots: [] }, emote: undefined },
      uiBox: () => null,
      uiChoice: () => null,
      pcDesktop: () => null,
      remotePc: () => null,
      battleView: () => null,
    } as unknown as SceneView;

    scene.emit(view);
    host.frameDone(0, 0);
    player.px = 8; // halfway to cell 1, but cellX is still the source cell
    scene.emit(view);
    host.frameDone(1, 0);
    player.cellX = 1; // landing switches the support tile
    player.px = 16;
    scene.emit(view);
    host.frameDone(2, 0);

    const ops = entArgs(host);
    expect(ops.filter((args) => args[0] === 0).map((args) => args[5])).toEqual([15, 15, 16]);
    expect(ops.find((args) => args[0] === 1)?.[5]).toBe(0);
  });

  test.skipIf(!hasGroundProfile)(
    "ROM profile lifts Mom, Daisy, starter balls, Pokédexes, and the town map",
    () => {
      const gen = loadGen(genDir);
      const profile = loadProfile();
      expect(profile).not.toBeNull();
      const gameData = fromObject(
        JSON.parse(
          new TextDecoder().decode(
            buildGamedata(
              gen,
              {
                sprites: {},
                picFront: {},
                picBack: {},
                emotePage: null,
                uiPage: 1,
                terrainPage: 0,
              },
              [...DEFAULT_MAPS],
              profile,
            ),
          ),
        ),
      );
      const expected: Record<string, Record<string, number>> = {
        REDS_HOUSE_1F: { REDSHOUSE1F_MOM: 5 },
        BLUES_HOUSE: { BLUESHOUSE_DAISY1: 5, BLUESHOUSE_TOWN_MAP: 6 },
        OAKS_LAB: {
          OAKSLAB_CHARMANDER_POKE_BALL: 6,
          OAKSLAB_SQUIRTLE_POKE_BALL: 6,
          OAKSLAB_BULBASAUR_POKE_BALL: 6,
          OAKSLAB_POKEDEX1: 6,
          OAKSLAB_POKEDEX2: 6,
        },
      };
      let checked = 0;
      for (const [mapId, objects] of Object.entries(expected)) {
        const host = new RecorderHost();
        const game = new VoxelmonGame(gameData, host, 1);
        game.newGame();
        game.overworld.setMap(mapId, 0, 0, "down");
        game.tick(0);
        const bySlot = new Map(entArgs(host).map((args) => [args[0], args]));
        for (const [name, height] of Object.entries(objects)) {
          const slot = game.overworld.npcs.findIndex((npc) => npc.def.name === name) + 1;
          expect(slot, `${mapId}:${name} must be a visible object`).toBeGreaterThan(0);
          expect(bySlot.get(slot)?.[5], `${mapId}:${name}`).toBe(height);
          checked += 1;
        }
      }
      expect(checked).toBe(8);
    },
  );
});

describe("scene sky visibility", () => {
  test.skipIf(!hasGen)("emits once per map identity in the mapShow tick", () => {
    const host = new RecorderHost();
    const game = new VoxelmonGame(romData!, host, 1);
    game.newGame();

    const visit = (id: string): void => {
      game.overworld.setMap(id, 1, 1, "down");
      game.tick(0);
      game.tick(0); // unchanged identity must not repeat the retained op
    };

    game.tick(0); // boot map: REDS_HOUSE_2F
    game.tick(0); // unchanged boot map
    for (const id of ["REDS_HOUSE_1F", "OAKS_LAB", "BLUES_HOUSE"]) visit(id);
    for (const id of ["PALLET_TOWN", "ROUTE_1", "VIRIDIAN_CITY"]) visit(id);

    const sky = host.text()
      .split("\n")
      .filter((line) => line.startsWith(`o ${VOX_OP.sky} `));
    expect(sky).toEqual([
      `o ${VOX_OP.sky} 0`,
      `o ${VOX_OP.sky} 0`,
      `o ${VOX_OP.sky} 0`,
      `o ${VOX_OP.sky} 0`,
      `o ${VOX_OP.sky} 1`,
      `o ${VOX_OP.sky} 1`,
      `o ${VOX_OP.sky} 1`,
    ]);

    const lines = host.text().split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]!.startsWith(`o ${VOX_OP.mapShow} 0 `)) continue;
      expect(lines.slice(i, i + 8).some((line) => line.startsWith(`o ${VOX_OP.sky} `))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — movement (Player.lua)
// ---------------------------------------------------------------------------

describe("movement", () => {
  test.skipIf(!hasGen)("a step takes 16 frames; facing carries no step (Player.lua:14, :114)", () => {
    const game = makeGame();
    const p = game.overworld.player;
    // spawn faces down and (3,7) is walkable: no turn, pure step
    const t = holdUntil(game, VOX_BTN.down, () => p.landedCount === 1, 40);
    expect(t).toBe(16);
    expect([p.cellX, p.cellY]).toEqual([3, 7]);
  });

  test.skipIf(!hasGen)("turning first costs the 4-frame window (Player.lua:28, #415)", () => {
    const game = makeGame();
    const p = game.overworld.player;
    game.tick(VOX_BTN.right); // tap: turn only
    expect(p.facing).toBe("right");
    expect(p.landedCount).toBe(0);
    expect([p.cellX, p.cellY]).toEqual([3, 6]);
    // now hold: the turn window (4) then the step (16)
    const t = holdUntil(game, VOX_BTN.right, () => p.landedCount === 1, 40);
    expect(t + 1).toBe(4 + 16); // the tap tick above spent tick 1 of the window
  });

  test.skipIf(!hasGen)("walls block and animate in place (Player.lua:135, #230)", () => {
    const game = makeGame();
    const p = game.overworld.player;
    // (3,5) is solid furniture above the spawn
    holdUntil(game, VOX_BTN.up, () => p.landedCount > 0, 60);
    expect(p.landedCount).toBe(0);
    expect([p.cellX, p.cellY]).toEqual([3, 6]);
    expect(p.bumpFrames).toBeGreaterThan(0); // wall-bonk walk-in-place
    expect(p.walkPhase()).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — Red's bedroom PC hidden event + native modal desktop
// ---------------------------------------------------------------------------

describe("bedroom computer", () => {
  test.skipIf(!hasGen)("only the ROM pcTile coordinate and facing open the native choice", () => {
    const game = makeGame();
    game.overworld.setMap("REDS_HOUSE_2F", 0, 2, "right");
    tap(game, VOX_BTN.a);
    expect(game.stackKinds()).toEqual(["overworld"]);

    game.overworld.setMap("REDS_HOUSE_2F", 1, 2, "up");
    tap(game, VOX_BTN.a);
    expect(game.stackKinds()).toEqual(["overworld"]);

    openBedroomPcChoice(game);
    const choice = game.uiChoice();
    expect(choice?.labels).toEqual(["LOCAL PC", "REMOTE PC"]);
    expect(choice?.selected).toBe(0);
  });

  test.skipIf(!hasGen)("local PC opens a coloured retained overlay with mock operations and closes", () => {
    const host = new RecorderHost();
    const game = new VoxelmonGame(romData!, host, 1);
    game.newGame();
    openBedroomPcChoice(game);

    tap(game, VOX_BTN.a); // LOCAL PC
    idle(game, 15); // native ChoiceBox answer hold
    expect(game.stackKinds()).toEqual(["overworld", "pc-desktop"]);
    expect(game.pcDesktop()).toMatchObject({ page: "home", selected: 0, status: "4 OBJECTS" });
    expect(host.text()).toContain(`o ${VOX_OP.uiRect} `);
    expect(host.text()).toContain(`s ${VOX_OP.uiLabel} `);

    const p = game.overworld.player;
    const parked = [p.cellX, p.cellY, p.landedCount];
    tap(game, VOX_BTN.down); // BOX NETWORK
    tap(game, VOX_BTN.a);
    expect(game.pcDesktop()).toMatchObject({ page: "storage", boxNumber: 1 });
    tap(game, VOX_BTN.right);
    expect(game.pcDesktop()).toMatchObject({ page: "storage", boxNumber: 2 });
    tap(game, VOX_BTN.a);
    expect(game.pcDesktop()?.status).toBe("BOX 02 SYNC COMPLETE");
    expect([p.cellX, p.cellY, p.landedCount]).toEqual(parked); // world stayed frozen

    tap(game, VOX_BTN.b); // child page -> desktop
    expect(game.pcDesktop()).toMatchObject({ page: "home" });
    tap(game, VOX_BTN.b); // desktop -> overworld
    expect(game.stackKinds()).toEqual(["overworld"]);
    expect(game.pcDesktop()).toBeNull();
    expect(host.text().match(new RegExp(`o ${VOX_OP.uiOverlayClear}(?:\\n|$)`, "g"))?.length).toBeGreaterThanOrEqual(2);
  });

  test.skipIf(!hasGen)("storage scrolls a full party so the selected sixth row stays visible", () => {
    const host = new RecorderHost();
    const game = new VoxelmonGame(romData!, host, 1);
    game.newGame();
    game.save.party = Array.from({ length: 6 }, (_, i) => ({
      ...newMon(romData!, "SQUIRTLE", 5),
      nickname: `MON${i + 1}`,
    }));
    openBedroomPcChoice(game);
    tap(game, VOX_BTN.a);
    idle(game, 15);
    tap(game, VOX_BTN.down); // BOX NETWORK
    tap(game, VOX_BTN.a);
    for (let i = 0; i < 5; i++) tap(game, VOX_BTN.down);

    expect(game.pcDesktop()).toMatchObject({ page: "storage", selected: 5 });
    expect(host.text()).toContain("MON6  L5");
  });

  test.skipIf(!hasGen)("remote PC retries, becomes live, freezes the world, and closes cleanly", () => {
    const host = new RecorderHost();
    const game = new VoxelmonGame(romData!, host, 1);
    game.newGame();
    openBedroomPcChoice(game);
    tap(game, VOX_BTN.down);
    expect(game.uiChoice()?.selected).toBe(1);
    tap(game, VOX_BTN.a);
    idle(game, 15);

    expect(game.stackKinds()).toEqual(["overworld", "pc-remote"]);
    expect(game.pcDesktop()).toBeNull();
    expect(game.remotePc()).toMatchObject({ status: "waiting", frameIndex: -1 });
    expect(host.remoteOpenCalls).toBeGreaterThanOrEqual(1);
    expect(host.text()).toContain(`o ${VOX_OP.remotePlane} `);

    const p = game.overworld.player;
    const parked = [p.cellX, p.cellY, p.landedCount];
    host.remoteAvailable = true;
    idle(game, 31);
    expect(host.remoteOpenCalls).toBeGreaterThanOrEqual(2);
    expect(host.remoteTickCalls).toBeGreaterThanOrEqual(1);
    host.remoteFrame = 42;
    game.tick(0);
    expect(game.remotePc()).toMatchObject({ status: "live", frameIndex: 42 });
    expect([p.cellX, p.cellY, p.landedCount]).toEqual(parked);

    const opensBeforeTerminal = host.remoteOpenCalls;
    const revisionAtLive = game.remotePc()!.revision;
    host.remoteFrame = -2;
    game.tick(0);
    expect(game.remotePc()).toMatchObject({ status: "waiting", frameIndex: -1 });
    expect(game.remotePc()!.revision).toBe(revisionAtLive + 1);
    expect(host.remoteCloseCalls).toBe(1);
    expect(host.remoteOpenCalls).toBe(opensBeforeTerminal);

    // A terminal stream is closed immediately, then retried on the same
    // 30-tick cadence as a host that was absent when the modal opened.
    idle(game, 30);
    expect(host.remoteOpenCalls).toBe(opensBeforeTerminal);
    game.tick(0);
    expect(host.remoteOpenCalls).toBe(opensBeforeTerminal + 1);
    expect(game.remotePc()).toMatchObject({ status: "waiting", frameIndex: -1 });
    host.remoteFrame = 84;
    game.tick(0);
    expect(game.remotePc()).toMatchObject({ status: "live", frameIndex: 84 });
    expect(game.remotePc()!.revision).toBe(revisionAtLive + 2);
    expect([p.cellX, p.cellY, p.landedCount]).toEqual(parked);

    tap(game, VOX_BTN.b);
    expect(game.stackKinds()).toEqual(["overworld"]);
    expect(game.remotePc()).toBeNull();
    expect(host.remoteCloseCalls).toBe(2);
    expect(host.text()).toContain(`o ${VOX_OP.remotePlane} 0 0 0 0`);

    // START owns the exact same teardown path, including remoteClose.
    openBedroomPcChoice(game);
    tap(game, VOX_BTN.down);
    tap(game, VOX_BTN.a);
    idle(game, 15);
    expect(game.stackKinds()).toEqual(["overworld", "pc-remote"]);
    tap(game, VOX_BTN.start);
    expect(game.stackKinds()).toEqual(["overworld"]);
    expect(host.remoteCloseCalls).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — ledge hop (OverworldController.lua:1322, field.ledges)
// ---------------------------------------------------------------------------

describe("ledge hop", () => {
  test.skipIf(!hasGen)("a south-facing ledge on ROUTE_1 hops two cells", () => {
    const game = makeGame();
    // (4,4) stands on tile 44 with ledge tile 55 south of it; (4,6) walkable
    game.overworld.setMap("ROUTE_1", 4, 4, "down");
    game.overworld.refreshStandingOnWarp();
    const p = game.overworld.player;
    const before = p.landedCount;
    game.tick(VOX_BTN.down);
    // the arc armed at 32 (hopFrames); the same tick's player update
    // already burned one frame (Player.lua:172)
    expect(p.hopFrames).toBe(31);
    holdUntil(game, 0, () => p.landedCount - before >= 2, 60);
    expect(p.landedCount - before).toBe(2);
    expect([p.cellX, p.cellY]).toEqual([4, 6]);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — warps (Warp.lua + OverworldController takeWarp/startWarpTo)
// ---------------------------------------------------------------------------

describe("warps", () => {
  test.skipIf(!hasGen)("REDS_HOUSE_2F stairs fire on ARRIVAL and land on the 1F stairs", () => {
    const game = makeGame();
    const ow = game.overworld;
    walk(game, VOX_BTN.right, 1);
    walk(game, VOX_BTN.up, 4);
    walk(game, VOX_BTN.right, 3);
    walk(game, VOX_BTN.up, 1); // onto (7,1): Warp.onArrive
    idle(game, 40); // WARP_FADE_OUT
    expect(ow.map.id).toBe("REDS_HOUSE_1F");
    expect([ow.player.cellX, ow.player.cellY]).toEqual([7, 1]);
    // the landing cell is inert until stepped off (warpEntryCell, #265)
    expect(ow.warpEntryCell).toEqual({ x: 7, y: 1 });
    // a stair warp tile CLEARS standing-on-warp (issue #230)
    expect(ow.standingOnWarp).toBe(false);
  });

  test.skipIf(!hasGen)("step off and back re-fires the stairs (positional re-entry, #265)", () => {
    const game = makeGame();
    const ow = game.overworld;
    walk(game, VOX_BTN.right, 1);
    walk(game, VOX_BTN.up, 4);
    walk(game, VOX_BTN.right, 3);
    walk(game, VOX_BTN.up, 1);
    idle(game, 40); // now on 1F (7,1)
    walk(game, VOX_BTN.down, 1); // step OFF the landing
    expect(ow.warpEntryCell).toBeUndefined();
    walk(game, VOX_BTN.up, 1); // step BACK ON: the warp re-fires
    idle(game, 40);
    expect(ow.map.id).toBe("REDS_HOUSE_2F");
    expect([ow.player.cellX, ow.player.cellY]).toEqual([7, 1]);
  });

  test.skipIf(!hasGen)("exit mat: edge warp to PALLET_TOWN with the door walk-out", () => {
    const game = makeGame();
    const ow = game.overworld;
    walk(game, VOX_BTN.right, 1);
    walk(game, VOX_BTN.up, 4);
    walk(game, VOX_BTN.right, 3);
    walk(game, VOX_BTN.up, 1);
    idle(game, 40);
    walk(game, VOX_BTN.down, 5);
    walk(game, VOX_BTN.left, 4);
    walk(game, VOX_BTN.down, 1); // onto the mat (3,7)
    // the mat is a plain tile: standing-on-warp stays set (issue #378)
    expect(ow.standingOnWarp).toBe(true);
    walk(game, VOX_BTN.down, 1); // off the map edge -> LAST_MAP warp
    idle(game, 10);
    expect(ow.map.id).toBe("PALLET_TOWN");
    // landed on the door (5,5), then PlayerStepOutFromDoor stepped south
    expect([ow.player.cellX, ow.player.cellY]).toEqual([5, 6]);
    expect(ow.warpEntryCell).toBeUndefined(); // the walk-out left the mat live
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — connections (computeNeighbors + crossConnection)
// ---------------------------------------------------------------------------

describe("connections", () => {
  test.skipIf(!hasGen)("computeNeighbors offsets (OverworldController.lua:164)", () => {
    const n = computeNeighbors(romData!.maps!, "PALLET_TOWN", 1);
    const route1 = n.find((x) => x.id === "ROUTE_1");
    // north: ox = offset*32 = 0, oy = -heightBlocks*32 = -18*32
    expect(route1).toEqual({ id: "ROUTE_1", ox: 0, oy: -576 });
    const viridian = computeNeighbors(romData!.maps!, "ROUTE_1", 1).find(
      (x) => x.id === "VIRIDIAN_CITY",
    );
    // north conn offset -5 blocks: ox = -160; Viridian is 18 blocks tall
    expect(viridian).toEqual({ id: "VIRIDIAN_CITY", ox: -160, oy: -576 });
  });

  test.skipIf(!hasGen)("PALLET north edge hard-loads ROUTE_1", () => {
    const game = makeGame();
    const ow = game.overworld;
    ow.setMap("PALLET_TOWN", 10, 1, "up");
    ow.refreshStandingOnWarp();
    const p = ow.player;
    walk(game, VOX_BTN.up, 1); // (10,0)
    walk(game, VOX_BTN.up, 1); // starts the hard scene load
    expect(ow.map.id).toBe("ROUTE_1");
    // destX = curX - offset*2 = 10; entry row = heightCells-1 = 35
    expect([p.cellX, p.cellY]).toEqual([10, 35]);
    // the destination starts cleanly rather than retaining the seam strip
    expect(p.moving).toBe(false);
  });

  test.skipIf(!hasGen)("ROUTE_1 north edge lands in VIRIDIAN_CITY at the -5 offset", () => {
    const game = makeGame();
    const ow = game.overworld;
    ow.setMap("ROUTE_1", 10, 1, "up");
    ow.refreshStandingOnWarp();
    walk(game, VOX_BTN.up, 1);
    walk(game, VOX_BTN.up, 1);
    expect(ow.map.id).toBe("VIRIDIAN_CITY");
    // destX = 10 - (-5 * 2) = 20
    expect([ow.player.cellX, ow.player.cellY]).toEqual([20, 35]);
  });

  test.skipIf(!hasGen)("a solid landing on the neighbor bumps (Map.defPassable fail-closed)", () => {
    const game = makeGame();
    const ow = game.overworld;
    // Pallet south shore: (2,17) is land; ROUTE_21 (2,0) is water -> bump
    ow.setMap("PALLET_TOWN", 2, 17, "down");
    ow.refreshStandingOnWarp();
    const p = ow.player;
    holdUntil(game, VOX_BTN.down, () => p.landedCount > 0, 60);
    expect(ow.map.id).toBe("PALLET_TOWN");
    expect([p.cellX, p.cellY]).toEqual([2, 17]);
  });
});

describe("Pokémon Red economy", () => {
  test.skipIf(!hasGen)("new game, trainer prizes, cap, and blackout update saved money", () => {
    const game = makeGame();
    expect(game.save.money).toBe(3000);

    expect(
      game.awardTrainerMoney(
        "BROCK",
        "OPP_BROCK",
        [{ level: 12 }, { level: 14 }],
      ),
    ).toBe(1386);
    expect(game.save.money).toBe(4386);

    game.save.money = 999990;
    game.awardTrainerMoney("BROCK", "OPP_BROCK", [{ level: 14 }]);
    expect(game.save.money).toBe(999999);

    game.save.money = 3001;
    game.blackout();
    expect(game.save.money).toBe(1500);
  });

  test.skipIf(!hasGen)("blackout returns to Mom until a Center becomes the checkpoint", () => {
    const home = makeGame();
    const homeMon = home.save.party[0]!;
    homeMon.hp = 0;
    homeMon.status = "PSN";
    home.overworld.setMap("VIRIDIAN_FOREST", 16, 20, "down");
    home.save.lastHeal = { map: "PALLET_TOWN", x: 5, y: 6 }; // old-save default
    home.blackout();
    idle(home, 80);
    expect(home.overworld.map.id).toBe("REDS_HOUSE_1F");
    expect([home.overworld.player.cellX, home.overworld.player.cellY]).toEqual([4, 6]);
    expect(homeMon.hp).toBe(homeMon.stats.hp);
    expect(homeMon.status).toBeNull();

    const center = makeGame();
    const centerMon = center.save.party[0]!;
    centerMon.hp = 0;
    center.save.lastHeal = { map: "VIRIDIAN_POKECENTER", x: 3, y: 6 };
    center.overworld.setMap("VIRIDIAN_FOREST", 16, 20, "down");
    center.blackout();
    idle(center, 80);
    expect(center.overworld.map.id).toBe("VIRIDIAN_POKECENTER");
    expect([center.overworld.player.cellX, center.overworld.player.cellY]).toEqual([3, 6]);
    expect(center.overworld.lastOutdoor?.id).not.toBe("VIRIDIAN_FOREST");
    expect(centerMon.hp).toBe(centerMon.stats.hp);
  });
});

describe("title and save", () => {
  test.skipIf(!hasGen)("new game starts at title and Continue restores map, party, and flags", () => {
    const host = new RecorderHost();
    const first = new VoxelmonGame(romData!, host, 9);
    first.newGame();
    first.chooseStarter("CHARMANDER");
    first.overworld.setMap("ROUTE_1", 10, 20, "up");
    first.save.flags.TEST_SAVE_FLAG = true;
    expect(first.saveGame()).toBe(true);

    const resumed = new VoxelmonGame(romData!, host, 9);
    resumed.boot();
    expect(resumed.stackKinds()).toEqual(["overworld", "title"]);
    tap(resumed, VOX_BTN.start);
    resumed.tick(0);
    tap(resumed, VOX_BTN.a);
    expect(resumed.stackKinds()).toEqual(["overworld"]);
    expect(resumed.overworld.map.id).toBe("ROUTE_1");
    expect([resumed.overworld.player.cellX, resumed.overworld.player.cellY]).toEqual([10, 20]);
    expect(resumed.save.party[0]?.species).toBe("CHARMANDER");
    expect(resumed.save.flags.TEST_SAVE_FLAG).toBe(true);
  });

  test.skipIf(!hasGen)("corrupt save suppresses Continue", () => {
    const host = new RecorderHost();
    host.savedJson = "{broken";
    const game = new VoxelmonGame(romData!, host, 1);
    game.boot();
    expect(game.hasSave()).toBe(false);
    expect(game.loadGame()).toBe(false);
  });

  test.skipIf(!hasGen)("START menu SAVE writes the current game", () => {
    const host = new RecorderHost();
    const game = new VoxelmonGame(romData!, host, 2);
    game.newGame();
    game.chooseStarter("BULBASAUR");
    tap(game, VOX_BTN.start);
    tap(game, VOX_BTN.down);
    tap(game, VOX_BTN.down);
    tap(game, VOX_BTN.down);
    tap(game, VOX_BTN.a);
    expect(host.savedJson).not.toBeNull();
    expect(JSON.parse(host.savedJson!).save.party[0].species).toBe("BULBASAUR");
  });

  test.skipIf(!hasGen)("START menu music switch slows walking and persists", () => {
    const host = new RecorderHost();
    const game = new VoxelmonGame(romData!, host, 3);
    game.newGame();
    expect(game.musicEnabled).toBe(false);
    expect(game.overworld.player.stepFrames).toBe(16);

    tap(game, VOX_BTN.start);
    tap(game, VOX_BTN.down);
    tap(game, VOX_BTN.down);
    tap(game, VOX_BTN.a);
    expect(game.musicEnabled).toBe(true);
    expect(game.overworld.player.stepFrames).toBe(24);

    tap(game, VOX_BTN.down);
    tap(game, VOX_BTN.a);
    const resumed = new VoxelmonGame(romData!, host, 3);
    expect(resumed.loadGame()).toBe(true);
    expect(resumed.musicEnabled).toBe(true);
    expect(resumed.overworld.player.stepFrames).toBe(24);

    resumed.setMusicEnabled(false);
    expect(resumed.overworld.player.stepFrames).toBe(16);
  });

  test.skipIf(!hasGen)("START menu POKEMON reorders the active lineup", () => {
    const game = makeGame();
    game.save.party.push(newMon(game.data, "CHARMANDER", 5));
    expect(game.save.party.map((mon) => mon.species)).toEqual(["SQUIRTLE", "CHARMANDER"]);
    game.openParty();
    idle(game, 300);
    tap(game, VOX_BTN.down); // choose Charmander
    tap(game, VOX_BTN.a);
    idle(game, 300);
    tap(game, VOX_BTN.a); // move to slot 1
    idle(game, 30);
    expect(game.save.party.map((mon) => mon.species)).toEqual(["CHARMANDER", "SQUIRTLE"]);
  });

  test.skipIf(!hasGen)("TM34 is visible, teaches Bide once, and HM01 remains reusable", () => {
    const tm = makeGame();
    tm.save.inventory.TM_BIDE = 1;
    tm.openBag();
    idle(tm, 300);
    tap(tm, VOX_BTN.a); // TM34
    idle(tm, 300);
    tap(tm, VOX_BTN.a); // Squirtle
    idle(tm, 30);
    expect(tm.save.party[0]!.moves.some((move) => move.id === "BIDE")).toBe(true);
    expect(tm.save.inventory.TM_BIDE).toBeUndefined();

    const hm = makeGame();
    hm.save.party[0] = newMon(hm.data, "BULBASAUR", 5);
    hm.save.inventory.HM_CUT = 1;
    hm.openBag();
    idle(hm, 300);
    tap(hm, VOX_BTN.a); // HM01
    idle(hm, 300);
    tap(hm, VOX_BTN.a); // Bulbasaur
    idle(hm, 30);
    expect(hm.save.party[0]!.moves.some((move) => move.id === "CUT")).toBe(true);
    expect(hm.save.inventory.HM_CUT).toBe(1);
  });

  test.skipIf(!hasGen)("New Game runs the intro and default player/rival naming flow", () => {
    const game = new VoxelmonGame(romData!, new RecorderHost(), 2);
    game.boot();
    tap(game, VOX_BTN.start);
    tap(game, VOX_BTN.a);
    for (let i = 0; i < 5000 && game.stackKinds().length > 1; i++) {
      game.tick(i % 2 === 0 ? VOX_BTN.a : 0);
    }
    expect(game.stackKinds()).toEqual(["overworld"]);
    expect(game.save.player).toEqual({ name: "RED", rival: "BLUE" });
    expect(game.save.party).toHaveLength(0);
  });
});

describe("Oak new-game flow", () => {
  test.skipIf(!hasGen)("Oak approaches, escorts the player, and returns control inside the lab", () => {
    const game = new VoxelmonGame(romData!, new RecorderHost(), 3);
    game.newGame();
    const ow = game.overworld;
    ow.setMap("PALLET_TOWN", 10, 2, "up");
    walk(game, VOX_BTN.up, 1);
    for (let i = 0; i < 5000 && !game.save.flags.EVENT_OAK_ASKED_TO_CHOOSE_MON; i++) {
      game.tick(i % 2 === 0 ? VOX_BTN.a : 0);
    }
    expect(ow.map.id).toBe("OAKS_LAB");
    expect(game.save.flags.EVENT_FOLLOWED_OAK_INTO_LAB).toBe(true);
    expect(game.save.flags.EVENT_OAK_ASKED_TO_CHOOSE_MON).toBe(true);
    expect(game.save.party).toHaveLength(0);
  });

  test.skipIf(!hasGen)("Oak's escort reaches the lab door at the music-on walk speed", () => {
    const game = new VoxelmonGame(romData!, new RecorderHost(), 31);
    game.newGame();
    game.setMusicEnabled(true);
    const ow = game.overworld;
    ow.setMap("PALLET_TOWN", 10, 2, "up");
    walk(game, VOX_BTN.up, 1);
    for (let i = 0; i < 7000 && !game.save.flags.EVENT_OAK_ASKED_TO_CHOOSE_MON; i++) {
      game.tick(i % 2 === 0 ? VOX_BTN.a : 0);
    }
    expect(ow.map.id).toBe("OAKS_LAB");
    expect(game.save.flags.EVENT_OAK_ASKED_TO_CHOOSE_MON).toBe(true);
    expect(ow.player.stepFrames).toBe(24);
  });

  test.skipIf(!hasGen)("each lab ball grants the selected starter instead of forced Squirtle", () => {
    for (const [species, x] of [["CHARMANDER", 6], ["SQUIRTLE", 7], ["BULBASAUR", 8]] as const) {
      const game = new VoxelmonGame(romData!, new RecorderHost(), 4);
      game.newGame();
      game.save.flags.EVENT_FOLLOWED_OAK_INTO_LAB = true;
      game.overworld.setMap("OAKS_LAB", x, 4, "up");
      tap(game, VOX_BTN.a);
      for (let i = 0; i < 300 && game.stackKinds().includes("textbox"); i++) game.tick(i % 2 ? 0 : VOX_BTN.a);
      tap(game, VOX_BTN.a);
      idle(game, 20);
      expect(game.save.party[0]?.species).toBe(species);
      expect(game.save.flags[`EVENT_CHOSE_${species}`]).toBe(true);
    }
  });

  test.skipIf(!hasGen)("leaving the starter table triggers Blue's counter-starter battle once", () => {
    const game = new VoxelmonGame(romData!, new RecorderHost(), 5);
    game.newGame();
    game.save.flags.EVENT_FOLLOWED_OAK_INTO_LAB = true;
    game.chooseStarter("BULBASAUR");
    game.overworld.setMap("OAKS_LAB", 5, 5, "down");
    walk(game, VOX_BTN.down, 1);
    for (let i = 0; i < 500 && !game.battleView(); i++) game.tick(i % 2 ? 0 : VOX_BTN.a);
    expect(game.save.flags.EVENT_BATTLED_RIVAL_IN_OAKS_LAB).toBe(true);
    expect(game.battleView()?.battle.enemy?.mon.species).toBe("CHARMANDER");
  });
});

describe("Pallet-to-Brock chapter", () => {
  test.skipIf(!hasGen)("expanded cooker exposes the complete first-chapter map chain", () => {
    for (const id of [
      "VIRIDIAN_POKECENTER", "VIRIDIAN_MART", "ROUTE_2",
      "VIRIDIAN_FOREST_SOUTH_GATE", "VIRIDIAN_FOREST",
      "VIRIDIAN_FOREST_NORTH_GATE", "PEWTER_CITY",
      "PEWTER_POKECENTER", "PEWTER_MART", "PEWTER_GYM",
    ]) expect(DEFAULT_MAPS).toContain(id);
  });

  test.skipIf(!hasGen)("a Center nurse heals and becomes the blackout checkpoint", () => {
    const game = makeGame();
    const mon = game.save.party[0]!;
    mon.hp = 1;
    mon.status = "PSN";
    game.overworld.setMap("VIRIDIAN_POKECENTER", 3, 2, "up");
    const nurse = game.overworld.npcs.find((npc) => npc.def.name.endsWith("POKECENTER_NURSE"))!;
    game.overworld.talkTo(nurse);
    for (let i = 0; i < 1000 && (mon.hp !== mon.stats.hp || mon.status); i++) {
      game.tick(i % 2 === 0 ? VOX_BTN.a : 0);
    }
    expect(mon.hp).toBe(mon.stats.hp);
    expect(mon.status).toBeNull();
    expect(game.save.lastHeal).toEqual({ map: "VIRIDIAN_POKECENTER", x: 3, y: 6 });
  });

  test.skipIf(!hasGen)("Viridian Mart opens its full stock and completes a purchase", () => {
    const game = makeGame();
    game.overworld.setMap("VIRIDIAN_MART", 3, 6, "up");
    const clerk = game.overworld.npcs.find((npc) => npc.def.name.endsWith("MART_CLERK"))!;
    expect(clerk).toBeDefined();
    game.overworld.talkTo(clerk);
    idle(game, 300); // welcome text reveals, then BUY/SELL/QUIT opens
    expect(game.stackKinds().at(-1)).toBe("choice");
    tap(game, VOX_BTN.a); // BUY
    idle(game, 300); // answer hold + stock prompt reveal
    expect(game.stackKinds().at(-1)).toBe("choice");
    const money = game.save.money;
    if (money === undefined) throw new Error("new game must initialize money");
    tap(game, VOX_BTN.a); // first row: POKé BALL
    idle(game, 20);
    expect(game.save.inventory.POKE_BALL).toBe(1);
    expect(game.save.money).toBe(money - game.data.items!.POKE_BALL!.price);
  });

  test.skipIf(!hasGen)("Forest item balls disappear persistently after pickup", () => {
    const game = makeGame();
    game.overworld.setMap("VIRIDIAN_FOREST", 24, 11, "right");
    const ball = game.overworld.npcs.find((npc) => npc.def.name === "VIRIDIANFOREST_ANTIDOTE")!;
    game.overworld.talkTo(ball);
    expect(game.save.inventory.ANTIDOTE).toBe(1);
    expect(game.save.flags.EVENT_TAKEN_VIRIDIANFOREST_ANTIDOTE).toBe(true);
    game.overworld.setMap("VIRIDIAN_FOREST", 24, 11, "right");
    expect(game.overworld.npcs.some((npc) => npc.def.name === "VIRIDIANFOREST_ANTIDOTE")).toBe(false);
  });

  test.skipIf(!hasGen)("Brock sends Geodude then Onix and awards badge plus TM34", () => {
    const game = makeGame();
    game.overworld.setMap("PEWTER_GYM", 4, 2, "up");
    const brock = game.overworld.npcs.find((npc) => npc.def.name === "PEWTERGYM_BROCK")!;
    game.overworld.talkTo(brock);
    for (let i = 0; i < 1500 && !game.battleView(); i++) game.tick(i % 2 === 0 ? VOX_BTN.a : 0);
    expect(game.battleView()?.battle.enemy.mon.species).toBe("GEODUDE");
    game.battleView()!.battle.finished = "win";
    game.tick(0);
    expect(game.battleView()?.battle.enemy.mon.species).toBe("ONIX");
    game.battleView()!.battle.finished = "win";
    game.tick(0);
    for (let i = 0; i < 1500 && !game.save.flags.EVENT_BEAT_BROCK; i++) {
      game.tick(i % 2 === 0 ? VOX_BTN.a : 0);
    }
    expect(game.save.flags.EVENT_BEAT_BROCK).toBe(true);
    expect(game.save.flags.EVENT_GOT_TM34).toBe(true);
    expect(game.save.inventory.BOULDERBADGE).toBe(1);
    expect(game.save.inventory.TM_BIDE).toBe(1);
    expect(game.save.money).toBe(4386);
  });

  test.skipIf(!hasGen)("Pewter's east exit stays blocked until Brock is beaten", () => {
    const game = makeGame();
    game.overworld.setMap("PEWTER_CITY", 39, 16, "right");
    const east = game.overworld.map.def.connections.east!;
    expect(game.overworld.crossConnection("right", east)).toBe(true);
    expect(game.overworld.map.id).toBe("PEWTER_CITY");
    expect(game.stackKinds().at(-1)).toBe("textbox");

    game.save.flags.EVENT_BEAT_BROCK = true;
    while (game.stackKinds().at(-1) === "textbox") tap(game, VOX_BTN.a);
    expect(game.overworld.crossConnection("right", east)).toBe(true);
    idle(game, 80);
    expect(game.overworld.map.id).toBe("ROUTE_3");
  });
});

describe("Route 22 through Cerulean chapter", () => {
  test.skipIf(!hasGen)("cooker includes the Nidoran detour, Mt. Moon, and Misty's city", () => {
    for (const id of [
      "ROUTE_22", "ROUTE_22_GATE", "ROUTE_3", "ROUTE_4",
      "MT_MOON_POKECENTER", "MT_MOON_1F", "MT_MOON_B1F", "MT_MOON_B2F",
      "CERULEAN_CITY", "CERULEAN_POKECENTER", "CERULEAN_MART", "CERULEAN_GYM",
    ]) expect(DEFAULT_MAPS).toContain(id);
    expect(romData!.encounters.ROUTE_22.grass?.slots.some((slot) => slot.species === "NIDORAN_F")).toBe(true);
  });

  test.skipIf(!hasGen)("Route 22 Gary uses the ROM party selected by the rival starter", () => {
    const game = makeGame(); // Squirtle means Gary chose Bulbasaur.
    game.overworld.setMap("ROUTE_22", 29, 4, "left");
    game.overworld.onStepComplete();
    for (let i = 0; i < 1000 && !game.battleView(); i++) game.tick(i % 2 === 0 ? VOX_BTN.a : 0);
    const battle = game.battleView()?.battle;
    expect(battle?.enemy.mon.species).toBe("PIDGEY");
    expect(battle?.enemy.mon.level).toBe(9);
  });

  test.skipIf(!hasGen)("Misty's ROM roster is Staryu 18 and Starmie 21", () => {
    expect(romData!.trainers?.OPP_MISTY.parties[0]).toEqual([
      { level: 18, species: "STARYU" },
      { level: 21, species: "STARMIE" },
    ]);
  });

  test.skipIf(!hasGen)("the Mt. Moon Center salesman sells one level-5 Magikarp for ¥500", () => {
    const game = makeGame();
    game.save.money = 3000;
    game.overworld.setMap("MT_MOON_POKECENTER", 10, 5, "up");
    const salesman = game.overworld.npcs.find(
      (npc) => npc.def.name === "MTMOONPOKECENTER_MAGIKARP_SALESMAN",
    )!;
    expect(salesman).toBeDefined();
    game.overworld.talkTo(salesman);
    idle(game, 300);
    expect(game.stackKinds().at(-1)).toBe("choice");
    tap(game, VOX_BTN.a);
    idle(game, 300);
    expect(game.save.money).toBe(2500);
    expect(game.save.party.at(-1)?.species).toBe("MAGIKARP");
    expect(game.save.party.at(-1)?.level).toBe(5);
    expect(game.save.flags.EVENT_BOUGHT_MAGIKARP).toBe(true);
    expect(game.buyMagikarp()).toBe("already-bought");
  });
});

describe("Vermilion, S.S. Anne, and Diglett's Cave", () => {
  test.skipIf(!hasGen)("the complete ship and Diglett tunnel loop are cooked", () => {
    for (const id of [
      "ROUTE_11", "DIGLETTS_CAVE_ROUTE_11", "DIGLETTS_CAVE",
      "DIGLETTS_CAVE_ROUTE_2", "VERMILION_DOCK", "SS_ANNE_1F",
      "SS_ANNE_1F_ROOMS", "SS_ANNE_2F", "SS_ANNE_2F_ROOMS",
      "SS_ANNE_3F", "SS_ANNE_B1F", "SS_ANNE_B1F_ROOMS",
      "SS_ANNE_BOW", "SS_ANNE_KITCHEN", "SS_ANNE_CAPTAINS_ROOM",
    ]) expect(DEFAULT_MAPS).toContain(id);
    expect(romData!.encounters.DIGLETTS_CAVE).toBeDefined();
  });

  test.skipIf(!hasGen)("Diglett connecting houses and gate floors are included and return correctly", () => {
    for (const id of ["ROUTE_2_TRADE_HOUSE", "ROUTE_2_GATE", "ROUTE_11_GATE_1F", "ROUTE_11_GATE_2F"]) {
      expect(DEFAULT_MAPS).toContain(id);
    }
    for (const [route, interior] of [
      ["ROUTE_2", "ROUTE_2_TRADE_HOUSE"],
      ["ROUTE_2", "ROUTE_2_GATE"],
      ["ROUTE_11", "ROUTE_11_GATE_1F"],
    ]) {
      const game = makeGame();
      game.overworld.setMap(route, 0, 0, "down");
      const door = game.overworld.map.def.warps.find(w => w.destMap === interior)!;
      game.overworld.takeWarp(door);
      idle(game, 80);
      expect(game.overworld.map.id).toBe(interior);
      expect(game.overworld.npcs.length).toBeGreaterThan(0);
      if (interior === "ROUTE_11_GATE_1F") {
        game.overworld.takeWarp(game.overworld.map.def.warps.find(w => w.destMap === "ROUTE_11_GATE_2F")!);
        idle(game, 80);
        expect(game.overworld.map.id).toBe("ROUTE_11_GATE_2F");
        game.overworld.takeWarp(game.overworld.map.def.warps[0]);
        idle(game, 80);
        expect(game.overworld.map.id).toBe(interior);
      }
      game.overworld.takeWarp(game.overworld.map.def.warps.find(w => w.destMap === "LAST_MAP")!);
      idle(game, 80);
      expect(game.overworld.map.id).toBe(route);
    }
  });

  test.skipIf(!hasGen)("Diglett's Cave can be traversed between both routes", () => {
    for (const [source, target] of [["ROUTE_2", "ROUTE_11"], ["ROUTE_11", "ROUTE_2"]]) {
      const game = makeGame();
      game.overworld.setMap(source, 0, 0, "down");
      const enter = (destination: string) => {
        const warp = game.overworld.map.def.warps.find(w => w.destMap === destination)!;
        expect(warp).toBeDefined();
        game.overworld.takeWarp(warp);
        idle(game, 80);
      };
      enter(`DIGLETTS_CAVE_${source}`);
      enter("DIGLETTS_CAVE");
      expect(game.overworld.map.id).toBe("DIGLETTS_CAVE");
      enter(`DIGLETTS_CAVE_${target}`);
      enter("LAST_MAP");
      expect(game.overworld.map.id).toBe(target);
    }
  });

  test.skipIf(!hasGen)("each Diglett foyer exits onto its own physical route", () => {
    for (const [foyer, route] of [
      ["DIGLETTS_CAVE_ROUTE_2", "ROUTE_2"],
      ["DIGLETTS_CAVE_ROUTE_11", "ROUTE_11"],
    ] as const) {
      const game = makeGame();
      // Deliberately remember the opposite side: this reproduces a complete
      // tunnel traversal and guards against generic LAST_MAP misrouting.
      game.overworld.lastOutdoor = { id: route === "ROUTE_2" ? "ROUTE_11" : "ROUTE_2", x: 0, y: 0 };
      game.overworld.setMap(foyer, 2, 6, "down");
      const exit = game.overworld.map.def.warps.find((w) => w.destMap === "LAST_MAP")!;
      game.overworld.takeWarp(exit);
      idle(game, 40);
      expect(game.overworld.map.id).toBe(route);
      const physicalDoor = romData!.maps![route]!.warps.find((w) => w.destMap === foyer)!;
      expect(game.overworld.player.cellX).toBe(physicalDoor.x);
      expect([physicalDoor.y, physicalDoor.y + 1]).toContain(game.overworld.player.cellY);
    }
  });

  test.skipIf(!hasGen)("the S.S. Anne requires a Ticket and departs after HM01", () => {
    const game = makeGame();
    game.overworld.setMap("VERMILION_CITY", 18, 30, "down");
    const dock = game.overworld.map.def.warps.find((w) => w.destMap === "VERMILION_DOCK")!;
    delete game.save.inventory.SS_TICKET;
    game.overworld.takeWarp(dock);
    expect(game.overworld.map.id).toBe("VERMILION_CITY");
    expect(game.stackKinds().at(-1)).toBe("textbox");

    while (game.stackKinds().at(-1) === "textbox") tap(game, VOX_BTN.a);
    game.save.inventory.SS_TICKET = 1;
    game.overworld.takeWarp(dock);
    idle(game, 80);
    expect(game.overworld.map.id).toBe("VERMILION_DOCK");

    game.overworld.setMap("SS_ANNE_1F", 26, 1, "up");
    game.save.flags.EVENT_GOT_HM01 = true;
    const leave = game.overworld.map.def.warps.find((w) => w.destMap === "VERMILION_DOCK")!;
    game.overworld.takeWarp(leave);
    expect(game.save.flags.EVENT_SS_ANNE_LEFT).toBe(true);
  });

  test.skipIf(!hasGen)("ship item balls, trainers, rival, and captain events are wired", () => {
    const game = makeGame();
    game.overworld.setMap("SS_ANNE_1F_ROOMS", 0, 0, "down");
    const tm = game.overworld.npcs.find((n) => n.def.name === "SSANNE1FROOMS_TM_BODY_SLAM")!;
    game.overworld.talkTo(tm);
    expect(game.save.inventory.TM_BODY_SLAM).toBe(1);
    expect(game.save.flags.EVENT_TAKEN_SSANNE1FROOMS_TM_BODY_SLAM).toBe(true);

    game.overworld.setMap("SS_ANNE_CAPTAINS_ROOM", 4, 3, "up");
    const captain = game.overworld.npcs.find((n) => n.def.name === "SSANNECAPTAINSROOM_CAPTAIN")!;
    game.overworld.talkTo(captain);
    expect(game.save.inventory.HM_CUT).toBe(1);
    expect(game.save.flags.EVENT_GOT_HM01).toBe(true);

    game.overworld.setMap("SS_ANNE_BOW", 0, 0, "down");
    const sailor = game.overworld.npcs.find((n) => n.def.name === "SSANNEBOW_SAILOR2")!;
    game.overworld.talkTo(sailor);
    for (let i = 0; i < 800 && !game.battleView(); i++) game.tick(i % 2 ? 0 : VOX_BTN.a);
    expect(game.battleView()?.battle.enemy.mon.species).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — encounters through the overworld path (Encounter.lua:22-39)
// ---------------------------------------------------------------------------

describe("encounters", () => {
  const grassStep = (rate: number, pick: number) => {
    const game = makeGame(1, true);
    const ow = game.overworld;
    ow.setMap("ROUTE_1", 11, 6, "down");
    ow.refreshStandingOnWarp();
    game.rng = seqRng(rate, pick);
    walk(game, VOX_BTN.down, 1); // land on (11,7): grass
    return game;
  };

  test.skipIf(!hasGen)("rate gate uses the handheld-adjusted ROM rate", () => {
    const rate = romData!.encounters.ROUTE_1.grass!.rate;
    expect(rate).toBe(25);
    const game = grassStep(effectiveRate(rate), 0); // equality still fails the strict gate
    expect(game.overworld.encounterCount).toBe(0);
    expect(game.stackKinds()).toEqual(["overworld"]);
  });

  test.skipIf(!hasGen)("slot mapping matches encounters.json through the 256 buckets", () => {
    const slots = romData!.encounters.ROUTE_1.grass!.slots;
    // bucket thresholds (FieldDefaults.lua:210): pick < threshold[i] -> slot i
    const cases: [number, number][] = [
      [0, 0],
      [50, 0],
      [51, 1],
      [141, 3],
      [215, 5],
      [255, 9],
    ];
    for (const [pick, slotIdx] of cases) {
      expect(pick).toBeLessThan(ENCOUNTER_BUCKETS[slotIdx]);
      const game = grassStep(0, pick); // rate roll 0 always hits
      expect(game.overworld.encounterCount).toBe(1);
      expect(game.overworld.lastEncounter).toEqual({
        species: slots[slotIdx].species,
        level: slots[slotIdx].level,
      });
      // the REAL wild battle is on top (the battle port replaced the stub)
      expect(game.stackKinds()).toEqual(["overworld", "battle"]);
    }
  });

  test.skipIf(!hasGen)("no roll on plain ground; rolls only on completed grass steps", () => {
    const game = makeGame(1, true);
    const ow = game.overworld;
    ow.setMap("ROUTE_1", 9, 16, "down");
    ow.refreshStandingOnWarp();
    game.rng = seqRng(0, 0); // would ALWAYS encounter if a roll happened
    walk(game, VOX_BTN.down, 1); // (9,17): plain path
    expect(ow.encounterCount).toBe(0);
  });

  test.skipIf(!hasGen)("a grass encounter opens the real wild battle", () => {
    const game = grassStep(0, 100);
    expect(game.stackKinds()).toEqual(["overworld", "battle"]);
    const bv = game.battleView();
    expect(bv).not.toBeNull();
    expect(bv!.battle.kind).toBe("wild");
    expect(bv!.battle.enemy.mon.species).toBe(game.overworld.lastEncounter!.species);
    expect(bv!.battle.enemy.mon.level).toBe(game.overworld.lastEncounter!.level);
    // the player stayed exactly where the encounter fired — nothing moves
    // the player; the camera goes to the arena (docs/VOXEL.md §4)
    expect([game.overworld.player.cellX, game.overworld.player.cellY]).toEqual([11, 7]);
  });

  test.skipIf(!hasGen)("cave encounters roll only after a completed walkable step", () => {
    const game = makeGame(1, true);
    const ow = game.overworld;
    ow.setMap("MT_MOON_1F", 5, 5, "down");
    game.rng = seqRng(0, 0);
    const before = ow.encounterCount;
    tap(game, VOX_BTN.left); // turn-only input cannot roll
    expect(ow.encounterCount).toBe(before);

    let walked = false;
    for (let y = 1; y < ow.map.heightCells - 1 && !walked; y++) {
      for (let x = 1; x < ow.map.widthCells - 1 && !walked; x++) {
        if (
          !ow.map.isWalkableCell(x, y) ||
          !ow.map.isWalkableCell(x + 1, y) ||
          ow.map.warpAtCell(x, y) ||
          ow.map.warpAtCell(x + 1, y) ||
          ow.npcAtCell(x, y) ||
          ow.npcAtCell(x + 1, y)
        ) continue;
        ow.setMap("MT_MOON_1F", x, y, "right");
        game.rng = seqRng(0, 0);
        walk(game, VOX_BTN.right, 1);
        walked = true;
      }
    }
    expect(walked).toBe(true);
    expect(ow.encounterCount).toBe(before + 1);
    expect(game.stackKinds().at(-1)).toBe("battle");
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — textbox against real extracted text
// ---------------------------------------------------------------------------

describe("textbox with ROM text", () => {
  test.skipIf(!hasGen)("the Pallet sign paginates to one 3-line page with a cont scroll", () => {
    const text = (romData!.text as Record<string, string>)._PalletTownSignText;
    expect(text).toBe("PALLET TOWN\nShades of yourjourney await!");
    const pages = paginate(text);
    expect(pages.length).toBe(1);
    expect(pages[0].lines).toEqual(["PALLET TOWN", "Shades of your", "journey await!"]);
    expect(pages[0].contBefore).toEqual([false, false, true]);
    for (const line of pages[0].lines) {
      expect(glyphLen(line)).toBeLessThanOrEqual(18);
    }
  });

  test.skipIf(!hasGen)("reveal counts every glyph of the sign's first line", () => {
    const input = new Input();
    const text = (romData!.text as Record<string, string>)._PalletTownSignText;
    const box = new Textbox(text);
    // 11 glyphs at the default 3-frame cadence
    for (let i = 0; i < 33; i++) box.update(input);
    expect(box.shown[0].revealed).toBe(glyphLen("PALLET TOWN"));
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — the story tape: determinism, marks, and the real cli
// ---------------------------------------------------------------------------

const STORY_SEED = 17;

async function runStoryInProcess(): Promise<RecorderHost> {
  const host = new RecorderHost();
  const game = new VoxelmonGame({ ...romData!, partyIcons: undefined }, host, STORY_SEED);
  // sim/cli.ts installs the audio banks before newGame; the `audiodata` op it
  // emits is part of the trace, so this run has to do the same to compare.
  game.setAudio(await loadAudioBanks(genDir));
  game.newGame();
  game.chooseStarter("SQUIRTLE");
  const tapeText = await Bun.file(join(root, "voxelmon/tapes/story.tape")).text();
  const tape = new TapePlayer(parseTape(tapeText));
  while (!tape.done && game.tickIndex < 100_000) {
    const step = tape.next(game);
    for (const m of step.marks) host.mark(m);
    if (tape.done) break;
    game.tick(step.buttons);
    tape.observe(game);
  }
  expect(tape.done).toBe(true);
  return host;
}

describe("story tape", () => {
  test.skipIf(!hasGen)("a walk into a wall trips the 240-tick stall watchdog", () => {
    const game = makeGame();
    // (3,5) is solid furniture straight up from the spawn
    const tape = new TapePlayer(parseTape("walk u 1\n"));
    expect(() => {
      for (let i = 0; i < 400; i++) {
        const step = tape.next(game);
        if (tape.done) break;
        game.tick(step.buttons);
        tape.observe(game);
      }
    }).toThrow(TapeStallError);
  });

  test.skipIf(!hasGen)(
    "reaches every mark, sees exactly one wild encounter, and is byte-deterministic",
    async () => {
      const a = await runStoryInProcess();
      const b = await runStoryInProcess();
      expect(a.marks).toEqual([
        "bedroom",
        "downstairs",
        "pallet-town",
        "sign-read",
        "oaks-lab",
        "lab-exit",
        "route-1",
        "mid-route",
        "encounter-seen",
        "viridian",
        "done",
      ]);
      expect(a.text()).toBe(b.text());
      // the wild battle textbox crossed the boundary
      expect(a.text()).toContain('s 52 1 14 "Wild PIDGEY"');
      // the SGB palette op rides map entry (cooked gamedata only: the boot
      // bedroom is a Pallet interior -> PALLET; Route 1 -> ROUTE); a raw
      // gen/ run has no mapPalette and emits the grayscale -1 once instead
      const trace = a.text();
      if (romData!.mapPalette) {
        expect(trace).toContain(`o ${VOX_OP.palette} ${romData!.mapPalette.PALLET_TOWN}`);
        expect(trace).toContain(`o ${VOX_OP.palette} ${romData!.mapPalette.ROUTE_1}`);
      } else {
        expect(trace).toContain(`o ${VOX_OP.palette} -1`);
      }
    },
    30_000,
  );

  test.skipIf(!hasGen)(
    "the cli runs the tape end-to-end and writes the identical vtrace",
    async () => {
      const out = join(root, "dist/voxelmon/trace/story-test.vtrace");
      const proc = Bun.spawnSync(
        [
          "bun",
          "voxelmon/game/sim/cli.ts",
          "--legacy-encounters",
          "--tape",
          "voxelmon/tapes/story.tape",
          "--out",
          out,
          "--seed",
          String(STORY_SEED),
        ],
        { cwd: root },
      );
      expect(proc.exitCode).toBe(0);
      const cliText = await Bun.file(out).text();
      const inProc = await runStoryInProcess();
      expect(cliText).toBe(inProc.text());
    },
    60_000,
  );
});
