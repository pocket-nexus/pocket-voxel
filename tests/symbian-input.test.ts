import { expect, test } from "bun:test";
import { touchButtons } from "../host/symbian/input.ts";

const pack = (x: number, y: number) => (0x80000000 | Math.round(y) << 10 | Math.round(x)) >>> 0;
test("E7 controls match fitted artwork and preserve simultaneous contacts", () => {
  for (const [w, h] of [[360, 612], [640, 332]]) {
    const scale = Math.min(w / 640, h / 960);
    const point = (x: number, y: number) => pack((w - 640 * scale) / 2 + x * scale, (h - 960 * scale) / 2 + y * scale);
    expect(touchButtons([point(150, 620)], w, h)).toBe(1);
    expect(touchButtons([point(220, 700), point(520, 640)], w, h)).toBe(8 | 16);
    expect(touchButtons([point(405, 750)], w, h)).toBe(32);
    expect(touchButtons([point(242, 920)], w, h)).toBe(128);
    expect(touchButtons([point(380, 920)], w, h)).toBe(64);
    expect(touchButtons([point(320, 400)], w, h)).toBe(0);
    expect(touchButtons([], w, h)).toBe(0);
  }
});

import { Controls } from "../host/symbian/input.ts";
test("About menu consumes game input and requires press and release inside its target", () => {
  const c = new Controls(), point = (x: number, y: number) => pack(1.125 * x, 36 + 1.125 * y);
  expect(c.sample([point(160, 260)], 360, 612).visual).toBe(0x40000000);
  expect(c.sample([], 360, 612).visual).toBe(0x80000000);
  expect(c.sample([point(260, 320)], 360, 612, 8).buttons).toBe(0);
  c.sample([], 360, 612);
  c.sample([point(160, 318)], 360, 612);
  expect(c.sample([], 360, 612).visual).toBe(0);
  c.sample([point(160, 260)], 360, 612);
  c.sample([point(230, 260)], 360, 612);
  expect(c.sample([], 360, 612).visual).toBe(0);
});
