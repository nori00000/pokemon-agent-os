import type { MgbaHttpClient } from "../mgba-http";
import type { OccupancyGrid } from "./pathfinder";

/**
 * RAM memory-map parsing -> walkability mask. Instead of discovering walls by
 * bumping into them, read the on-screen tilemap from RAM each step and mark the
 * surrounding tiles free/blocked in the OccupancyGrid, so A* routes over the
 * real collision map on the first try (solves maze navigation like Route 1).
 */

const TILEMAP_ADDR = 0xc3_a0; // wTileMap: 20x18 on-screen background tiles
const TILEMAP_W = 20;
const TILEMAP_H = 18;
const TILESET_ADDR = 0xd3_67; // wCurMapTileset

// Walkable tile ids per tileset (pret data/tilesets/collision_tile_ids.asm).
// OVERWORLD tileset id 0 is used by Pallet Town, Route 1, Viridian, etc.
const OVERWORLD_WALKABLE: ReadonlySet<number> = new Set([
  0x00, 0x10, 0x1b, 0x20, 0x21, 0x23, 0x2c, 0x2d, 0x2e, 0x30, 0x31, 0x33, 0x39,
  0x3c, 0x3e, 0x52, 0x54, 0x58, 0x5b,
]);

const WALKABLE_BY_TILESET: Readonly<Record<number, ReadonlySet<number>>> = {
  0: OVERWORLD_WALKABLE,
};

export interface ScreenCenter {
  col: number;
  row: number;
}

// Player's fixed standing tile within the 20x18 screen tilemap. Calibratable;
// override via AGENT_OS_CENTER_COL / AGENT_OS_CENTER_ROW.
export const DEFAULT_CENTER: ScreenCenter = { col: 8, row: 9 };

export function isWalkable(tilesetId: number, tileId: number): boolean {
  const set = WALKABLE_BY_TILESET[tilesetId];
  if (!set) {
    return true; // unknown tileset -> optimistic (defer to bump learning)
  }
  return set.has(tileId);
}

export function parseTileRange(body: string): number[] {
  return body
    .trim()
    .split(",")
    .map((hex) => Number.parseInt(hex.trim(), 16))
    .filter((value) => Number.isInteger(value));
}

export async function readTileMap(
  client: MgbaHttpClient,
  signal?: AbortSignal
): Promise<number[]> {
  const body = await client.request("/core/readrange", {
    params: {
      address: `0x${TILEMAP_ADDR.toString(16)}`,
      length: TILEMAP_W * TILEMAP_H,
    },
    signal,
  });
  return parseTileRange(body);
}

/**
 * Translate the on-screen tilemap to map-coordinate walkability and write it
 * into the OccupancyGrid. The screen scrolls with the player, so the player's
 * map position (px,py) sits at the fixed screen tile `center`.
 */
export function maskFromTileMap(
  grid: OccupancyGrid,
  mapKey: string,
  tiles: readonly number[],
  tilesetId: number,
  px: number,
  py: number,
  center: ScreenCenter = DEFAULT_CENTER
): { blocked: number; free: number } {
  let free = 0;
  let blocked = 0;
  for (let row = 0; row < TILEMAP_H; row += 1) {
    for (let col = 0; col < TILEMAP_W; col += 1) {
      const tileId = tiles[row * TILEMAP_W + col];
      if (tileId === undefined) {
        continue;
      }
      const mx = px + (col - center.col);
      const my = py + (row - center.row);
      if (mx < 0 || my < 0) {
        continue;
      }
      if (isWalkable(tilesetId, tileId)) {
        grid.markFree(mapKey, mx, my);
        free += 1;
      } else {
        grid.markBlocked(mapKey, mx, my);
        blocked += 1;
      }
    }
  }
  return { blocked, free };
}

export interface MaskOptions {
  center: ScreenCenter;
}

/** Read the live tilemap + tileset and apply the walkability mask to the grid. */
export async function applyMemoryMask(
  client: MgbaHttpClient,
  grid: OccupancyGrid,
  mapKey: string,
  px: number,
  py: number,
  options: MaskOptions,
  signal?: AbortSignal
): Promise<void> {
  const [tiles, tileset] = await Promise.all([
    readTileMap(client, signal),
    client.read8(TILESET_ADDR, signal),
  ]);
  if (tiles.length < TILEMAP_W * TILEMAP_H) {
    return; // partial read; skip rather than mask wrong tiles
  }
  maskFromTileMap(grid, mapKey, tiles, tileset, px, py, options.center);
}
