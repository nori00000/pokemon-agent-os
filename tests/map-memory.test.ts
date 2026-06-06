import { describe, expect, it } from "vitest";
import { isWalkable, MapMemory } from "../src/game/map-memory";

describe("MapMemory", () => {
  it("treats unknown, walkable, grass, door, and warp as walkable", () => {
    expect(isWalkable("unknown")).toBe(true);
    expect(isWalkable("walkable")).toBe(true);
    expect(isWalkable("grass")).toBe(true);
    expect(isWalkable("door")).toBe(true);
    expect(isWalkable("warp")).toBe(true);
  });

  it("learns collision tiles as blocked", () => {
    const memory = new MapMemory();
    memory.learnCollision("pallet", 3, 4);

    expect(memory.walkabilityGrid("pallet", 5, 5)[4]?.[3]).toBe(false);
  });

  it("treats NPC occupied tiles as temporary blocked", () => {
    const memory = new MapMemory();
    memory.recordTile("route-1", 1, 1, "npc");

    expect(memory.walkabilityGrid("route-1", 3, 3)[1]?.[1]).toBe(false);
    expect(memory.walkabilityGrid("route-1", 3, 3)[2]?.[2]).toBe(true);
  });
});
