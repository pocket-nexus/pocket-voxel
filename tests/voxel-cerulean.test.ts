import { expect, test } from "bun:test";
import { loadRuntimeData } from "../voxelmon/game/data.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { DEFAULT_MAPS } from "../voxelmon/cook/core.ts";
import { GameMap } from "../voxelmon/game/world/map.ts";
import { destination, physicalExit } from "../voxelmon/game/world/warp.ts";
import { canMove, DELTA, type Dir, type TilePairs } from "../voxelmon/game/world/collision.ts";
const data = await loadRuntimeData(new URL("../dist/voxelmon/gen", import.meta.url).pathname);
function game() { const g = new VoxelmonGame(data, new RecorderHost(), 1); g.newGame(); g.chooseStarter("BULBASAUR"); return g; }
function idle(g: VoxelmonGame, n = 100) { for (let i = 0; i < n; i++) g.tick(0); }
function dismiss(g: VoxelmonGame) { for (let i = 0; i < 30 && g.stackKinds().includes("textbox"); i++) { idle(g, 180); g.tick(16); g.tick(0); } }

test("Bill opens the front door; both house doors enter and both exits release the player", () => {
  const g = game(); g.overworld.setMap("BILLS_HOUSE", 0, 0);
  g.overworld.talkTo(g.overworld.npcs.find(n => n.def.name === "BILLSHOUSE_BILL_POKEMON")!); dismiss(g);
  expect(g.save.inventory.SS_TICKET).toBe(1);
  for (const [x, y] of [[27, 11], [27, 9], [9, 11], [9, 9]]) {
    g.overworld.setMap("CERULEAN_CITY", x, y, y === 9 ? "down" : "up");
    expect(g.overworld.npcs.some(n => n.def.name === "CERULEANCITY_GUARD2")).toBe(false);
    g.overworld.warpEntryCell = undefined;
    g.overworld.onStepComplete(); idle(g);
    expect(g.overworld.map.id).toBe(x === 27 ? "CERULEAN_TRASHED_HOUSE" : "CERULEAN_BADGE_HOUSE");
    expect(g.overworld.transitioning).toBe(false);
  }
  for (const index of [0, 2]) {
    const trapped = game(); trapped.overworld.setMap("CERULEAN_TRASHED_HOUSE", 3, 1, index === 0 ? "down" : "up");
    trapped.overworld.takeWarp(trapped.overworld.map.def.warps[index]); idle(trapped);
    expect(trapped.overworld.map.id).toBe("CERULEAN_CITY");
    expect(trapped.overworld.npcs.some(n => n.def.name === "CERULEANCITY_GUARD2")).toBe(false);
    expect(trapped.overworld.scriptMoves.length).toBe(0);
    expect(["up", "down", "left", "right"].some(dir => canMove(trapped.overworld.map, trapped.overworld.entities, trapped.overworld.player, dir as "up").ok)).toBe(true);
  }
});

test("Gary stays visible while walking sideways and six cells south, then disappears", () => {
  for (const x of [20, 21]) {
    const g = game(); g.overworld.setMap("CERULEAN_CITY", x, 6, "up");
    g.pushTrainerBattle = (_n, _c, _p, won) => won();
    g.overworld.onStepComplete(); dismiss(g);
    const rival = g.overworld.npcs.find(n => n.def.name === "CERULEANCITY_RIVAL")!;
    expect(rival).toBeDefined(); expect(g.save.flags.EVENT_BEAT_CERULEAN_RIVAL).toBe(true);
    idle(g, 20); expect(rival.cellX).toBe(x === 20 ? 21 : 20);
    idle(g, 120); expect(rival.cellY).toBe(11);
    expect(g.overworld.npcs.includes(rival)).toBe(false);
    expect(g.overworld.scriptMoves.length).toBe(0);
  }
});

test("fifth bridge win gives one Nugget, recruiter also repairs old completed saves", () => {
  for (const oldSave of [false, true]) {
    const g = game(); g.overworld.setMap("ROUTE_24", 10, 18, "up");
    for (let i = 2; i <= 5; i++) g.save.flags[`EVENT_BEAT_ROUTE_24_TRAINER_${i}`] = true;
    if (oldSave) g.save.flags.EVENT_BEAT_ROUTE_24_TRAINER_1 = true;
    const last = g.overworld.npcs.find(n => n.def.index === (oldSave ? 1 : 3))!;
    g.pushTrainerBattle = (_n, _c, _p, won) => won();
    g.overworld.talkTo(last); dismiss(g);
    expect(g.save.inventory.NUGGET).toBe(1);
    expect(g.save.flags.EVENT_GOT_NUGGET).toBe(true);
    g.overworld.talkTo(g.overworld.npcs.find(n => n.def.index === 1)!); dismiss(g);
    expect(g.save.inventory.NUGGET).toBe(1);
  }
});

test("interact cuts Vermilion's tree only with Cut and the Cascadebadge", () => {
  for (const ready of [false, true]) {
    const g = game(); g.overworld.setMap("VERMILION_CITY", 0, 0);
    const m = g.overworld.map; let x = 0, y = 0;
    outer: for (y = 0; y < m.heightCells; y++) for (x = 0; x < m.widthCells; x++) if (m.cellTile(x, y) === 0x3d) break outer;
    g.overworld.player.cellX = x; g.overworld.player.cellY = y + 1; g.overworld.player.facing = "up";
    if (ready) { g.save.inventory.CASCADEBADGE = 1; g.save.party[0].moves = [{ id: "CUT", pp: 30 }]; }
    g.overworld.interact(); dismiss(g);
    expect(m.isWalkableCell(x, y)).toBe(ready);
  }
});

test("Rocket returns Dig once and clears the house escape route", () => {
  const g = game(); g.overworld.setMap("CERULEAN_CITY", 30, 9, "up");
  g.pushTrainerBattle = (_n, _c, _p, won) => won();
  const rocket = g.overworld.npcs.find(n => n.def.name === "CERULEANCITY_ROCKET")!;
  g.overworld.talkTo(rocket); dismiss(g);
  expect(g.save.inventory.TM_DIG).toBe(1);
  expect(g.save.flags.EVENT_BEAT_CERULEAN_ROCKET_THIEF).toBe(true);
  expect(g.overworld.npcs.includes(rocket)).toBe(false);
  g.overworld.setMap("CERULEAN_CITY", 30, 9, "up");
  expect(g.overworld.npcs.some(n => n.def.name === "CERULEANCITY_ROCKET")).toBe(false);
});

test("southbound walking topology reaches the captain from Cerulean without Cut", () => {
  const withCut = false;
  const field = data.field as { cutTreeSwaps: { before: number; after: number }[]; tilePairs: TilePairs; ledges: { tileset?: string; facing: string; input: string; standingTile: number; ledgeTile: number }[] };
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
  add("CERULEAN_CITY", 27, 12);
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
  for (const id of ["CERULEAN_TRASHED_HOUSE", "ROUTE_5", "UNDERGROUND_PATH_ROUTE_5", "UNDERGROUND_PATH_NORTH_SOUTH", "UNDERGROUND_PATH_ROUTE_6", "ROUTE_6", "VERMILION_CITY", "VERMILION_DOCK", "SS_ANNE_1F", "SS_ANNE_2F", "SS_ANNE_CAPTAINS_ROOM"]) expect(reached.has(id), `unreachable ${id}`).toBe(true);
});

test("loading an old save on the blocked doorstep restores a south exit", () => {
  const g = game(); g.overworld.setMap("CERULEAN_CITY", 27, 11, "down");
  expect(canMove(g.overworld.map, g.overworld.entities, g.overworld.player, "down").ok).toBe(true);
});

test("the bridge recruiter does not award a prize before the five wins", () => {
  const g = game(); g.overworld.setMap("ROUTE_24", 10, 15, "right");
  g.overworld.talkTo(g.overworld.npcs.find(n => n.def.index === 1)!); dismiss(g);
  expect(g.save.inventory.NUGGET ?? 0).toBe(0);
  expect(g.save.flags.EVENT_GOT_NUGGET).toBeFalsy();
});
