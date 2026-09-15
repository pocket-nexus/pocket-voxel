# Pocket Voxel on PSP-1000: source and engineering findings

Publication checkpoint: September 12, 2026.

## September 13 user hardware report

psplumberdev reports days of PSP-1000 use without crashes and supplied the
[hardware photo](shots/psp1000voxelproof.jpeg) featured in the README. This
updates the earlier hardware-validation status below. The report does not
include instrumented frame timings or a complete campaign acceptance record.

## September 12 progress checkpoint

This source checkpoint adds a party follower with directional sprites, visible
wild encounters, expanded status-move handling and TM/HM teaching. Trainer
battles preserve the selected active party member between opponents. Campaign
work includes Cerulean fixes and routes through Lt. Surge and Erika, Cut,
trainer detection, gym rewards, and corrected Center/Underground Path exits.
PSP work adds live memory diagnostics and explicit asset reloads, alongside
PC-prepared terrain pages and streaming cache updates described below.

Fresh publication checks: **165 Bun tests passed, 2 skipped, 0 failed** across
the Cerulean, Erika, follower, PSP frame, status moves, streaming, rules and
wild encounter suites; **56 Rust core tests passed**. The skipped tests need
LuaJIT. Gameplay checks used locally generated data, which is not published.
These checks do not establish a full campaign playthrough or physical PSP
acceptance. Older build and validation results below retain their original scope.

The submodule URL points to the publication fork so recursive checkouts can
retrieve the pending PocketJS allocator diagnostics dependency. Upstream
PocketJS remains credited below. ROMs, cooked packages, backups and local saves
are excluded. The checked-in follower sprite data is produced from a generated
reference atlas; the optional conversion tool expects that local atlas at
`output/imagegen/party-directions.png` and is not needed for normal builds.

Pocket Voxel runs TypeScript gameplay in QuickJS and renders a retained voxel
scene through Rust and the PSP Graphics Engine. This checkpoint changes how
that runtime uses memory: the cooked world stays on the Memory Stick, visible
assets stream into reusable caches, and JavaScript compilation moves to the
build machine. It also includes the accumulated gameplay and cooker fixes.

This report describes mechanisms present in the source. It does not establish
a new measured frame rate, a complete playthrough, or hardware certification.
The README's existing PSP-2000 pictures belong to an earlier revision.

## September 10 campaign expansion through Erika

The package now contains 116 maps (206,252,768 bytes), including Vermilion Gym,
Route 9/10, both Rock Tunnel floors, Lavender, Route 8/7 and their Underground
Path, Celadon Gym, department store floors, mansion and town interiors.
Geometry and textures still stream through the same current-map caches; new
maps add disk payloads and catalog entries rather than loading every map at once.

Blackouts validate the saved Center checkpoint and restore its physical outdoor
exit. LAST_MAP exits use matching outdoor backlinks, fixing wrong-side exits
from both Underground Paths and the stale Diglett exit after a blackout.
Trainer sight now reads the ROM's per-map trainer headers, including Route 6.
Zero-range trainers remain talk-only. Canonical and older save defeat flags
both suppress repeat battles, while defeated trainers remain visible.

Teach HM01 CUT through the Bag, earn Misty's Cascadebadge, then press A facing
a small tree. Cut swaps collision blocks and hides cooked STMP geometry; trees
regrow on map re-entry. Surge and Erika use their ROM parties and award their
badges and TMs once. The route to Celadon uses Rock Tunnel, Lavender and the
Route 8–7 Underground Path while Saffron remains outside this chapter.

Validation covers a flood of actual walk cells, directional ledges, doors,
stairs and map seams from Vermilion to all three gym leaders; this topology
check ignores temporary NPC occupancy and assumes Cut access. Separate tests
exercise blackout plus Center exit, both Underground Paths, trainer detection,
Cut geometry commands/regrowth, leader rewards and Celadon color variants.
The release PSP build and file-backed package validation pass. The broader
world suite has an unrelated external-profile fixture mismatch: Mom's expected
support height is 5, while the installed profile produces 0. No PSP hardware
playthrough was performed.

## September 10 update: Select diagnostics and PC-prepared terrain

Press Select to toggle a live diagnostics panel. It shows the PSP model
reported by KUBridge (unknown if unavailable), kernel free RAM and largest
block, reusable game-heap RAM and largest block, current map, active overworld
Pokémon, shown sprites, cached atlas pages, cached battle art, music state,
and free RAM before/after the latest map cleanup or garbage collection.
The panel updates once per second while gameplay continues. Select is reserved
for this panel in normal PSP builds; capture/autopilot input remains scripted.

Kernel free memory excludes the arena already reserved for the game. Heap free
memory includes free-list blocks plus the uncarved tail. Their sum is not one
contiguous allocation. Cleanup readings surround cache clearing and GC;
ordinary cache eviction retains capacity, but forced Start/map-entry reloads
release geometry, atlas and renderer transient buffers to the game allocator. A battle
art page can remain cached after a battle, so loaded art and active battle are
reported separately.

Every Start press, including closing a menu, forces an unload, garbage
collection and reload of the current visible assets. Holding Start fires
once per press. Doors, route crossings, warps, Fly and save-load entries use
the same path; the PSP guest observes GameMap object replacement so same-map
teleports also reload. The host waits for the GE before freeing buffers, then
re-reads all required geometry/texture frames before drawing. Gameplay state,
party and music state survive the refresh. Kernel-reserved arena memory stays
reserved; freed asset blocks become available inside the game heap. Select
shows the latest cleanup reason and the forced-reload count. These synchronous
reloads can produce a short pause.

The PC cooker now writes independent terrain pages per tileset and stores each
map's page binding in VCOL. Tilesets sharing bitmap art but using different
color groups keep separate pages; maps using the same tileset share a page.
All terrain animation frames, normalized UVs, ground/facade bakes and swizzled
pixels are prepared on the PC. A small first-tileset page remains as the unused
compatibility fallback on disk. Map-specific Celadon color exceptions receive
their own PC-baked terrain variants. PSP reads only the exact `(page, frame)` pairs
needed by its draw list, replacing obsolete animation frames in place after
the GE finishes. It performs no runtime terrain composition or swizzling.

For the installed 65-map asset set, the previous shared terrain allocation was
753,664 bytes (736 KiB). The new 16 tileset pages need 2,048–6,144 bytes per
active frame. Multiple visible tilesets and ground-bake pages add their own
payloads; these figures are not total game RAM or measured frame rates. The
package grows from 143,415,696 to 143,801,008 bytes. Package size is deliberately
secondary to resident RAM. Streaming animation adds small Memory Stick reads.

Validation: core tests include distinct animation-frame working sets; cooker
tests compare every terrain animation texel against the original combined
layout in plain and RED++ modes, verify swizzled bytes in the final pak, and
check that shared tilesets reuse pages. Release builds and pak validation are
also checked. The full TypeScript check additionally requires the generated
web WASM modules; the PSP/source check excludes those two web smoke scripts.
This update has not been tested on physical PSP hardware.

## What changed and why

| Problem | Implementation | Tradeoff |
| --- | --- | --- |
| Loading the complete pak competes with the game heap | A positional file reader validates a small index and streams mesh ranges and atlas frames | Storage reads can hold a frame |
| Parsing bundled JavaScript consumes startup memory | A host compiler serializes bytecode using the same pinned QuickJS revision as the PSP | Bytecode must be rebuilt with the matching engine |
| Startup data overlaps with steady-state allocations | Load GAME first, let the guest parse it, release the native transport buffer, collect garbage, then load resident data | Initialization order and borrowed lifetimes matter |
| Dense foliage expands the live geometry set | PSP chunk distance is 256 world pixels, grass/flower distance is 192, and detail density selects every eighth quad | Distant pop-in and less foliage are deliberate compromises |
| Allocation growth can invalidate data still used by the GE | Wait for GE completion before mutating geometry or atlas caches | Cache misses introduce a synchronization cost |
| Heap pressure is difficult to diagnose | PocketJS reports requested live/peak bytes, allocation count, largest request, and last failed request | Requested bytes are not total arena consumption |
| Reused allocator slabs can hide garbage from bump-only heuristics | Collect on scene transitions and pressure, with maintenance collection every 600 logic ticks | Collection can hold a frame; audio is prefilled ahead of it |
| Oversized terrain atlases repeat on the GE | Pack sheets into columns within a 512×512 page; split shared sheets by tileset variant | Different layout requires recooking assets |

Geometry has a 1 MiB cache-retention threshold; atlas data has a 512 KiB
threshold. **These are eviction thresholds, not hard memory ceilings.** A
frame's required assets must still fit, and retained vector capacity and
allocator overhead can exceed payload bytes. The transition prefetch uses the
first visible view; later movement loads additional assets on demand.

## Where the code lives

- `crates/pocketvoxel-core/src/pak/index.rs`: file-backed container indexing and validation.
- `crates/pocketvoxel-core/src/pak.rs`: resident and streaming-resident readers.
- `crates/pocketvoxel-core/src/draw.rs`: the draw list and its asset working set.
- `crates/pocketvoxel-psp/src/pak_file.rs`: positional reads, geometry cache, atlas cache.
- `crates/pocketvoxel-gu/src/lib.rs`: rendering through supplied geometry and atlas sources.
- `crates/pocketvoxel-psp/src/main.rs`: startup ordering, bytecode loading, GE synchronization, garbage collection, and telemetry.
- `tools/qjbc/`: the host bytecode compiler, with a pinned QuickJS dependency.
- `vendor/pocketjs/hosts/psp/src/qjs_alloc.rs`: allocator accounting required by the PSP host.
- `contracts/spec/voxel-spec.ts`: the authoritative quality settings and camera rigs.

The PocketJS allocator change is a separate dependency commit. A reproducible
checkout needs that commit available remotely, followed by a recursive
submodule update. The publication branch pins it explicitly.

## Gameplay and presentation in this checkpoint

The source includes trainer parties and payouts, expanded early-game story
handlers and encounters, inventory/economy handling, save-state serialization,
and a PSP file bridge for saves. PSP saves use a bounded 128 KiB JSON payload
with temporary and backup files in `ms0:/PSP/SAVEDATA/VOXELMON/`.
Legacy saves in the game folder are read for migration; saving writes to the
separate SAVEDATA directory. Gameplay schema
validation remains in the guest. These mechanisms do not by themselves prove
that every story path or storage-failure case is complete.

Cooker changes include terrain atlas layout and palette variants, entity
support heights, and geometry adjustments. Camera rigs also changed. Existing
render hashes need comparison against this revision; historical identity and
PSP/Vita guest-byte equality claims must not be carried forward unchanged.
The PSP now embeds bytecode while the Vita path retains JavaScript.

## Reproduce from source

Install Bun, Rust, LuaJIT, and the project's pinned PSP toolchain. Follow the
[getting-started guide](guide/getting-started.md) for reference checkouts and
provide your own supported ROM. Generated content stays in ignored `dist/`.

```sh
git submodule update --init --recursive
bun install
export VOXELMON_ROM=/path/to/your/rom.gb
export VOXELMON_G1R=/path/to/gen1recomp
export VOXELMON_VOXELMOD=/path/to/DramaticShapeVoxelMod
bun tools/voxel.ts import
bun tools/voxel.ts cook
bun test tests/
cargo test -p pocketvoxel-core
bun run tsc
bun tools/voxel.ts psp --release
```

The PSP command bundles gameplay, runs the pinned host bytecode compiler, and
builds the EBOOT. Install the EBOOT and locally cooked `voxelmon.vxpak` together.
For measurements, build with the PSP `telemetry` feature and record device
model, launch method, initial free memory, cache high-water values, QuickJS
requested bytes, arena headroom, frame timing, and audio underruns. Repeat
through map transitions and dense Forest scenes; a successful boot alone is
insufficient evidence of sustained playability.

## Validation at publication preparation

- Documentation site: `bun run docs:build` passed (bundle-size warning only).
- Rust core: **55 passed**, no failures (`cargo test -p pocketvoxel-core`).
- Focused gameplay, world, rules, contract, and seam tests: **220 passed,
  3 skipped, no failures** across five test files.
- Initial full Bun run: 300 passed, 8 skipped, 11 failed. LuaJIT was absent
  from PATH, and generated web/template and trace checks also failed.
- Full rerun with the installed LuaJIT and Rust paths: the first cook/reader
  validation passed, but the process was killed before the suite completed.
  This is an incomplete run, not a pass.
- Type checking identified two source errors, which were corrected during
  preparation. Missing generated WASM modules still prevent a clean check.
- `git diff --check` passes. Publication files were checked for common private
  key/token patterns and oversized artifacts, with no matches.
- No fresh physical PSP run, full story acceptance, GE parity capture, or
  console/web rebuild was completed for this publication checkpoint.

These limits are why the source is presented as a development checkpoint.

## Credits and content boundary

Pocket Voxel builds on [PocketJS](https://github.com/pocket-stack/pocketjs),
the [gen1recomp](https://github.com/bryanthaboi/gen1recomp) gameplay reference,
and [DramaticShape's Voxel Mod](https://github.com/DramaticShape/DramaticShapeVoxelMod).
See the repository's MIT license and existing attribution records.
This publication contains source and documentation; ROM files, extracted
content, cooked paks, local saves, and generated game bundles are excluded.
