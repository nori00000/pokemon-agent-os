import type { MapCoord, MoveButton } from "./knowledge";

type Cell = "blocked" | "free";

/**
 * Per-map occupancy learned empirically: when a directional move fails to change
 * position, the target tile is marked blocked. A* then routes around it. Unknown
 * tiles are treated as passable (optimistic), so the agent explores then learns.
 */
export class OccupancyGrid {
  readonly #cells = new Map<string, Cell>();

  static key(mapKey: string, x: number, y: number): string {
    return `${mapKey}:${x}:${y}`;
  }

  mark(mapKey: string, x: number, y: number, cell: Cell): void {
    this.#cells.set(OccupancyGrid.key(mapKey, x, y), cell);
  }

  markFree(mapKey: string, x: number, y: number): void {
    this.mark(mapKey, x, y, "free");
  }

  markBlocked(mapKey: string, x: number, y: number): void {
    this.mark(mapKey, x, y, "blocked");
  }

  isBlocked(mapKey: string, x: number, y: number): boolean {
    return this.#cells.get(OccupancyGrid.key(mapKey, x, y)) === "blocked";
  }

  get size(): number {
    return this.#cells.size;
  }
}

const STEP_DELTA: Record<MoveButton, MapCoord> = {
  Down: { x: 0, y: 1 },
  Left: { x: -1, y: 0 },
  Right: { x: 1, y: 0 },
  Up: { x: 0, y: -1 },
};

const MOVES: readonly MoveButton[] = ["Up", "Down", "Left", "Right"];

export function stepDelta(button: MoveButton): MapCoord {
  return STEP_DELTA[button];
}

function manhattan(ax: number, ay: number, b: MapCoord): number {
  return Math.abs(ax - b.x) + Math.abs(ay - b.y);
}

interface Came {
  dir: MoveButton;
  prev: string;
}

function lowestF(open: Map<string, number>): string {
  let bestKey = "";
  let bestF = Number.POSITIVE_INFINITY;
  for (const [key, f] of open) {
    if (f < bestF) {
      bestF = f;
      bestKey = key;
    }
  }
  return bestKey;
}

function firstDirection(
  came: Map<string, Came>,
  startKey: string,
  goalKey: string
): MoveButton | null {
  let cursor = goalKey;
  let firstDir: MoveButton | null = null;
  while (cursor !== startKey) {
    const step = came.get(cursor);
    if (!step) {
      return null;
    }
    firstDir = step.dir;
    cursor = step.prev;
  }
  return firstDir;
}

/**
 * A* over the 4-connected grid toward `to`, avoiding learned-blocked tiles.
 * Returns the first step's button, or null if no route is found within budget.
 */
export function nextStepToward(
  grid: OccupancyGrid,
  mapKey: string,
  from: MapCoord,
  to: MapCoord,
  maxNodes = 4000
): MoveButton | null {
  if (from.x === to.x && from.y === to.y) {
    return null;
  }
  const startKey = `${from.x},${from.y}`;
  const gScore = new Map<string, number>([[startKey, 0]]);
  const open = new Map<string, number>([
    [startKey, manhattan(from.x, from.y, to)],
  ]);
  const came = new Map<string, Came>();

  for (let nodes = 0; nodes < maxNodes && open.size > 0; nodes += 1) {
    const currentKey = lowestF(open);
    open.delete(currentKey);
    const [cx, cy] = currentKey.split(",").map(Number);
    if (cx === to.x && cy === to.y) {
      return firstDirection(came, startKey, currentKey);
    }
    expandNeighbors({
      came,
      current: currentKey,
      cx,
      cy,
      gScore,
      grid,
      mapKey,
      open,
      to,
    });
  }
  return null;
}

interface ExpandArgs {
  came: Map<string, Came>;
  current: string;
  cx: number;
  cy: number;
  grid: OccupancyGrid;
  gScore: Map<string, number>;
  mapKey: string;
  open: Map<string, number>;
  to: MapCoord;
}

function expandNeighbors(args: ExpandArgs): void {
  const currentG = args.gScore.get(args.current) ?? Number.POSITIVE_INFINITY;
  for (const dir of MOVES) {
    const d = STEP_DELTA[dir];
    const nx = args.cx + d.x;
    const ny = args.cy + d.y;
    if (nx < 0 || ny < 0 || args.grid.isBlocked(args.mapKey, nx, ny)) {
      continue;
    }
    const neighborKey = `${nx},${ny}`;
    const tentative = currentG + 1;
    if (
      tentative < (args.gScore.get(neighborKey) ?? Number.POSITIVE_INFINITY)
    ) {
      args.gScore.set(neighborKey, tentative);
      args.came.set(neighborKey, { dir, prev: args.current });
      args.open.set(neighborKey, tentative + manhattan(nx, ny, args.to));
    }
  }
}
