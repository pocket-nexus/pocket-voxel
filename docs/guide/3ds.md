# Pocket Voxel on Nintendo 3DS

The native host runs the shared QuickJS game and Rust scene through citro3d / PICA200. It uses the current PocketJS 3DS toolchain conventions and HBL return chord. Pocket Doc, Pocket Map, and Pocket Term use the generic retained UI host; Voxel keeps its own native scene renderer and embedded VXPK.

## Screens and controls

The upper screen is 400×240. The existing 480×272 camera renders into a 400×226 band with 7-pixel bars; no game geometry or UI is cropped. The lower screen displays a 320×240 PocketJS plate with control hints. It reserves the touch panel for future interactions and consumes no touch input in this version.

- D-pad or Circle Pad: move
- A: confirm; B: back
- Start / Select: game controls
- L + R + Start: return to Homebrew Launcher (consumed by the host)

The normal app has no developer console overlay. Optional `--heartbeat 1` diagnostics write detailed stage receipts to SD; they are disabled by default.

## Build and install

From the repository root, after the local ROM has been imported and cooked:

```sh
bun run 3ds          # dist/3ds/voxelmon.3dsx
bun run 3ds --cia    # also dist/3ds/voxelmon.cia
```

The Rust compiler is `nightly-2026-07-02` with `rust-src`; C, libctru, citro3d, shader assembly, and packaging use the digest-pinned devkitPro image matching PocketJS. `makerom` is pinned to the same upstream revision. Docker must be running.

Copy `voxelmon.3dsx` to `/3ds/pocket-voxel/pocket-voxel.3dsx` on the console SD card, then launch Pocket Voxel from HBL. Alternatively install the generated CIA with the console's package installer. Both artifacts contain the game bundle, cooked VXPK, native-size 24/48-pixel Voxel icons, and bottom plate. They do not require a desktop companion. Other Pocket apps and their per-app runtime slots are untouched.

Build receipts beside each artifact contain its build ID and SHA-256. Runtime receipts use the app-specific `/pocketvoxel-3ds/` SD directory: `status.txt`, `memory.txt`, and `error.txt`. `status.txt` records the build, tick/present counts, input actions, and audio state. The full package is roughly 30 MiB and contains local ROM-derived data; do not publish it with the source.

## Native lifecycle and audio

The game advances at 60 Hz independently of presentation. Catch-up after a slow draw is bounded, and suspend/resume does not replay minutes of input. The previous GPU frame retires before texture updates or arena reuse. `L+R+START` releases native audio and graphics before returning to HBL.

The core renders 11.025 kHz stereo PCM on the host thread. Four NDSP buffers keep output asynchronous without sharing mutable scene state between threads. Audio pauses for sleep/HOME and resumes through the APT lifecycle hook. A console needs usable DSP firmware for NDSP; if initialization fails, the game continues and records `audio_state=unavailable` plus the native result code.

## Validation

```sh
cargo test --manifest-path crates/pocketvoxel-pica/Cargo.toml
cargo test --manifest-path crates/pocketvoxel-3ds/Cargo.toml
bun crates/pocketvoxel-3ds/abi/check.ts
bun run e2e:3ds
E2E_3DS_TAPE=battle bun run e2e:3ds
E2E_3DS_TAPE=computer bun run e2e:3ds
```

The Azahar driver uses separate storage per tape and terminates only its own recorded process. Each tape checks liveness, the real lower framebuffer, byte-exact regression hashes, and color/structure agreement with the current CPU oracle. Goldens cover 11 story, 4 battle, and 7 computer checkpoints. Capture builds are distinct artifacts and must not be installed as the playable app.

Emulator evidence does not establish physical controls, audible DSP output, HOME/sleep behavior, or HBL switching on a console. Those remain hardware acceptance gates. New 3DS is the initial hardware target; the Old 3DS memory budget has not been validated. `memory.txt` records the actual heap and linear-memory grant rather than assuming that an emulator's grant is available on every launcher.

The detailed original renderer investigation remains in [docs/PICA.md](../PICA.md).
