import { readFileSync } from 'node:fs';
import { rasterizeIconSvg } from '../vendor/pocketjs/tools/icon-raster.ts';

/**
 * The Pocket Voxel mark with its transparent corners: the launch image, the
 * in-app popup, and the icon of the iPhone 4S System app. The iPod touch 4
 * icon is the Pocket3D app icon, which tools/iphone4s.ts copies from PocketJS.
 */
export async function rasterizeVoxelIcon(size: number) {
  const svg = readFileSync(new URL('../web/favicon.svg', import.meta.url), 'utf8')
    .replace('<svg ', '<svg width="32" height="32" ');
  return rasterizeIconSvg(svg, size, size, false);
}
