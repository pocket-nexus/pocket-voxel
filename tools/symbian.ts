import { resolve, join } from "node:path";
import { copyFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { bakeControlTextures } from "./control-textures.ts";
import { rasterizeVoxelIcon } from "./ios-artwork.ts";

const root = resolve(import.meta.dir, "..");
const output = resolve(root, ".pocket-build/symbian");
const runtime = resolve(process.env.POCKETJS_ROOT ?? join(root, "vendor/pocketjs"));
const data = join(output, "data");
mkdirSync(data, { recursive: true });
copyFileSync(join(root, "dist/voxelmon/voxelmon.vxpak"), join(data, "voxelmon.vxpak"));
await Bun.write(join(output, "voxel-mark.png"), (await rasterizeVoxelIcon(512)).toBuffer("image/png"));
const textures = bakeControlTextures(root, output);
const pin = await Bun.file(join(runtime, "tools/cli/symbian-toolchain.json")).json();
const target = join(root, "vendor/pocketjs/hosts/nokia-e7/targets/armv6-symbian-eabi.json");
const native = Bun.spawn(["rustup", "run", pin.runtime.rustToolchain, "cargo", "build", "--release",
  "--manifest-path", join(root, "crates/pocketvoxel-symbian/Cargo.toml"),
  "--target-dir", join(output, "cargo"), "--target", target, "-Z", "json-target-spec",
  "-Z", "build-std=core,alloc,compiler_builtins", "-Z", "build-std-features=compiler-builtins-mem"], {
  cwd: root, env: { ...process.env, ...textures }, stdout: "inherit", stderr: "inherit",
});
if (await native.exited) throw new Error("Pocket Voxel E7 core build failed");
if (process.argv.includes("--core-only")) process.exit(0);
const { buildApp } = await import(pathToFileURL(join(runtime, "tools/symbian.ts")).href);
const navigation = process.env.POCKETJS_NAVIGATION;
if (!navigation) throw new Error("Set POCKETJS_NAVIGATION to the Shell native-apps.json");
await buildApp(join(root, "host/symbian/pocket.json"), process.env.POCKETJS_SIS_VERSION ?? "0.3.12", {
  projectRoot: root, outputRoot: output, frameRate: 60, navigation,
  coreLibrary: join(output, "cargo/armv6-symbian-eabi/release/libpocketvoxel_symbian.a"),
  massStorageDataRoot: data,
  perfTrace: process.argv.includes("--perf-trace"),
});
