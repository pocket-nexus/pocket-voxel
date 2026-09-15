import { expect, test } from "bun:test";
import { loadRuntimeData } from "../voxelmon/game/data.ts";
import { WildBattle } from "../voxelmon/game/battle/battle.ts";
import { newMon } from "../voxelmon/game/battle/mon.ts";
import { EFFECTS } from "../voxelmon/game/battle/effects.ts";
import { seqRng } from "../voxelmon/game/rng.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
const data = await loadRuntimeData(new URL("../dist/voxelmon/gen", import.meta.url).pathname);
function battle(runtime = data) {
  const rng = seqRng(0);
  const mon = newMon(runtime, "MEW", 40, rng);
  const b = new WildBattle(runtime, {party: [mon], inventory: {}, player: {name:"RED",rival:"BLUE"}}, rng, "RATTATA", 40);
  return b;
}
function use(b: WildBattle, id: string) { b.performMove(b.player, b.enemy, {id,pp:20}, false); }
test("every imported zero-power move has a handler", () => {
  for (const move of Object.values(data.moves).filter(m => m.power === 0)) expect(EFFECTS[move.effect!], move.id).toBeDefined();
});
test("all stat-raising moves change their user's stages and cap at six", () => {
  for (const [id,stat,delta] of [["SWORDS_DANCE","attack",2],["GROWTH","special",1],["AMNESIA","special",2],["AGILITY","speed",2],["DOUBLE_TEAM","evasion",1],["BARRIER","defense",2]] as const) {
    const b=battle(); use(b,id); expect(b.player.stages[stat]).toBe(delta); expect(b.enemy.stages[stat]).toBeUndefined();
    b.player.stages[stat]=6; use(b,id); expect(b.player.stages[stat]).toBe(6);
  }
});
test("sleep, poison, Toxic, paralysis and confusion take effect", () => {
  for (const [id,status] of [["SLEEP_POWDER","SLP"],["POISONPOWDER","PSN"],["TOXIC","PSN"],["STUN_SPORE","PAR"]]) {
    const b=battle(); use(b,id); expect(b.enemy.mon.status).toBe(status);
    if (id === "TOXIC") expect(b.enemy.toxicCounter).toBeDefined();
    use(b,"SLEEP_POWDER"); expect(b.enemy.mon.status).toBe(status);
  }
  const b=battle(); use(b,"CONFUSE_RAY"); expect(b.enemy.confusedTurns).toBeGreaterThan(0);
});
test("healing, Rest, screens, Mist and Haze change battle state", () => {
  const b=battle(); b.player.mon.hp=1; use(b,"RECOVER"); expect(b.player.mon.hp).toBe(1+Math.floor(b.player.mon.stats.hp/2));
  b.player.mon.status="PSN"; use(b,"REST"); expect(b.player.mon.hp).toBe(b.player.mon.stats.hp); expect(b.player.mon.status).toBe("SLP"); expect(b.player.sleepTurns).toBe(2);
  use(b,"REFLECT"); use(b,"LIGHT_SCREEN"); use(b,"MIST"); expect(b.player.reflect && b.player.lightScreen && b.player.mist).toBe(true);
  b.player.stages.attack=3; b.enemy.mon.status="PAR"; use(b,"HAZE"); expect(b.player.stages).toEqual({}); expect(b.player.reflect).toBeUndefined(); expect(b.enemy.mon.status).toBeNull();
});
test("Disable uses one-based move slots; Transform and Mimic do not overwrite saved moves", () => {
  const b=battle(); use(b,"DISABLE"); expect(b.enemy.disabledSlot).toBeGreaterThan(0);
  const saved=JSON.stringify(b.player.mon.moves); b.enemy.stages.attack=2; use(b,"TRANSFORM");
  expect(b.player.curMoves).not.toBe(b.enemy.curMoves); expect(b.player.curMoves.every(m=>m.pp===5)).toBe(true);
  expect(b.player.stages.attack).toBe(2); expect(JSON.stringify(b.player.mon.moves)).toBe(saved);
  const c=battle(); c.player.mon.moves=[{id:"MIMIC",pp:10}]; c.player.curMoves=c.player.mon.moves; use(c,"MIMIC");
  for (let i=0;i<4000 && c.phase!=="moveSelect";i++) c.update({isDown:()=>true,wasPressed:k=>k==="a"});
  expect(c.phase).toBe("moveSelect"); expect(c.selectionMoves.map(m=>m.id)).toEqual(c.enemy.curMoves.map(m=>m.id));
  c.update({isDown:()=>false,wasPressed:k=>k==="b"}); expect(c.phase).toBe("moveSelect");
  c.update({isDown:()=>true,wasPressed:k=>k==="a"});
  expect(c.player.curMoves[0].id).not.toBe("MIMIC"); expect(c.player.mon.moves[0].id).toBe("MIMIC");
});
test("Bide stores damage, releases twice the damage and spends PP only once", () => {
  const b=battle(); const m={id:"BIDE",pp:10}; b.performMove(b.player,b.enemy,m,false); expect(m.pp).toBe(9);
  b.applyDamage(b.player,7); const hp=b.enemy.mon.hp;
  b.executeAction(b.player,b.enemy,m); expect(b.enemy.mon.hp).toBe(hp);
  b.executeAction(b.player,b.enemy,m); expect(b.enemy.mon.hp).toBe(hp-14); expect(m.pp).toBe(9); expect(b.player.bideTurns).toBeUndefined();
});
test("Teleport ends wild battles and fails in trainer battles", () => {
  const b=battle(); use(b,"TELEPORT"); expect(b.result).toBe("run"); expect(b.afterQueue).toBe("finish");
  const t = new WildBattle(data,b.save,b.rng,"RATTATA",40,{name:"TRAINER"}); use(t,"TELEPORT"); expect(t.result).toBeNull();
});
function game() { const g=new VoxelmonGame(data,new RecorderHost(),1);g.newGame();g.chooseStarter("BULBASAUR");return g; }
test("TM teaching consumes one item, rejects incompatibility and duplicates, and fills PP", () => {
  const g=game(), mon=g.save.party[0]; mon.moves=[{id:"TACKLE",pp:1}];g.save.inventory.TM_BIDE=2;
  g["teachMachine"]("TM_BIDE",0); expect(mon.moves[1]).toEqual({id:"BIDE",pp:data.moves.BIDE.pp});expect(g.save.inventory.TM_BIDE).toBe(1);
  g["teachMachine"]("TM_BIDE",0);expect(g.save.inventory.TM_BIDE).toBe(1);
  g.save.inventory.TM_WATER_GUN=1;g["teachMachine"]("TM_WATER_GUN",0);expect(mon.moves.some(m=>m.id==="WATER_GUN")).toBe(false);expect(g.save.inventory.TM_WATER_GUN).toBe(1);
});
test("TM replacement preserves the selected slot; cancel and HM protection preserve inventory", () => {
  const g=game(), mon=g.save.party[0];mon.moves=[{id:"TACKLE",pp:1},{id:"GROWL",pp:1},{id:"CUT",pp:1},{id:"VINE_WHIP",pp:1}];g.save.inventory.TM_BIDE=1;
  let choose: (i:number)=>void=()=>{};
  g.showMenuChoice=(_text,_labels,cb)=>{choose=cb;};
  g["teachMachine"]("TM_BIDE",0);choose(4);expect(g.save.inventory.TM_BIDE).toBe(1);
  g["teachMachine"]("TM_BIDE",0);choose(2);expect(mon.moves[2].id).toBe("CUT");expect(g.save.inventory.TM_BIDE).toBe(1);
  g["teachMachine"]("TM_BIDE",0);choose(1);expect(mon.moves.map(m=>m.id)).toEqual(["TACKLE","BIDE","CUT","VINE_WHIP"]);expect(g.save.inventory.TM_BIDE??0).toBe(0);
  g.save.inventory.HM_CUT=1;mon.moves=[{id:"TACKLE",pp:1}];g["teachMachine"]("HM_CUT",0);expect(mon.moves[1].id).toBe("CUT");expect(g.save.inventory.HM_CUT).toBe(1);
});

test("TM bag flow reaches the party and four-move replacement menus with controller input", () => {
  const g=game(), mon=g.save.party[0];
  mon.moves=[{id:"TACKLE",pp:1},{id:"GROWL",pp:1},{id:"LEECH_SEED",pp:1},{id:"VINE_WHIP",pp:1}];
  g.save.inventory={TM_BIDE:1};g.save.bagOrder=["TM_BIDE"];
  const tap=(mask:number)=>{g.tick(0);g.tick(mask);g.tick(0);};
  const untilChoice=()=>{for(let i=0;i<4000&&g.top()?.kind!=="choice";i++)g.tick(i%2?0:16);expect(g.top()?.kind).toBe("choice");};
  const confirm=()=>{tap(16);for(let i=0;i<16;i++)g.tick(0);};
  g.openBag();untilChoice();confirm();untilChoice();
  expect((g.top() as unknown as {labels:string[]}).labels[0]).toContain("ABLE");
  confirm();untilChoice();confirm();
  expect(mon.moves[0].id).toBe("BIDE"); expect(g.save.inventory.TM_BIDE??0).toBe(0);
});

test("Substitute absorbs hits, Conversion copies types, and Splash leaves HP alone", () => {
  const b=battle(), hp=b.player.mon.hp;use(b,"SUBSTITUTE");
  const cost=Math.floor(b.player.mon.stats.hp/4);expect(b.player.mon.hp).toBe(hp-cost);expect(b.player.substituteHP).toBe(cost+1);
  b.applyDamage(b.player,cost+1);expect(b.player.substituteHP).toBeUndefined();expect(b.player.mon.hp).toBe(hp-cost);
  b.enemy.curTypes=["WATER"];use(b,"CONVERSION");expect(b.player.curTypes).toEqual(["WATER"]);expect(b.player.curTypes).not.toBe(b.enemy.curTypes);
  const before=[b.player.mon.hp,b.enemy.mon.hp];use(b,"SPLASH");expect([b.player.mon.hp,b.enemy.mon.hp]).toEqual(before);
});
test("Mirror Move and Metronome invoke a move without an extra PP charge", () => {
  const b=battle();b.enemy.lastMove="SWORDS_DANCE";const mirror={id:"MIRROR_MOVE",pp:10};b.performMove(b.player,b.enemy,mirror,false);
  expect(b.player.stages.attack).toBe(2);expect(mirror.pp).toBe(9);
  const original=data.moves;
  const c=battle({...data,moves:{METRONOME:original.METRONOME,SWORDS_DANCE:original.SWORDS_DANCE}});
  const metronome={id:"METRONOME",pp:10};c.performMove(c.player,c.enemy,metronome,false);expect(c.player.stages.attack).toBe(2);expect(metronome.pp).toBe(9);
});
test("status accuracy and immunities still apply", () => {
  const b=battle();b.enemy.curTypes=["GROUND"];use(b,"THUNDER_WAVE");expect(b.enemy.mon.status).toBeNull();
  b.enemy.curTypes=["POISON"];use(b,"TOXIC");expect(b.enemy.mon.status).toBeNull();
  b.enemy.curTypes=["GRASS"];use(b,"LEECH_SEED");expect(b.enemy.leechSeeded).toBeUndefined();
  b.enemy.invulnerable=true;use(b,"SLEEP_POWDER");expect(b.enemy.mon.status).toBeNull();
});
