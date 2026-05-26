import { describe, expect, it } from "vitest";
import { MgbaHttpClient } from "../src/mgba-http";
import { createMgbaControlPlane } from "../src/tools";

describe("createMgbaControlPlane", () => {
  it("registers control-only mGBA tools by default", () => {
    const tools = createMgbaControlPlane({
      client: new MgbaHttpClient({ baseUrl: "http://127.0.0.1:5000" }),
    });

    expect(tools).not.toHaveProperty("mgba_reset");
    expect(tools).not.toHaveProperty("mgba_load_rom");
    expect(Object.keys(tools).sort()).toEqual([
      "mgba_hold",
      "mgba_hold_many",
      "mgba_release",
      "mgba_tap",
      "mgba_tap_many",
    ]);
  });
});
