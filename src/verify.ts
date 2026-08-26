import { join } from "node:path";
import { readConfig } from "./config-read.js";
import { loadLedger, THIS_REPO, isRuleArtifact, type AdrRecord } from "./ledger.js";
import { evaluateChokePoint, type RuleResult, type RuleState } from "./rules.js";
import { INVOCATION, PRODUCT_NAME } from "./name.js";

/**
 * `verify` — the half of the gate that decides, where `check` only counts.
 *
 * `check` is contracted fast, offline and deterministic, and executes nothing;
 * that contract is worth keeping, so this is a second command rather than a
 * flag. The consequence of the split is the point: until this existed, no
 * `enforced-by` entry could resolve to `enforced` at all, so `check` reported
 * every accepted class-1-3 ADR as exposure and passed anyway. An artifact is
 * enforced here only when it has been evaluated and came back green.
 */
export type AdrState = "enforced" | "partial" | "declared" | "failed";

export interface ArtifactVerdict {
  kind: string;
  state: RuleState;
  detail: string;
  violations: string[];
}

export interface AdrVerdict {
  id: string;
  file: string;
  class: number | null;
  state: AdrState;
  artifacts: ArtifactVerdict[];
}

export interface VerifySummary {
  accepted: number;
  enforced: number;
  /**
   * Held by a rule that ran green, while also naming an artifact this gate
   * cannot run. Reported separately because folding it into `enforced` would
   * overstate the guarantee, and folding it into the gap would punish an ADR
   * for recording more enforcement than this gate can execute.
   */
  partial: number;
  failed: number;
  /** Accepted class-1-3 ADRs with nothing evaluable behind them at all. */
  inert: number;
  violations: number;
}

export interface VerifyReport {
  results: AdrVerdict[];
  summary: VerifySummary;
  ok: boolean;
}

const GATED_CLASSES = [1, 2, 3];

function verdictFor(
  record: AdrRecord,
  root: string,
  thisRepo: string,
  testGlobs: string[],
): AdrVerdict {
  const mine = [
    ...(record.enforcedBy[thisRepo] ?? []),
    ...(thisRepo === THIS_REPO ? [] : (record.enforcedBy[THIS_REPO] ?? [])),
  ];

  const artifacts: ArtifactVerdict[] = mine.map((artifact) => {
    if (isRuleArtifact(artifact)) {
      if (artifact.rule !== "choke-point") {
        // An unknown rule is a red verdict, never a quiet pass. A ledger written
        // against a newer version of this tool must not read as enforced by an older one.
        return {
          kind: String(artifact.rule),
          state: "failed" as RuleState,
          detail: `unknown rule \`${String(artifact.rule)}\` — this version of ${PRODUCT_NAME} cannot evaluate it`,
          violations: [],
        };
      }
      const result: RuleResult = evaluateChokePoint(root, artifact, testGlobs);
      return { kind: "choke-point", ...result };
    }
    // Runnable artifacts are not executed in this version: `run:` is not
    // implemented, and shipping it without an opt-in, a provenance gate and
    // signed ratification would make the ledger a code-execution surface.
    return {
      kind: String(artifact.type ?? "artifact"),
      state: "declared" as RuleState,
      detail: `${artifact.file ?? "artifact"} — nothing here runs it; give this ADR a built-in rule, or hold it at class 4 with a written justification`,
      violations: [],
    };
  });

  const state: AdrState =
    artifacts.length === 0
      ? "failed"
      : artifacts.some((a) => a.state === "failed")
        ? "failed"
        : artifacts.every((a) => a.state === "enforced")
          ? "enforced"
          : artifacts.some((a) => a.state === "enforced")
            ? "partial"
            : "declared";

  if (artifacts.length === 0) {
    artifacts.push({
      kind: "none",
      state: "failed",
      detail: "accepted but `enforced-by` is empty — nothing holds this invariant",
      violations: [],
    });
  }

  return {
    id: record.id || record.file,
    file: record.file,
    class: typeof record.enforcementClass === "number" ? record.enforcementClass : null,
    state,
    artifacts,
  };
}

export function verify(cwd: string): VerifyReport {
  const config = readConfig(cwd);
  const thisRepo = config.repo ?? THIS_REPO;
  const { records } = loadLedger(join(cwd, config.adrDir));

  // Only accepted class-1-3 ADRs are gated. A proposed decision is not yet a
  // promise, and class 4 promises nothing but attention by construction — its
  // exposure is `check`'s headline number, not a verdict here.
  const gated = records.filter(
    (record) => record.status === "accepted" && GATED_CLASSES.includes(record.enforcementClass),
  );
  const results = gated.map((record) => verdictFor(record, cwd, thisRepo, config.testGlobs));

  const summary: VerifySummary = {
    accepted: gated.length,
    enforced: results.filter((r) => r.state === "enforced").length,
    partial: results.filter((r) => r.state === "partial").length,
    failed: results.filter((r) => r.state === "failed").length,
    inert: results.filter((r) => r.state === "declared").length,
    violations: results.reduce(
      (total, r) => total + r.artifacts.reduce((n, a) => n + a.violations.length, 0),
      0,
    ),
  };

  // Exit 1 on red, and on an accepted rule held by nothing evaluable. The
  // second half is the inversion: a gate that only fails on violations is
  // green over an invariant nobody ever checked.
  return { results, summary, ok: summary.failed === 0 && summary.inert === 0 };
}

const MARK: Record<AdrState, string> = {
  enforced: "ok",
  partial: "part",
  declared: "INERT",
  failed: "FAIL",
};

export function asVerifyJson(report: VerifyReport): string {
  return JSON.stringify(
    { version: 1, tool: PRODUCT_NAME, command: "verify", ok: report.ok, summary: report.summary, adrs: report.results },
    null,
    2,
  );
}

export function asVerifyTable(report: VerifyReport): string {
  const lines: string[] = [];
  if (report.results.length === 0) {
    return [
      "No accepted class-1-3 ADRs to verify.",
      "",
      `Nothing is claimed, so nothing is checked. \`${INVOCATION} check\` reports coverage.`,
    ].join("\n");
  }

  const width = Math.max(3, ...report.results.map((r) => r.id.length));
  lines.push(`${"ADR".padEnd(width)}  CLASS  VERDICT`, `${"-".repeat(width)}  -----  -------`);
  for (const result of report.results) {
    lines.push(`${result.id.padEnd(width)}  ${String(result.class ?? "-").padStart(5)}  ${MARK[result.state]}`);
    for (const artifact of result.artifacts) lines.push(`${" ".repeat(width + 9)}  ${artifact.detail}`);
  }

  const { accepted, enforced, partial, failed, inert, violations } = report.summary;
  lines.push(
    "",
    `${accepted} accepted class-1-3 ADR${accepted === 1 ? "" : "s"} · ${enforced} enforced · ${partial} part · ${failed} failed · ${inert} inert`,
    "",
    `VIOLATIONS: ${violations}`,
  );

  if (inert > 0) {
    lines.push(
      "",
      `${inert} accepted ADR${inert === 1 ? " has" : "s have"} nothing this gate can evaluate.`,
      "That is the hole the gate exists to find: not a rule broken, but a rule",
      "nobody ever checked. Give it a built-in rule, or hold it at class 4 with",
      "a written justification — but it is exposure until then.",
    );
  }
  if (!report.ok) lines.push("", "FAILED");
  return lines.join("\n");
}
