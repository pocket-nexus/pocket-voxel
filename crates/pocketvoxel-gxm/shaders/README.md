# GXM shader provenance

These binaries are the `.data` payloads from xerpi/libvita2d commit
`a8f15ab09d5233f0a4e4ad0e8f6ade0da888cbed`:

```text
libvita2d/shader/compiled/color_v_gxp.o   -> color_v.gxp
libvita2d/shader/compiled/color_f_gxp.o   -> color_f.gxp
libvita2d/shader/compiled/texture_v_gxp.o -> texture_v.gxp
libvita2d/shader/compiled/texture_f_gxp.o -> texture_f.gxp
```

Extract each payload with VitaSDK's object-copy tool:

```sh
arm-vita-eabi-objcopy -O binary INPUT_gxp.o OUTPUT.gxp
```

The four files are byte-identical to the copies PocketJS kept under
`engine/pocket3d/crates/pocket3d-vita/shaders/` until PocketJS commit
`a2d778b9` moved that crate to OpenStrike; they were taken from PocketJS
`fbd3a5d4`. See `LICENSE.libvita2d` for the upstream MIT license.
