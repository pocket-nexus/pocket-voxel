// The console icons of the packages the browser assembles.
//
// A PSP ZIP or PS Vita VPK built on the site carries the Pocket3D app icon.
// The two files are not kept in this repository. `web/platform/manifest.json`
// names the paths the export worker fetches and pins each file's size and
// SHA-256; the web build copies the files of the pinned PocketJS checkout to
// those paths under `dist/web/platform/`, and refuses a file the manifest does
// not pin. After a PocketJS pin that changes an icon, `bytes` and `sha256` of
// the two `icon0` entries move with it.

import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { POCKET3D_ICON } from "../../vendor/pocketjs/tools/pocket3d-icon.ts";

/** Path under `platform/` -> the PocketJS file served there. */
export const PLATFORM_ICONS: Readonly<Record<string, string>> = {
  "psp/ICON0.png": POCKET3D_ICON.psp,
  "vita/sce_sys/icon0.png": POCKET3D_ICON.vita,
};

/** The file behind a manifest path: PocketJS for an icon, `web/platform/` for the rest. */
export function platformSource(platform: string, path: string): string {
  return PLATFORM_ICONS[path] ?? join(platform, path);
}

interface ManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

/** Copy both icons into a built `platform/` directory, checked against its manifest. */
export function copyPlatformIcons(builtPlatform: string): void {
  const manifest = JSON.parse(readFileSync(join(builtPlatform, "manifest.json"), "utf8")) as {
    psp: { files: ManifestFile[] };
    vita: { files: ManifestFile[] };
  };
  const pinned = new Map(
    [...manifest.psp.files, ...manifest.vita.files].map((file) => [file.path, file]),
  );
  for (const [path, source] of Object.entries(PLATFORM_ICONS)) {
    const bytes = readFileSync(source);
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const pin = pinned.get(path);
    if (!pin || pin.bytes !== bytes.byteLength || pin.sha256 !== sha256) {
      throw new Error(
        `web/platform/manifest.json does not pin ${source} at ${path}: ` +
          `it needs "bytes": ${bytes.byteLength} and "sha256": "${sha256}"`,
      );
    }
    const target = join(builtPlatform, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}
