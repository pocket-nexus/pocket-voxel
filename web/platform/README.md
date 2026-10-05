# Browser console templates

These files are ROM-independent release hosts built from the Pocket Voxel
source tree. The browser never cross-compiles user data into native code:
it cooks one local `VXPK`, then the packager WASM assembles that data with
these validated templates.

- PSP output is a memory-stick ZIP containing
  `PSP/GAME/VOXELMON/EBOOT.PBP`, `voxelmon.vxpak`, and the native runtime
  notices together. It targets PSP-2000 or newer with custom firmware, or
  PPSSPP.
- PS Vita output is a VPK containing the safe FSELF, SFO, LiveArea artwork,
  native runtime notices, and the locally cooked `voxelmon.vxpak` at its root.
- Both downloads carry the same hash-pinned `THIRD_PARTY_NOTICES.txt` beside
  their runtime files, including the native hosts' complete license terms.

The console icon of both downloads is the Pocket3D app icon. `psp/ICON0.png`
and `vita/sce_sys/icon0.png` are not kept in this directory: the web build
(`web/scripts/platform-icons.ts`) copies them from
`vendor/pocketjs/engine/pocket3d/icon/` into `dist/web/platform/`, and
`manifest.json` pins their size and SHA-256.

The original artwork in `source/` is Pocket Voxel project artwork and contains
no ROM-derived pixels. Binary hashes, the source revision, guest bundle hash,
and package compatibility are pinned in `manifest.json`.
