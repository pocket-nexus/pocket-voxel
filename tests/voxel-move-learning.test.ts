import { expect, test } from "bun:test";
import { loadRuntimeData } from "../voxelmon/game/data.ts";
import { WildBattle, type BattleButton } from "../voxelmon/game/battle/battle.ts";
import { isHmMove, newMon } from "../voxelmon/game/battle/mon.ts";
import { seqRng } from "../voxelmon/game/rng.ts";
import { BattleUi } from "../voxelmon/game/battle/ui.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";

const data = await loadRuntimeData(new URL("../dist/voxelmon/gen", import.meta.url).pathname);
function tick(b: WildBattle, key: BattleButton = "a") {
  b.update({ isDown: k => k === key, wasPressed: k => k === key });
}
function settle(b: WildBattle) {
  for (let i = 0; i < 12000 && b.phase === "messages" && !b.finished; i++) tick(b);
  expect(b.finished !== null || b.phase !== "messages").toBe(true);
}
function battle() {
  const mon = newMon(data, "SQUIRTLE", 7, seqRng(0));
  mon.moves = [{id:"TACKLE",pp:0,ppUps:3},{id:"GROWL",pp:1},{id:"SURF",pp:1},{id:"WITHDRAW",pp:1}];
  const b = new WildBattle(data, {party:[mon], inventory:{}, player:{name:"RED",rival:"BLUE"}}, seqRng(0), "PIDGEY", 3);
  b.enter(); settle(b);
  return b;
}
function learn(b: WildBattle, move = "BUBBLE") {
  b.phase = "messages";
  b.act(() => b.learnMove(b.player.mon, move));
  settle(b);
  expect(String(b.phase)).toBe("moveLearn");
}

test("four-move level-up pauses victory, replaces the chosen move, and restores new PP", () => {
  const b=battle(), mon=b.player.mon; mon.exp=300;
  b.enemy.mon.hp=1; b.enemy.shownHP=1;
  b.player.curMoves[0].pp=1;
  b.resolveTurn(b.player.curMoves[0]); settle(b);
  expect(mon.level).toBe(8); expect(String(b.phase)).toBe("moveLearn"); expect(b.finished).toBeNull();
  tick(b); settle(b);
  expect(mon.moves[0]).toEqual({id:"BUBBLE",pp:data.moves.BUBBLE.pp});
  expect(mon.moves.map(m=>m.id)).toEqual(["BUBBLE","GROWL","SURF","WITHDRAW"]);
  expect(b.player.curMoves[0]).toBe(mon.moves[0]); expect(b.finished).toBe("win");
});

test("each HM is protected and the menu remains available for another selection", () => {
  for (const hm of ["CUT","FLY","SURF","STRENGTH","FLASH"]) {
    const b=battle(); b.player.mon.moves[0]={id:hm,pp:1}; const before=structuredClone(b.player.mon.moves);
    learn(b); tick(b); settle(b);
    expect(String(b.phase)).toBe("moveLearn"); expect(b.player.mon.moves).toEqual(before);
    expect(b.messageLog).toContain("HM moves can't be\nforgotten!");
    tick(b,"down"); tick(b); settle(b);
    expect(b.player.mon.moves[0]).toEqual(before[0]); expect(b.player.mon.moves[1].id).toBe("BUBBLE");
  }
  expect(isHmMove({...data,items:undefined},"CUT")).toBe(true);
});

test("B and CANCEL decline without changing moves or PP, including an all-HM moveset", () => {
  for (const useCancelRow of [false,true]) {
    const b=battle(); b.player.mon.moves=["CUT","FLY","SURF","STRENGTH"].map(id=>({id,pp:1}));
    const before=structuredClone(b.player.mon.moves); learn(b);
    if (useCancelRow) { tick(b,"up"); expect(b.learnIndex).toBe(4); tick(b); }
    else tick(b,"b");
    settle(b); expect(b.player.mon.moves).toEqual(before); expect(b.phase).toBe("menu");
    expect(b.messageLog).toContain("SQUIRTLE did not learn\nBUBBLE!");
  }
});

test("queued learns use updated moves and preserve a different party member's active moves", () => {
  const b=battle(), other=newMon(data,"MEW",40,seqRng(0)); other.moves=structuredClone(b.player.mon.moves);
  b.save.party.push(other); const active=structuredClone(b.player.mon.moves);
  b.phase="messages"; b.act(()=>{b.learnMove(other,"BUBBLE");b.learnMove(other,"BUBBLE");b.learnMove(other,"BIDE");});
  settle(b); tick(b); settle(b);
  expect(String(b.phase)).toBe("moveLearn"); expect(b.learningMove?.moveId).toBe("BIDE");
  expect(other.moves[0].id).toBe("BUBBLE"); tick(b,"down"); tick(b); settle(b);
  expect(other.moves.map(m=>m.id)).toEqual(["BUBBLE","BIDE","SURF","WITHDRAW"]);
  expect(b.player.mon.moves).toEqual(active);
});

test("move-learning UI emits the choice screen and handles every cursor position", () => {
  const b=battle(); learn(b); const ui=new BattleUi(),host=new RecorderHost();
  for(let i=0;i<5;i++){ui.emit(host,b);tick(b,"down");}
  expect(b.learnIndex).toBe(0); expect(host.opCount).toBeGreaterThan(0);
});

test("Supersonic lands, spends PP, and confusion interrupts the target's next action", () => {
  const b=battle(); b.rng=seqRng(0); const move={id:"SUPERSONIC",pp:20};
  b.performMove(b.player,b.enemy,move,false);
  expect(move.pp).toBe(19); expect(b.enemy.confusedTurns).toBeGreaterThan(0);
  const hp=b.enemy.mon.hp, playerHp=b.player.mon.hp;
  b.executeAction(b.enemy,b.player,b.enemy.curMoves[0]);
  expect(b.enemy.mon.hp).toBeLessThan(hp); expect(b.player.mon.hp).toBe(playerHp);
  expect(b.queue.some(row=>row.text?.includes("hurt itself"))).toBe(true);
  b.statusInterrupt(b.enemy,b.player); expect(b.enemy.confusedTurns).toBeUndefined();
});

test("Supersonic keeps its imported accuracy and reports existing confusion clearly", () => {
  const b=battle(); b.rng=seqRng(255); b.performMove(b.player,b.enemy,{id:"SUPERSONIC",pp:20},false);
  expect(b.enemy.confusedTurns).toBeUndefined(); expect(b.queue.some(row=>row.text?.includes("attack missed"))).toBe(true);
  b.rng=seqRng(0); b.performMove(b.player,b.enemy,{id:"SUPERSONIC",pp:20},false);
  const turns=b.enemy.confusedTurns; b.performMove(b.player,b.enemy,{id:"SUPERSONIC",pp:20},false);
  expect(b.enemy.confusedTurns).toBe(turns); expect(b.queue.some(row=>row.text?.includes("already confused"))).toBe(true);
  b.enemy.confusedTurns=undefined; b.enemy.substituteHP=10;
  b.performMove(b.player,b.enemy,{id:"SUPERSONIC",pp:20},false); expect(b.enemy.confusedTurns).toBeUndefined();
});
