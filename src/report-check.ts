import { INVOCATION, PRODUCT_NAME } from "./name.js";
import { LOCK_FILE } from "./lock.js";
import type { CheckReport, AdrResult } from "./check.js";

/**
 * The JSON shape is a public contract (CLI spec §6.3): the dashboard and
 * `audit` consume it. Per-ADR status, class and path are included because
 * §11.1 needs them without a change to this contract.
 */
export function asJson(report: CheckReport): string {
  return JSON.stringify(
    {
      version: 1,
      tool: PRODUCT_NAME,
      ok: report.ok,
      lock: report.lockState,
      summary: report.summary,
      adrs: report.results.map((r) => ({
        id: r.id,
        status: r.status,
        class: r.class,
        verdict: r.verdict,
        file: r.file,
        failures: r.failures,
        declared: r.declared,
        unenforced: r.unenforced,
        unverified_repos: r.unverifiedRepos,
      })),
    },
    null,
    2,
  );
}

const MARK: Record<AdrResult["verdict"], string> = {
  pass: "ok",
  fail: "FAIL",
  unverified: "part",
};

export function asTable(report: CheckReport): string {
  const lines: string[] = [];

  if (report.results.length === 0) {
    lines.push("No ADRs in the ledger yet.", "");
    lines.push(`Nothing is enforced, and \`${PRODUCT_NAME} check\` cannot tell you that anything is safe.`);
    return lines.join("\n");
  }

  const width = (pick: (r: AdrResult) => string, header: string) =>
    Math.max(header.length, ...report.results.map((r) => pick(r).length));
  const idW = width((r) => r.id, "ADR");
  const stW = width((r) => r.status, "STATUS");

  lines.push(
    `${"ADR".padEnd(idW)}  ${"STATUS".padEnd(stW)}  CLASS  VERDICT`,
    `${"-".repeat(idW)}  ${"-".repeat(stW)}  -----  -------`,
  );
  for (const r of report.results) {
    lines.push(
      `${r.id.padEnd(idW)}  ${r.status.padEnd(stW)}  ${String(r.class ?? "-").padStart(5)}  ${MARK[r.verdict]}`,
    );
    for (const failure of r.failures) lines.push(`${" ".repeat(idW + stW + 11)}  ${failure}`);
    for (const detail of r.declared) lines.push(`${" ".repeat(idW + stW + 11)}  declared: ${detail}`);
    for (const repo of r.unverifiedRepos) {
      lines.push(`${" ".repeat(idW + stW + 11)}  unverified from here: ${repo}`);
    }
  }

  const { total, accepted, enforced, class4, unverified } = report.summary;
  lines.push(
    "",
    `${total} ADR${total === 1 ? "" : "s"} · ${accepted} accepted · ${enforced} enforced`,
    "",
    // The headline metric: invariants held by nothing but human attention.
    `CLASS-4 COUNT: ${class4}${class4 === 0 ? "" : "   (uninsured exposure — nothing but attention holds these)"}`,
  );

  const unenforced = report.results.filter((r) => r.unenforced);
  if (unenforced.length > 0) {
    lines.push(
      "",
      `${unenforced.length} of those declare class 1-3 but nothing enforces them:`,
      ...unenforced.map((r) => `  ${r.id} — artifacts resolve, but none of them run`),
      "",
      "An artifact that merely exists holds no invariant — and `check` cannot",
      "run one: it is contracted to execute and evaluate nothing, so no entry",
      "resolves to `enforced` here and the count above is a fact about this",
      "command rather than about your ledger.",
      "",
      `Run \`${INVOCATION} verify\` for the verdict. To close the gap, give the`,
      "ADR a built-in rule, or record it at class 4 with a written",
      "justification — but it counts as exposure either way.",
    );
  }
  if (unverified > 0) {
    lines.push(
      "",
      `${unverified} ADR${unverified === 1 ? "" : "s"} declare enforcement in repos this gate cannot see.`,
      "They are reported, not passed — a green gate over an unenforced repo is the",
      "same failure one level up.",
    );
  }
  if (report.lockState === "absent") {
    lines.push(
      "",
      `Ratification is unguarded: there is no ${LOCK_FILE}.`,
      "Nothing here notices a decision moved back to `proposed`, demoted to class 4,",
      "or quietly reworded — and un-ratifying does not even raise the count above.",
      `Run \`${INVOCATION} ratify\`, then own that path so changing it needs review.`,
    );
  }
  if (!report.ok) {
    lines.push("", "FAILED — an accepted invariant has nothing holding it.");
  }
  return lines.join("\n");
}
