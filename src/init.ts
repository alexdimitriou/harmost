import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CONFIG_FILE, DEFAULT_ADR_DIR, INVOCATION, PRODUCT_NAME } from "./name.js";
import { DEFAULT_CONFIG } from "./config.js";
import { writeIfAbsent, type ScaffoldResult } from "./scaffold.js";
import { mergeHookRegistration, type ClaudeSettings } from "./claude-settings.js";
import { GITHUB_WORKFLOW, WORKFLOW_PATH } from "./ci-github.js";

export interface InitOptions {
  claude?: boolean;
  ci?: string;
  cwd?: string;
}

const CLAUDE_SETTINGS = ".claude/settings.json";

function packagedTemplate(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "..", "templates", "ADR-TEMPLATE.md"), "utf8");
}

/**
 * settings.json is merged into, never replaced — it is the user's file and may
 * carry hooks, permissions and env we know nothing about. writeIfAbsent is
 * therefore wrong here; the idempotency lives in mergeHookRegistration instead.
 */
function registerClaudeHook(path: string): ScaffoldResult {
  const existing: ClaudeSettings = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as ClaudeSettings)
    : {};
  const { settings, changed } = mergeHookRegistration(existing);
  if (!changed) return { path, outcome: "skipped" };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return { path, outcome: "created" };
}

export function init(options: InitOptions = {}): ScaffoldResult[] {
  const root = options.cwd ?? process.cwd();
  const at = (p: string) => join(root, p);

  if (options.ci !== undefined && options.ci !== "github") {
    throw new Error(
      `unknown --ci target "${options.ci}". Only "github" generates a workflow; ` +
        `every other CI system needs one line: run \`${INVOCATION} check\`.`,
    );
  }

  const results: ScaffoldResult[] = [
    writeIfAbsent(at(CONFIG_FILE), DEFAULT_CONFIG),
    writeIfAbsent(at(join(DEFAULT_ADR_DIR, "TEMPLATE.md")), packagedTemplate()),
  ];
  if (options.claude) results.push(registerClaudeHook(at(CLAUDE_SETTINGS)));
  if (options.ci) results.push(writeIfAbsent(at(WORKFLOW_PATH), GITHUB_WORKFLOW));
  return results;
}

export function report(results: ScaffoldResult[], root: string): string {
  const rel = (p: string) => (p.startsWith(root) ? p.slice(root.length + 1) : p);
  const created = results.filter((r) => r.outcome === "created");
  const lines = [
    ...created.map((r) => `  created  ${rel(r.path)}`),
    ...results.filter((r) => r.outcome === "skipped").map((r) => `  exists   ${rel(r.path)}`),
  ];

  if (created.length === 0) {
    lines.push("", `Nothing to do — ${PRODUCT_NAME} is already initialised here.`);
  } else {
    lines.push(
      "",
      "Next:",
      `  ${INVOCATION} new "<the rule, in one sentence>" --class 2 --symbols <identifiers>`,
      `  ${INVOCATION} check`,
    );
  }
  return lines.join("\n");
}
