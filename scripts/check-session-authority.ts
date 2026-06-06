import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = process.cwd();

const RULES = [
  {
    allow: new Set([
      "src/mgba-http.ts",
      "src/agent-os/os-runner.ts",
      "src/session/input-gate.ts",
      "src/supervisor.ts",
      "src/tools/hold.ts",
      "src/tools/release.ts",
      "src/tools/tap.ts",
    ]),
    name: "low-level-input",
    pattern: /\.(?:tap|tapMany|hold|holdMany|clear|clearMany)\(/,
  },
  {
    allow: new Set(["src/agent/mode-gated-tool-factory.ts", "src/tools/index.ts"]),
    name: "tool-gating-authority",
    pattern: /isToolAllowedForMode|ModeGatedToolFactory|resolveTools/,
  },
  {
    allow: new Set(["src/session/input-gate.ts", "src/session/transition-detector.ts"]),
    name: "readiness-polling",
    pattern: /walkCounter|joyIgnore|windowY/,
  },
];

const files = await collectTypeScriptFiles(join(ROOT, "src"));
const violations: Array<{ file: string; rule: string }> = [];

for (const file of files) {
  const projectPath = relative(ROOT, file);
  const text = await readFile(file, "utf8");
  for (const rule of RULES) {
    if (rule.pattern.test(text) && !rule.allow.has(projectPath)) {
      violations.push({ file: projectPath, rule: rule.name });
    }
  }
}

if (violations.length > 0) {
  console.error(JSON.stringify({ authority_violations: violations }, null, 2));
  process.exit(1);
}

console.log("session authority check passed");

async function collectTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return collectTypeScriptFiles(path);
      }
      return entry.isFile() && path.endsWith(".ts") ? [path] : [];
    })
  );
  return nested.flat();
}
