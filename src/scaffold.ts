import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export type Outcome = "created" | "skipped" | "refused";

export interface ScaffoldResult {
  path: string;
  outcome: Outcome;
  /** Why we declined to touch it. Present only for "refused". */
  reason?: string;
  /** git ignores this path, so it will never reach another clone.
   *  `source` is the ignoring rule, e.g. ".gitignore:38". */
  ignoredBy?: string;
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
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  } catch (error) {
    // A path component exists as a plain file (EEXIST/ENOTDIR), the volume is
    // read-only, permissions deny it. Previously this threw out of init, which
    // aborted the whole scaffold after partial writes that were never reported.
    // Report it as one refused item and let the rest proceed.
    return { path, outcome: "refused", reason: (error as Error).message };
  }
  return { path, outcome: "created" };
}
