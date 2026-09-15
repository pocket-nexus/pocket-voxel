import { describe, expect, test } from "bun:test";
import { ATLAS_KIND, VXPK_TAG, COLOR_PAL_NONE } from "../contracts/spec/voxel-spec.ts";
import { buildTerrainPage, swizzle } from "../voxelmon/cook/atlas.ts";
import { cookVoxelPak } from "../voxelmon/cook/core.ts";
import { GEN_DIR, genMissingReason, loadGen, loadRedpp } from "../voxelmon/cook/data-node.ts";
import { sheetKeyOf } from "../voxelmon/cook/data.ts";
import { Redpp, TILE_GROUP_EXCEPTIONS } from "../voxelmon/cook/redpp.ts";

const reason = genMissingReason(GEN_DIR);
if (reason) console.error(`terrain streaming tests skipped: ${reason}`);

describe.skipIf(reason !== null)("PC-prepared terrain streaming", () => {
  for (const color of [false, true]) {
    test(`local terrain pages preserve every animated texel (${color ? "color" : "plain"})`, () => {
      const gen = loadGen(GEN_DIR);
      const pack = color ? loadRedpp(GEN_DIR) : null;
      if (color && !pack) throw new Error("color streaming test requires the RED++ source pack");
      const redpp = pack ? new Redpp(pack) : null;
      const names = ["PALLET_TOWN", "ROUTE_1", "REDS_HOUSE_1F", "VIRIDIAN_POKECENTER", "VIRIDIAN_MART"];
      const tilesets = names.map(name => gen.tilesets[gen.maps[name].tileset]);
      const combined = buildTerrainPage(gen, tilesets, redpp);
      const { pak } = cookVoxelPak({ gen, profile: null, redpp: pack, mapNames: names, options: { treeBoxes: true } });
      const view = new DataView(pak.buffer, pak.byteOffset, pak.byteLength);
      const sections = new Map<number, number>();
      for (let i = 0; i < view.getUint16(6, true); i++) {
        const at = 16 + i * 16;
        sections.set(view.getUint32(at, true), view.getUint32(at + 4, true));
      }
      const atls = sections.get(VXPK_TAG.atlas)!;
      const vcol = sections.get(VXPK_TAG.color)!;
      const bindings = new Map<number, number>();
      for (let i = 0; i < names.length; i++) {
        const at = vcol + 16 + i * 8;
        bindings.set(view.getUint32(at, true), view.getUint16(at + 6, true));
        if (!color) expect(view.getUint16(at + 4, true)).toBe(COLOR_PAL_NONE);
      }
      expect(bindings.get(gen.maps.PALLET_TOWN.index)).toBe(bindings.get(gen.maps.ROUTE_1.index));
      // These share bitmap artwork but have different color-group rules.
      expect(bindings.get(gen.maps.VIRIDIAN_POKECENTER.index)).not.toBe(bindings.get(gen.maps.VIRIDIAN_MART.index));
      for (const name of names) {
        const ts = gen.tilesets[gen.maps[name].tileset];
        const local = buildTerrainPage(gen, [ts], redpp);
        const pageId = bindings.get(gen.maps[name].index)!;
        expect(pageId).toBeGreaterThan(0);
        const at = atls + 2 + pageId * 16;
        expect(view.getUint16(at, true)).toBe(local.page.w);
        expect(view.getUint16(at + 2, true)).toBe(local.page.h);
        expect(view.getUint16(at + 4, true)).toBe(ATLAS_KIND.terrain);
        expect(view.getUint16(at + 6, true)).toBe(local.page.frames.length);
        const dataAt = atls + view.getUint32(at + 8, true);
        const frameBytes = view.getUint32(at + 12, true);
        expect(frameBytes).toBeLessThan(combined.page.w * combined.page.h);
        for (let frame = 0; frame < local.page.frames.length; frame++) {
          expect(pak.slice(dataAt + frame * frameBytes, dataAt + (frame + 1) * frameBytes))
            .toEqual(new Uint8Array(swizzle(local.page.w, local.page.h, local.page.frames[frame])));
        }
        const key = sheetKeyOf(ts);
        const x0 = combined.baseX.get(`${key}#${ts.id}`) ?? combined.baseX.get(key)!;
        const y0 = combined.baseY.get(`${key}#${ts.id}`) ?? combined.baseY.get(key)!;
        for (let frame = 0; frame < combined.page.frames.length; frame++) {
          const original = combined.page.frames[frame];
          const prepared = local.page.frames[frame % local.page.frames.length];
          for (let y = 0; y < local.page.h; y++) {
            expect(prepared.subarray(y * local.page.w, (y + 1) * local.page.w))
              .toEqual(original.subarray((y0 + y) * combined.page.w + x0, (y0 + y) * combined.page.w + x0 + local.page.w));
          }
        }
      }
    }, 120000);
  }
});


test.skipIf(reason !== null)("Celadon terrain variants bake map-specific color groups on the PC", () => {
  const gen = loadGen(GEN_DIR), pack = loadRedpp(GEN_DIR)!;
  const redpp = new Redpp(pack);
  for (const [id, exception] of Object.entries(TILE_GROUP_EXCEPTIONS)) {
    const ts = gen.tilesets[gen.maps[id].tileset];
    const layout = buildTerrainPage(gen, [ts], redpp, id);
    const key = sheetKeyOf(ts);
    const x0 = layout.baseX.get(key)!, y0 = layout.baseY.get(key)!;
    let checked = 0;
    for (const tile of exception.tiles) for (const frame of layout.page.frames) {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const px = frame[(y0 + Math.floor(tile / ts.tilesPerRow) * 8 + y) * layout.page.w + x0 + (tile % ts.tilesPerRow) * 8 + x];
        if (px === 255) continue;
        expect(px >> 2).toBe(exception.group); checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  }
});
