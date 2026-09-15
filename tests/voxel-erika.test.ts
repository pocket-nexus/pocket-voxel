import { expect, test } from "bun:test";
import { VOX_OP } from "../contracts/spec/voxel-spec.ts";
import { DEFAULT_MAPS } from "../voxelmon/cook/core.ts";
import { loadRuntimeData } from "../voxelmon/game/data.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { GameMap } from "../voxelmon/game/world/map.ts";
import { canMove, DELTA, type Dir, type TilePairs } from "../voxelmon/game/world/collision.ts";
import { destination, physicalExit } from "../voxelmon/game/world/warp.ts";
import { trainerHeader } from "../voxelmon/game/world/trainers.ts";

const data = await loadRuntimeData(new URL("../dist/voxelmon/gen", import.meta.url).pathname);
const field = data.field as { cutTreeSwaps: { before: number; after: number }[]; tilePairs: TilePairs; ledges: { tileset?: string; facing: string; input: string; standingTile: number; ledgeTile: number }[] };
function game() {
  const g = new VoxelmonGame(data, new RecorderHost(), 1);
  g.newGame(); g.chooseStarter("BULBASAUR");
  return g;
}
function idle(g: VoxelmonGame, n = 80) { for (let i = 0; i < n; i++) g.tick(0); }
function dismiss(g: VoxelmonGame) {
  for (let i = 0; i < 20 && g.stackKinds().includes("textbox"); i++) { idle(g, 180); g.tick(16); g.tick(0); }
}

test("blackout followed by the Center door returns to its city, not Diglett's Cave", () => {
  for (const city of ["VERMILION", "CERULEAN", "LAVENDER", "CELADON"]) {
    const g = game();
    g.save.lastHeal = { map: `${city}_POKECENTER`, x: 3, y: 6 };
    g.overworld.setMap("DIGLETTS_CAVE_ROUTE_11", 2, 4, "down");
    g.overworld.lastOutdoor = { id: "ROUTE_11", x: 4, y: 5 };
    g.blackout(); idle(g);
    expect(g.overworld.map.id).toBe(`${city}_POKECENTER`);
    g.overworld.takeWarp(g.overworld.map.def.warps.find(w => w.destMap === "LAST_MAP")!);
    idle(g);
    expect(g.overworld.map.id).toBe(city === "LAVENDER" ? "LAVENDER_TOWN" : `${city}_CITY`);
  }
});

test("both Underground Paths exit at the physical entrance on either side", () => {
  for (const route of [5, 6, 7, 8]) {
    const g = game(); const id = `UNDERGROUND_PATH_ROUTE_${route}`;
    g.overworld.setMap(id, 2, 6, "down");
    g.overworld.lastOutdoor = { id: "ROUTE_11", x: 0, y: 0 };
    g.overworld.takeWarp(g.overworld.map.def.warps.find(w => w.destMap === "LAST_MAP")!);
    idle(g); expect(g.overworld.map.id).toBe(`ROUTE_${route}`);
  }
});

test("Route 6 trainers detect the player and defeated trainers stay present without re-engaging", () => {
  const g = game(); g.overworld.setMap("ROUTE_6", 0, 0, "down");
  const npc = g.overworld.npcs.find(n => trainerHeader(data, g.overworld.map.def, n.def.index)?.range === 4)!;
  const h = trainerHeader(data, g.overworld.map.def, npc.def.index)!;
  const dir = npc.def.range!.toLowerCase() as Dir;
  const [dx, dy] = DELTA[dir];
  g.overworld.player.cellX = npc.cellX + dx; g.overworld.player.cellY = npc.cellY + dy;
  const sight = () => (g.overworld as unknown as { tryTrainerSight(): boolean }).tryTrainerSight();
  expect(sight()).toBe(true); expect(npc.frozen).toBe(true);
  dismiss(g); idle(g); dismiss(g);
  expect(g.battleView()?.battle.kind).toBe("trainer");
  const defeated = game(); defeated.save.flags[h.event] = true;
  defeated.overworld.setMap("ROUTE_6", npc.def.x + dx, npc.def.y + dy, "down");
  expect(defeated.overworld.npcs.some(n => n.def.name === npc.def.name)).toBe(true);
  expect((defeated.overworld as unknown as { tryTrainerSight(): boolean }).tryTrainerSight()).toBe(false);
});

test("Cut changes collision, emits removable geometry, and trees regrow on map re-entry", () => {
  const g = game(); g.save.inventory.CASCADEBADGE = 1;
  g.save.party[0].moves = [{ id: "CUT", pp: 30 }];
  for (const id of ["CERULEAN_CITY", "VERMILION_CITY", "CELADON_CITY", "CELADON_GYM"]) {
    g.overworld.setMap(id, 0, 0, "down"); const map = g.overworld.map;
    let tree: [number, number] | undefined;
    for (let y = 0; y < map.heightCells && !tree; y++) for (let x = 0; x < map.widthCells; x++) {
      if (map.cellTile(x, y) === (map.def.tileset === "GYM" ? 0x50 : 0x3d)) { tree = [x, y]; break; }
    }
    expect(tree).toBeDefined(); const [x, y] = tree!;
    expect((g.overworld as unknown as { tryCut(x: number, y: number): boolean }).tryCut(x, y)).toBe(true);
    dismiss(g); expect(map.isWalkableCell(x, y)).toBe(true);
    expect(map.removedStamps.has(`${x},${y}`)).toBe(true);
    expect((g.host as RecorderHost).text()).toContain(`o ${VOX_OP.stamp} ${map.def.index} ${x} ${y} 0`);
    g.overworld.setMap(id, 0, 0, "down"); expect(g.overworld.map.isWalkableCell(x, y)).toBe(false);
    idle(g, 1);
    expect((g.host as RecorderHost).text()).toContain(`o ${VOX_OP.stamp} ${map.def.index} ${x} ${y} 1`);
  }
});

for (const withCut of [false, true]) test(`walkable campaign connects Vermilion ${withCut ? "through Erika with Cut" : "back to Misty without Cut"}`, () => {
  // Flood actual walk cells, directed ledges, stairs, doors and seam offsets.
  // Trainers can be defeated; ignore temporary NPC occupancy for this topology audit.
  const maps = new Map(DEFAULT_MAPS.map(id => [id, new GameMap(data.maps![id], data.tilesets![data.maps![id].tileset])]));
  for (const map of maps.values()) if (withCut && ["OVERWORLD", "GYM"].includes(map.def.tileset)) {
    for (let y = 0; y < map.heightCells; y++) for (let x = 0; x < map.widthCells; x++) {
      if (map.cellTile(x, y) !== (map.def.tileset === "GYM" ? 0x50 : 0x3d)) continue;
      const bx = x >> 1, by = y >> 1;
      const swap = field.cutTreeSwaps.find(s => s.before === map.blockAt(bx, by));
      if (swap) map.cutBlock(bx, by, swap.after);
    }
  }
  const compass = { up: "north", down: "south", left: "west", right: "east" } as const;
  const seen = new Set<string>(), reached = new Set<string>();
  const queue: [string, number, number][] = [];
  const add = (id: string, x: number, y: number) => {
    const map = maps.get(id); if (!map?.inBounds(x, y)) return;
    const key = `${id}:${x},${y}`; if (seen.has(key)) return;
    seen.add(key); reached.add(id); queue.push([id, x, y]);
  };
  add("VERMILION_POKECENTER", 3, 6);
  for (let i = 0; i < queue.length; i++) {
    const [id, x, y] = queue[i], map = maps.get(id)!;
    const warp = map.warpAtCell(x, y)?.def;
    if (warp) {
      const parent = warp.destMap === "LAST_MAP" ? physicalExit(data, id, warp) : undefined;
      if (warp.destMap !== "LAST_MAP" || parent) { const d = destination(data, warp, parent); add(d.map, d.x, d.y); }
    }
    for (const dir of Object.keys(DELTA) as Dir[]) {
      const [dx, dy] = DELTA[dir]; const nx = x + dx, ny = y + dy;
      if (canMove(map, [], { cellX: x, cellY: y }, dir, field.tilePairs).ok) add(id, nx, ny);
      if (!map.inBounds(nx, ny)) {
        const c = map.def.connections?.[compass[dir]], dest = c && maps.get(c.map);
        if (c && dest) {
          const tx = dir === "left" ? dest.widthCells - 1 : dir === "right" ? 0 : x - c.offset * 2;
          const ty = dir === "up" ? dest.heightCells - 1 : dir === "down" ? 0 : y - c.offset * 2;
          if (dest.inBounds(tx, ty) && dest.isWalkableCell(tx, ty)) add(c.map, tx, ty);
        }
      } else for (const l of field.ledges ?? []) {
        if ((l.tileset ?? "OVERWORLD") === map.def.tileset && l.facing === dir && l.input === dir && l.standingTile === map.cellTile(x, y) && l.ledgeTile === map.cellTile(nx, ny) && map.inBounds(nx + dx, ny + dy) && map.isWalkableCell(nx + dx, ny + dy)) add(id, nx + dx, ny + dy);
      }
    }
  }
  for (const id of (withCut ? ["ROUTE_6", "UNDERGROUND_PATH_NORTH_SOUTH", "ROUTE_5", "CERULEAN_GYM", "ROUTE_9", "ROUTE_10", "ROCK_TUNNEL_1F", "ROCK_TUNNEL_B1F", "LAVENDER_TOWN", "ROUTE_8", "UNDERGROUND_PATH_WEST_EAST", "ROUTE_7", "CELADON_CITY", "VERMILION_GYM", "CELADON_GYM"] : ["ROUTE_6", "UNDERGROUND_PATH_NORTH_SOUTH", "ROUTE_5", "CERULEAN_GYM"])) expect(reached.has(id), `unreachable ${id}`).toBe(true);
  for (const [id, name] of [["CERULEAN_GYM", "CERULEANGYM_MISTY"], ["VERMILION_GYM", "VERMILIONGYM_LT_SURGE"], ["CELADON_GYM", "CELADONGYM_ERIKA"]]) {
    if (!withCut && id !== "CERULEAN_GYM") continue;
    const leader = data.maps![id].objects.find(o => o.name === name)!;
    expect(Object.values(DELTA).some(([dx, dy]) => seen.has(`${id}:${leader.x + dx},${leader.y + dy}`)), `cannot reach ${name}`).toBe(true);
  }
});


test("Lt. Surge and Erika start their ROM parties and award badges and TMs once", () => {
  for (const [map, name, cls, badge, tm, flag] of [
    ["VERMILION_GYM", "VERMILIONGYM_LT_SURGE", "OPP_LT_SURGE", "THUNDERBADGE", "TM_THUNDERBOLT", "EVENT_BEAT_LT_SURGE"],
    ["CELADON_GYM", "CELADONGYM_ERIKA", "OPP_ERIKA", "RAINBOWBADGE", "TM_MEGA_DRAIN", "EVENT_BEAT_ERIKA"],
  ]) {
    const g = game(); g.overworld.setMap(map, 4, 4, "up");
    let battles = 0;
    g.pushTrainerBattle = (_name, trainerClass, party, won) => {
      battles++; expect(trainerClass).toBe(cls); expect(party).toEqual(data.trainers![cls].parties[0]); won();
    };
    const npc = g.overworld.npcs.find(n => n.def.name === name)!;
    g.overworld.talkTo(npc); dismiss(g);
    expect(battles).toBe(1); expect(g.save.flags[flag]).toBe(true);
    expect(g.save.inventory[badge]).toBe(1); expect(g.save.inventory[tm]).toBe(1);
    g.overworld.talkTo(npc); dismiss(g);
    expect(battles).toBe(1); expect(g.save.inventory[tm]).toBe(1);
  }
});

test("Mt. Moon fossil choice grants one fossil and clears both floor objects", () => {
  const g = game();
  g.overworld.setMap("MT_MOON_B2F", 12, 6, "right");
  g.save.flags.EVENT_BEAT_MT_MOON_3_SUPER_NERD = true;
  const fossil = g.overworld.npcs.find(n => n.def.name === "MTMOONB2F_DOME_FOSSIL")!;
  g.overworld.talkTo(fossil);
  // Select the default DOME choice and advance the resulting text.
  for (let i = 0; i < 180; i++) g.tick(0);
  g.tick(16); g.tick(0);
  for (let i = 0; i < 180; i++) g.tick(0);
  expect(g.save.inventory.DOME_FOSSIL).toBe(1);
  expect(g.save.flags.EVENT_GOT_DOME_FOSSIL).toBe(true);
  expect(g.save.flags.EVENT_MT_MOON_FOSSIL_TAKEN).toBe(true);
  expect(g.overworld.npcs.some(n => n.def.name?.includes("FOSSIL"))).toBe(false);
});
