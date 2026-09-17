# Pocket Voxel on Nokia E7

The E7 host runs the Voxelmon game through PocketJS's Symbian native-extension
ABI. It shares game state, scene geometry, materials and touch-control artwork
with the iOS port. A GLES2 adapter implements the fixed-function drawing calls
used by that renderer. Qt owns the GPU context and depth buffer.

Build after cooking the Voxelmon data (`dist/voxelmon/voxelmon.vxpak`):

```sh
bun install --frozen-lockfile
bun install --cwd vendor/pocketjs --frozen-lockfile
export POCKETJS_NAVIGATION=/path/to/pocket-shell/shells/touch/native-apps.json
bun run symbian
bun vendor/pocketjs/tools/symbian.ts deploy .pocket-build/symbian/pocket-voxel.sis
```

The PocketJS Symbian toolchain needs Docker and its pinned Rust nightly. The
build creates the Rust archive, game payload, control textures, icon, signed
SIS and receipt under `.pocket-build/symbian/`. `--core-only` builds the archive;
`--perf-trace` enables the runtime replay. `POCKETJS_ROOT` selects a runtime
checkout, and `POCKETJS_SIS_VERSION` overrides the package version.

Package UID `0xE9A45CD9` and executable `PocketJsPocketVoxelE9A45CD9.exe` are
stable. The installer places the cooked pack under the app's private mass
storage directory. The native extension owns the aligned bytes until shutdown.
The game uses the PSP quality tier and portrait touch controls. The entire
320×480 control coordinate system scales with the rendered content, including
letterboxing. Multiple contacts can hold a direction and an action together.

The shared host reserves a bottom return strip: tap or swipe up for Shell
Home, or lift and hold for its switcher. Returning pauses this process and releases its GPU resources; opening
its card rebuilds the graphics resources and resumes the same game. Closing the card exits the task. The Symbian
Home key remains an OS action. Install Shell and Clear with the same navigation
registry to use the three-app workflow.

This port has **no audio output**. It does not add serialized game recovery
across process termination. Device replay validates rendering and input
routing; physical touch latency and long play sessions require separate checks.
