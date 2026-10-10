# Pocket Voxel 3DS native host

C owns libctru, citro3d, QuickJS, NDSP, and the two screen buffers. The Rust
`pocketvoxel-3ds` crate owns the shared scene and guest op surface;
`pocketvoxel-pica` lowers its DrawList into GPU commands and texture plans.

See the [Nintendo 3DS guide](../../docs/guide/3ds.md) for building, installing,
controls, lifecycle, runtime receipts, and validation limits.
