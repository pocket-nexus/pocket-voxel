// Original Red party-menu icons: MonPartyData and AnimatePartyMon.
// Some icons reuse overworld sheets; the others mirror a ROM half-sprite.
import { check, type Ctx } from "../ctx.ts";
import { blit, decode2bpp, GfxImage } from "../gfx.ts";

export function partyIconsBySpecies(ctx: Ctx): Record<string, string> {
  const table = ctx.symbol("MonPartyData");
  const packed = ctx.rom.bytes(table.bank, table.address, Math.ceil(ctx.manifest.dexOrder.length / 2));
  const result: Record<string, string> = {};
  ctx.manifest.dexOrder.forEach((species, i) => {
    const value = i % 2 === 0 ? packed[i >> 1] >> 4 : packed[i >> 1] & 15;
    const icon = ctx.manifest.iconOrder[value];
    check(icon, `missing party icon ${value} for ${species}`);
    result[species] = icon;
  });
  return result;
}

export function extractPartyIconGraphics(ctx: Ctx): void {
  const sheets: Record<string, [string, number, number]> = {
    MON: ["monster", 3, 0], BALL: ["poke_ball", 0, 0],
    HELIX: ["fossil", 0, 0], FAIRY: ["fairy", 3, 0],
    BIRD: ["bird", 3, 0], WATER: ["seel", 0, 3],
  };
  const halves: Record<string, [string, number, number]> = {
    BUG: ["Bug", 2, 1], GRASS: ["Plant", 2, 1],
    SNAKE: ["Snake", 1, 2], QUADRUPED: ["Quadruped", 1, 2],
  };
  // Take one snapshot before appending icons; all reused sheets were decoded
  // by extractSprites, and the large battle pictures have not been loaded.
  const pixels = ctx.gfx.bytes();
  for (const icon of ctx.manifest.iconOrder) {
    const image = new GfxImage(16, 32);
    for (let frame = 0; frame < 2; frame++) {
      let source: GfxImage;
      let y = 0;
      const half = halves[icon];
      if (half) {
        const label = `${half[0]}IconFrame${half[frame + 1]}`;
        const symbol = ctx.symbol(label);
        source = decode2bpp(ctx.rom.bytes(symbol.bank, symbol.address, 32), 8, 16, true);
      } else {
        const sheet = sheets[icon];
        check(sheet, `unsupported party icon ${icon}`);
        const entry = ctx.gfx.directory[`sprites/${sheet[0]}`];
        check(entry, `missing party sprite sheet ${sheet[0]}`);
        source = new GfxImage(entry.w, entry.h);
        source.px.set(pixels.subarray(entry.off, entry.off + entry.w * entry.h));
        y = Number(sheet[frame + 1]) * 16;
      }
      // The menu mirrors the left half of every built-in icon but HELIX.
      blit(image, source, 0, frame * 16, 0, y, icon === "HELIX" ? 16 : 8, 16);
      if (icon !== "HELIX") blit(image, source, 8, frame * 16, 0, y, 8, 16, true);
    }
    ctx.gfx.add(`icons/party_${icon}`, image);
  }
}
