export type TileKind = "blocked" | "door" | "grass" | "npc" | "unknown" | "walkable" | "warp" | "water";

export interface MapMemoryRecord {
  height: number;
  mapId: string;
  tiles: Record<string, TileKind>;
  width: number;
}

export class MapMemory {
  readonly #records = new Map<string, MapMemoryRecord>();

  recordTile(mapId: string, x: number, y: number, kind: TileKind): void {
    const record = this.#recordFor(mapId);
    record.tiles[key(x, y)] = kind;
    record.width = Math.max(record.width, x + 1);
    record.height = Math.max(record.height, y + 1);
  }

  learnCollision(mapId: string, x: number, y: number): void {
    this.recordTile(mapId, x, y, "blocked");
  }

  walkabilityGrid(mapId: string, width = 20, height = 18): boolean[][] {
    const record = this.#recordFor(mapId);
    return Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) => isWalkable(record.tiles[key(x, y)] ?? "unknown"))
    );
  }

  toJSON(): Record<string, MapMemoryRecord> {
    return Object.fromEntries(this.#records);
  }

  #recordFor(mapId: string): MapMemoryRecord {
    const existing = this.#records.get(mapId);
    if (existing) {
      return existing;
    }
    const record: MapMemoryRecord = { height: 0, mapId, tiles: {}, width: 0 };
    this.#records.set(mapId, record);
    return record;
  }
}

export function isWalkable(kind: TileKind): boolean {
  if (kind === "blocked" || kind === "npc" || kind === "water") {
    return false;
  }
  return true;
}

function key(x: number, y: number): string {
  return `${y},${x}`;
}
