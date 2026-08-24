import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CONFIG_FILE, DEFAULT_ADR_DIR, INVOCATION, PRODUCT_NAME } from "./name.js";
import { readConfig } from "./config-read.js";
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
function registerClaudeHook(path: string, tools: readonly string[]): ScaffoldResult {
  let existing: ClaudeSettings = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, "utf8")) as ClaudeSettings;
    } catch {
      // Their file, and it does not parse. Overwriting it would destroy
      // permissions and hooks we cannot read. Refuse loudly: reporting this as
      // a plain "exists" would leave the user believing the hook is registered
      // when nothing was written — governance that is silently inert.
      return { path, outcome: "refused", reason: "file is not valid JSON — left untouched, hook NOT registered" };
    }
  }

  const outcome = mergeHookRegistration(existing, tools);
  if (outcome.status === "unchanged") return { path, outcome: "skipped" };
  if (outcome.status === "refused") {
    return { path, outcome: "refused", reason: `${outcome.reason} — left untouched, hook NOT registered` };
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(outcome.settings, null, 2) + "\n", "utf8");
  } catch (error) {
    return { path, outcome: "refused", reason: (error as Error).message };
  }
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

  // Honour an adr_dir the user already configured. Writing the template to the
  // default while `new` reads the configured directory would silently strand
  // every edit they make to it.
  let adrDir = DEFAULT_ADR_DIR;
  let tools: readonly string[] = [];
  if (existsSync(at(CONFIG_FILE))) {
    try {
      const config = readConfig(root);
      adrDir = config.adrDir;
      // Register the matcher the config actually asks for. A hard-coded matcher
      // means a tool added to hook.tools is never routed to us, and the hook
      // stays silent on exactly the edits the user set out to cover.
      tools = config.hook.tools;
    } catch {
      // Unreadable config: fall back to the defaults rather than fail the scaffold.
    }
  }

  const results: ScaffoldResult[] = [
    writeIfAbsent(at(CONFIG_FILE), DEFAULT_CONFIG),
    writeIfAbsent(at(join(adrDir, "TEMPLATE.md")), packagedTemplate()),
  ];
  if (options.claude) results.push(registerClaudeHook(at(CLAUDE_SETTINGS), tools));
  if (options.ci) results.push(writeIfAbsent(at(WORKFLOW_PATH), GITHUB_WORKFLOW));
  return results;
}

export function report(results: ScaffoldResult[], root: string): string {
  const rel = (p: string) => (p.startsWith(root) ? p.slice(root.length + 1) : p);
  const created = results.filter((r) => r.outcome === "created");
  const refused = results.filter((r) => r.outcome === "refused");
  const lines = [
    ...created.map((r) => `  created  ${rel(r.path)}`),
    ...results.filter((r) => r.outcome === "skipped").map((r) => `  exists   ${rel(r.path)}`),
    ...refused.map((r) => `  REFUSED  ${rel(r.path)} — ${r.reason ?? "unknown reason"}`),
  ];

  if (refused.length > 0) {
    lines.push(
      "",
      `${refused.length} item${refused.length === 1 ? "" : "s"} could not be written. Nothing was overwritten.`,
      "Resolve the above and re-run — init is safe to repeat.",
    );
  }

  if (created.length === 0 && refused.length === 0) {
    lines.push("", `Nothing to do — ${PRODUCT_NAME} is already initialised here.`);
  } else if (created.length > 0) {
    lines.push(
      "",
      "Next:",
      `  ${INVOCATION} new "<the rule, in one sentence>" --class 2 --symbols <identifiers>`,
      `  ${INVOCATION} check`,
    );
  }
  return lines.join("\n");
}
