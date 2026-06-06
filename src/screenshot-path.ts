import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createScreenshotPath(): Promise<string> {
  const directory = join(tmpdir(), "pss-mgba-screenshots");
  await mkdir(directory, { recursive: true });
  return join(
    directory,
    `mgba-${Date.now()}-${process.pid}-${randomUUID()}.png`
  );
}
