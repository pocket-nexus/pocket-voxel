import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rasterizeVoxelIcon } from './ios-artwork.ts';

/** Native-size lower-screen plate and independently sampled SMDH icons. */
export async function build3dsArtwork(root: string, output: string) {
  mkdirSync(output, { recursive: true });
  GlobalFonts.registerFromPath(join(root, 'vendor/pocketjs/assets/fonts/Inter-Regular.ttf'), 'Pocket Inter');
  const canvas = createCanvas(320, 240);
  const ctx = canvas.getContext('2d');
  const background = ctx.createLinearGradient(0, 0, 0, 240);
  background.addColorStop(0, '#edf1f6');
  background.addColorStop(1, '#d7dfe9');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, 320, 240);
  const logo = await loadImage(join(root, 'vendor/pocketjs/hosts/3ds/icon.png'));
  ctx.drawImage(logo, 136, 38, 48, 48);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#26364b';
  ctx.font = '22px "Pocket Inter"';
  ctx.fillText('PocketJS', 160, 116);
  ctx.fillStyle = '#66768a';
  ctx.font = '12px "Pocket Inter"';
  ctx.fillText('Pocket Voxel', 160, 138);
  ctx.fillStyle = '#bbc6d4';
  ctx.fillRect(48, 161, 224, 1);
  ctx.fillStyle = '#526379';
  ctx.font = '11px "Pocket Inter"';
  ctx.fillText('D-pad / Circle Pad: move', 160, 183);
  ctx.fillText('A: confirm     B: back     Start: menu', 160, 201);
  ctx.fillStyle = '#7d8a9b';
  ctx.font = '10px "Pocket Inter"';
  ctx.fillText('L + R + START: Homebrew Launcher', 160, 224);
  writeFileSync(join(output, 'bottom.png'), canvas.toBuffer('image/png'));
  const pixels = ctx.getImageData(0, 0, 320, 240).data;
  const bgr = Buffer.alloc(320 * 240 * 3);
  for (let y = 0; y < 240; y++) for (let x = 0; x < 320; x++) {
    const src = (y * 320 + x) * 4;
    const dst = (x * 240 + 239 - y) * 3;
    bgr[dst] = pixels[src + 2];
    bgr[dst + 1] = pixels[src + 1];
    bgr[dst + 2] = pixels[src];
  }
  writeFileSync(join(output, 'bottom.bgr'), bgr);
  for (const size of [24, 48]) {
    const icon = await rasterizeVoxelIcon(size, true);
    writeFileSync(join(output, `icon-${size}.png`), icon.toBuffer('image/png'));
  }
}
