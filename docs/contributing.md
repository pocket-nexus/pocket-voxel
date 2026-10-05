# Contributing

The codebase is opinionated in a few places where being casual has already
been measured to hurt. Read this page before your first PR; it is short and
every rule on it has a story behind it (usually in [VOXEL.md](/VOXEL)).

## The hard rules

1. **No ROM-derived byte is ever committed.** No cooked pak, no extracted
   art, no decoded text, no golden PNG. Goldens are frame *hashes*. If your
   change wants to commit a picture, capture real hardware output (the XMB
   art standard) or don't.
2. **The identity anchor is not yours to move.** `*-max.hashes` are never
   re-recorded for a dial edit. The three legitimate re-basing events — a
   vertex format change, a pack order change, a gameplay change — each pay
   with a pixel-diff proof: which marks moved, by how many pixels, and why
   each had to. See [the golden ceremony](/guide/testing#the-golden-ceremony).
3. **No camera-relative representation change inside the visible field.** A
   distance boundary that moves with the player plays as flicker on device.
   New fidelity work uses uniform dials, or cooks all levels and keeps the
   boundary out of the frustum. See
   [the no-moving-boundary rule](/guide/quality-ladder#the-no-moving-boundary-rule).
4. **The 24 px underside cull is a pak invariant.** Anything that lowers a
   camera eye below 24 world px — a new rig, a lower rig height, a new pitch
   rung — invalidates every cooked pak, not just the cooker. Say so in the PR
   if you touch a rig.
5. **Gameplay formulas cite their provenance.** Every ported rule carries a
   citation to the Lua it ports. A change to a rules module either matches
   the reference at its cited lines or declares an adaptation the way
   `rules/status.ts` does.
6. **The surface changes by ceremony.** Edit `contracts/spec/voxel-spec.ts`,
   regenerate the Rust (`gen-voxel-rust.ts`), commit both — the byte-compare
   drift guard fails the build otherwise.
7. **The Pocket3D title card plays first at every launch** on the PS Vita,
   the PSP and the Web Player. It comes from PocketJS
   (`vendor/pocketjs/engine/pocket3d/crates/pocket3d-title`): do not skip,
   shorten, recolour or redraw it here, and do not draw the mark with the
   game's own renderer. The call sites are `pocket3d_title::vita::play()` in
   `crates/pocketvoxel-vita/src/main.rs` (before `vita2d_init_advanced`
   starts GXM), `title()` in `crates/pocketvoxel-psp/src/main.rs` (in
   `psp_main`, before the debug screen or the GE draw) and `playTitle()` in
   `web/main.ts` (`boot`, awaited before the game reads input or starts its
   clock). The one skip is the PSP `capture` and `autopilot` features,
   which never ship.
8. **The app icon is the Pocket3D app icon**, read from the PocketJS
   checkout's `vendor/pocketjs/engine/pocket3d/icon/`. This repository draws
   no icon and tracks no copy of one: do not add an `ICON0.PNG`, `icon0.png`,
   `icon.png` or `Icon.png`, and do not resize, recolour or crop the PocketJS
   files. The consumers are `xmb_icon_png` in
   `crates/pocketvoxel-psp/Psp.toml` and the `pack-pbp` repack in
   `tools/voxel.ts` (`psp/ICON0.PNG`), `icon` on `packageVitaVpk` in
   `tools/voxel.ts` (`vita/icon0.png`), `web/scripts/platform-icons.ts` (the
   web build copies both files to the paths `web/platform/manifest.json`
   pins) and `bakeArtwork` in `tools/iphone4s.ts` for the iPod touch 4
   (`ios/Icon.png`, `ios/Icon@2x.png`). A new console target takes its icon
   the same way. The rule covers the icon only: `PIC1.png` and the LiveArea
   `bg.png` / `startup.png` are not PocketJS icon files. The procedure is
   `vendor/pocketjs/skills/pocket3d-brand/SKILL.md`;
   `tests/pocket3d-icon.test.ts` holds the wiring. After a PocketJS pin that
   changes an icon, update `bytes` and `sha256` of the two `icon0` entries in
   `web/platform/manifest.json`: the web build prints the values it needs.

## Before you push

```sh
bun run tsc                  # typecheck
bun test                     # 226 tests; ROM-gated suites skip without inputs
bun tools/voxel.ts check     # both tapes, both rungs, against the goldens
```

If your change legitimately moves the **shipped**-rung picture (a dial
change), run `bun tools/voxel.ts record`, commit the updated hashes, and put
the accounting in the PR: which marks moved and why each one had to. Use
`bun tools/voxel.ts shots` to eyeball, and the PPSSPP e2e to prove the GE
agrees.

If `check` goes red at the `-max` tier: stop. The fix is in your change,
never in the golden file.

## Layout

```text
crates/pocketvoxel-core     scene core (no_std + alloc, zero deps)
crates/pocketvoxel-sim      desktop headless host: rasterizer, PNGs, hashes
crates/pocketvoxel-gu       PSP sceGu backend
crates/pocketvoxel-psp      the EBOOT shell
crates/pocketvoxel-gxm      Vita raw-GXM backend
crates/pocketvoxel-vita     the VPK shell
voxelmon/import             ROM importer (TS)
voxelmon/cook               voxelizer + atlas packer + VXPK writer (TS)
voxelmon/game               the gameplay port (TS) — Bun headless and QuickJS
voxelmon/tapes              intent tapes
contracts/spec              the surface spec + Rust codegen
tools/voxel.ts              the pipeline command
tests/                      suites + goldens (hashes only)
vendor/pocketjs             the engine, pinned as a submodule
```

The submodule pin moves deliberately: the PSP host library, the audio module
and the toolchain pins all come from one mainline engine commit.

## Working on these docs

The site lives in `docs/` and builds with VitePress:

```sh
bun run docs:dev       # local dev server with hot reload
bun run docs:build     # production build (also validates links)
bun run docs:preview   # serve the built site
```

`docs/VOXEL.md` is the design record — a decision log, not a manual. Keep it
append-oriented and let these pages stay the readable layer that links into
it; don't duplicate a fact in both places when a link will do.
