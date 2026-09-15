import { expect, test } from "bun:test";
import { loadRuntimeData } from "../voxelmon/game/data.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { newMon } from "../voxelmon/game/battle/mon.ts";
import { WildBattle, type BattleButton } from "../voxelmon/game/battle/battle.ts";
import { seqRng } from "../voxelmon/game/rng.ts";
import { expForLevel } from "../voxelmon/game/rules/growth.ts";
import { useMedicine } from "../voxelmon/game/rules/medicine.ts";
import { BattleUi } from "../voxelmon/game/battle/ui.ts";

const data=await loadRuntimeData(new URL("../dist/voxelmon/gen",import.meta.url).pathname);
function game() { const g=new VoxelmonGame(data,new RecorderHost(),1);g.newGame();g.chooseStarter("BULBASAUR");return g; }
function dialogs(g: VoxelmonGame, index=0, yes=true) {
  const messages:string[]=[];
  g.showText=(text,done)=>{messages.push(text);done?.();};
  g.showChoice=(text,choose)=>{messages.push(text);choose(yes);};
  g.showMenuChoice=(text,_labels,choose)=>{messages.push(text);choose(index);};
  return messages;
}
function talk(g:VoxelmonGame,map:string,name:string) {
  g.overworld.setMap(map,0,0,"down");
  const npc=g.overworld.npcs.find(n=>n.def.name===name);expect(npc).toBeDefined();g.overworld.talkTo(npc!);
}

test("fan-club voucher exchanges once at bike shop, including a full bag",()=>{
  const g=game();dialogs(g);
  talk(g,"POKEMON_FAN_CLUB","POKEMONFANCLUB_CHAIRMAN");expect(g.save.inventory.BIKE_VOUCHER).toBe(1);
  for(let i=0;i<19;i++)g.save.inventory[`FILLER_${i}`]=1;
  const money=g.save.money;
  talk(g,"BIKE_SHOP","BIKESHOP_CLERK");expect(g.save.inventory.BIKE_VOUCHER).toBeUndefined();expect(g.save.inventory.BICYCLE).toBe(1);expect(g.save.money).toBe(money);
  talk(g,"POKEMON_FAN_CLUB","POKEMONFANCLUB_CHAIRMAN");talk(g,"BIKE_SHOP","BIKESHOP_CLERK");
  expect(g.save.inventory.BICYCLE).toBe(1);expect(g.save.inventory.BIKE_VOUCHER).toBeUndefined();
});
test("bike cancel, unaffordable sale and full-bag voucher grant leave rewards untouched",()=>{
  const g=game();dialogs(g);talk(g,"BIKE_SHOP","BIKESHOP_CLERK");expect(g.save.inventory.BICYCLE).toBeUndefined();
  dialogs(g,0,false);talk(g,"POKEMON_FAN_CLUB","POKEMONFANCLUB_CHAIRMAN");expect(g.save.inventory.BIKE_VOUCHER).toBeUndefined();
  dialogs(g);g.save.inventory={};for(let i=0;i<20;i++)g.save.inventory[`FILLER_${i}`]=1;
  talk(g,"POKEMON_FAN_CLUB","POKEMONFANCLUB_CHAIRMAN");expect(g.save.flags.EVENT_GOT_BIKE_VOUCHER).toBeFalsy();
  g.save.inventory={BIKE_VOUCHER:1};dialogs(g,0,false);talk(g,"BIKE_SHOP","BIKESHOP_CLERK");expect(g.save.inventory.BIKE_VOUCHER).toBe(1);
});
test("bicycle toggles outdoors, dismounts indoors, and is not consumed",()=>{
  const g=game();dialogs(g);g.save.inventory.BICYCLE=1;g.overworld.setMap("CERULEAN_CITY",10,10,"down");
  g.toggleBicycle();expect(g.cycling).toBe(true);expect(g.overworld.player.stepFrames).toBe(8);
  g.toggleBicycle();expect(g.overworld.player.stepFrames).toBe(16);g.toggleBicycle();
  g.overworld.setMap("BIKE_SHOP",0,0,"down");g.tick(0);expect(g.cycling).toBe(false);expect(g.overworld.player.stepFrames).toBe(16);
  g.toggleBicycle();expect(g.cycling).toBe(false);expect(g.save.inventory.BICYCLE).toBe(1);
});
test("daycare deposits, gains step EXP across save/load, and retrieves for the correct fee",()=>{
  const g=game();g.save.party.push(newMon(data,"RATTATA",5,seqRng(0)));dialogs(g,1);
  talk(g,"DAYCARE","DAYCARE_GENTLEMAN");expect(g.save.party.length).toBe(1);
  const dc=g.save.daycare!;expect(dc.mon.species).toBe("RATTATA");
  g.overworld.onStepComplete();expect(dc.steps).toBe(1);
  dc.steps=expForLevel(data.pokemon.RATTATA.growthRate,7)-dc.mon.exp;g.save.money=1000;
  expect(g.saveGame()).toBe(true);expect(g.loadGame()).toBe(true);expect(g.save.daycare?.steps).toBe(dc.steps);
  dialogs(g,0,false);g.openDaycare();g.openDaycare();expect(g.save.daycare?.mon.level).toBe(5);expect(g.save.money).toBe(1000);
  dialogs(g);g.openDaycare();expect(g.save.daycare).toBeUndefined();expect(g.save.party[1].level).toBe(7);expect(g.save.money).toBe(700);
});
test("daycare blocks last healthy deposit, full-party pickup and insufficient money",()=>{
  const g=game();dialogs(g);g.openDaycare();expect(g.save.daycare).toBeUndefined();
  const other=newMon(data,"RATTATA",5);other.hp=0;g.save.party.push(other);g.openDaycare();expect(g.save.daycare).toBeUndefined();
  other.hp=other.stats.hp;g.openDaycare();expect(g.save.daycare).toBeDefined();
  g.save.money=0;g.openDaycare();expect(g.save.daycare).toBeDefined();
  g.save.money=1000;while(g.save.party.length<6)g.save.party.push(newMon(data,"PIDGEY",5));g.openDaycare();expect(g.save.daycare).toBeDefined();expect(g.save.money).toBe(1000);
});
test("all potion strengths cap HP, Full Restore cures, and potions never revive",()=>{
  for(const [id,heal] of [["POTION",20],["SUPER_POTION",50],["HYPER_POTION",200],["MAX_POTION",Infinity]] as const){
    const mon=newMon(data,"MEW",100);mon.hp=1;expect(useMedicine(mon,id)).toBe(true);expect(mon.hp).toBe(Math.min(mon.stats.hp,1+heal));
    mon.hp=mon.stats.hp;expect(useMedicine(mon,id)).toBe(false);mon.hp=0;expect(useMedicine(mon,id)).toBe(false);
  }
  const mon=newMon(data,"MEW",40);mon.status="PSN";expect(useMedicine(mon,"FULL_RESTORE")).toBe(true);expect(mon.status).toBeNull();
});
function tick(b:WildBattle,k:BattleButton="a"){b.update({isDown:x=>x===k,wasPressed:x=>x===k});}
function settle(b:WildBattle){for(let i=0;i<12000&&b.phase==="messages"&&!b.finished;i++)tick(b);expect(b.phase!=="messages"||b.finished!==null).toBe(true);}
function trainer(){
 const mon=newMon(data,"MEW",40),bench=newMon(data,"SQUIRTLE",30);mon.hp-=30;bench.hp-=30;
 const b=new WildBattle(data,{party:[mon,bench],inventory:{POTION:3,POKE_BALL:2},player:{name:"RED",rival:"BLUE"}},seqRng(0),"RATTATA",20,{name:"TRAINER"});
 b.enter();settle(b);b.enemy.curMoves=[{id:"SPLASH",pp:40}];return b;
}
test("trainer potion targets active or benched Pokémon and gives the opponent one action",()=>{
 for(const index of [0,1]){
  const b=trainer(),mon=b.save.party[index],hp=mon.hp;b.openItems();expect(b.phase).toBe("item");tick(b);expect(b.phase).toBe("party");
  if(index)tick(b,"down");tick(b);expect(mon.hp).toBe(hp+20);expect(b.save.inventory.POTION).toBe(2);settle(b);
  expect(b.messageLog.filter(m=>m.includes("used SPLASH"))).toHaveLength(1);expect(b.phase).toBe("menu");
 }
});
test("trainer bags block only balls; medicine cancel and no-effect do not consume a turn",()=>{
 const b=trainer();b.openItems();b.itemIndex=b.itemList.indexOf("POKE_BALL");tick(b);settle(b);expect(b.save.inventory.POKE_BALL).toBe(2);
 b.openItems();b.itemIndex=b.itemList.indexOf("POTION");tick(b);tick(b,"b");expect(b.phase).toBe("item");expect(b.save.inventory.POTION).toBe(3);
 b.player.mon.hp=b.player.mon.stats.hp;tick(b);tick(b);settle(b);expect(b.save.inventory.POTION).toBe(3);expect(b.messageLog.some(m=>m.includes("used SPLASH"))).toBe(false);
 b.player.mon.hp=0;b.openItems();b.itemIndex=0;tick(b);tick(b);expect(b.save.inventory.POTION).toBe(3);
});
test("field bag uses Super Potion through controller menus",()=>{
 const g=game(),mon=g.save.party[0];mon.hp=1;g.save.inventory={SUPER_POTION:1};g.save.bagOrder=["SUPER_POTION"];
 const tap=(m:number)=>{g.tick(0);g.tick(m);g.tick(0);};
 const choose=()=>{for(let i=0;i<4000&&g.top()?.kind!=="choice";i++)g.tick(i%2?0:16);expect(g.top()?.kind).toBe("choice");tap(16);for(let i=0;i<16;i++)g.tick(0);};
 g.openBag();choose();choose();expect(mon.hp).toBe(mon.stats.hp);expect(g.save.inventory.SUPER_POTION).toBeUndefined();
});
test("large battle item bag keeps the selected item within the tile screen",()=>{
 const b=trainer();b.save.inventory={POTION:1,SUPER_POTION:1,HYPER_POTION:1,MAX_POTION:1,FULL_RESTORE:1,ANTIDOTE:1,AWAKENING:1,POKE_BALL:1};b.openItems();b.itemIndex=7;
 const host=new RecorderHost(),ui=new BattleUi();
 const tile=host.uiTile.bind(host);host.uiTile=(x,y,t)=>{expect(x).toBeGreaterThanOrEqual(0);expect(x).toBeLessThan(20);expect(y).toBeGreaterThanOrEqual(0);expect(y).toBeLessThan(18);tile(x,y,t);};
 ui.emit(host,b);ui.emit(host,b);expect(host.opCount).toBeGreaterThan(0);
});

test("daycare retrieval offers learned moves and protects HMs",()=>{
 const g=game(),mon=newMon(data,"SQUIRTLE",7);mon.moves=[{id:"SURF",pp:1},{id:"TACKLE",pp:1},{id:"GROWL",pp:1},{id:"WITHDRAW",pp:1}];
 g.save.daycare={mon,depositLevel:7,steps:expForLevel(data.pokemon.SQUIRTLE.growthRate,8)-mon.exp};g.save.money=1000;
 let choose:(i:number)=>void=()=>{};g.showChoice=(_t,cb)=>cb(true);g.showText=(_t,done)=>done?.();g.showMenuChoice=(_t,_labels,cb)=>{choose=cb;};
 g.openDaycare();expect(g.save.party).toContain(mon);expect(g.save.daycare).toBeUndefined();expect(g.save.money).toBe(800);
 choose(0);expect(mon.moves[0].id).toBe("SURF");choose(1);expect(mon.moves[1]).toEqual({id:"BUBBLE",pp:data.moves.BUBBLE.pp});
});
test("evolution learning offers replacement and continues after declining",()=>{
 const runtime={...data,pokemon:{...data.pokemon,IVYSAUR:{...data.pokemon.IVYSAUR,learnset:[{level:16,move:"BUBBLE"}]}}};
 const g=new VoxelmonGame(runtime,new RecorderHost(),1);g.newGame();
 const mon=newMon(runtime,"IVYSAUR",16);mon.moves=["CUT","TACKLE","GROWL","WITHDRAW"].map(id=>({id,pp:1}));
 let choose:(i:number)=>void=()=>{},done=false;g.showText=(_t,cb)=>cb?.();g.showMenuChoice=(_t,_labels,cb)=>{choose=cb;};
 g["learnEvolutionMoves"](mon,()=>{done=true;});choose(0);expect(mon.moves[0].id).toBe("CUT");expect(done).toBe(false);choose(4);expect(done).toBe(true);expect(mon.moves.some(m=>m.id==="BUBBLE")).toBe(false);
});
