// voxelmon/cook/atlas.ts — CLUT8 atlas pages + palettes.
//
// Pages are pre-swizzled (16-byte x 8-row blocks, engine pak.rs
// swizzle_stride/swizzle_rows — mirrored byte-for-byte from
// pocketvoxel-core/src/pak/builder.rs swizzle()). Palettes: one per
// ATLAS_KIND; entries 0..3 are the GB shades, 0xff transparent, rest black.
//
// TERRAIN is ONE combined page: every tileset sheet the cooked maps use,
// stacked vertically — the core binds `page_of_kind(TERRAIN)` for every
// chunk mesh (draw.rs), so all chunk UVs must live in one page. Animated
// tilesets bake the full 8-step water/flower cycle as whole-page frame
// variants (gen1recomp TileRenderer.lua:74-92): water tile rows rotate by
// WATER_OFFSETS per step, the flower tile cycles flower1-3.

import followerDirections from "./follower-directions.json";
import { ATLAS_KIND } from "../../contracts/spec/voxel-spec.ts";
import { ANIM_STEPS, FLOWER_FRAMES, WATER_OFFSETS, defaultAnimatedTiles } from "./classify.ts";
import { type Art, artOf, type GenData, PX_CLEAR, sheetKeyOf, type TilesetDef } from "./data.ts";
import { type Redpp, SHADES } from "./redpp.ts";

// ---------------------------------------------------------------------------
// swizzle (builder.rs:27 — the exact transform the reader inverts)
// ---------------------------------------------------------------------------

export const swizzleStride = (w: number): number => Math.ceil(w / 16) * 16;
export const swizzleRows = (h: number): number => Math.ceil(h / 8) * 8;
export const swizzledLen = (w: number, h: number): number => swizzleStride(w) * swizzleRows(h);

export function swizzle(w: number, h: number, linear: Uint8Array): Uint8Array {
  if (linear.length !== w * h) throw new Error("linear texel size mismatch");
  const stride = swizzleStride(w);
  const rows = swizzleRows(h);
  const out = new Uint8Array(stride * rows);
  let dst = 0;
  for (let blockY = 0; blockY < rows / 8; blockY++) {
    for (let blockX = 0; blockX < stride / 16; blockX++) {
      for (let row = 0; row < 8; row++) {
        const y = blockY * 8 + row;
        for (let column = 0; column < 16; column++) {
          const x = blockX * 16 + column;
          if (x < w && y < h) out[dst + column] = linear[y * w + x];
        }
        dst += 16;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// palettes
// ---------------------------------------------------------------------------

/** GB shade -> opaque ABGR gray (0 lightest). */
const SHADE_ABGR = [0xffffffff, 0xffaaaaaa, 0xff555555, 0xff000000];

export function gbPalette(): Uint32Array {
  const pal = new Uint32Array(256).fill(0xff000000);
  for (let i = 0; i < 4; i++) pal[i] = SHADE_ABGR[i];
  pal[PX_CLEAR] = 0x00000000; // transparent
  return pal;
}

/** One SGB SuperPalette as a 256-entry CLUT: entries 0..3 are its 4 colors
 * (palettes.json stores lightest first, so color i lands on GB shade i),
 * PX_CLEAR transparent, the rest black — the gbPalette shape recolored. */
export function sgbPalette(rgb: [number, number, number][]): Uint32Array {
  const pal = new Uint32Array(256).fill(0xff000000);
  for (let i = 0; i < 4; i++) {
    const [r, g, b] = rgb[i];
    pal[i] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
  }
  pal[PX_CLEAR] = 0x00000000; // transparent
  return pal;
}

/**
 * The VPAL list (voxel-spec.ts §VXPK_TAG.palette): one GB grayscale default
 * per ATLAS_KIND, then every SGB SuperPalette in the ROM's own order — the
 * `palette` op's index i selects VPAL[4 + i], and gamedata's `mapPalette`
 * values index the same order. That PREFIX is a compatibility guarantee:
 * `draw::SGB_PAL_BASE` is 4 and the `mapPalette` contract stays valid
 * whatever the tail carries.
 *
 * `extra` appends the RED++ color CLUTs (world, OBJ, pic — cook/redpp.ts),
 * whose absolute VPAL indices the VCOL section names; the base length is
 * what turns a tail position into that index.
 */
export function buildPalettes(gen: GenData, extra: Uint32Array[] = []): Uint32Array[] {
  const defaults = Object.keys(ATLAS_KIND).map(() => gbPalette());
  const sgb = gen.palettes.order.map((name) => {
    const rgb = gen.palettes.palettes[name];
    if (!rgb) throw new Error(`palettes.json order names a missing palette: ${name}`);
    return sgbPalette(rgb);
  });
  return [...defaults, ...sgb, ...extra];
}

/** The VPAL index the RED++ tail starts at (= 4 kind defaults + the SGB set). */
export function paletteBase(gen: GenData): number {
  return Object.keys(ATLAS_KIND).length + gen.palettes.order.length;
}

// ---------------------------------------------------------------------------
// pages
// ---------------------------------------------------------------------------

export interface PageDef {
  w: number;
  h: number;
  kind: number;
  /** LINEAR frames (swizzled at pack time). */
  frames: Uint8Array[];
  /** Debug name (not packed). */
  name: string;
}

export interface TerrainLayout {
  page: PageDef;
  /** Sheet variant -> x/y offset inside the hardware-sized combined page. */
  baseX: Map<string, number>;
  baseY: Map<string, number>;
  /**
   * Sheet gfx keys whose texels carry RED++ group indices (`group*4+shade`)
   * instead of raw GB shades. A map drawn from one of these MUST bind a
   * world palette (cook/redpp.ts); a sheet the pack has no data for stays
   * byte-identical to a cook without the pack.
   */
  bakedSheets: Set<string>;
}

function blitArt(dst: Uint8Array, dstW: number, art: Art, dx: number, dy: number): void {
  for (let y = 0; y < art.h; y++) {
    for (let x = 0; x < art.w; x++) {
      dst[(dy + y) * dstW + (dx + x)] = art.px(x, y);
    }
  }
}

/**
 * The combined terrain page over the tilesets the cooked maps use.
 *
 * With a RED++ pack, every tile's texels are rewritten to `group*4+shade`
 * AFTER the water-rotate / flower-frame substitutions, so an animated tile
 * picks up its DESTINATION tile's group — matching the reference, whose
 * `buildAnim` recolors through the same `gbc` context
 * (gen1recomp TileRenderer.lua:343-353).
 */
export function buildTerrainPage(
  gen: GenData,
  tilesets: TilesetDef[],
  redpp?: Redpp | null,
  mapId: string | null = null,
): TerrainLayout {
  // Distinct sheet variants, sorted for determinism. RED++ occasionally
  // assigns different tile-group vectors to tilesets that share one bitmap
  // (POKECENTER/MART and GATE/FOREST_GATE). Give those variants independent
  // vertical copies; the PSP streams the one terrain page, so this is a
  // storage trade rather than a resident-memory allocation.
  const bySheet = new Map<string, TilesetDef[]>();
  for (const ts of tilesets) {
    const key = sheetKeyOf(ts);
    const list = bySheet.get(key) ?? [];
    if (!list.some((row) => row.id === ts.id)) list.push(ts);
    bySheet.set(key, list);
  }
  const sheets: { key: string; variant: string; ts: TilesetDef }[] = [];
  for (const key of [...bySheet.keys()].sort()) {
    const list = bySheet.get(key)!;
    // Always split a shared bitmap by tileset. Keeping the plain and RED++
    // layouts identical makes palette baking a texel-value transform only,
    // and avoids making UVs depend on whether a color pack was supplied.
    if (list.length > 1) {
      for (const ts of [...list].sort((a, b) => a.id.localeCompare(b.id))) {
        sheets.push({ key, variant: `${key}#${ts.id}`, ts });
      }
    } else {
      sheets.push({ key, variant: key, ts: list[0] });
    }
  }
  // PSP textures are limited to 512x512. Pack the 128px-wide sheets into
  // columns instead of letting the combined terrain page grow vertically
  // past that boundary (which the GE displays as repeated atlas grids).
  const totalH = sheets.reduce((sum, sheet) => {
    const e = gen.gfx[sheet.key];
    if (!e) throw new Error(`missing tileset sheet: ${sheet.key}`);
    return sum + e.h;
  }, 0);
  const columns = Math.max(1, Math.ceil(totalH / 512));
  const w = columns * 128;
  if (w > 512) throw new Error(`terrain atlas needs ${columns} columns (${w}px), over PSP limit`);
  const heights = new Array<number>(columns).fill(0);
  const baseX = new Map<string, number>();
  const baseY = new Map<string, number>();
  for (const sheet of sheets) {
    const e = gen.gfx[sheet.key];
    if (!e) throw new Error(`missing tileset sheet: ${sheet.key}`);
    let column = 0;
    for (let i = 1; i < columns; i++) if (heights[i] < heights[column]) column = i;
    baseX.set(sheet.variant, column * 128);
    baseY.set(sheet.variant, heights[column]);
    heights[column] += e.h;
  }
  const h = Math.max(...heights);
  if (h > 512) throw new Error(`terrain atlas column is ${h}px high, over PSP limit`);

  // which sheets animate (any using tileset declares water/flower cycles)
  const animated = new Map<string, TilesetDef>();
  for (const ts of tilesets) {
    const key = sheetKeyOf(ts);
    const variant = baseY.has(`${key}#${ts.id}`) ? `${key}#${ts.id}` : key;
    if (defaultAnimatedTiles(ts.animation).length > 0) animated.set(variant, ts);
  }
  const frameCount = animated.size > 0 ? ANIM_STEPS : 1;

  const frames: Uint8Array[] = [];
  for (let step = 0; step < frameCount; step++) {
    const linear = new Uint8Array(w * h).fill(PX_CLEAR);
    for (const sheet of sheets) {
      const art = artOf(gen, sheet.key)!;
      const x0 = baseX.get(sheet.variant)!;
      const y0 = baseY.get(sheet.variant)!;
      blitArt(linear, w, art, x0, y0);
      const ts = animated.get(sheet.variant);
      if (!ts) continue;
      const perRow = ts.tilesPerRow || 16;
      for (const spec of defaultAnimatedTiles(ts.animation)) {
        const tx = (spec.tile % perRow) * 8 + x0;
        const ty = Math.floor(spec.tile / perRow) * 8 + y0;
        if (spec.kind === "hshift") {
          // rotate the tile's rows right by the step's cumulative offset
          // (TileRenderer.lua:201-208: setPixel((x + o) % 8, y, src[x]))
          const o = WATER_OFFSETS[step % WATER_OFFSETS.length];
          for (let yy = 0; yy < 8; yy++) {
            for (let xx = 0; xx < 8; xx++) {
              linear[(ty + yy) * w + tx + ((xx + o) % 8)] = art.px(tx - x0 + xx, ty - y0 + yy);
            }
          }
        } else {
          const n = FLOWER_FRAMES[step % FLOWER_FRAMES.length];
          const frame = artOf(gen, `tilesets/flower${n}`);
          if (frame) {
            for (let yy = 0; yy < 8; yy++) {
              for (let xx = 0; xx < 8; xx++) {
                linear[(ty + yy) * w + tx + xx] = frame.px(xx, yy);
              }
            }
          }
        }
      }
    }
    frames.push(linear);
  }

  const bakedSheets = bakeGroups(gen, tilesets, redpp, frames, w, baseX, baseY, mapId);

  return {
    page: { w, h, kind: ATLAS_KIND.terrain, frames, name: "terrain" },
    baseX,
    baseY,
    bakedSheets,
  };
}

/**
 * Rewrite every tile region's texels from a GB shade to `group*4+shade`.
 * `PX_CLEAR` survives untouched (it is the alpha-test cutout, not a shade).
 *
 * v1 keeps ONE terrain page, so two tilesets sharing a sheet must agree
 * tile-for-tile: measured 0 of the 4 v1 sheets disagree (2 of 19 whole-game
 * — `gate.png`, `pokecenter.png`). A disagreement is a hard cook error, not
 * a silent mis-bake; the VCOL record reserves a `terrain_page` field so the
 * page splitter can land later without a format change.
 */
function bakeGroups(
  gen: GenData,
  tilesets: TilesetDef[],
  redpp: Redpp | null | undefined,
  frames: Uint8Array[],
  w: number,
  baseX: Map<string, number>,
  baseY: Map<string, number>,
  mapId: string | null,
): Set<string> {
  const baked = new Set<string>();
  if (!redpp) return baked;

  const bySheet = new Map<string, TilesetDef[]>();
  for (const ts of tilesets) {
    const key = sheetKeyOf(ts);
    const list = bySheet.get(key);
    if (list) {
      if (!list.some((t) => t.id === ts.id)) list.push(ts);
    } else {
      bySheet.set(key, [ts]);
    }
  }

  for (const [key, list] of bySheet) {
    const known = list.filter((ts) => redpp.hasTileset(ts.id));
    if (known.length === 0) continue; // a tileset the pack has no data for
    if (known.length !== list.length) {
      const missing = list.filter((ts) => !redpp.hasTileset(ts.id)).map((t) => t.id);
      throw new Error(
        `RED++ color: sheet ${key} mixes tilesets with and without pack data ` +
          `(missing: ${missing.join(", ")}) — split the page or extend the pack`,
      );
    }
    const e = gen.gfx[key];
    if (!e) throw new Error(`missing tileset sheet: ${key}`);
    const split = baseY.has(`${key}#${known[0].id}`);
    const variants = split ? known : [known[0]];
    for (const ts of variants) {
      const variant = split ? `${key}#${ts.id}` : key;
      const x0 = baseX.get(variant)!;
      const y0 = baseY.get(variant)!;
      const perRow = ts.tilesPerRow || 16;
      const cols = Math.floor(e.w / 8);
      const rows = Math.floor(e.h / 8);
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const tileId = row * perRow + col;
          const group = redpp.groupOf(ts.id, mapId, tileId);
          if (group === null) continue;
          const shift = group * SHADES;
          for (const frame of frames) {
            for (let y = 0; y < 8; y++) {
              const dst = (y0 + row * 8 + y) * w + x0 + col * 8;
              for (let x = 0; x < 8; x++) {
                const px = frame[dst + x];
                if (px === PX_CLEAR) continue;
                frame[dst + x] = shift + (px & 3);
              }
            }
          }
        }
      }
    }
    baked.add(key);
  }
  return baked;
}

/**
 * One sprite page per walk sheet (16x16 cells stacked vertically), padded to
 * 64 px wide: the GE missamples 16-px-wide pages (bisected on device and
 * under PPSSPPHeadless — a 128-wide page through the same card draw renders
 * perfectly). Content stays at x in [0, 16); draw.rs normalizes card U by
 * CELL_PX / page.w, so the pad is never sampled.
 */
export const SPRITE_PAGE_W = 64;
export function buildSpritePage(gen: GenData, key: string): PageDef {
  const art = artOf(gen, key);
  if (!art) throw new Error(`missing sprite sheet: ${key}`);
  const w = Math.max(art.w, SPRITE_PAGE_W);
  const linear = new Uint8Array(w * art.h).fill(PX_CLEAR);
  for (let y = 0; y < art.h; y++)
    for (let x = 0; x < art.w; x++) linear[y * w + x] = art.px(x, y);
  return { w, h: art.h, kind: ATLAS_KIND.sprites, frames: [linear], name: key };
}

/** Shared party-icon companions. Keep both original front poses verbatim;
 * original walk sheets supply directions where available. */
export function buildFollowerPage(gen: GenData, icon: string): PageDef {
  const front = artOf(gen, `icons/party_${icon}`);
  if (!front) throw new Error(`missing party icon: ${icon}`);
  const originals: Record<string, string> = { MON: "monster", FAIRY: "fairy", BIRD: "bird", WATER: "seel" };
  const original = originals[icon] && artOf(gen, `sprites/${originals[icon]}`);
  const directions = (followerDirections as Record<string, string[][]>)[icon];
  const pixels = new Uint8Array(SPRITE_PAGE_W * 96).fill(PX_CLEAR);
  for (let frame = 0; frame < 6; frame++) for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    let value: number;
    if (frame === 0 || frame === 3) value = front.px(x, y + (frame === 3 ? 16 : 0));
    else if (original) value = original.px(x, frame * 16 + y);
    else {
      const row = frame === 1 ? 0 : frame === 2 ? 1 : frame === 4 ? 2 : 3;
      const shade = directions?.[row]?.[y]?.[x];
      if (shade === undefined) throw new Error(`missing ${icon} direction ${frame}`);
      value = shade === "." ? PX_CLEAR : Number(shade);
    }
    pixels[(frame * 16 + y) * SPRITE_PAGE_W + x] = value;
  }
  return { w: SPRITE_PAGE_W, h: 96, kind: ATLAS_KIND.sprites, frames: [pixels], name: `follower/${icon}` };
}

/** The emote page: gen's 48x16 horizontal strip restacked 16x48 vertical
 *  (the core's sheet_uv stacks 16x16 cells vertically). */
export function buildEmotePage(gen: GenData): PageDef | null {
  const art = artOf(gen, "emotes");
  if (!art) return null;
  const cells = Math.floor(art.w / 16);
  // Same 64-wide pad as buildSpritePage (the GE missamples 16-px pages).
  const linear = new Uint8Array(SPRITE_PAGE_W * cells * 16).fill(PX_CLEAR);
  for (let i = 0; i < cells; i++) {
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        linear[(i * 16 + y) * SPRITE_PAGE_W + x] = art.px(i * 16 + x, y);
      }
    }
  }
  return {
    w: SPRITE_PAGE_W,
    h: cells * 16,
    kind: ATLAS_KIND.sprites,
    frames: [linear],
    name: "emotes",
  };
}

/**
 * The UI page: ONE 128x128 page, tile id = GB tile code (SCHEMA.md §UI):
 * font_extra tiles at extraBase (0x60..0x7f), font glyphs at mainBase
 * (0x80..0xff), 16 tiles per row, 8x8 tiles, tile 0 transparent.
 */
export function buildUiPage(gen: GenData): PageDef {
  const w = 128;
  const h = 128; // 256 tiles / 16 per row * 8 px
  const linear = new Uint8Array(w * h).fill(PX_CLEAR);
  const place = (art: Art, base: number): void => {
    // Source rows are the sheet's own width in tiles (font sheets are 16
    // wide, the battle HUD pages 15 and 3).
    const glyphsPerRow = Math.floor(art.w / 8);
    const count = Math.floor(art.w / 8) * Math.floor(art.h / 8);
    for (let g = 0; g < count; g++) {
      const sx = (g % glyphsPerRow) * 8;
      const sy = Math.floor(g / glyphsPerRow) * 8;
      const tile = base + g;
      if (tile > 0xff) break;
      const dx = (tile % 16) * 8;
      const dy = Math.floor(tile / 16) * 8;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          // GB UI tiles are opaque white-backed (the textbox interior must
          // cover the world); only the unset tile 0 stays transparent.
          const px = art.px(sx + x, sy + y);
          linear[(dy + y) * w + dx + x] = px === PX_CLEAR ? 0 : px;
        }
      }
    }
  };
  const extra = artOf(gen, "fonts/font_extra");
  if (extra) place(extra, gen.font.extraBase);
  const font = artOf(gen, "fonts/font");
  if (font) place(font, gen.font.mainBase);
  // The in-battle HUD overlay (gen1recomp HudTiles.lua PAGES): pokered
  // overlays the $62-$78 font area — font_battle_extra at $62, then the
  // three HUD line pages on top of its tail ($6D/$73/$76). The textbox
  // borders at $79-$7F survive; battle and overworld share one UI page.
  for (const [key, base] of [
    ["battle/font_battle_extra", 0x62],
    ["battle/battle_hud_1", 0x6d],
    ["battle/battle_hud_2", 0x73],
    ["battle/battle_hud_3", 0x76],
  ] as const) {
    const sheet = artOf(gen, key);
    if (sheet) place(sheet, base);
  }
  return { w, h, kind: ATLAS_KIND.ui, frames: [linear], name: "ui" };
}

/** One pics page per battle pic gfx key. */
export function buildPicPage(gen: GenData, key: string): PageDef {
  const art = artOf(gen, key);
  if (!art) throw new Error(`missing pic: ${key}`);
  const linear = new Uint8Array(art.w * art.h);
  blitArt(linear, art.w, art, 0, 0);
  return { w: art.w, h: art.h, kind: ATLAS_KIND.pics, frames: [linear], name: key };
}
