import { readFileSync, existsSync, statSync } from "node:fs";
import { matchesGlob } from "node:path";
import { join } from "node:path";
import { readConfig } from "./config-read.js";
import { ADR_FILE } from "./adr.js";
import { loadLedger, STATUSES, THIS_REPO, type AdrRecord, type Artifact } from "./ledger.js";

export type Verdict = "pass" | "fail" | "unverified";

export interface AdrResult {
  id: string;
  status: string;
  class: number | null;
  verdict: Verdict;
  file: string;
  failures: string[];
  unverifiedRepos: string[];
}

export interface CheckSummary {
  total: number;
  accepted: number;
  enforced: number;
  class4: number;
  unverified: number;
}

export interface CheckReport {
  results: AdrResult[];
  summary: CheckSummary;
  ok: boolean;
}

/** Whole-word match, so `test_login` does not satisfy a claim about `login`. */
function namedInFile(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(source);
}

/** A placeholder left by `new` is not a symbol. Without this, an untouched
 *  scaffold satisfies the "the hook could never surface this" rule while the
 *  hook can still never surface it. */
const isPlaceholder = (term: string): boolean => /^<.*>$/.test(term.trim());

function resolveArtifact(
  root: string,
  artifact: Artifact,
  testGlobs: string[],
  cache: Map<string, string | null>,
): string | null {
  if (!artifact || typeof artifact.file !== "string" || artifact.file.length === 0) {
    return "enforced-by entry has no `file`";
  }
  const path = join(root, artifact.file);
  if (!existsSync(path)) return `${artifact.file} does not exist`;

  if (!statSync(path).isFile()) return `${artifact.file} is not a file`;

  if (artifact.type === "lint") {
    // Existence only for the tracer. Verifying a lint actually runs belongs to
    // the host repo's own CI; this gate verifies the declared artifact is there.
    return null;
  }
  if (artifact.type !== "test") return `unknown enforced-by type "${String(artifact.type)}"`;
  if (typeof artifact.name !== "string" || artifact.name.length === 0) {
    return `${artifact.file} is declared as a test but names no test`;
  }
  // test_globs is where tests are allowed to live. Without this the config key
  // is decorative and a test artifact can point at production source, so the
  // gate would be satisfied by the very code it is supposed to be checking.
  if (testGlobs.length > 0 && !testGlobs.some((glob) => matchesGlob(artifact.file, glob))) {
    return `${artifact.file} is outside test_globs (${testGlobs.join(", ")}) — a test must live where tests live`;
  }
  if (!cache.has(path)) {
    try {
      cache.set(path, readFileSync(path, "utf8"));
    } catch {
      cache.set(path, null);
    }
  }
  const source = cache.get(path) ?? null;
  if (source === null) return `${artifact.file} could not be read`;
  return namedInFile(source, artifact.name)
    ? null
    : `${artifact.file} does not contain a test named ${artifact.name}`;
}

function validate(record: AdrRecord, ledger: AdrRecord[], root: string, thisRepo: string, testGlobs: string[], cache: Map<string, string | null>) {
  const failures: string[] = [];
  const unverifiedRepos: string[] = [];

  // Rule 1 — required fields.
  for (const [field, value] of [
    ["id", record.id],
    ["title", record.title],
    ["invariant", record.invariant],
  ] as const) {
    if (value.length === 0) failures.push(`missing required field \`${field}\``);
  }
  if (!STATUSES.includes(record.status)) {
    failures.push(`status must be one of ${STATUSES.join(", ")} — got "${String(record.status)}"`);
  }
  if (![1, 2, 3, 4].includes(record.enforcementClass)) {
    failures.push(`enforcement-class must be 1-4 — got "${String(record.enforcementClass)}"`);
  }
  const realSymbols = record.symbols.filter((sym) => !isPlaceholder(sym));
  const realEndpoints = record.endpoints.filter((e) => !isPlaceholder(e));
  if (realSymbols.length === 0 && realEndpoints.length === 0) {
    // Without either, the hook can never deliver this ADR to anyone.
    failures.push("no `symbols` or `endpoints` — the hook could never surface this rule");
  }

  // Rule 2 — id unique, and matching the filename.
  if (record.id.length > 0) {
    const clashes = ledger.filter((r) => r.id === record.id && r.file !== record.file);
    if (clashes.length > 0) {
      failures.push(`id also used by ${clashes.map((c) => c.file).join(", ")}`);
    }
    const fromFile = ADR_FILE.exec(record.file);
    if (fromFile && `ADR-${fromFile[1]}` !== record.id) {
      failures.push(`id ${record.id} does not match filename ${record.file}`);
    }
  }

  // Rule 5 — supersession is symmetric.
  if (record.supersedes !== null) {
    const target = ledger.find((r) => r.id === record.supersedes);
    if (!target) failures.push(`supersedes ${record.supersedes}, which is not in the ledger`);
    else if (target.status !== "superseded") {
      failures.push(`supersedes ${target.id}, but ${target.id} is \`${target.status}\`, not \`superseded\``);
    }
  }

  if (record.status === "accepted") {
    if (record.enforcementClass === 4) {
      // Rule 4 — class 4 is permitted, but never silently.
      if (record.justification === null || record.justification.trim().length === 0) {
        failures.push("accepted at class 4 with no `justification` — say why 1-3 are impossible");
      }
    } else if ([1, 2, 3].includes(record.enforcementClass)) {
      // Rule 3 — the coverage gate. Accepted means something holds it.
      const repos = Object.keys(record.enforcedBy);
      const local = record.enforcedBy[thisRepo] ?? record.enforcedBy[THIS_REPO] ?? [];
      const hasAny = repos.some((r) => (record.enforcedBy[r] ?? []).length > 0);

      if (!hasAny) {
        failures.push("accepted but `enforced-by` is empty — nothing holds this invariant");
      } else {
        for (const artifact of local) {
          const failure = resolveArtifact(root, artifact, testGlobs, cache);
          if (failure !== null) failures.push(failure);
        }
        if (local.length === 0 && repos.length > 0) {
          failures.push(`accepted but declares no enforcement for this repo (${thisRepo})`);
        }
        // Q5: other repos are named but cannot be verified from here. Report
        // them rather than passing them silently — a green gate over an
        // unenforced repo is the original SSO bug's shape one level up.
        for (const repo of repos) {
          if (repo !== thisRepo && repo !== THIS_REPO) unverifiedRepos.push(repo);
        }
      }
    }
  }

  return { failures, unverifiedRepos };
}

export function check(cwd: string): CheckReport {
  const config = readConfig(cwd);
  const thisRepo = config.repo ?? THIS_REPO;
  const { records, errors } = loadLedger(join(cwd, config.adrDir));
  const cache = new Map<string, string | null>();

  const results: AdrResult[] = errors.map((e) => ({
    id: e.file,
    status: "unreadable",
    class: null,
    verdict: "fail" as Verdict,
    file: e.file,
    failures: [e.message],
    unverifiedRepos: [],
  }));

  for (const record of records) {
    const { failures, unverifiedRepos } = validate(record, records, cwd, thisRepo, config.testGlobs, cache);
    results.push({
      id: record.id || record.file,
      status: String(record.status),
      class: typeof record.enforcementClass === "number" ? record.enforcementClass : null,
      verdict: failures.length > 0 ? "fail" : unverifiedRepos.length > 0 ? "unverified" : "pass",
      file: record.file,
      failures,
      unverifiedRepos,
    });
  }

  const accepted = records.filter((r) => r.status === "accepted");
  const verdictOf = new Map(results.map((r) => [r.file, r.verdict]));
  const summary: CheckSummary = {
    total: records.length,
    accepted: accepted.length,
    // "enforced" means the artifact actually resolved — not that one was
    // declared. Counting declarations would report a green number over a
    // missing test, which is the silent hole this gate exists to prevent.
    enforced: accepted.filter(
      (r) => [1, 2, 3].includes(r.enforcementClass) && verdictOf.get(r.file) !== "fail",
    ).length,
    class4: accepted.filter((r) => r.enforcementClass === 4).length,
    unverified: results.filter((r) => r.verdict === "unverified").length,
  };

  return { results, summary, ok: results.every((r) => r.verdict !== "fail") };
}
