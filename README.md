<h1><img src="./web/favicon.svg" width="40" height="40" alt="" align="absmiddle" /> Pocket Voxel</h1>

<p align="center">
  <img src="docs/shots/psp-pallet-town.png" width="720" alt="Pallet Town as a voxel diorama on a real PSP — carved trees, gabled roofs, an NPC and the player between the houses." />
</p>

<p align="center">
  <img src="docs/shots/psp-bedroom.png" width="352" alt="The player's bedroom: bookshelves, bed, SNES and a potted plant, voxelized." />
  <img src="docs/shots/psp-route-1.png" width="352" alt="Route 1: tall encounter grass, ledges, fences, and rows of carved trees." />
</p>

<p align="center"><em>All three screenshots are captures from a real PSP-2000 over PSPLINK.
The same build runs on a PS Vita at 960x544 — see <a href="#run-it">Run it</a>.</em></p>

A Game Boy creature-RPG, presented as a voxelized 3D diorama in the browser
and on handheld hardware — **the Web Player, a real PSP and a real PS Vita,
from one cooked pak and one guest bundle**. The gameplay is a TypeScript port of the
[gen1recomp](https://github.com/bryanthaboi/gen1recomp) Lua engine running in
an embedded QuickJS guest; the presentation is a Rust reimplementation of the
[DramaticShape Voxel Mod](https://github.com/DramaticShape/DramaticShapeVoxelMod)
diorama renderer. Both upstreams are MIT-licensed; both serve here as
executable specifications, not vendored code.

Pocket Voxel is one of the two mods on [Pocket Studio](https://studio.pocket.nexus/#games). The engines behind Pocket Studio also run mods. This one reads files from a game you own, so Pocket Studio shows it as a demo. The code is here: take it and make it yours.

Pocket Voxel is a specialized runtime of
[PocketJS](https://github.com/pocket-nexus/pocketjs) — the same
`⟨ core, surface, guest ⟩` composition as
[OpenStrike](https://github.com/pocket-nexus/open-strike), with the ownership
split inverted: **the game state lives in the guest** (world, battle, script
VM, menus, saves — every formula cites the Lua it ports), and the Rust core
owns only the retained scene — cooked voxel chunks, entity billboards, camera
rungs, the battle stage, a GB UI tile layer, a bounded native-pixel colour
overlay, and the chip synth that renders the ROM's own sound programs to PCM.
Steady-state boundary traffic is a few ops per tick against a measured QuickJS
budget of ~8k ops per frame.

Pocket Voxel is built on [Pocket3D](https://3d.pocket.nexus) and shows the
Pocket3D title card at launch: **on the PS Vita and the PSP before the
renderer starts, and in the Web Player before the game starts**. The card is
PocketJS's `pocket3d-title`, 144 ticks at 60 Hz. The iPhone 4S / iPod touch 4
and Cardputer Zero hosts have no drawer for it and do not show it yet.

The app icon is the Pocket3D app icon: **the XMB's `ICON0.PNG`, the PS Vita
bubble's `icon0.png` and the iPod touch 4's `Icon.png` / `Icon@2x.png` are the
files under `vendor/pocketjs/engine/pocket3d/icon/`**, read by each build and
by the web build that serves them to the browser packager. This repository
tracks no icon file for those consoles. The rule covers the icon only: the
PSP's `PIC1.png` and the PS Vita LiveArea's `bg.png` and `startup.png` are
unchanged. The iPhone 4S app and the Cardputer Zero launcher entry keep the
Pocket Voxel mark: PocketJS has no icon file in the form those two launchers
read.

## You bring the ROM

This repository is **ROM-fed, exactly like upstream gen1recomp**: the only
game-content input is a canonical US Gen-1 ROM you already own. The importer
verifies its SHA-1 before decoding one byte, everything decoded lands under
git-ignored `dist/`, and **no ROM-derived byte is ever committed** — no
cooked pak, no extracted art, no decoded text; the rendering goldens are
frame *hashes*, never pixels. The screenshots above are hardware captures of
the running device, the same standard as the EBOOT's XMB background.

## How it works

```text
cook time (Bun, your machine)            run time (PSP / PS Vita)
├─ import/  ROM → gen/ (SHA-1 gated)     ├─ QuickJS guest: the gameplay port,
├─ cook/    voxelizer: classify tiles,   │    one frame(buttons) per tick
│    carve trees, place 42 building      ├─ voxel surface: ~10-40 ops/tick
│    templates, bake ground+facades,     │    drive the retained scene
│    pack chunks → voxelmon.vxpak        ├─ pocketvoxel-core: culling, camera
└─ tapes/   intent tapes → .vtrace       │    rungs, draw list, chip synth
     (the acceptance path)               └─ the backend for this machine:
                                              pocketvoxel-gu  (PSP, sceGu)
                                              pocketvoxel-gxm (Vita, GXM)
```

- **One pak, many machines.** Fidelity is a runtime *ladder*, not a build
  flag: the same 29.7 MB pak serves the PSP rung (30 fps present lock, 60 Hz
  logic), the Vita rung, and the desktop identity rung — which replays the
  pre-ladder picture pixel-for-pixel and is pinned by committed frame hashes
  no dial edit may move. **The rung is named by the HOST, not the guest**, so
  the guest bundle inside the Vita VPK is byte-identical to the one baked
  into the PSP EBOOT — no `#ifdef`, no second build of the game.
- **Each machine gets its own renderer, not its own fork.** Both consume the
  same ordered draw list and resolve every texture's palette through the same
  function: `pocketvoxel-gu` on the PSP's GE, `pocketvoxel-gxm` on the Vita's
  GXM. The Vita draws it at native 960x544 while the logical viewport stays
  the PSP's 480x272, so the layout, the cameras and every golden are
  unchanged and only the pixel count moves.
- **No camera-relative representation change inside the visible field.** The
  PSP rung pays its frame budget with uniform dials only (coarse-carved
  trees, ground baked to per-chunk pages, stratified detail density) — a
  distance boundary that moves with the player plays as flicker, and this
  repo's rule is that it never ships.
- **Deterministic to the byte.** Two cooks are byte-identical; gameplay is a
  fixed 60 Hz step with tape-recorded intent; the software rasterizer and
  the GE resolve the same draw list within a measured pixel tolerance,
  enforced by a PPSSPP-headless e2e at every story checkpoint.

## Quick start

Needs [Bun](https://bun.sh) and a Rust toolchain. Device builds need one
console toolchain each; both are covered under [Run it](#run-it).

```sh
git clone --recursive https://github.com/pocket-nexus/pocket-voxel
cd pocket-voxel && bun install

export VOXELMON_ROM=/path/to/your/rom.gb   # SHA-1 verified before any decode
export VOXELMON_G1R=~/code/gen1recomp      # reference checkouts: the manifest
export VOXELMON_VOXELMOD=~/code/DramaticShapeVoxelMod  # and the tile profiles

bun tools/voxel.ts import   # ROM → dist/voxelmon/gen/
bun tools/voxel.ts cook     # gen/ → dist/voxelmon/voxelmon.vxpak
bun tools/voxel.ts check    # replay the tapes, assert both rungs' hashes
```

## Run it

### Web

The browser build contains the renderer and non-ROM reference metadata, but no
game content. It verifies and bakes a ROM you select entirely in a local Web
Worker, then offers three independent targets from the same cooked world:
the in-page Web Player, a PSP memory-stick ZIP, or a PS Vita VPK. A second,
lazy-loaded WASM packager validates the ROM-independent native templates and
assembles either console download locally; it does not upload the ROM or run a
cross-compiler in the tab.

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.126 --locked
bun run web:build
bun run web:serve            # http://127.0.0.1:8131/
bun run web:smoke:packages   # verify PSP/Vita archives + embedded VXPK
bun run web:deploy           # publish static assets to pocketvoxel.games
# Optional real-Chrome acceptance with VOXELMON_ROM (or the local default):
bun run web:e2e
```

Drop your canonical US Pokémon Red ROM onto the page. The player maps its
480×272 framebuffer onto a demand-rendered 3D Game Boy; the model's D-pad,
face buttons, Start, and Select are interactive alongside keyboard and standard
gamepad input. The ROM and cooked pak remain in memory for this tab only; they
are neither uploaded nor written to browser storage. The attributed stage model
and its license ship under `web/assets/game-boy/`. PSP output is a ZIP whose
`PSP/GAME/VOXELMON/` directory contains both the generated `EBOOT.PBP` and its
required `voxelmon.vxpak`; Vita output is one self-contained `.vpk`. Both
downloads carry the native runtime's third-party notices.

### PSP

Needs the [cargo-psp](https://github.com/overdrivenpotato/rust-psp) toolchain,
which `tools/voxel.ts` resolves and pins for you.

```sh
bun tools/voxel.ts psp --release   # the EBOOT
```

Put `EBOOT.PBP` and `voxelmon.vxpak` in one folder under `ms0:/PSP/GAME/`, or
develop over [PSPLINK](https://github.com/pspdev/psplinkusb) with the pak
served from `host0:`.

The bedroom computer can consume a live macOS desktop stream from the local
companion daemon. It uses FFmpeg's AVFoundation capture, converts the selected
display to **512×128 RGB332 CLUT8 at 12 fps**, pre-squashed for the 2:1 desktop
window, and continuously publishes the fixed-size
`pocket-svc/voxelmon/media/desktop.pkst` ring. macOS asks for Screen Recording
permission the first time the terminal captures a display.

```sh
brew install ffmpeg
bun run desktop:serve                         # Capture screen 0; ~/.config/ppsspp
bun run desktop:serve -- --screen 1 --fps 20 # another display/rate
bun run desktop:serve -- --dir /path/to/usbhostfs-root
```

Use `--device "Capture screen 0"` to bypass device discovery. `Ctrl-C` marks
the stream ended, closes it, stops FFmpeg, and deletes `desktop.pkst` so the
last captured frames do not persist on disk. The empty service `enable` file
stays in place so the game can continue to show its waiting state.

### PS Vita

Needs [VitaSDK](https://vitasdk.org) and
[cargo-vita](https://github.com/vita-rust/cargo-vita).

```sh
export VITASDK=~/vitasdk
bun tools/voxel.ts vita --release   # dist/voxelmon/voxelmon.vpk
```

**The VPK carries the pak inside it and needs nothing else on the console.**
Copy it over (VitaShell's `SELECT` starts USB or FTP), press `X` on it,
confirm — that is the whole install. It ships libvita2d's precompiled GXM
shaders, so a stock HENkaku console does not need Sony's runtime shader
compiler (`libshacccg.suprx`) the way most Vita 3D homebrew does.

For REMOTE COMPUTER on a Vita, put the Mac and Vita on the same network and
opt into the PKNT TCP stream plus its UDP discovery beacon:

```sh
bun run desktop:serve -- --tcp       # TCP 8622, or: --tcp 9000
```

**Network streaming is off by default.** `--tcp` broadcasts availability and
serves the live screen to compatible `voxelmon` clients on the local network;
PKNT does not authenticate peers, so enable it only on a network you trust.

One honest difference from the PSP picture: the GE cuts sprite art out with a
hardware alpha test and **GXM has none**, so grass, flowers and entity
billboards blend instead of clipping, and give up their baked ambient
occlusion to do it. Solid geometry and the Game Boy UI layer are unaffected —
[docs/VOXEL.md §12](docs/VOXEL.md) has the per-pass accounting.

### iPhone 4S / iPod touch 4 (iOS 6)

The jailbroken iPhone 4S target is a standalone portrait application. It uses
PocketJS's pinned iOS 6 ARMv7 toolchain and GLES 1.1 shell, embeds the cooked
VXPK in `PocketVoxel.app`, renders the game in the upper half of the Retina
display, streams the core's stereo PCM through Audio Queue Services, and draws
touch D-pad, A/B, Start, and Select controls in the lower half. The raised
controls reuse Motion Lab's baked-letter and D-pad visual vocabulary, with the
required `(yui540)` credit kept on-screen; its accepted permission boundary is
recorded in
[`vendor/pocketjs/apps/motions/ATTRIBUTION.md`](vendor/pocketjs/apps/motions/ATTRIBUTION.md).
Nothing ROM-derived is committed.

```sh
export VOXELMON_ROM=/path/to/PokemonRed.gb
bun tools/voxel.ts import
bun tools/voxel.ts cook
bun iphone4s doctor
bun iphone4s deploy
bun iphone4s launch
bun iphone4s status
bun iphone4s capture
```

The deploy command accepts only the validated iPhone 4S/iOS 6.1.3 identity,
uses key-only USB SSH, verifies every staged file byte-for-byte, and atomically
replaces only `/Applications/PocketVoxel.app`. The installed app launches from
its own SpringBoard icon and does not need a companion process or pak file.

For an iPod touch 4 (`iPod4,1`, iOS 6.1.6), use the same cooked content and
select the physical device explicitly:

```sh
export POCKETJS_IPODTOUCH4_UDID='<device-udid-from-idevice_id>'
bun ipodtouch4 doctor
bun ipodtouch4 deploy
bun ipodtouch4 launch
# Press and release the controls on the device, then check the fresh receipt.
bun ipodtouch4 status --require-action
bun ipodtouch4 capture
```

The iPod uses PocketJS's MobileInstallation helper and AppSync Unified to
install a removable User app. Updates preserve its data container, and every
installed file is checked against the build receipt. Its icon is the opaque
Pocket3D app icon, copied into the bundle as `Icon.png` and `Icon@2x.png`;
SpringBoard applies its native mask and shadow. Build artifacts and device
receipts are under `dist/ipodtouch4`. If iOS 6 retains an old icon after an
update, reboot the device once to reload SpringBoard's in-memory icon cache.
Runtime and audio receipts live inside the app's own container. Both targets
share the ARMv7 renderer and support simultaneous D-pad and A/B contacts. `input_chord_frames` in the status receipt
records frames that received a direction and A/B together.

### Nintendo 3DS

The native PICA200 backend renders the game on the **400×240 upper screen**,
in a 400×226 band that preserves the cooked camera aspect. The **320×240 lower
screen** displays a PocketJS placeholder and control hints. D-pad / Circle Pad,
A/B, Start, and Select control the game; **L+R+START returns to HBL**.

```sh
bun run 3ds          # dist/3ds/voxelmon.3dsx
bun run 3ds --cia    # also dist/3ds/voxelmon.cia
```

Use the same imported and cooked content as the other native targets. Copy the
`.3dsx` to `/3ds/pocket-voxel/pocket-voxel.3dsx` on the SD card, or install the CIA. Each package
embeds its game, VXPK, and icons. Build/runtime receipts keep the artifact,
rendering, input, and NDSP audio evidence separate. The host uses the pinned
PocketJS 3DS toolchain, 60 Hz game logic, and 11.025 kHz stereo output.

Azahar covers story, battle, computer menus, and both screens. Physical-device
acceptance is pending; New 3DS is the initial target and Old 3DS memory remains
unverified. See [the 3DS host guide](hosts/3ds/README.md) for prerequisites,
audio requirements, receipts, and reproducible validation.

### Cardputer Zero

The native Cardputer Zero host targets its internal **320×170 RGB565** LCD
and TCA8418 keyboard. Pocket Voxel keeps the **480×272 logical viewport** and
renders directly at **300×170**, centered with 10-pixel black bars on both
sides; the image is not stretched or cropped.

Install the Rust target and cross-linker once, connect the device over ADB,
then give VC4 a 64 MiB contiguous-memory pool once. The stock Cardputer Zero
image uses 32 MiB, which cannot hold VC4's binner and the renderer's buffer
objects at the same time:

```sh
adb shell "cp -p /boot/firmware/cmdline.txt /boot/firmware/cmdline.txt.pre-pocket-voxel-gpu && sed -i 's/cma=[^ ]*/cma=64M/' /boot/firmware/cmdline.txt && systemctl reboot"
adb wait-for-device
```

Then build, cook the local ROM-derived pak, and add Pocket Voxel to APPLaunch:

```sh
rustup target add aarch64-unknown-linux-gnu --toolchain stable
cargo install cargo-zigbuild
VOXELMON_ROM=/path/to/PokemonRed.gb bun run cardputer:install
```

Use the arrow keys or `WASD` to move. `Enter`, `Space`, `Z`, or `J` confirms;
`Backspace`, `X`, or `K` cancels; `P` is Start, `O`/`Q` is Select, and `Esc`
returns to APPLaunch. **The SPI panel exposes a fixed 320×170 at 30 Hz DRM
mode**, so the host preserves 60 Hz game logic and presents at the panel-native
30 fps. **The host rasterizes geometry, indexed atlas textures, depth, and
blending on the BCM2837 VC4/V3D GPU through GLES2.** The GPU is a separate DRM
device from the SPI display, so each 300×170 result is read back and written to
the RGB565 panel. `--software` selects the CPU rasterizer only for diagnostics;
the default path rejects Mesa software renderers instead of silently using
one. **The game clock remains 60 Hz and audio is prebuffered at 11.025 kHz
stereo, so a skipped display frame does not slow music playback.**

## Tests

```sh
bun test                    # 241 tests; ROM-gated suites skip with a reason
bun tools/voxel.ts check    # both quality rungs' frame hashes
bun tests/e2e/voxel-ppsspp.ts   # GE-vs-sim parity at 11 story marks
```

## Architecture notes

The full design record is [docs/VOXEL.md](docs/VOXEL.md): the content
boundary, the guest/core split, the VXPK format, the quality ladder and its
identity anchor, the fetch-bound GE findings, and the determinism ceremony
that governs when a committed hash may ever be re-based. The engine arrives
as a pinned git submodule (`vendor/pocketjs`), the OpenStrike pattern: the
PSP host library, the audio module and the toolchain pins all come from one
engine commit — a mainline commit, moved forward deliberately.

## License

MIT. The ROM, and everything derived from it, stays yours and stays local.

The vendored Pocket3D (`vendor/pocketjs/pocket3d/`, `devices/` and
`engine/pocket3d/`) is under the
[Pocket3D License](https://github.com/pocket-nexus/pocketjs/blob/main/pocket3d/LICENSE):
MIT's grant plus one condition, that a distributed product drawing 3D scenes
with Pocket3D shows the title card each time it starts. The rest of
`vendor/pocketjs` is MIT.
