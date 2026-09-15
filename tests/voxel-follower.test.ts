import { expect, test } from "bun:test";
import { loadRuntimeData } from "../voxelmon/game/data.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { newMon } from "../voxelmon/game/battle/mon.ts";
import { PartyFollower } from "../voxelmon/game/world/follower.ts";
import { Player } from "../voxelmon/game/world/player.ts";
import { buildFollowerPage } from "../voxelmon/cook/atlas.ts";
import { loadGen } from "../voxelmon/cook/data-node.ts";
import { VOX_OP } from "../contracts/spec/voxel-spec.ts";
const data = await loadRuntimeData(new URL("../dist/voxelmon/gen", import.meta.url).pathname);
function game() {
  const g = new VoxelmonGame(data, new RecorderHost(), 1); g.newGame(); g.chooseStarter("BULBASAUR");
  g.save.party.push(newMon(data, "BEEDRILL", 30, g.battleRng));
  return g;
}
function pump(g: VoxelmonGame, until: () => boolean) {
  for (let i = 0; i < 12000 && !until(); i++) g.tick(i % 2 ? 0 : 16);
  expect(until()).toBe(true);
}

test("Beedrill stays active across trainer replacements with stages, HP, PP and experience", () => {
  const g = game();
  g.pushTrainerBattle("TEST", "OPP_BUG_CATCHER", [{ species: "METAPOD", level: 2 }, { species: "KAKUNA", level: 2 }], () => {});
  const b = g.battleView()!.battle;
  pump(g, () => b.phase === "menu");
  const bee = g.save.party[1]; b.resolveSwitch(bee);
  pump(g, () => b.phase === "menu");
  expect(b.player.mon).toBe(bee);
  b.player.stages.attack = 2;
  const active = b.player, hp = bee.hp, pp = bee.moves.map(m => m.pp);
  b.enemy.mon.hp = 0; b.onFaint(b.enemy); b.phase = "messages";
  pump(g, () => g.battleView()!.battle !== b);
  const next = g.battleView()!.battle;
  expect(next.player).toBe(active);
  expect(next.player.stages.attack).toBe(2);
  expect(bee.hp).toBe(hp); expect(bee.moves.map(m => m.pp)).toEqual(pp);
  expect(g.save.party[0].species).toBe("BULBASAUR");
  pump(g, () => next.phase === "menu");
  expect(next.player.mon).toBe(bee);
  const leadExp = g.save.party[0].exp, beeExp = bee.exp;
  next.awardExp();
  expect(bee.exp).toBeGreaterThan(beeExp);
  expect(g.save.party[0].exp).toBe(leadExp);
});

test("a fainted active mon requires a choice instead of silently sending party slot one", () => {
  const g = game(); g.pushTrainerBattle("TEST", "OPP_BUG_CATCHER", [{ species: "METAPOD", level: 2 }, { species: "KAKUNA", level: 2 }], () => {});
  const b = g.battleView()!.battle; pump(g, () => b.phase === "menu");
  b.resolveSwitch(g.save.party[1]); pump(g, () => b.phase === "menu");
  b.player.mon.hp = 0; b.finished = "win"; g.tick(0);
  const next = g.battleView()!.battle;
  pump(g, () => next.phase === "party");
  expect(next.partyForced).toBe(true); expect(next.player.mon).toBe(g.save.party[1]);
});

test("follower follows turns, changes with party lead, and resets across maps", () => {
  const g = game(), p = new Player(5, 5, "right"), f = new PartyFollower();
  f.reset(p); f.update(p, g.save.party[0]); expect(f.active).toBe(false);
  p.cellX = 6; p.px = 96; f.update(p, g.save.party[0]);
  expect(f.active).toBe(true); expect([f.px, f.py]).toEqual([80, 80]);
  p.moving = true; p.stepFramesCur = 16; p.progress = 8; p.py = 88;
  f.update(p, g.save.party[1]); expect(f.species).toBe("BEEDRILL");
  expect([f.px, f.py]).toEqual([88, 80]);
  p.moving = false; p.cellY = 6; p.py = 96;
  f.update(p, g.save.party[1]); expect([f.px, f.py]).toEqual([96, 80]);
  g.overworld.setMap("CERULEAN_CITY", 19, 18); g.overworld.follower.update(g.overworld.player, g.save.party[0]);
  expect(g.overworld.follower.active).toBe(false);
  f.update(p); expect(f.active).toBe(false);
});

test("follower is rendered on its own entity slot and never joins collision entities", () => {
  const g = new VoxelmonGame({ ...data, followerSprites: { BULBASAUR: 700, BEEDRILL: 701 } }, new RecorderHost(), 1);
  g.newGame(); g.chooseStarter("BULBASAUR"); g.save.party.push(newMon(data, "BEEDRILL", 30, g.battleRng));
  g.overworld.setMap("REDS_HOUSE_2F", 3, 4, "right");
  const p = g.overworld.player; p.cellX = 4; p.px = 64;
  g.tick(0);
  const slot = g.overworld.npcs.length + 1;
  expect((g.host as RecorderHost).text()).toContain(`o ${VOX_OP.ent} ${slot} 700`);
  expect(g.overworld.entities).toHaveLength(g.overworld.npcs.length + 1);
  [g.save.party[0], g.save.party[1]] = [g.save.party[1], g.save.party[0]]; g.tick(0);
  expect((g.host as RecorderHost).text()).toContain(`o ${VOX_OP.ent} ${slot} 701`);
});

test("followers share ten icon types and preserve both original front poses", () => {
  const gen = loadGen();
  const icons = [...new Set(Object.values(gen.pokemon).map(p => p.partyIcon as string))];
  expect(icons).toHaveLength(10);
  for (const icon of icons) {
    const page = buildFollowerPage(gen, icon), source = gen.gfx[`icons/party_${icon}`];
    expect(page.w).toBe(64); expect(page.h).toBe(96);
    for (let frame = 0; frame < 6; frame++) {
      const pose = page.frames[0].slice(frame * 1024, (frame + 1) * 1024);
      expect(pose.some(p => p !== 255)).toBe(true);
      expect(pose.every(p => p === 255 || p < 4)).toBe(true);
    }
    for (let pose = 0; pose < 2; pose++) for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      expect(page.frames[0][(pose * 48 + y) * 64 + x]).toBe(gen.gfxBin[source.off + (pose * 16 + y) * 16 + x]);
    }
  }
});

test("follower faces along its own trail and uses up and side walking frames", () => {
  const p = new Player(5, 5, "up"), f = new PartyFollower(); f.reset(p);
  p.cellY = 4; p.py = 64; f.update(p, {species: "ONIX"});
  expect(f.facing).toBe("up"); expect(f.frame).toBe(1);
  p.moving = true; p.progress = 8; p.animClock = 8; f.update(p, {species: "ONIX"}); expect(f.frame).toBe(4);
  p.cellX = 6; p.progress = 0; p.animClock = 0; f.update(p, {species: "ONIX"});
  expect(f.facing).toBe("right"); expect(f.frame).toBe(2);
  p.progress = 8; p.animClock = 8; f.update(p, {species: "ONIX"}); expect(f.frame).toBe(5);
});
