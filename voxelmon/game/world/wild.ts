// A bounded population of visible encounters. Only species/level and a small
// walking state live here; battle Pokémon are created on contact, as before.
import { ENTS_MAX } from "../../../contracts/spec/voxel-spec.ts";
import type { EncounterDef, EncounterSlot, VoxelmonData } from "../data.ts";
import { ENCOUNTER_BUCKETS, effectiveRate } from "../rules/encounter.ts";
import { seededRng, type Rng } from "../rng.ts";
import { canMove, DELTA, occupied, type Dir, type Mover, type TilePairs } from "./collision.ts";
import type { GameMap } from "./map.ts";

export const WILD_LIMIT = 4;
export const WILD_RADIUS = 5;
export const WILD_DESPAWN_RADIUS = 8;
const STEP_TICKS = 24;
const SPAWN_TICKS = 30;
const DIRS: readonly Dir[] = ["up", "down", "left", "right"];
type Habitat = "grass" | "water";

export class WildSprite implements Mover {
  active = false;
  species = "";
  level = 1;
  icon = "MON";
  habitat: Habitat = "grass";
  cellX = 0;
  cellY = 0;
  px = 0;
  py = 0;
  targetX?: number;
  targetY?: number;
  facing: Dir = "down";
  surfing = false;
  moving = false;
  progress = 0;
  timer = 0;
  animation = 0;
  get frame(): number { return Math.floor(this.animation / 16) % 2; }
}

/** Same ROM slot weights as step encounters, without rerolling the species
 * on contact. The rate gate belongs to the population's spawn clock. */
export function pickWild(table: NonNullable<EncounterDef["grass"]>, rng: Rng): EncounterSlot | null {
  const pick = rng.byte();
  const buckets = table.buckets ?? ENCOUNTER_BUCKETS;
  for (let i = 0; i < buckets.length; i++) {
    if (pick < buckets[i]) {
      const slot = table.slots[i];
      return slot ? { species: slot.species, level: slot.level } : null;
    }
  }
  return null;
}

export class WildPopulation {
  readonly slots = Array.from({ length: WILD_LIMIT }, () => new WildSprite());
  private clock = 0;
  private firstSpawn = true;
  // Separate from battle, encounter and NPC RNG: walking cannot reroll a
  // damage/accuracy roll or change the existing townspeople's wandering.
  constructor(readonly rng: Rng = seededRng(0x57494c44)) {}

  clear(): void {
    for (const wild of this.slots) { wild.active = false; wild.moving = false; }
    this.clock = 0;
    this.firstSpawn = true;
  }

  atCell(x: number, y: number): WildSprite | undefined {
    return this.slots.find(w => w.active && (
      (w.cellX === x && w.cellY === y) || (w.targetX === x && w.targetY === y)
    ));
  }

  consume(wild: WildSprite): EncounterSlot {
    wild.active = false;
    wild.moving = false;
    wild.targetX = wild.targetY = undefined;
    this.firstSpawn = false;
    this.clock = 180; // enough room to leave after running from a battle
    return { species: wild.species, level: wild.level };
  }

  habitatAt(data: VoxelmonData, map: GameMap, x: number, y: number): Habitat | null {
    if (!map.inBounds(x, y) || map.warpAtCell(x, y)) return null;
    // Keep stairs/doorways clear even when cave encounters cover all floor.
    for (const dir of DIRS) {
      const [dx, dy] = DELTA[dir];
      if (map.warpAtCell(x + dx, y + dy)) return null;
    }
    const enc = data.encounters[map.id];
    if (map.isWaterCell(x, y)) return enc?.water?.rate ? "water" : null;
    if (!map.isWalkableCell(x, y) || !enc?.grass?.rate) return null;
    if (map.isGrassCell(x, y)) return "grass";
    const indoor = data.field?.indoorEncounters as { firstIndoorMap: number; excludedTileset: string } | undefined;
    return indoor && map.def.index >= indoor.firstIndoorMap && map.def.tileset !== indoor.excludedTileset
      ? "grass" : null;
  }

  update(data: VoxelmonData, map: GameMap, player: Mover, entities: readonly Mover[], pairs?: TilePairs, reservedSlots = 0): void {
    if (!data.partyIcons) return;
    const limit = Math.max(0, Math.min(WILD_LIMIT, ENTS_MAX - entities.length - reservedSlots));
    for (let i = 0; i < this.slots.length; i++) {
      const wild = this.slots[i];
      if (!wild.active) continue;
      // A map swap can land between the population update and the renderer.
      // Never retain or draw a stale encounter outside the new map's cell
      // rectangle.
      if (!map.inBounds(wild.cellX, wild.cellY) ||
          (wild.targetX !== undefined && !map.inBounds(wild.targetX, wild.targetY!))) {
        wild.active = false;
        wild.moving = false;
        wild.targetX = wild.targetY = undefined;
        continue;
      }
      if (i >= limit || occupied(entities, wild.cellX, wild.cellY)) {
        wild.active = false;
        continue;
      }
      if (Math.max(Math.abs(wild.cellX - player.cellX), Math.abs(wild.cellY - player.cellY)) > WILD_DESPAWN_RADIUS) {
        wild.active = false;
        continue;
      }
      wild.animation = (wild.animation + 1) % 32;
      if (wild.moving) {
        wild.progress++;
        const [dx, dy] = DELTA[wild.facing];
        const pixels = Math.floor(wild.progress * 16 / STEP_TICKS);
        wild.px = wild.cellX * 16 + dx * pixels;
        wild.py = wild.cellY * 16 + dy * pixels;
        if (wild.progress >= STEP_TICKS) {
          wild.cellX = wild.targetX!;
          wild.cellY = wild.targetY!;
          wild.targetX = wild.targetY = undefined;
          wild.moving = false;
        }
        continue;
      }
      if (--wild.timer > 0) continue;
      wild.timer = 30 + this.rng.int(91);
      const dir = DIRS[this.rng.int(DIRS.length)];
      const [dx, dy] = DELTA[dir];
      const x = wild.cellX + dx, y = wild.cellY + dy;
      wild.facing = dir;
      // Keep idle populations near the view instead of letting all four
      // wander far away while still occupying the active slots.
      if (Math.max(Math.abs(x - player.cellX), Math.abs(y - player.cellY)) > WILD_RADIUS) continue;
      if (this.habitatAt(data, map, x, y) !== wild.habitat || this.atCell(x, y)) continue;
      if (!canMove(map, entities, wild, dir, pairs).ok) continue;
      wild.targetX = x; wild.targetY = y;
      wild.progress = 0; wild.moving = true;
    }
    if (--this.clock > 0) return;
    this.clock = SPAWN_TICKS;
    const free = this.slots.find((w, i) => i < limit && !w.active);
    if (!free) return;
    // Fixed effort, independent of map size. Sparse grass never means a
    // whole-map search or an unbounded spawn retry on PSP.
    for (let attempt = 0; attempt < 16; attempt++) {
      const x = player.cellX + this.rng.int(WILD_RADIUS * 2 + 1) - WILD_RADIUS;
      const y = player.cellY + this.rng.int(WILD_RADIUS * 2 + 1) - WILD_RADIUS;
      if (Math.max(Math.abs(x - player.cellX), Math.abs(y - player.cellY)) < 3) continue;
      const habitat = this.habitatAt(data, map, x, y);
      if (!habitat || (habitat === "water" && !player.surfing)) continue;
      if (occupied(entities, x, y) || this.atCell(x, y)) continue;
      const table = data.encounters[map.id]?.[habitat];
      if (!table || (!this.firstSpawn && this.rng.byte() >= effectiveRate(table.rate))) return;
      const slot = pickWild(table, this.rng);
      const icon = slot && data.pokemon[slot.species]?.partyIcon;
      if (!slot || !icon || data.partyIcons[icon] === undefined) return;
      free.species = slot.species; free.level = slot.level; free.icon = icon;
      free.habitat = habitat; free.surfing = habitat === "water";
      free.cellX = x; free.cellY = y; free.px = x * 16; free.py = y * 16;
      free.targetX = free.targetY = undefined;
      free.moving = false; free.progress = 0; free.timer = 30 + this.rng.int(91);
      free.animation = 0; free.facing = "down"; free.active = true;
      this.firstSpawn = false;
      return;
    }
  }
}
