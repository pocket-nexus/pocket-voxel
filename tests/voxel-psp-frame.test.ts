import { expect, test } from "bun:test";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { createPspFrame, PSP_RELOAD_MAP, PSP_RELOAD_START } from "../voxelmon/game/psp-frame.ts";

function fixture() {
  const received: number[] = [];
  const game = {
    overworld: { map: { id: "PALLET_TOWN" } },
    onTick: () => {},
    tick(buttons: number) { received.push(buttons); this.onTick(); },
  };
  return { game, received, frame: createPspFrame(game) };
}

test("every Start press reloads, including closing a menu; holds do not repeat", () => {
  const { frame, received } = fixture();
  expect(frame(0)).toBe(0);
  expect(frame(VOX_BTN.start)).toBe(PSP_RELOAD_START);
  for (let i = 0; i < 120; i++) expect(frame(VOX_BTN.start)).toBe(0);
  expect(frame(0)).toBe(0);
  expect(frame(VOX_BTN.start)).toBe(PSP_RELOAD_START);
  expect(received[1]).toBe(VOX_BTN.start);
  expect(received.at(-1)).toBe(VOX_BTN.start);
});

test("walking and non-Start menus do not force a reload", () => {
  const { frame } = fixture();
  for (const buttons of [VOX_BTN.up, VOX_BTN.a, VOX_BTN.b, VOX_BTN.select, 0]) {
    expect(frame(buttons)).toBe(0);
  }
});

test("house, route, warp and Fly landings reload after destination state is installed", () => {
  const { game, frame } = fixture();
  for (const destination of ["REDS_HOUSE_1F", "PALLET_TOWN", "ROUTE_1", "VIRIDIAN_CITY"]) {
    game.onTick = () => { game.overworld.map = { id: destination }; };
    expect(frame(0)).toBe(PSP_RELOAD_MAP);
    expect(game.overworld.map.id).toBe(destination);
    game.onTick = () => {};
    expect(frame(0)).toBe(0);
  }
});

test("same-map teleports reload despite unchanged map ID", () => {
  const { game, frame } = fixture();
  game.onTick = () => { game.overworld.map = { id: game.overworld.map.id }; };
  expect(frame(0)).toBe(PSP_RELOAD_MAP);
});

test("loading another overworld with the same map ID also reloads", () => {
  const { game, frame } = fixture();
  game.onTick = () => { game.overworld = { map: { id: "PALLET_TOWN" } }; };
  expect(frame(0)).toBe(PSP_RELOAD_MAP);
});

test("Start and a transition in the same turn request one combined reload", () => {
  const { game, frame } = fixture();
  game.onTick = () => { game.overworld.map = { id: "ROUTE_1" }; };
  expect(frame(VOX_BTN.start)).toBe(PSP_RELOAD_START | PSP_RELOAD_MAP);
  game.onTick = () => {};
  expect(frame(VOX_BTN.start)).toBe(0);
});
