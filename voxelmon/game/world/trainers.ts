import type { MapDef, VoxelmonData } from "../data.ts";

export interface TrainerHeader {
  event: string;
  range: number;
  battle?: string;
  won?: string;
  after?: string;
}

/** Imported Lua tables are arrays when dense, numeric-key objects when
 * sparse (for example gyms whose leader occupies object slot 1). */
export function trainerHeader(data: VoxelmonData, map: MapDef, objectIndex: number): TrainerHeader | undefined {
  const table = data.trainer_headers?.[map.label] as
    | TrainerHeader[] | Record<string, TrainerHeader> | undefined;
  const header = Array.isArray(table) ? table[objectIndex - 1] : table?.[String(objectIndex)];
  return header && typeof header.event === "string" && Number.isFinite(header.range)
    ? header : undefined;
}
