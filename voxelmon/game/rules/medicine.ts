import type { PartyMon } from "../battle/mon.ts";

const HEAL: Record<string, number> = {
  POTION: 20, SUPER_POTION: 50, HYPER_POTION: 200,
  MAX_POTION: Infinity, FULL_RESTORE: Infinity,
};
const CURE: Record<string, string> = {
  ANTIDOTE: "PSN", PARLYZ_HEAL: "PAR", BURN_HEAL: "BRN",
  ICE_HEAL: "FRZ", AWAKENING: "SLP",
};
export function isMedicine(id: string): boolean {
  return id in HEAL || id in CURE || id === "FULL_HEAL";
}
/** Shared field/battle effect. No effect never consumes an item or revives. */
export function useMedicine(mon: PartyMon, id: string): boolean {
  if (mon.hp <= 0) return false;
  let used = false;
  if (id in HEAL && mon.hp < mon.stats.hp) {
    mon.hp = Math.min(mon.stats.hp, mon.hp + HEAL[id]); used = true;
  }
  if (mon.status && (CURE[id] === mon.status || id === "FULL_HEAL" || id === "FULL_RESTORE")) {
    mon.status = null; used = true;
  }
  return used;
}
