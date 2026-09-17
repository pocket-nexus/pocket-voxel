import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
function mustRun(command: string, args: string[]) {
  const result = Bun.spawnSync([command, ...args]);
  if (result.exitCode) throw new Error(result.stderr.toString());
}

export function bakeControlTextures(ROOT: string, BUILD_ROOT: string): Record<string, string> {
  const motions = join(ROOT, 'vendor/pocketjs/apps/motions');
  const font = join(ROOT, 'vendor/pocketjs/assets/fonts/InterDisplay-Bold.ttf');
  const output = (name: string) => join(BUILD_ROOT, `${name}.rgba`);
  if (!existsSync(join(motions, 'letter-a.svg')) || !existsSync(join(motions, 'letter-b.svg'))) {
    throw new Error('PocketJS Motion Lab baked-letter references are missing');
  }
  const bakeLabel = (name: string, label: string, width: number, height: number, pointSize: number, color = '#f1f1f1') => {
    const path = output(name);
    mustRun('magick', [
      '-size', `${width}x${height}`, 'xc:none', '-font', font, '-pointsize', String(pointSize),
      '-fill', color, '-gravity', 'center', '-annotate', '+0+0', label,
      '-depth', '8', `RGBA:${path}`,
    ]);
    if (readFileSync(path).byteLength !== width * height * 4) throw new Error(`${name} texture has the wrong size`);
    return path;
  };
  const bakeImage = (name: string, source: string, width: number, height: number) => {
    const path = output(name);
    mustRun('magick', [
      '-background', 'none', '-density', '768', source, '-colorspace', 'sRGB',
      '-filter', 'Lanczos', '-resize', `${width}x${height}!`,
      '-depth', '8', `RGBA:${path}`,
    ]);
    if (readFileSync(path).byteLength !== width * height * 4) throw new Error(`${name} texture has the wrong size`);
    return path;
  };
  const dpadSource = join(ROOT, 'host/iphone4s/dpad.svg');
  const bakeDpad = (name: string, perspective?: string) => {
    const path = output(name);
    const args = ['-background', 'none', dpadSource, '-alpha', 'on', '-resize', '256x256!'];
    if (perspective) {
      args.push(
        '-define', 'distort:viewport=256x256+0+0', '-virtual-pixel', 'transparent',
        '-distort', 'Perspective', perspective,
      );
    }
    args.push('-depth', '8', `RGBA:${path}`);
    mustRun('magick', args);
    if (readFileSync(path).byteLength !== 256 * 256 * 4) throw new Error(`${name} texture has the wrong size`);
    return path;
  };
  return {
    POCKETVOXEL_LETTER_A: bakeLabel('letter-a', 'A', 64, 64, 52),
    POCKETVOXEL_LETTER_B: bakeLabel('letter-b', 'B', 64, 64, 52),
    POCKETVOXEL_SELECT_LABEL: bakeLabel('select-label', 'SELECT', 80, 24, 16),
    POCKETVOXEL_START_LABEL: bakeLabel('start-label', 'START', 80, 24, 16),
    POCKETVOXEL_MOTION_CREDIT: bakeLabel('motion-credit', '(yui540)', 96, 18, 13),
    POCKETVOXEL_MENU_LABEL: bakeLabel('menu-label', 'MENU', 80, 24, 16),
    POCKETVOXEL_POPUP_TITLE: bakeLabel('popup-title', 'POCKET VOXEL', 360, 52, 34),
    POCKETVOXEL_POPUP_SUBTITLE: bakeLabel('popup-subtitle', 'A WORLD IN YOUR POCKET', 320, 30, 17, '#514557'),
    POCKETVOXEL_POPUP_CREDIT: bakeLabel('popup-credit', 'MOTION STUDIES BY yui540', 320, 30, 16, '#514557'),
    POCKETVOXEL_DONE_LABEL: bakeLabel('done-label', 'DONE', 96, 28, 18),
    POCKETVOXEL_POPUP_ICON: bakeImage('popup-icon', join(BUILD_ROOT, 'voxel-mark.png'), 112, 112),
    POCKETVOXEL_DPAD_IDLE: bakeDpad('dpad-idle'),
    POCKETVOXEL_DPAD_UP: bakeDpad('dpad-up', '0,0 6,7 255,0 249,7 0,255 0,252 255,255 255,252'),
    POCKETVOXEL_DPAD_RIGHT: bakeDpad('dpad-right', '0,0 4,0 255,0 248,6 0,255 4,255 255,255 248,249'),
    POCKETVOXEL_DPAD_DOWN: bakeDpad('dpad-down', '0,0 0,4 255,0 255,4 0,255 6,248 255,255 249,248'),
    POCKETVOXEL_DPAD_LEFT: bakeDpad('dpad-left', '0,0 7,6 255,0 252,0 0,255 7,249 255,255 252,255'),
  };
}
