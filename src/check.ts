import { readFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { matchesGlob, relative, isAbsolute } from "node:path";
import { join } from "node:path";
import { readConfig } from "./config-read.js";
import { ADR_FILE, endpointNeedles } from "./adr.js";
import { loadLedger, STATUSES, THIS_REPO, isRuleArtifact, type AdrRecord, type Artifact } from "./ledger.js";
import { containsTerm } from "./match.js";
import { decisionSection } from "./hook.js";
import { parseRef, resolveRef, upstreamLedgerDir } from "./refs.js";
import { INVOCATION } from "./name.js";

export type Verdict = "pass" | "fail" | "unverified";

export interface AdrResult {
  id: string;
  status: string;
  class: number | null;
  verdict: Verdict;
  file: string;
  failures: string[];
  /** Artifacts that resolve but hold nothing — see Q7. */
  declared: string[];
  /** Accepted class 1-3, but nothing enforces it. Counts as class 4. */
  unenforced: boolean;
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
const namedInFile = (source: string, name: string): boolean => containsTerm(source, name);

/** A placeholder left by `new` is not a symbol. Without this, an untouched
 *  scaffold satisfies the "the hook could never surface this" rule while the
 *  hook can still never surface it. */
const isPlaceholder = (term: string): boolean => /^<.*>$/.test(term.trim());

export type ArtifactState = "enforced" | "declared" | "failed";
export interface ArtifactResult {
  state: ArtifactState;
  detail: string;
}

/**
 * Q7 (2026-08-24): resolving is not enforcing.
 *
 * v0.1 called an artifact `enforced` when its file existed and named the test
 * it claimed. Nothing ran. That is a class-4 guarantee reported under a class-3
 * label — the mislabelling the taxonomy exists to forbid — and it understated
 * the class-4 count, which methodology §8 reports upward as uninsured exposure.
 *
 * `check` cannot execute anything and must not start: §6 contracts it as fast,
 * offline and deterministic. But it can tell by inspection that an entry with
 * no `run:` and no `rule:` could never hold an invariant, and say so.
 * Execution is v0.2's `verify`.
 */
function resolveArtifact(
  root: string,
  artifact: Artifact,
  testGlobs: string[],
  cache: Map<string, string | null>,
): ArtifactResult {
  // A built-in rule names no file and is not this gate's business: `check` is
  // contracted to execute and evaluate nothing (spec §6). Reporting it as an
  // unknown type would fail every ledger that adopts rules, so it is declared
  // here and resolved by `verify`.
  if (isRuleArtifact(artifact)) {
    return {
      state: "declared",
      detail: `\`${artifact.rule}\` rule — \`check\` evaluates nothing; run \`${INVOCATION} verify\``,
    };
  }
  if (!artifact || typeof artifact.file !== "string" || artifact.file.length === 0) {
    return { state: "failed", detail: "enforced-by entry has no `file`" };
  }
  const path = join(root, artifact.file);
  if (!existsSync(path)) return { state: "failed", detail: `${artifact.file} does not exist` };

  if (!statSync(path).isFile()) return { state: "failed", detail: `${artifact.file} is not a file` };

  // Containment is a determinism requirement, not a security one: `check` is
  // contracted deterministic and offline, and a verdict that depends on a file
  // outside the repo (via `..` or a symlink) is not reproducible on another
  // machine. realpath resolves symlinks, which a lexical check cannot.
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return { state: "failed", detail: `${artifact.file} could not be resolved` };
  }
  const outside = relative(realpathSync(root), real);
  if (outside.startsWith("..") || isAbsolute(outside)) {
    return { state: "failed", detail: `${artifact.file} resolves outside the repository — enforcement must be reproducible from a clean clone` };
  }

  if (artifact.type === "lint") {
    // Existence only (spec §6.2). A file that exists holds nothing, so this is
    // declared, never enforced.
    return { state: "declared", detail: `${artifact.file} exists but nothing runs it` };
  }
  if (artifact.type !== "test") return { state: "failed", detail: `unknown enforced-by type "${String(artifact.type)}"` };
  if (typeof artifact.name !== "string" || artifact.name.length === 0) {
    return { state: "failed", detail: `${artifact.file} is declared as a test but names no test` };
  }
  // test_globs is where tests are allowed to live. Without this the config key
  // is decorative and a test artifact can point at production source, so the
  // gate would be satisfied by the very code it is supposed to be checking.
  if (testGlobs.length === 0) {
    // An empty allowlist permits nothing. Reading it as "no constraint" would
    // let one config edit reopen the hole the allowlist exists to close.
    return { state: "failed", detail: `test_globs is empty — no location is permitted for a test artifact, so ${artifact.file} cannot satisfy this ADR` };
  }
  if (!testGlobs.some((glob) => matchesGlob(artifact.file, glob))) {
    return { state: "failed", detail: `${artifact.file} is outside test_globs (${testGlobs.join(", ")}) — a test must live where tests live` };
  }
  if (!cache.has(path)) {
    try {
      cache.set(path, readFileSync(path, "utf8"));
    } catch {
      cache.set(path, null);
    }
  }
  const source = cache.get(path) ?? null;
  if (source === null) return { state: "failed", detail: `${artifact.file} could not be read` };
  if (!namedInFile(source, artifact.name)) {
    return { state: "failed", detail: `${artifact.file} does not contain a test named ${artifact.name}` };
  }
  // The test exists and is named. Whether it RUNS, and whether it passes, this
  // gate cannot know — so the honest state is declared.
  return {
    state: "declared",
    detail: `${artifact.file} names ${artifact.name}, but \`check\` does not run it`,
  };
}

function validate(record: AdrRecord, ledger: AdrRecord[], root: string, thisRepo: string, testGlobs: string[], cache: Map<string, string | null>) {
  const failures: string[] = [];
  const declared: string[] = [];
  const unverifiedRepos: string[] = [];
  let enforcedHere = false;
  let unenforced = false;

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
  // "Deliverable" must mean what the hook can actually match on, not merely
  // "non-empty". An empty string, a placeholder, or a route that is nothing but
  // mount segments ("/api/v1") all pass a length check while the hook can never
  // surface them — an ADR nobody is ever shown, behind a green gate.
  // The same rule one level in: matchers decide whether the hook reaches an
  // edit, and `## Decision` is what it delivers when it does. An accepted ADR
  // without that section is matched, injected, and says nothing — the agent is
  // handed a title where a rule should be, and nobody is told. Proposed ADRs
  // are exempt: a decision still being drafted has not claimed anything yet.
  if (record.status === "accepted") {
    if (!cache.has(record.path)) {
      try {
        cache.set(record.path, readFileSync(record.path, "utf8"));
      } catch {
        cache.set(record.path, null);
      }
    }
    const source = cache.get(record.path) ?? null;
    if (source !== null && decisionSection(source) === null) {
      failures.push("accepted but has no `## Decision` section — the hook would deliver a title and no rule");
    }
  }

  // A citation that resolves to nothing is worse than an absent one: it reads
  // as authority. This is what makes a cross-ledger reference more than prose —
  // the rule it names either exists where it says, or the gate says so.
  for (const raw of record.cites) {
    const ref = parseRef(raw);
    if (ref === null) {
      failures.push(`cites \`${String(raw)}\` — not a reference (expected \`ADR-ID\` or \`package/ADR-ID\`)`);
      continue;
    }
    if (ref.package !== null && upstreamLedgerDir(root, ref.package) === null) {
      failures.push(
        `cites \`${ref.raw}\` — no ledger from \`${ref.package}\` is installed here, so the rule it names cannot be read`,
      );
      continue;
    }
    if (resolveRef(ref, ledger, root) === null) {
      const where = ref.package === null ? "this ledger" : `\`${ref.package}\``;
      failures.push(`cites \`${ref.raw}\` — ${where} has no ${ref.id}`);
    }
  }

  const realSymbols = record.symbols.filter((sym) => sym.trim().length > 0 && !isPlaceholder(sym));
  const realEndpoints = record.endpoints.filter(
    (e) => !isPlaceholder(e) && endpointNeedles(e).length > 0,
  );
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
      // Both buckets are "here": a ledger may name this repo explicitly AND
      // carry a "." bucket. Taking only the first silently drops the other's
      // artifacts — neither verified nor reported as unverified.
      const local = [
        ...(record.enforcedBy[thisRepo] ?? []),
        ...(thisRepo === THIS_REPO ? [] : (record.enforcedBy[THIS_REPO] ?? [])),
      ];
      const hasAny = repos.some((r) => (record.enforcedBy[r] ?? []).length > 0);

      if (!hasAny) {
        failures.push("accepted but `enforced-by` is empty — nothing holds this invariant");
      } else {
        for (const artifact of local) {
          const resolved = resolveArtifact(root, artifact, testGlobs, cache);
          if (resolved.state === "failed") failures.push(resolved.detail);
          else if (resolved.state === "declared") declared.push(resolved.detail);
          else enforcedHere = true;
        }
        // Q7: an accepted class-1-3 ADR whose artifacts all merely resolve is
        // not enforced by anything. It is not a build failure — the artifacts
        // are real and the host CI may well run them — but it must stop being
        // counted as enforced, and it belongs in the class-4 total.
        if (!enforcedHere && declared.length > 0) unenforced = true;
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

  return { failures, declared, unverifiedRepos, unenforced };
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
    declared: [],
    unenforced: false,
    unverifiedRepos: [],
  }));

  for (const record of records) {
    const { failures, declared, unverifiedRepos, unenforced } = validate(
      record, records, cwd, thisRepo, config.testGlobs, cache,
    );
    results.push({
      id: record.id || record.file,
      status: String(record.status),
      class: typeof record.enforcementClass === "number" ? record.enforcementClass : null,
      verdict: failures.length > 0 ? "fail" : unverifiedRepos.length > 0 ? "unverified" : "pass",
      file: record.file,
      failures,
      declared,
      unenforced,
      unverifiedRepos,
    });
  }

  const accepted = records.filter((r) => r.status === "accepted");
  const resultOf = new Map(results.map((r) => [r.file, r]));
  const holdsSomething = (r: AdrRecord): boolean => {
    const result = resultOf.get(r.file);
    return result !== undefined && result.verdict !== "fail" && !result.unenforced;
  };
  const summary: CheckSummary = {
    total: records.length,
    accepted: accepted.length,
    // "enforced" means something actually holds the invariant — not that an
    // artifact was declared, and (Q7) not that a file merely exists naming a
    // test nobody runs. Both weaker readings report a green number over an
    // invariant nothing defends.
    enforced: accepted.filter((r) => [1, 2, 3].includes(r.enforcementClass) && holdsSomething(r)).length,
    // Q7: an accepted class-1-3 ADR that nothing enforces IS class-4 exposure,
    // whatever the frontmatter claims. The headline metric counts reality.
    class4:
      accepted.filter((r) => r.enforcementClass === 4).length +
      accepted.filter((r) => [1, 2, 3].includes(r.enforcementClass) && !holdsSomething(r)).length,
    unverified: results.filter((r) => r.verdict === "unverified").length,
  };

  return { results, summary, ok: results.every((r) => r.verdict !== "fail") };
}
