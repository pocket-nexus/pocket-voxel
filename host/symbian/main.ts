import "../../voxelmon/game/psp-main.ts";
import { Controls } from "./input.ts";

const runtime = globalThis as unknown as {
  frame: (buttons: number, analog?: number, touches?: number[]) => void;
  __pocketResizeViewport: (width: number, height: number) => void;
  ui: { __viewport: { w: number; h: number } };
  voxel: { nativeButtons(): number; buttons(mask: number): void };
};
const gameFrame = runtime.frame;
const controls = new Controls();
let viewport = runtime.ui.__viewport;
runtime.__pocketResizeViewport = (w, h) => { viewport = { w, h }; runtime.ui.__viewport = viewport; };
runtime.frame = (_buttons, _analog, touches = []) => {
  const input = controls.sample(touches, viewport.w, viewport.h, runtime.voxel.nativeButtons());
  runtime.voxel.buttons(input.visual);
  gameFrame(input.buttons);
};
