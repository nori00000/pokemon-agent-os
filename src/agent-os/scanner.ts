import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { MgbaHttpClient } from "../mgba-http";
import type { PokemonStateObservation } from "../pokemon-state";
import { readPokemonStateObservation } from "../pokemon-state";
import type { MapCoord, MoveButton, SpatialGraph } from "./knowledge";
import {
  directionToTarget,
  loadSpatialGraph,
  resolveMapKey,
} from "./knowledge";
import type { RunnerOptions } from "./os-runner";
import { pressButton, sleep } from "./os-runner";
import { nextStepToward, OccupancyGrid, stepDelta } from "./pathfinder";

const SCAN_DIRS: readonly MoveButton[] = ["Up", "Down", "Left", "Right"];
const RETURN_DIRS: readonly MoveButton[] = ["Down", "Up", "Left", "Right"];

export interface ScanExit {
  arriveMapId: number | null;
  arriveX: number | null;
  arriveY: number | null;
  dir: MoveButton;
  fromX: number;
  fromY: number;
}

export interface ScanResult {
  exits: ScanExit[];
  startMapId: number | null;
  startMapKey: string | null;
  walkableTiles: number;
}

function preblockWarps(
  grid: OccupancyGrid,
  spatial: SpatialGraph,
  startMapId: number | null
): void {
  const key = resolveMapKey(spatial, startMapId);
  if (key === null) {
    return;
  }
  const node = spatial.maps[key];
  if (!node) {
    return;
  }
  const mk = `${startMapId}`;
  for (const exit of node.exits) {
    if (exit.type === "warp") {
      grid.markBlocked(mk, exit.trigger.x, exit.trigger.y);
    }
  }
}

/** Nearest unvisited, unblocked neighbor of any visited tile (the frontier). */
function pickFrontier(
  grid: OccupancyGrid,
  visited: ReadonlySet<string>,
  mk: string,
  from: MapCoord
): MapCoord | null {
  let best: MapCoord | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const key of visited) {
    const [vx, vy] = key.split(",").map(Number);
    for (const dir of SCAN_DIRS) {
      const d = stepDelta(dir);
      const nx = vx + d.x;
      const ny = vy + d.y;
      if (nx < 0 || ny < 0 || visited.has(`${nx},${ny}`)) {
        continue;
      }
      if (grid.isBlocked(mk, nx, ny)) {
        continue;
      }
      const dist = Math.abs(nx - from.x) + Math.abs(ny - from.y);
      if (dist < bestDist) {
        bestDist = dist;
        best = { x: nx, y: ny };
      }
    }
  }
  return best;
}

/** After a transition, walk back into the start map (Down handles most cases). */
async function returnToMap(
  client: MgbaHttpClient,
  startMapId: number | null,
  settleMs: number,
  signal?: AbortSignal
): Promise<PokemonStateObservation> {
  for (const dir of RETURN_DIRS) {
    for (let i = 0; i < 3; i += 1) {
      const st = await readPokemonStateObservation(client, signal);
      if (st.mapId === startMapId) {
        return st;
      }
      await pressButton(client, dir, signal);
      await sleep(settleMs);
    }
  }
  return readPokemonStateObservation(client, signal);
}

interface StepArgs {
  client: MgbaHttpClient;
  dir: MoveButton;
  exits: ScanExit[];
  grid: OccupancyGrid;
  mk: string;
  outPath: string;
  settleMs: number;
  signal?: AbortSignal;
  startMapId: number | null;
  x: number;
  y: number;
}

function facesDir(direction: string, dir: MoveButton): boolean {
  return direction === dir.toLowerCase();
}

async function pressAndRead(
  client: MgbaHttpClient,
  dir: MoveButton,
  settleMs: number,
  signal?: AbortSignal
): Promise<PokemonStateObservation> {
  await pressButton(client, dir, signal);
  await sleep(settleMs);
  return readPokemonStateObservation(client, signal);
}

async function scanStep(p: StepArgs): Promise<PokemonStateObservation> {
  let next = await pressAndRead(p.client, p.dir, p.settleMs, p.signal);
  // Pokémon turns to face a new direction on the first press without stepping;
  // if we only turned, press once more to actually step before judging blocked.
  const turnedOnly =
    next.mapId === p.startMapId &&
    next.position.x === p.x &&
    next.position.y === p.y &&
    facesDir(next.direction, p.dir);
  if (turnedOnly) {
    next = await pressAndRead(p.client, p.dir, p.settleMs, p.signal);
  }
  const d = stepDelta(p.dir);
  if (next.mapId !== null && next.mapId !== p.startMapId) {
    const exit: ScanExit = {
      arriveMapId: next.mapId,
      arriveX: next.position.x,
      arriveY: next.position.y,
      dir: p.dir,
      fromX: p.x,
      fromY: p.y,
    };
    p.exits.push(exit);
    appendFileSync(p.outPath, `${JSON.stringify(exit)}\n`);
    p.grid.markBlocked(p.mk, p.x + d.x, p.y + d.y);
    return next;
  }
  if (next.position.x === p.x && next.position.y === p.y) {
    p.grid.markBlocked(p.mk, p.x + d.x, p.y + d.y);
  }
  return next;
}

/**
 * Flood-fill the current map: visit every reachable tile and record every map
 * transition (exit) it finds. Known door warps are pre-blocked so the scan
 * stays in the current map and surfaces the unknown connection exits.
 */
export async function runScan(
  options: RunnerOptions,
  signal?: AbortSignal
): Promise<ScanResult> {
  const client = new MgbaHttpClient({ baseUrl: options.baseUrl });
  mkdirSync(options.logsDir, { recursive: true });
  const outPath = join(options.logsDir, "scan.jsonl");
  const spatial = loadSpatialGraph(options.knowledgeDir);
  const grid = new OccupancyGrid();
  const visited = new Set<string>();
  const exits: ScanExit[] = [];

  let cur = await readPokemonStateObservation(client, signal);
  const startMapId = cur.mapId;
  const mk = `${startMapId}`;
  preblockWarps(grid, spatial, startMapId);

  for (let step = 0; step < options.maxSteps; step += 1) {
    if (signal?.aborted) {
      break;
    }
    if (cur.mapId !== startMapId) {
      cur = await returnToMap(client, startMapId, options.settleMs, signal);
      continue;
    }
    if (cur.position.x === null || cur.position.y === null) {
      break;
    }
    const x = cur.position.x;
    const y = cur.position.y;
    visited.add(`${x},${y}`);
    grid.markFree(mk, x, y);

    const target = pickFrontier(grid, visited, mk, { x, y });
    if (!target) {
      break;
    }
    const dir =
      nextStepToward(grid, mk, { x, y }, target) ??
      directionToTarget({ x, y }, target);
    if (!dir) {
      break;
    }
    cur = await scanStep({
      client,
      dir,
      exits,
      grid,
      mk,
      outPath,
      settleMs: options.settleMs,
      signal,
      startMapId,
      x,
      y,
    });
  }

  return {
    exits,
    startMapId,
    startMapKey: resolveMapKey(spatial, startMapId),
    walkableTiles: visited.size,
  };
}
