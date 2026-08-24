import { readFileSync, existsSync } from "node:fs";
import { join, isAbsolute, normalize, relative } from "node:path";
import { parse } from "yaml";
import { CONFIG_FILE, DEFAULT_ADR_DIR, INVOCATION } from "./name.js";

export interface Config {
  version: number;
  adrDir: string;
  testGlobs: string[];
  hook: { tools: string[]; maxInjectedAdrs: number };
  /** The name this repo is known by in the ledger, when the ledger names repos. */
  repo?: string;
}

export class NotInitialisedError extends Error {
  constructor(root: string) {
    super(
      `no ${CONFIG_FILE} in ${root}. Run \`${INVOCATION} init\` first.`,
    );
    this.name = "NotInitialisedError";
  }
}

interface RawConfig {
  version?: number;
  adr_dir?: string;
  test_globs?: string[];
  repo?: string;
  hook?: { tools?: string[]; max_injected_adrs?: number };
}

/** Read the host repo's config. Defaults fill anything absent — a config that
 *  parses but omits keys is valid; only a missing file is an error. */
/** The ledger must live inside the repo it governs: it is the repo's history,
 *  it is what CI checks out, and a ledger outside the working tree is neither
 *  reviewed in PRs nor present on another machine. */
function validateAdrDir(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error("`adr_dir` is empty");
  if (isAbsolute(trimmed)) throw new Error(`\`adr_dir\` must be repo-relative — got "${trimmed}"`);
  const normalised = normalize(trimmed);
  if (normalised === "." || normalised === "./" || normalised === "/") {
    throw new Error("`adr_dir` must name a subdirectory, not the repository root");
  }
  const escapes = relative(".", normalised).startsWith("..");
  if (escapes) throw new Error(`\`adr_dir\` escapes the repository — got "${trimmed}"`);
  return normalised;
}

export function readConfig(root: string): Config {
  const path = join(root, CONFIG_FILE);
  if (!existsSync(path)) throw new NotInitialisedError(root);
  const raw = (parse(readFileSync(path, "utf8")) ?? {}) as RawConfig;
  return {
    version: raw.version ?? 1,
    adrDir: raw.adr_dir === undefined ? DEFAULT_ADR_DIR : validateAdrDir(String(raw.adr_dir)),
    testGlobs: raw.test_globs ?? ["tests/**", "**/*.test.*", "**/*.spec.*"],
    hook: {
      tools: raw.hook?.tools ?? ["Edit", "Write", "MultiEdit"],
      maxInjectedAdrs: raw.hook?.max_injected_adrs ?? 3,
    },
    repo: raw.repo,
  };
}
