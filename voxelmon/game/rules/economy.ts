// Pokémon Red's money rules. Monetary values are stored in three packed-BCD
// bytes in the ROM/save, so the playable range is ¥0..¥999,999.

import type { ItemDef, TrainerClass } from "../data.ts";

export const STARTING_MONEY = 3000;
export const MAX_MONEY = 999999;

export function clampMoney(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_MONEY, Math.floor(value)));
}

/** BeatTrainer: class base money multiplied by the final party member's level. */
export function trainerPayout(
  trainer: Pick<TrainerClass, "baseMoney"> | null | undefined,
  party: readonly { level: number }[],
): number {
  const last = party[party.length - 1];
  if (!trainer || !last) return 0;
  return clampMoney(trainer.baseMoney * last.level);
}

/** ResetStatusAndHalveMoneyOnBlackout: discard the odd Pokédollar. */
export function moneyAfterBlackout(money: number): number {
  return Math.floor(clampMoney(money) / 2);
}

/** Poké Mart selling price is half the ROM purchase price, rounded down. */
export function sellPrice(item: Pick<ItemDef, "price">): number {
  return Math.floor(clampMoney(item.price) / 2);
}
