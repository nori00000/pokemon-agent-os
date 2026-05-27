import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createScreenshotPath } from "../src/screenshot-path";

describe("createScreenshotPath", () => {
  it("uses unique internal paths for concurrent screenshots", async () => {
    const paths = await Promise.all([
      createScreenshotPath(),
      createScreenshotPath(),
      createScreenshotPath(),
    ]);

    expect(new Set(paths).size).toBe(3);
    expect(
      paths.every((path) =>
        path.startsWith(`${tmpdir()}/pss-mgba-screenshots/`)
      )
    ).toBe(true);
  });
});
