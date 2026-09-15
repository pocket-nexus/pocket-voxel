// Browser-safe in-memory VXPK cooker. Node/Bun input discovery and output
// writes stay in cli.ts/data-node.ts.

import {
  ATLAS_KIND,
  COLOR_PAL_NONE,
  MESH_KIND,
  VXPK_META_FLAG_GROUND_BAKE,
  VXPK_META_FLAG_TREE_COARSE,
  VXPK_META_FLAG_TREE_LOD,
} from "../../contracts/spec/voxel-spec.ts";
import {
  buildEmotePage,
  buildPalettes,
  buildPicPage,
  buildSpritePage,
  buildFollowerPage,
  buildTerrainPage,
  buildUiPage,
  paletteBase,
  type PageDef,
} from "./atlas.ts";
import type { BuildingStats } from "./buildings.ts";
import { GameMap, type GenData, type Profile } from "./data.ts";
import { buildCharmap, buildGamedata, type AtlasIndex } from "./gamedata.ts";
import { BAKE_MAX_Y, BAKE_PAGE_H, BAKE_TEXELS, bakeGround, foldFacades } from "./groundbake.ts";
import {
  packMap,
  runGeometry,
  type BorderMask,
  type MapGeometry,
  type UvTransform,
} from "./mesh.ts";
import { writePak, type PakInput } from "./pak.ts";
import {
  planColour,
  Redpp,
  type ColourPlan,
  type PageOwner,
  type RedppPack,
} from "./redpp.ts";
import { analyseMap } from "./structures.ts";
import {
  placeDirectNeighbour,
  type ConnectionDirection,
} from "../shared/connections.ts";

export const DEFAULT_MAPS: readonly string[] = [
  "REDS_HOUSE_1F",
  "REDS_HOUSE_2F",
  "PALLET_TOWN",
  "OAKS_LAB",
  "ROUTE_1",
  "VIRIDIAN_CITY",
  "VIRIDIAN_POKECENTER",
  "VIRIDIAN_MART",
  // The first complete campaign chapter. Geometry remains file-backed on
  // PSP-1000, so adding these maps costs storage rather than resident RAM.
  "ROUTE_2",
  "ROUTE_2_GATE",
  "ROUTE_2_TRADE_HOUSE",
  "VIRIDIAN_FOREST_SOUTH_GATE",
  "VIRIDIAN_FOREST",
  "VIRIDIAN_FOREST_NORTH_GATE",
  "PEWTER_CITY",
  "PEWTER_POKECENTER",
  "PEWTER_MART",
  "PEWTER_GYM",
  "BLUES_HOUSE",
  // West rival/Nidoran detour and the complete Brock-to-Misty chapter.
  "ROUTE_22",
  "ROUTE_22_GATE",
  "ROUTE_3",
  "ROUTE_4",
  "MT_MOON_POKECENTER",
  "MT_MOON_1F",
  "MT_MOON_B1F",
  "MT_MOON_B2F",
  "CERULEAN_CITY",
  "CERULEAN_POKECENTER",
  "CERULEAN_MART",
  "CERULEAN_GYM",
  // Nugget Bridge/Bill, the southbound Underground Path, Vermilion, and
  // every accessible deck and cabin of the S.S. Anne.
  "CERULEAN_TRASHED_HOUSE",
  "ROUTE_24",
  "ROUTE_25",
  "BILLS_HOUSE",
  "ROUTE_5",
  "ROUTE_5_GATE",
  "UNDERGROUND_PATH_ROUTE_5",
  "UNDERGROUND_PATH_NORTH_SOUTH",
  "UNDERGROUND_PATH_ROUTE_6",
  "ROUTE_6_GATE",
  "ROUTE_6",
  "VERMILION_CITY",
  "VERMILION_POKECENTER",
  "VERMILION_MART",
  "VERMILION_OLD_ROD_HOUSE",
  "VERMILION_PIDGEY_HOUSE",
  "VERMILION_TRADE_HOUSE",
  // East Vermilion, both floors of its gate, and the complete Diglett's
  // Cave loop back to Route 2. Route 12 remains outside this chapter.
  "ROUTE_11",
  "ROUTE_11_GATE_1F",
  "ROUTE_11_GATE_2F",
  "DIGLETTS_CAVE_ROUTE_11",
  "DIGLETTS_CAVE",
  "DIGLETTS_CAVE_ROUTE_2",
  "VERMILION_DOCK",
  "SS_ANNE_1F",
  "SS_ANNE_1F_ROOMS",
  "SS_ANNE_2F",
  "SS_ANNE_2F_ROOMS",
  "SS_ANNE_3F",
  "SS_ANNE_B1F",
  "SS_ANNE_B1F_ROOMS",
  "SS_ANNE_BOW",
  "SS_ANNE_KITCHEN",
  "SS_ANNE_CAPTAINS_ROOM",
  // Streamed campaign through Rock Tunnel, Lavender, and Erika.
  "VERMILION_GYM",
  "POKEMON_FAN_CLUB",
  "VIRIDIAN_NICKNAME_HOUSE",
  "VIRIDIAN_SCHOOL_HOUSE",
  "MUSEUM_1F",
  "MUSEUM_2F",
  "PEWTER_NIDORAN_HOUSE",
  "PEWTER_SPEECH_HOUSE",
  "CERULEAN_TRADE_HOUSE",
  "CERULEAN_BADGE_HOUSE",
  "BIKE_SHOP",
  "DAYCARE",
  "ROUTE_9",
  "ROUTE_10",
  "ROCK_TUNNEL_1F",
  "ROCK_TUNNEL_B1F",
  "ROCK_TUNNEL_POKECENTER",
  "LAVENDER_TOWN",
  "LAVENDER_POKECENTER",
  "LAVENDER_MART",
  "LAVENDER_CUBONE_HOUSE",
  "MR_FUJIS_HOUSE",
  "NAME_RATERS_HOUSE",
  "POKEMON_TOWER_1F",
  "ROUTE_8",
  "ROUTE_8_GATE",
  "UNDERGROUND_PATH_ROUTE_8",
  "UNDERGROUND_PATH_WEST_EAST",
  "UNDERGROUND_PATH_ROUTE_7",
  "ROUTE_7",
  "ROUTE_7_GATE",
  "CELADON_CITY",
  "CELADON_POKECENTER",
  "CELADON_GYM",
  "CELADON_CHIEF_HOUSE",
  "CELADON_DINER",
  "CELADON_HOTEL",
  "CELADON_MANSION_1F",
  "CELADON_MANSION_2F",
  "CELADON_MANSION_3F",
  "CELADON_MANSION_ROOF",
  "CELADON_MANSION_ROOF_HOUSE",
  "CELADON_MART_1F",
  "CELADON_MART_2F",
  "CELADON_MART_3F",
  "CELADON_MART_4F",
  "CELADON_MART_5F",
  "CELADON_MART_ROOF",
  "CELADON_MART_ELEVATOR",
  "GAME_CORNER",
  "GAME_CORNER_PRIZE_ROOM",
  // Rocket Hideout, Pokémon Tower and Saffron/Silph event chapter. These
  // maps are streamed from the Memory Stick on PSP; they are not resident as
  // one monolithic world allocation.
  "ROCKET_HIDEOUT_B1F",
  "ROCKET_HIDEOUT_B2F",
  "ROCKET_HIDEOUT_B3F",
  "ROCKET_HIDEOUT_B4F",
  "ROCKET_HIDEOUT_ELEVATOR",
  "POKEMON_TOWER_2F",
  "POKEMON_TOWER_3F",
  "POKEMON_TOWER_4F",
  "POKEMON_TOWER_5F",
  "POKEMON_TOWER_6F",
  "POKEMON_TOWER_7F",
  "MR_FUJIS_HOUSE",
  "SAFFRON_CITY",
  "SAFFRON_POKECENTER",
  "SAFFRON_MART",
  "SAFFRON_PIDGEY_HOUSE",
  "FIGHTING_DOJO",
  "SAFFRON_GYM",
  "SILPH_CO_1F",
  "SILPH_CO_2F",
  "SILPH_CO_3F",
  "SILPH_CO_4F",
  "SILPH_CO_5F",
  "SILPH_CO_6F",
  "SILPH_CO_7F",
  "SILPH_CO_8F",
  "SILPH_CO_9F",
  "SILPH_CO_10F",
  "SILPH_CO_11F",

];

export interface CookOptions {
  /** Keep faces the fixed camera set cannot see (the diagnostic A/B mode). */
  keepHidden?: boolean;
  /** Skip all carved tree levels (the legacy boxes-everywhere floor). */
  treeBoxes?: boolean;
}

export interface CookInput {
  gen: GenData;
  profile: Profile | null;
  redpp: RedppPack | null;
  audioJson?: Uint8Array;
  audioPrograms?: Uint8Array;
  mapNames?: readonly string[];
  options?: CookOptions;
}

export interface CookProgress {
  phase: "atlas" | "map" | "ground-bake" | "pack";
  completed: number;
  total: number;
  label: string;
}

export type CookProgressHook = (progress: CookProgress) => void;

export interface CookArtifacts {
  pak: Uint8Array;
  gameJson: Uint8Array;
  mapStats: { id: string; mapId: number; chunks: number; verts: number; stamps: number }[];
  buildingStats: BuildingStats;
  pakBytes: number;
  sections: { tag: string; bytes: number }[];
  colour: ColourPlan["stats"] | null;
  palettes: number;
}

function sheetKey(map: GameMap): string {
  return map.tileset.image.replace(/^assets\/generated\//, "").replace(/\.png$/, "");
}

/** Cook one complete VXPK in memory. All metadata is injected, making the
 * dependency closure suitable for a browser worker. */
export function cookVoxelPak(
  input: CookInput,
  onProgress?: CookProgressHook,
): CookArtifacts {
  const { gen, profile } = input;
  const mapNames = input.mapNames ?? DEFAULT_MAPS;
  const options = input.options ?? {};
  const redpp = input.redpp ? new Redpp(input.redpp) : null;

  const maps = mapNames.map((name) => {
    const def = gen.maps[name];
    if (!def) throw new Error(`unknown map: ${name}`);
    const tileset = gen.tilesets[def.tileset];
    if (!tileset) throw new Error(`unknown tileset: ${def.tileset} (map ${name})`);
    return new GameMap(def, tileset);
  });
  const cookedMaps = new Set(mapNames);

  // --- atlases -----------------------------------------------------------
  const terrainPage = 0;
  const terrain = buildTerrainPage(gen, maps.slice(0, 1).map((m) => m.tileset), redpp);
  const pages: PageDef[] = [terrain.page];
  const pageOwners: PageOwner[] = [{ kind: terrain.page.kind }];
  const uiPage = pages.length;
  pages.push(buildUiPage(gen));
  pageOwners.push({ kind: ATLAS_KIND.ui });

  const spriteIndex: Record<string, number> = {};
  const spriteKeys = Object.keys(gen.gfx)
    .filter((key) => key.startsWith("sprites/"))
    .sort();
  for (const key of spriteKeys) {
    spriteIndex[key.slice("sprites/".length)] = pages.length;
    pages.push(buildSpritePage(gen, key));
    pageOwners.push({ kind: ATLAS_KIND.sprites, spriteKey: key });
  }

  let emotePage: number | null = null;
  const emotes = buildEmotePage(gen);
  if (emotes) {
    emotePage = pages.length;
    pages.push(emotes);
    pageOwners.push({ kind: ATLAS_KIND.sprites });
  }

  const frontIndex: Record<string, number> = {};
  const backIndex: Record<string, number> = {};
  const frontKeys = Object.keys(gen.gfx)
    .filter((key) => key.startsWith("battle/front/"))
    .sort();
  const frontPageByKey = new Map<string, number>();
  for (const key of frontKeys) {
    frontPageByKey.set(key, pages.length);
    pages.push(buildPicPage(gen, key));
    pageOwners.push({ kind: ATLAS_KIND.pics });
  }
  const backKeys = Object.keys(gen.gfx)
    .filter((key) => key.startsWith("battle/back/"))
    .sort();
  const backPageByKey = new Map<string, number>();
  for (const key of backKeys) {
    backPageByKey.set(key, pages.length);
    pages.push(buildPicPage(gen, key));
    pageOwners.push({ kind: ATLAS_KIND.pics });
  }
  const pageForPath = (byKey: Map<string, number>, path: string | undefined) => {
    if (!path) return undefined;
    const key = path.replace(/^assets\/generated\//, "").replace(/\.png$/, "");
    return byKey.get(key);
  };
  for (const [id, def] of Object.entries(gen.pokemon)) {
    const front = pageForPath(frontPageByKey, def.spriteFront as string | undefined);
    if (front !== undefined) {
      frontIndex[id] = front;
      pageOwners[front].species = id;
    }
    const back = pageForPath(backPageByKey, def.spriteBack as string | undefined);
    if (back !== undefined) {
      backIndex[id] = back;
      pageOwners[back].species = id;
    }
  }
  if (gen.gfx["battle/redb"]) {
    backIndex.redb = pages.length;
    pages.push(buildPicPage(gen, "battle/redb"));
    pageOwners.push({ kind: ATLAS_KIND.pics });
  }
  onProgress?.({ phase: "atlas", completed: 1, total: 1, label: "atlases" });

  // Each tileset (or map-specific color variant) gets a small PC-baked page.
  const exceptions = new Set(Redpp.mapExceptions([...mapNames]));
  const terrainKey = (map: GameMap) => exceptions.has(map.id) ? map.id : map.tileset.id;
  const localTerrain = new Map<string, { layout: ReturnType<typeof buildTerrainPage>; page: number }>();
  for (const map of maps) {
    const key = terrainKey(map);
    if (localTerrain.has(key)) continue;
    const layout = buildTerrainPage(gen, [map.tileset], redpp, exceptions.has(map.id) ? map.id : null);
    layout.page.name = `terrain/${key}`;
    localTerrain.set(key, { layout, page: pages.length });
    pages.push(layout.page);
    pageOwners.push({ kind: ATLAS_KIND.terrain });
    for (const sheet of layout.bakedSheets) terrain.bakedSheets.add(sheet);
  }

  // Colour planning depends on atlas ownership and map metadata, not geometry.
  // Doing it before the map loop lets each MapGeometry be ground-baked and
  // released immediately instead of retaining all maps at once.
  const colour = redpp
    ? planColour(gen, redpp, {
        base: paletteBase(gen),
        maps: maps.map((map) => ({
          id: map.id,
          mapId: map.def.index,
          tileset: map.def.tileset,
          index: map.def.index,
          sheetKey: sheetKey(map),
        })),
        bakedSheets: terrain.bakedSheets,
        terrainPage,
        pages: pageOwners,
      })
    : null;
  const palettes = buildPalettes(gen, colour?.palettes ?? []);

  // --- maps + immediate ground bake -------------------------------------
  const buildingStats: BuildingStats = { built: [], claimOnly: [], skipped: [], placements: 0 };
  const mapStats: CookArtifacts["mapStats"] = [];
  const packedMaps: PakInput["maps"] = [];
  let bakedChunks = 0;
  // PC-built, ready-to-stream terrain pages. Maps sharing a tileset also
  // share its small page, so connection seams never duplicate that RAM.
  // Keep page 0 as the legacy fallback; storage size is not a RAM budget.
  const mapTerrainPages = new Map<number, number>();

  for (let mi = 0; mi < maps.length; mi++) {
    const map = maps[mi];
    const masks: BorderMask[] = [];
    for (const [direction, connection] of Object.entries(map.def.connections ?? {})) {
      if (!cookedMaps.has(connection.map)) continue;
      const destination = gen.maps[connection.map];
      if (!destination) continue;
      const { ox, oy } = placeDirectNeighbour(
        direction as ConnectionDirection,
        connection,
        map.def,
        destination,
      );
      masks.push({
        x0: ox,
        z0: oy,
        x1: ox + destination.width * 32,
        z1: oy + destination.height * 32,
      });
    }
    // Viridian Forest's dense continuous canopy expands to ~2.9M carved
    // vertices, far beyond one PSP-1000 current-map cache. Its box canopy
    // preserves the maze silhouette at a fraction of that footprint.
    const treeBoxesForMap = (options.treeBoxes ?? false) || map.id === "VIRIDIAN_FOREST";
    let analysis: ReturnType<typeof analyseMap> | null = analyseMap(
      gen,
      map,
      profile,
      buildingStats,
      treeBoxesForMap,
    );
    let geometry: MapGeometry | null = runGeometry(
      map,
      analysis,
      masks,
      options.keepHidden ?? false,
    );
    // runGeometry has consumed every analysis product into its own streams.
    // Drop the large grids before ground baking this map.
    analysis = null;

    const local = localTerrain.get(terrainKey(map))!;
    const mapTerrain = local.layout;
    mapTerrainPages.set(map.def.index, local.page);
    const uvt: UvTransform = {
      baseX: mapTerrain.baseX.get(`${sheetKey(map)}#${map.tileset.id}`) ??
        mapTerrain.baseX.get(sheetKey(map)) ?? 0,
      baseY: mapTerrain.baseY.get(`${sheetKey(map)}#${map.tileset.id}`) ??
        mapTerrain.baseY.get(sheetKey(map)) ?? 0,
      pageW: mapTerrain.page.w,
      pageH: mapTerrain.page.h,
    };
    const packed = packMap(geometry, uvt);
    const verts = packed.chunks.reduce(
      (n, chunk) => n + chunk.meshes.reduce((m, mesh) => m + mesh.verts.length, 0),
      0,
    );
    mapStats.push({
      id: map.id,
      mapId: map.def.index,
      chunks: packed.chunks.length,
      verts,
      stamps: packed.stamps.length,
    });
    onProgress?.({ phase: "map", completed: mi + 1, total: maps.length, label: map.id });

    const worldPal = colour?.maps.find((entry) => entry.mapId === map.def.index)?.worldPal;
    const pal =
      worldPal !== undefined && worldPal !== COLOR_PAL_NONE ? palettes[worldPal] : palettes[0];
    const transparentIdx = (index: number) => (pal[index] >>> 24) === 0;
    let clearIndex = 0;
    for (let i = 0; i < 256; i++) {
      if ((pal[i] >>> 24) === 0) {
        clearIndex = i;
        break;
      }
    }
    const canvases = bakeGround(
      packed.chunks,
      geometry,
      mapTerrain.page,
      uvt,
      transparentIdx,
      clearIndex,
    );
    for (const [ci, canvas] of canvases) {
      const chunk = packed.chunks[ci];
      const keep: { verts: (typeof chunk.meshes)[0]["verts"]; indices: number[] } = {
        verts: [],
        indices: [],
      };
      const terrainMesh = chunk.meshes[MESH_KIND.terrain];
      for (let q = 0; q * 4 < terrainMesh.verts.length; q++) {
        const quad = terrainMesh.verts.slice(q * 4, q * 4 + 4);
        if (Math.max(...quad.map((vertex) => vertex.y)) <= BAKE_MAX_Y) continue;
        const base = keep.verts.length;
        keep.verts.push(...quad);
        keep.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
      const fullCanvas = new Uint8Array(BAKE_TEXELS * BAKE_PAGE_H).fill(clearIndex);
      fullCanvas.set(canvas, 0);
      const folded = foldFacades(
        keep.verts,
        fullCanvas,
        mapTerrain.page.frames[0],
        mapTerrain.page.w,
        mapTerrain.page.h,
        transparentIdx,
      );
      const keptVerts = folded.keep;
      const kept: typeof keep = { verts: keptVerts, indices: [] };
      for (let q = 0; q * 4 < keptVerts.length; q++) {
        kept.indices.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3);
      }
      chunk.meshes[MESH_KIND.terrainKeep] = kept;
      chunk.bakePage = pages.length;
      pages.push({
        w: BAKE_TEXELS,
        h: BAKE_PAGE_H,
        kind: ATLAS_KIND.terrain,
        frames: [fullCanvas],
        name: `bake/${map.def.index}/${chunk.cx},${chunk.cy}`,
      });
      pageOwners.push({ kind: ATLAS_KIND.terrain });

      const x0 = chunk.cx * 128;
      const z0 = chunk.cy * 128;
      const n = 8;
      const groundVScale = BAKE_TEXELS / BAKE_PAGE_H;
      const bakeVerts = [];
      for (let gz = 0; gz <= n; gz++) {
        for (let gx = 0; gx <= n; gx++) {
          bakeVerts.push({
            u: gx / n,
            v: (gz / n) * groundVScale,
            abgr: 0xffffffff,
            x: x0 + (gx * 128) / n,
            y: 0,
            z: z0 + (gz * 128) / n,
          });
        }
      }
      const bakeIndices: number[] = [];
      for (let gz = 0; gz < n; gz++) {
        for (let gx = 0; gx < n; gx++) {
          const base = gz * (n + 1) + gx;
          bakeIndices.push(
            base,
            base + 1,
            base + n + 2,
            base,
            base + n + 2,
            base + n + 1,
          );
        }
      }
      const facadeBase = bakeVerts.length;
      bakeVerts.push(...folded.facadeVerts);
      bakeIndices.push(...folded.facadeIndices.map((index) => index + facadeBase));
      chunk.meshes[MESH_KIND.groundBake] = { verts: bakeVerts, indices: bakeIndices };
      bakedChunks += 1;
    }
    onProgress?.({
      phase: "ground-bake",
      completed: mi + 1,
      total: maps.length,
      label: map.id,
    });

    packedMaps.push({ mapId: map.def.index, ...packed });
    // This explicit release is material in browser workers: before this
    // refactor eight full MapGeometry graphs stayed live through the bake.
    geometry = null;
  }

  // Append menu icons after every existing page. Terrain page indices,
  // geometry, textures and palettes remain unchanged by visible wilds.
  const partyIcons: Record<string, number> = {};
  for (const key of Object.keys(gen.gfx).filter(key => key.startsWith("icons/party_")).sort()) {
    partyIcons[key.slice("icons/party_".length)] = pages.length;
    pages.push(buildSpritePage(gen, key));
    pageOwners.push({ kind: ATLAS_KIND.sprites });
  }

  const followerSprites: Record<string, number> = {};
  const followerPages: Record<string, number> = {};
  for (const [id, def] of Object.entries(gen.pokemon)) {
    const icon = def.partyIcon as string | undefined;
    if (!icon || partyIcons[icon] === undefined) continue;
    if (followerPages[icon] === undefined) {
      followerPages[icon] = pages.length;
      pages.push(buildFollowerPage(gen, icon));
      pageOwners.push({ kind: ATLAS_KIND.sprites });
    }
    followerSprites[id] = followerPages[icon];
  }

  if (colour) {
    while (colour.pagePal.length < pages.length) colour.pagePal.push(COLOR_PAL_NONE);
  }

  // --- GAME + CMAP + pack ------------------------------------------------
  const atlas: AtlasIndex = {
    sprites: spriteIndex,
    partyIcons,
    followerSprites,
    picFront: frontIndex,
    picBack: backIndex,
    emotePage,
    uiPage,
    terrainPage,
  };
  const gameJson = buildGamedata(gen, atlas, [...mapNames], profile);
  const glyphs = buildCharmap(gen);
  const treeLod = packedMaps.some((map) =>
    map.chunks.some((chunk) => chunk.meshes[MESH_KIND.treeBox].indices.length > 0),
  );
  const treeCoarse = packedMaps.some((map) =>
    map.chunks.some((chunk) => chunk.meshes[MESH_KIND.treeCoarse].indices.length > 0),
  );

  onProgress?.({ phase: "pack", completed: 0, total: 1, label: "vxpk" });
  const { bytes: pak, stats } = writePak({
    palettes,
    pages,
    maps: packedMaps,
    glyphs,
    gameJson,
    audioJson: input.audioJson,
    audioPrograms: input.audioPrograms,
    emotePage,
    metaFlags:
      (treeLod ? VXPK_META_FLAG_TREE_LOD : 0) |
      (treeCoarse ? VXPK_META_FLAG_TREE_COARSE : 0) |
      (bakedChunks > 0 ? VXPK_META_FLAG_GROUND_BAKE : 0),
    colour: {
      maps: maps.map((map) => ({
        mapId: map.def.index,
        worldPal: colour?.maps.find((entry) => entry.mapId === map.def.index)?.worldPal ?? COLOR_PAL_NONE,
        terrainPage: mapTerrainPages.get(map.def.index)!,
      })),
      pagePal: colour?.pagePal ?? pages.map(() => COLOR_PAL_NONE),
      flags: colour?.flags ?? 0,
    },
  });
  onProgress?.({ phase: "pack", completed: 1, total: 1, label: "vxpk" });

  return {
    pak,
    gameJson,
    mapStats,
    buildingStats,
    pakBytes: stats.bytes,
    sections: stats.sections,
    colour: colour?.stats ?? null,
    palettes: palettes.length,
  };
}
