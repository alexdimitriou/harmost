import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export type Outcome = "created" | "skipped";

export interface ScaffoldResult {
  path: string;
  outcome: Outcome;
}

/**
 * Write a file only if it is absent.
 *
 * `init` is idempotent by construction (CLI spec §5): it never overwrites, so
 * re-running it on a live repo cannot destroy hand-edited state. Anything that
 * already exists is reported as skipped rather than silently left alone.
 */
export function writeIfAbsent(path: string, content: string): ScaffoldResult {
  if (existsSync(path)) return { path, outcome: "skipped" };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return { path, outcome: "created" };
}
