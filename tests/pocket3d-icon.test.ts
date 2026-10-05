import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { POCKET3D_ICON } from "../vendor/pocketjs/tools/pocket3d-icon.ts";
import {
  resolveVitaPackageAssets,
  VITA_ICON_VPK_PATH,
} from "../vendor/pocketjs/tools/vita-package.ts";
import { copyPlatformIcons, PLATFORM_ICONS } from "../web/scripts/platform-icons.ts";

// The app icon on every console is the Pocket3D app icon. Each build reads it
// from the PocketJS checkout (vendor/pocketjs/engine/pocket3d/icon/); this
// repository tracks no icon file and no copy of one. The procedure is
// vendor/pocketjs/skills/pocket3d-brand/SKILL.md.

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const ICONS = join(ROOT, "vendor/pocketjs/engine/pocket3d/icon");
const source = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const sha256 = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** Width, height and colour type from a PNG's IHDR. */
function png(path: string): [width: number, height: number, colourType: number] {
  const bytes = readFileSync(path);
  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20), bytes[25]!];
}

test("the PocketJS checkout holds the icon each console's launcher reads", () => {
  for (const path of Object.values(POCKET3D_ICON)) {
    expect(resolve(path).startsWith(ICONS + "/")).toBe(true);
    expect(existsSync(path)).toBe(true);
  }
  expect(png(POCKET3D_ICON.psp)).toEqual([144, 80, 6]);
  // The VPK packager accepts an indexed PNG only (colour type 3).
  expect(png(POCKET3D_ICON.vita)).toEqual([128, 128, 3]);
  expect(png(POCKET3D_ICON.ios).slice(0, 2)).toEqual([57, 57]);
  expect(png(POCKET3D_ICON.ios2x).slice(0, 2)).toEqual([114, 114]);
});

test("no PSP, PS Vita, Nintendo 3DS or iOS launcher icon is tracked in this repository", () => {
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT, stdout: "pipe" });
  expect(listed.exitCode).toBe(0);
  const tracked = listed.stdout.toString().split("\0").filter(Boolean);
  expect(tracked.length).toBeGreaterThan(100);
  // ICON0.PNG / icon0.png (PSP, PS Vita), Icon.png / Icon@2x.png (iOS),
  // icon.png / icon-small.png / *.smdh (Nintendo 3DS), and a drawing of one.
  // PocketJS has no file for the Cardputer Zero's APPLaunch entry or for an
  // iPhone 4S System app, so those two keep the Pocket Voxel mark.
  const icon = /(^|\/)(icon0\.png|icon(-small)?(@2x)?\.(png|svg)|[^/]+\.smdh)$/i;
  expect(tracked.filter((path) => icon.test(path))).toEqual([]);
  // The submodule is one entry: git lists none of the files inside it.
  expect(tracked).toContain("vendor/pocketjs");
});

test("the PSP EBOOT takes ICON0 from PocketJS", () => {
  const crate = join(ROOT, "crates/pocketvoxel-psp");
  const manifest = source("crates/pocketvoxel-psp/Psp.toml");
  // cargo-psp reads top-level keys only: under a table header it packs no icon.
  expect(manifest).not.toMatch(/^\s*\[/m);
  const icon = manifest.match(/^xmb_icon_png = "([^"]+)"$/m)?.[1];
  expect(icon).toBeTruthy();
  expect(resolve(crate, icon!)).toBe(resolve(POCKET3D_ICON.psp));
  // The background stays the game's own picture.
  const background = manifest.match(/^xmb_background_png = "([^"]+)"$/m)?.[1];
  expect(background).toBe("assets/PIC1.png");
  expect(png(join(crate, background!)).slice(0, 2)).toEqual([480, 272]);

  // tools/voxel.ts re-packs the PBP for MEMSIZE; ICON0 is the third argument.
  expect(source("tools/voxel.ts")).toMatch(
    /"pack-pbp",\s*`\$\{outDir\}\/EBOOT\.PBP`,\s*sfo,\s*POCKET3D_ICON\.psp,/,
  );
});

test("the PS Vita VPK takes the bubble icon from PocketJS", () => {
  expect(source("tools/voxel.ts")).toMatch(
    /await packageVitaVpk\(\{[\s\S]*?\bicon: POCKET3D_ICON\.vita,\s*\}\)/,
  );
  // `icon` wins over the framework default, and the packager's LiveArea rules
  // (128 x 128, indexed, non-interlaced) accept the file.
  const assets = resolveVitaPackageAssets({ icon: POCKET3D_ICON.vita });
  expect(assets.find((asset) => asset.destination === VITA_ICON_VPK_PATH)!.source).toBe(
    POCKET3D_ICON.vita,
  );
});

test("the web build serves the PocketJS icons at the paths the manifest pins", () => {
  expect(PLATFORM_ICONS).toEqual({
    "psp/ICON0.png": POCKET3D_ICON.psp,
    "vita/sce_sys/icon0.png": POCKET3D_ICON.vita,
  });
  const manifestPath = join(ROOT, "web/platform/manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
    "psp" | "vita",
    { files: { id: string; path: string; bytes: number; sha256: string }[] }
  >;
  for (const [path, icon] of Object.entries(PLATFORM_ICONS)) {
    // No copy beside the other templates: the build is the one writer.
    expect(existsSync(join(ROOT, "web/platform", path))).toBe(false);
    const entry = [...manifest.psp.files, ...manifest.vita.files].find((file) => file.path === path);
    expect(entry?.id).toBe("icon0");
    const bytes = readFileSync(icon);
    expect(entry!.bytes).toBe(bytes.byteLength);
    expect(entry!.sha256).toBe(sha256(bytes));
  }
  expect(source("web/scripts/build.ts")).toContain('copyPlatformIcons(join(out, "platform"));');

  const built = mkdtempSync(join(tmpdir(), "pocketvoxel-platform-"));
  try {
    cpSync(manifestPath, join(built, "manifest.json"));
    copyPlatformIcons(built);
    for (const [path, icon] of Object.entries(PLATFORM_ICONS)) {
      expect(readFileSync(join(built, path)).equals(readFileSync(icon))).toBe(true);
    }
    // A manifest that pins another file stops the build.
    manifest.psp.files.find((file) => file.id === "icon0")!.sha256 = "0".repeat(64);
    writeFileSync(join(built, "manifest.json"), JSON.stringify(manifest));
    expect(() => copyPlatformIcons(built)).toThrow("does not pin");
  } finally {
    rmSync(built, { recursive: true, force: true });
  }
});

test("the iPod touch 4 bundle takes Icon.png and Icon@2x.png from PocketJS", () => {
  const packager = source("tools/iphone4s.ts");
  expect(packager).toContain("const ICON_BASENAME = DEVICE.userApp ? 'Icon' : ");
  expect(packager).toContain("cpSync(POCKET3D_ICON.ios, join(BUNDLE_PATH, `${ICON_BASENAME}.png`));");
  expect(packager).toContain("cpSync(POCKET3D_ICON.ios2x, join(BUNDLE_PATH, `${ICON_BASENAME}@2x.png`));");
  // SpringBoard adds no gloss to a prerendered icon.
  expect(source("host/iphone4s/Info.plist")).toMatch(/<key>UIPrerenderedIcon<\/key>\s*<true\/>/);
});
