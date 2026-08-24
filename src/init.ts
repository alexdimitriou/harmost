import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

/**
 * Ask git which of these paths it ignores.
 *
 * `init --claude` happily reported "created .claude/settings.json" in a repo
 * whose .gitignore contains `.claude`. The file was written, the message was
 * true, and the hook was never going to reach a second developer: deterministic
 * delivery had quietly become per-developer opt-in, which is class 4 wearing
 * class 1's clothes. The tool has to say so — the whole product is the claim
 * that a mechanism holds without anyone remembering.
 *
 * Silent on anything unexpected (no git, not a repo, git not on PATH): a false
 * alarm here would train people to ignore the one warning that matters.
 */
function ignoredPaths(root: string, paths: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  if (paths.length === 0) return found;
  let result;
  try {
    // No --no-index: a path that was force-added is tracked, so it does reach
    // other clones and must not be warned about. Letting git consult the index
    // is what makes the warning mean "this will not travel".
    result = spawnSync("git", ["check-ignore", "-v", "--stdin"], {
      cwd: root,
      input: paths.join("\n"),
      encoding: "utf8",
    });
  } catch {
    return found;
  }
  // 0 = some ignored, 1 = none ignored, anything else = not a repo / no git.
  if (result.error || (result.status !== 0 && result.status !== 1)) return found;
  for (const line of (result.stdout ?? "").split("\n")) {
    // "<source>:<line>:<pattern>\t<path>"
    const tab = line.lastIndexOf("\t");
    if (tab === -1) continue;
    const rule = line.slice(0, tab);
    const path = line.slice(tab + 1);
    // "<source>:<linenum>:<pattern>" — keep source and line, drop the pattern.
    // Non-greedy so a pattern containing a colon cannot eat the line number.
    const located = /^(.*?:\d+):/.exec(rule);
    found.set(path, located ? located[1]! : rule);
  }
  return found;
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

  const landed = results.filter((r) => r.outcome !== "refused");
  const ignored = ignoredPaths(root, landed.map((r) => r.path));
  for (const result of landed) {
    const rule = ignored.get(result.path);
    if (rule !== undefined) result.ignoredBy = rule;
  }
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

  const ignored = results.filter((r) => r.ignoredBy !== undefined);
  if (ignored.length > 0) {
    lines.push(
      "",
      `WARNING — git ignores ${ignored.length === 1 ? "one of these files" : `${ignored.length} of these files`}, so ${ignored.length === 1 ? "it stays" : "they stay"} on this machine only:`,
      ...ignored.map((r) => `  ${rel(r.path)}  (ignored by ${r.ignoredBy})`),
      "",
      "None of this is enforcement until it reaches every clone. Un-ignore the",
      "path (a trailing `!` rule) or the mechanism is opt-in per developer —",
      "which is class 4, whatever the file says.",
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
