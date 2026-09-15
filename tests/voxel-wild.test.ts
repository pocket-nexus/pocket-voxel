import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fixtureData } from "./fixtures/voxelmon/fixture-data.ts";
import { GameMap } from "../voxelmon/game/world/map.ts";
import { WildPopulation, WILD_LIMIT, WILD_RADIUS, pickWild } from "../voxelmon/game/world/wild.ts";
import { fixedRng, seededRng, seqRng } from "../voxelmon/game/rng.ts";
import { ENTS_MAX, VOX_BTN, VOX_OP } from "../contracts/spec/voxel-spec.ts";
import { loadRuntimeData, type MapDef, type TilesetDef } from "../voxelmon/game/data.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { Ctx } from "../voxelmon/import/ctx.ts";
import { Rom } from "../voxelmon/import/rom.ts";
import { GfxBin, GfxImage } from "../voxelmon/import/gfx.ts";
import { extractPartyIconGraphics, partyIconsBySpecies } from "../voxelmon/import/stages/party-icons.ts";
import type { Manifest } from "../voxelmon/import/manifest.ts";

function fixture() {
  const data = fixtureData();
  data.partyIcons = { MON: 100 };
  for (const mon of Object.values(data.pokemon)) mon.partyIcon = "MON";
  const def: MapDef = { id: "WILD_TEST", label: "WildTest", index: 10, tileset: "OVERWORLD",
    width: 16, height: 16, blocks: Array(256).fill(0), borderBlock: 0,
    connections: {}, warps: [], objects: [], signs: [] };
  const ts = { id: "OVERWORLD", blocks: [Array(16).fill(1)], walkable: [1],
    grassTile: 1, counterTiles: [], doorTiles: [], warpTiles: [] } as unknown as TilesetDef;
  data.encounters.WILD_TEST = { grass: { rate: 255, buckets: [128, 256], slots: [
    { species: "FIXMON_A", level: 3 }, { species: "FIXMON_C", level: 7 },
  ] } };
  const map = new GameMap(def, ts);
  const player = { cellX: 16, cellY: 16, surfing: false };
  return { data, def, ts, map, player };
}

function seedSlot(pop: WildPopulation, x: number, y: number) {
  const wild = pop.slots[0];
  Object.assign(wild, { active: true, species: "FIXMON_A", level: 3, icon: "MON",
    cellX: x, cellY: y, px: x * 16, py: y * 16, timer: 500 });
  return wild;
}

describe("visible wild population (ROM-free)", () => {
  test("uses original cumulative slot probabilities and levels", () => {
    const { data } = fixture();
    const table = data.encounters.WILD_TEST.grass!;
    for (let roll = 0; roll < 256; roll++) {
      expect(pickWild(table, fixedRng(roll))).toEqual(table.slots[roll < 128 ? 0 : 1]);
    }
  });
  test("four reusable slots stay bounded through long walks and map resets", () => {
    const { data, map, player } = fixture();
    const pop = new WildPopulation(seededRng(8));
    const slots = [...pop.slots];
    let max = 0;
    for (let tick = 0; tick < 12000; tick++) {
      if (tick % 120 === 0) player.cellX = player.cellX === 16 ? 10 : 16;
      pop.update(data, map, player, [player]);
      const active = pop.slots.filter(w => w.active);
      max = Math.max(max, active.length);
      expect(active.length).toBeLessThanOrEqual(WILD_LIMIT);
      for (const w of active) {
        expect(map.isGrassCell(w.cellX, w.cellY)).toBe(true);
        expect(w.cellX === player.cellX && w.cellY === player.cellY).toBe(false);
        expect(data.encounters.WILD_TEST.grass!.slots).toContainEqual({ species: w.species, level: w.level });
      }
    }
    expect(max).toBe(WILD_LIMIT);
    pop.clear();
    expect(pop.slots.every(w => !w.active)).toBe(true);
    slots.forEach((slot, i) => expect(pop.slots[i]).toBe(slot));
  });
  test("spawns avoid player, NPC/reserved cells, doors and adjacent exit cells", () => {
    const { data, def, ts, player } = fixture();
    def.warps.push({ x: 19, y: 16, destMap: "OTHER", destWarp: 1 });
    const map = new GameMap(def, ts);
    const npc = { cellX: 16, cellY: 19, targetX: 17, targetY: 19 };
    const pop = new WildPopulation(seededRng(45));
    expect(pop.habitatAt(data, map, 19, 16)).toBeNull();
    expect(pop.habitatAt(data, map, 18, 16)).toBeNull();
    for (let tick = 0; tick < 1200; tick++) {
      pop.update(data, map, player, [player, npc]);
      for (const w of pop.slots.filter(w => w.active)) {
        expect(pop.habitatAt(data, map, w.cellX, w.cellY)).toBe("grass");
        expect(w.cellY === 19 && (w.cellX === 16 || w.cellX === 17)).toBe(false);
      }
    }
  });
  test("no spawns without tables, icon assets, or render slots", () => {
    for (const mode of ["tables", "assets", "full"] as const) {
      const { data, map, player } = fixture();
      if (mode === "tables") data.encounters = {};
      if (mode === "assets") delete data.partyIcons;
      const entities = mode === "full" ? Array(ENTS_MAX).fill(player) : [player];
      const pop = new WildPopulation(seededRng(2));
      for (let tick = 0; tick < 600; tick++) pop.update(data, map, player, entities);
      expect(pop.slots.some(w => w.active)).toBe(false);
    }
  });
  test("one remaining renderer slot allows only one wild Pokémon", () => {
    const { data, map, player } = fixture();
    const pop = new WildPopulation(seededRng(2));
    for (let tick = 0; tick < 600; tick++) pop.update(data, map, player, Array(ENTS_MAX - 1).fill(player));
    expect(pop.slots.filter(w => w.active).length).toBe(1);
  });
  test("consuming a creature keeps its identity and gives a respawn grace period", () => {
    const { data, map, player } = fixture();
    const pop = new WildPopulation();
    const w = seedSlot(pop, 18, 16);
    expect(pop.consume(w)).toEqual({ species: "FIXMON_A", level: 3 });
    expect(pop.atCell(18, 16)).toBeUndefined();
    for (let tick = 0; tick < 179; tick++) pop.update(data, map, player, [player]);
    expect(pop.slots.every(w => !w.active)).toBe(true);
  });
  test("wandering respects habitat edges and tile-pair barriers", () => {
    const { data, map, player } = fixture();
    // Right direction, timer=30; choose spawn positions too close to player.
    const rng = { int: (n: number) => n === 4 ? 3 : n === WILD_RADIUS * 2 + 1 ? WILD_RADIUS : 0, byte: () => 0 };
    const pop = new WildPopulation(rng);
    player.cellX = 12; player.cellY = 12;
    const w = seedSlot(pop, 10, 10); w.timer = 0;
    pop.update(data, map, player, [player], { land: [{ tileset: "OVERWORLD", a: 1, b: 1 }] });
    expect(w.moving).toBe(false);
    w.timer = 0;
    pop.update(data, map, player, [player]);
    expect(w.moving).toBe(true);
    for (let i = 0; i < 24; i++) pop.update(data, map, player, [player]);
    expect([w.cellX, w.cellY, w.px]).toEqual([11, 10, 176]);
    map.isGrassCell = (x) => x <= 11;
    w.timer = 0;
    pop.update(data, map, player, [player]);
    expect(w.moving).toBe(false);
  });
  test("water creatures require surfing and stay on water; cave floors are habitat", () => {
    const { data, def, ts, player } = fixture();
    data.encounters.WILD_TEST.water = data.encounters.WILD_TEST.grass;
    ts.blocks = [Array(16).fill(0x14)];
    const water = new GameMap(def, ts);
    const pop = new WildPopulation(seededRng(2));
    for (let i = 0; i < 600; i++) pop.update(data, water, player, [player]);
    expect(pop.slots.some(w => w.active)).toBe(false);
    player.surfing = true;
    for (let i = 0; i < 600; i++) pop.update(data, water, player, [player]);
    expect(pop.slots.some(w => w.active && w.surfing)).toBe(true);
    ts.blocks = [Array(16).fill(1)]; delete ts.grassTile;
    data.field = { indoorEncounters: { firstIndoorMap: 10, excludedTileset: "FOREST" } };
    const cave = new GameMap(def, ts);
    expect(pop.habitatAt(data, cave, 10, 10)).toBe("grass");
    def.tileset = "FOREST";
    expect(pop.habitatAt(data, cave, 10, 10)).toBeNull();
  });
});

describe("party icon extraction (synthetic bytes)", () => {
  test("dex mapping reads high nibble first and handles the odd final species", () => {
    const ctx = new Ctx(new Rom(new Uint8Array([0x01, 0x20])), {
      dexOrder: ["A", "B", "C"], iconOrder: ["MON", "BUG", "GRASS"], symbols: { MonPartyData: [0, 0] },
    } as unknown as Manifest, new GfxBin());
    expect(partyIconsBySpecies(ctx)).toEqual({ A: "MON", B: "BUG", C: "GRASS" });
  });
  test("original halves are mirrored and menu rest/alternate frames preserved", () => {
    const bytes = new Uint8Array(128); bytes.fill(0xff, 0, 32);
    const gfx = new GfxBin();
    const sheet = new GfxImage(16, 96); sheet.set(0, 48, 2); sheet.set(0, 0, 1);
    gfx.add("sprites/monster", sheet);
    const ctx = new Ctx(new Rom(bytes), { iconOrder: ["MON", "BUG"], symbols: {
      BugIconFrame1: [0, 32], BugIconFrame2: [0, 0],
    } } as unknown as Manifest, gfx);
    extractPartyIconGraphics(ctx);
    const decoded = gfx.bytes();
    const mon = gfx.directory["icons/party_MON"], bug = gfx.directory["icons/party_BUG"];
    expect([mon.w, mon.h]).toEqual([16, 32]);
    expect(decoded[mon.off]).toBe(2);
    expect(decoded[mon.off + 15]).toBe(2);
    expect(decoded[mon.off + 256]).toBe(1);
    expect(decoded[bug.off]).toBe(3);
    expect(decoded[bug.off + 256]).toBe(255);
  });
});

const genDir = join(import.meta.dir, "../dist/voxelmon/gen");
const hasGen = existsSync(join(genDir, "pokemon.json"));
const runtime = hasGen ? await loadRuntimeData(genDir) : null;
function gameWithIcons() {
  const data = structuredClone(runtime!);
  // Synthetic page numbers allow the gameplay tests before a ROM recook.
  data.partyIcons ??= { MON: 10000 };
  for (const def of Object.values(data.pokemon)) def.partyIcon ??= "MON";
  const host = new RecorderHost();
  const game = new VoxelmonGame(data, host, 5);
  game.newGame(); game.chooseStarter("SQUIRTLE");
  game.overworld.setMap("ROUTE_1", 11, 6, "down");
  return { game, host };
}

describe.skipIf(!hasGen)("visible wild integration", () => {
  test("contact opens the exact visible species and level once, without a step roll", () => {
    const { game } = gameWithIcons();
    const w = seedSlot(game.overworld.wild, 11, 7);
    Object.assign(w, { species: "PIDGEY", level: 4 });
    game.tick(VOX_BTN.down);
    expect(game.overworld.encounterCount).toBe(1);
    expect(game.battleView()?.battle.enemy.mon.species).toBe("PIDGEY");
    expect(game.battleView()?.battle.enemy.mon.level).toBe(4);
    expect(w.active).toBe(false);
    for (let i = 0; i < 30; i++) game.tick(VOX_BTN.down);
    expect(game.overworld.encounterCount).toBe(1);
  });
  test("A can engage a visible creature, and absent creatures do not roll invisible battles", () => {
    const { game } = gameWithIcons();
    game.rng = seqRng(0);
    game.overworld.onStepComplete();
    expect(game.battleView()).toBeNull();
    Object.assign(seedSlot(game.overworld.wild, 11, 7), { species: "RATTATA", level: 3 });
    game.tick(VOX_BTN.a);
    expect(game.battleView()?.battle.enemy.mon.species).toBe("RATTATA");
  });
  test("adding a wild sprite leaves every background, camera, player and NPC op unchanged", () => {
    const plain = gameWithIcons(), visible = gameWithIcons();
    for (const { game } of [plain, visible]) game.overworld.wild.consume(game.overworld.wild.slots[0]);
    const wild = seedSlot(visible.game.overworld.wild, 11, 9);
    wild.species = "PIDGEY";
    plain.game.tick(0); visible.game.tick(0);
    const slot = visible.game.overworld.npcs.length + 1 + (visible.game.data.followerSprites ? 1 : 0);
    const extra = `o ${VOX_OP.ent} ${slot} `;
    const lines = visible.host.text().split("\n");
    expect(lines.some(line => line.startsWith(extra))).toBe(true);
    expect(lines.filter(line => !line.startsWith(extra)).join("\n")).toBe(plain.host.text());
  });

  test("natural spawning does not consume battle RNG or alter the save schema", () => {
    const { game, host } = gameWithIcons();
    game.overworld.setMap("ROUTE_1", 14, 9, "down");
    let rolls = 0;
    game.rng = { byte: () => { rolls++; return 0; }, int: () => { rolls++; return 0; } };
    for (let i = 0; i < 600; i++) game.tick(0);
    expect(game.overworld.wild.slots.some(w => w.active)).toBe(true);
    expect(rolls).toBe(0);
    expect(game.saveGame()).toBe(true);
    const save = JSON.parse(host.savedJson!);
    expect(save.save.wild).toBeUndefined();
    expect(game.loadGame()).toBe(true);
    expect(game.overworld.map.id).toBe("ROUTE_1");
    expect(game.overworld.wild.slots.every(w => !w.active)).toBe(true);
  });

  test("no wilds spawn before a healthy party is available", () => {
    const { game } = gameWithIcons();
    game.save.party = [];
    for (let i = 0; i < 600; i++) game.tick(0);
    expect(game.overworld.wild.slots.some(w => w.active)).toBe(false);
  });

  test("wilds freeze while a menu is open and disappear on map changes", () => {
    const { game } = gameWithIcons();
    const w = seedSlot(game.overworld.wild, 11, 9);
    game.tick(VOX_BTN.start);
    const animation = w.animation;
    for (let i = 0; i < 200; i++) game.tick(0);
    expect(w.animation).toBe(animation);
    game.overworld.setMap("DIGLETTS_CAVE", 6, 5, "down");
    expect(game.overworld.wild.slots.every(w => !w.active)).toBe(true);
  });
});
