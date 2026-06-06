import { readFileSync } from "node:fs";
import { join } from "node:path";

export type MoveButton = "Down" | "Left" | "Right" | "Up";

export interface MapCoord {
  x: number;
  y: number;
}

export interface MapExit {
  target: (MapCoord & { map: string }) | null;
  to: string;
  trigger: MapCoord;
  type: string;
}

export interface MapNode {
  calibrated: boolean;
  exits: readonly MapExit[];
  key: string;
  landmarks: Readonly<Record<string, MapCoord>>;
  rawId: number;
}

export interface SpatialGraph {
  byRawId: ReadonlyMap<number, string>;
  maps: Readonly<Record<string, MapNode>>;
}

export interface Mission {
  id: string;
  name: string;
  order: number;
  recoveryPolicy: readonly string[];
  startMap: string | null;
  successMap: string | null;
  terminal: boolean;
}

export interface MissionGraph {
  missions: readonly Mission[];
}

export interface FailureEntry {
  evidence: readonly string[];
  recoveries: readonly string[];
  threshold: number;
}

export interface FailureDex {
  failures: Readonly<Record<string, FailureEntry>>;
}

interface RawExit {
  target?: { map: string; x: number; y: number };
  to: string;
  trigger: { x: number; y: number };
  type: string;
}

interface RawMap {
  calibrated?: boolean;
  exits?: RawExit[];
  landmarks?: Record<string, { x: number; y: number }>;
  map_raw_id: number;
}

export function parseSpatialGraph(raw: unknown): SpatialGraph {
  const maps: Record<string, MapNode> = {};
  const byRawId = new Map<number, string>();
  const rawMaps = (raw as { maps?: Record<string, RawMap> }).maps ?? {};
  for (const [key, value] of Object.entries(rawMaps)) {
    const node: MapNode = {
      calibrated: value.calibrated ?? false,
      exits: (value.exits ?? []).map((exit) => ({
        target: exit.target
          ? { map: exit.target.map, x: exit.target.x, y: exit.target.y }
          : null,
        to: exit.to,
        trigger: { x: exit.trigger.x, y: exit.trigger.y },
        type: exit.type,
      })),
      key,
      landmarks: value.landmarks ?? {},
      rawId: value.map_raw_id,
    };
    maps[key] = node;
    byRawId.set(node.rawId, key);
  }
  return { byRawId, maps };
}

export function parseMissionGraph(raw: unknown): MissionGraph {
  const rawMissions =
    (raw as { missions?: Record<string, unknown>[] }).missions ?? [];
  const missions: Mission[] = rawMissions.map((entry) => {
    const record = entry as {
      id: string;
      name: string;
      order: number;
      recovery_policy?: string[];
      start_condition?: { map?: string };
      success_condition?: { map?: string; terminal?: boolean };
    };
    return {
      id: record.id,
      name: record.name,
      order: record.order,
      recoveryPolicy: record.recovery_policy ?? [],
      startMap: record.start_condition?.map ?? null,
      successMap: record.success_condition?.map ?? null,
      terminal: record.success_condition?.terminal ?? false,
    };
  });
  missions.sort((a, b) => a.order - b.order);
  return { missions };
}

export function parseFailureDex(raw: unknown): FailureDex {
  const failures: Record<string, FailureEntry> = {};
  const rawFailures =
    (raw as { failures?: Record<string, RawFailure> }).failures ?? {};
  for (const [key, value] of Object.entries(rawFailures)) {
    failures[key] = {
      evidence: value.evidence ?? [],
      recoveries: value.recoveries ?? [],
      threshold: value.threshold ?? 0.7,
    };
  }
  return { failures };
}

interface RawFailure {
  evidence?: string[];
  recoveries?: string[];
  threshold?: number;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadSpatialGraph(knowledgeDir: string): SpatialGraph {
  return parseSpatialGraph(readJson(join(knowledgeDir, "spatial_graph.json")));
}

export function loadMissionGraph(knowledgeDir: string): MissionGraph {
  return parseMissionGraph(readJson(join(knowledgeDir, "mission_graph.json")));
}

export function loadFailureDex(knowledgeDir: string): FailureDex {
  return parseFailureDex(readJson(join(knowledgeDir, "failure_dex.json")));
}

export function resolveMapKey(
  graph: SpatialGraph,
  mapId: number | null
): string | null {
  if (mapId === null) {
    return null;
  }
  return graph.byRawId.get(mapId) ?? null;
}

/** BFS over inter-map exits. Returns the sequence of map keys from→to. */
export function findMapRoute(
  graph: SpatialGraph,
  fromKey: string,
  toKey: string
): string[] | null {
  if (fromKey === toKey) {
    return [fromKey];
  }
  const queue: string[] = [fromKey];
  const cameFrom = new Map<string, string>();
  const visited = new Set<string>([fromKey]);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const node = graph.maps[current];
    if (!node) {
      continue;
    }
    for (const exit of node.exits) {
      if (visited.has(exit.to)) {
        continue;
      }
      visited.add(exit.to);
      cameFrom.set(exit.to, current);
      if (exit.to === toKey) {
        return reconstructPath(cameFrom, fromKey, toKey);
      }
      queue.push(exit.to);
    }
  }
  return null;
}

function reconstructPath(
  cameFrom: Map<string, string>,
  fromKey: string,
  toKey: string
): string[] {
  const path: string[] = [toKey];
  let cursor = toKey;
  while (cursor !== fromKey) {
    const prev = cameFrom.get(cursor);
    if (prev === undefined) {
      break;
    }
    path.unshift(prev);
    cursor = prev;
  }
  return path;
}

/** The exit on `fromKey` that begins the route toward `toKey`. */
export function nextExitToward(
  graph: SpatialGraph,
  fromKey: string,
  toKey: string
): MapExit | null {
  const route = findMapRoute(graph, fromKey, toKey);
  if (!route || route.length < 2) {
    return null;
  }
  const nextMap = route[1];
  const node = graph.maps[fromKey];
  if (!node) {
    return null;
  }
  return node.exits.find((exit) => exit.to === nextMap) ?? null;
}

/** Axis-priority step from current tile toward a target tile. */
export function directionToTarget(
  from: MapCoord,
  to: MapCoord
): MoveButton | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) {
    return null;
  }
  if (Math.abs(dy) >= Math.abs(dx)) {
    return dy < 0 ? "Up" : "Down";
  }
  return dx < 0 ? "Left" : "Right";
}

export function manhattan(from: MapCoord, to: MapCoord): number {
  return Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
}

/** Lowest-order mission not yet completed whose start map matches (or any). */
export function selectMission(
  graph: MissionGraph,
  completed: ReadonlySet<string>,
  mapKey: string | null
): Mission | null {
  const pending = graph.missions.filter((m) => !completed.has(m.id));
  if (pending.length === 0) {
    return null;
  }
  if (mapKey) {
    const matching = pending.find((m) => m.startMap === mapKey);
    if (matching) {
      return matching;
    }
  }
  return pending[0];
}
