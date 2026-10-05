import { expect, test } from 'bun:test';
import { rasterizeVoxelIcon } from '../tools/ios-artwork.ts';

// The mark is the launch image, the in-app popup and the iPhone 4S icon. The
// iPod touch 4 icon is the Pocket3D app icon (tests/pocket3d-icon.test.ts).
test('iOS artwork preserves the metallic mark and its transparent corner mask', async () => {
  for (const size of [57, 114]) {
    const canvas = await rasterizeVoxelIcon(size);
    const pixels = canvas.getContext('2d').getImageData(0, 0, size, size).data;
    expect(pixels[3]).toBe(0);
    // The original ImageMagick SVG path silently lost the gradient stroke.
    const edge = (Math.floor(size / 2) * size + Math.round(size * 2 / 32)) * 4;
    expect(pixels[edge]).toBeGreaterThan(100);
    expect(pixels[edge + 3]).toBe(255);
  }
});
