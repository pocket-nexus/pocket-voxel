These are ROM-independent Picasso shader binaries used to check PICA output
completion. `incomplete-output.shbin` is the Voxel shader from commit 733c6a4,
whose first frame timed out on the physical console: its output table maps
all four components of o1, while its instructions write only xy.

`complete-output.shbin` assembles the fix in `hosts/3ds/src/vshader.v.pica`:
scale UVs in r1, then move all four components into o1 once. Both were built
with the devkitPro image pinned by `tools/voxel-3ds.ts`.
