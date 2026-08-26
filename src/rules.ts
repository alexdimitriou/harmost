import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import type { ChokePointArtifact } from "./ledger.js";
import { containsTerm } from "./match.js";

export type RuleState = "enforced" | "declared" | "failed";

export interface RuleResult {
  state: RuleState;
  detail: string;
  /** Files that broke the rule. The count the ratchet will one day lock. */
  violations: string[];
}

/** Named individually; beyond this the list is summarised rather than dumped. */
const MAX_NAMED = 10;

/**
 * The files a rule may look at: tracked files, and nothing else.
 *
 * `git ls-files` rather than a directory walk, for the reason artifact paths
 * must resolve inside the repository — a verdict has to be reproducible from a
 * clean clone. An untracked file is not in the clone, so what it contains is
 * not a property of what the repository ships. It also bounds the scan without
 * a hand-maintained ignore list that would drift from `.gitignore`.
 */
function trackedFiles(root: string): string[] | null {
  let result;
  try {
    result = spawnSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  if (result.error || result.status !== 0) return null;
  return (result.stdout ?? "").split("\0").filter((path) => path.length > 0);
}

const matchesAny = (path: string, globs: string[]): boolean =>
  globs.some((glob) => matchesGlob(path, glob));

const globList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((g): g is string => typeof g === "string" && g.length > 0) : [];

/**
 * Methodology §3.1, literally: symbol Y is referenced only from files matching X.
 *
 * `symbol` is the thing that must not spread — a construction expression, a
 * literal, a privileged call — not the API other modules are supposed to use.
 * Naming an exported function here makes every legitimate import a violation,
 * which is a rule that fails everywhere it succeeds.
 *
 * Evaluated offline against the working tree. Nothing here executes anything
 * from the ledger — the rule is data, and this is the code that reads it. That
 * is what keeps an ADR from being a code-execution surface on CI.
 */
export function evaluateChokePoint(
  root: string,
  rule: ChokePointArtifact,
  testGlobs: string[] = [],
): RuleResult {
  const symbol = typeof rule.symbol === "string" ? rule.symbol.trim() : "";
  const scope = globList(rule.in);
  const onlyFrom = globList(rule["only-from"]);
  const no = (detail: string): RuleResult => ({ state: "failed", detail, violations: [] });

  if (symbol.length === 0) return no("choke-point rule has no `symbol`");
  // `in` is required rather than defaulting to the whole repository. A rule
  // with no stated scope would read every tracked file of a monorepo on every
  // run, and a default that expensive is one people switch off.
  if (scope.length === 0) {
    return no(`choke-point \`${symbol}\` has no \`in\` scope — a rule must say where it looks`);
  }
  if (onlyFrom.length === 0) {
    return no(`choke-point \`${symbol}\` has no \`only-from\` — a choke point with no permitted site permits nothing`);
  }

  const files = trackedFiles(root);
  if (files === null) {
    // Never green on a guess: if the file list cannot be produced the same way
    // twice, neither can the verdict.
    return {
      state: "declared",
      detail: `choke-point \`${symbol}\` — could not list tracked files; is this a git repository?`,
      violations: [],
    };
  }

  // Tests are excluded, not by the rule's author remembering to exclude them
  // but by the config that already says where tests live. A test names the
  // symbol precisely because it is checking it — counting that as a violation
  // would make the check that holds the rule the first thing to break it.
  const scanned = files.filter(
    (file) => matchesAny(file, scope) && !matchesAny(file, testGlobs),
  );
  if (scanned.length === 0) {
    return no(
      `choke-point \`${symbol}\` — no non-test tracked file matches \`in\` (${scope.join(", ")}); a rule that scans nothing is not enforcement`,
    );
  }

  const hits: string[] = [];
  for (const file of scanned) {
    let source: string;
    try {
      source = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    if (containsTerm(source, symbol)) hits.push(file);
  }

  if (hits.length === 0) {
    // A choke point over a symbol that is not there is vacuously true, and
    // vacuous truth reports green forever: one typo in `symbol` would become
    // permanent enforcement of nothing, which is the flattering metric Q7 was
    // raised to remove.
    return no(
      `choke-point \`${symbol}\` — the symbol appears in none of the ${scanned.length} scanned files; a choke point over nothing is not enforcement`,
    );
  }

  const violations = hits.filter((file) => !matchesAny(file, onlyFrom));
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

  if (violations.length === 0) {
    return {
      state: "enforced",
      detail: `choke-point \`${symbol}\` — ${plural(hits.length, "reference")}, all within ${onlyFrom.join(", ")} (${plural(scanned.length, "file")} scanned)`,
      violations: [],
    };
  }

  const named = violations.slice(0, MAX_NAMED).join(", ");
  const rest = violations.length > MAX_NAMED ? `, and ${violations.length - MAX_NAMED} more` : "";
  return {
    state: "failed",
    detail: `choke-point \`${symbol}\` — ${plural(violations.length, "site")} outside ${onlyFrom.join(", ")}: ${named}${rest}`,
    violations,
  };
}
