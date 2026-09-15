import type { VoxelmonData } from "../data.ts";
import { add, type BagSave } from "../rules/bag.ts";

export interface RewardSave extends BagSave { flags: Record<string, boolean> }
export type RewardResult = "granted" | "already" | "full";

/** Ownership is recorded only after inventory accepts the reward. */
export function grantItem(save: RewardSave, data: VoxelmonData, event: string, item: string): RewardResult {
  if (save.flags[event]) return "already";
  if (!add(save, item, 1, data)) return "full";
  save.flags[event] = true;
  return "granted";
}

export const GYM_REWARDS: Record<string, { badge: string; tm: string; event: string }> = {
  PEWTERGYM_BROCK: { badge: "BOULDERBADGE", tm: "TM_BIDE", event: "EVENT_GOT_TM34" },
  CERULEANGYM_MISTY: { badge: "CASCADEBADGE", tm: "TM_BUBBLEBEAM", event: "EVENT_GOT_TM11" },
  VERMILIONGYM_LT_SURGE: { badge: "THUNDERBADGE", tm: "TM_THUNDERBOLT", event: "EVENT_GOT_TM24" },
  CELADONGYM_ERIKA: { badge: "RAINBOWBADGE", tm: "TM_MEGA_DRAIN", event: "EVENT_GOT_TM21" },
  SAFFRONGYM_SABRINA: { badge: "MARSHBADGE", tm: "TM_PSYWAVE", event: "EVENT_GOT_TM46" },
};
