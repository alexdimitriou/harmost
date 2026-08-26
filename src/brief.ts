import { check, type CheckReport } from "./check.js";
import { verify, type VerifyReport } from "./verify.js";
import { INVOCATION, PRODUCT_NAME } from "./name.js";
import { LOCK_FILE } from "./lock.js";
import { loadLedger, type AdrRecord } from "./ledger.js";
import { readConfig } from "./config-read.js";
import { join } from "node:path";

/**
 * What the ledger demands, delivered without anyone asking.
 *
 * The edit hook is reactive: it fires when an edit matches a decision's
 * symbols, so an agent that has not touched the covered code yet does not know
 * the decision exists. And nothing stopped an agent reporting itself finished
 * while a ratified decision was unheld. Between those two, the human was the
 * transport layer — reading the gate and re-stating it in a prompt, which is
 * the instruction-file failure the ledger exists to replace.
 */
interface Outstanding {
  id: string;
  title: string;
  reasons: string[];
}

interface State {
  check: CheckReport;
  verify: VerifyReport;
  records: AdrRecord[];
  outstanding: Outstanding[];
}

function read(cwd: string): State | null {
  let config;
  try {
    config = readConfig(cwd);
  } catch {
    // Not a repository this tool governs. Say nothing at all: a hook that
    // speaks up where it was never installed is noise everywhere it fires.
    return null;
  }

  const records = loadLedger(join(cwd, config.adrDir)).records;
  const checked = check(cwd);
  const verified = verify(cwd);
  const titles = new Map(records.map((r) => [r.id, r.title]));

  const reasons = new Map<string, string[]>();
  const note = (id: string, reason: string): void => {
    const list = reasons.get(id) ?? [];
    list.push(reason);
    reasons.set(id, list);
  };

  for (const result of checked.results) {
    for (const failure of result.failures) note(result.id, failure);
  }
  for (const result of verified.results) {
    if (result.state === "enforced" || result.state === "partial") continue;
    for (const artifact of result.artifacts) {
      if (artifact.state !== "enforced") note(result.id, artifact.detail);
    }
  }

  const outstanding = [...reasons.entries()]
    .map(([id, list]) => ({ id, title: titles.get(id) ?? "", reasons: [...new Set(list)] }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return { check: checked, verify: verified, records, outstanding };
}

const WEAKENING = [
  `Making the gate green means doing what these decisions require, and recording`,
  `the artifact that holds each one in its \`enforced-by\`. It does not mean`,
  `lowering an enforcement class, moving a decision back to \`proposed\`, rewording`,
  `what was ratified, or deleting it — \`${LOCK_FILE}\` records what was ratified and`,
  `the gate refuses all four. If you believe a decision is wrong, say so and leave`,
  `the gate red; changing it is the architect's call, not this session's.`,
];

/** Session-start context, or null when there is nothing worth the tokens. */
export function briefText(cwd: string): string | null {
  const state = read(cwd);
  if (state === null) return null;

  const accepted = state.records.filter((r) => r.status === "accepted").length;
  if (state.records.length === 0) return null;

  if (state.outstanding.length === 0) {
    return [
      `${PRODUCT_NAME}: ${accepted} ratified architectural decision${accepted === 1 ? "" : "s"} in this repository, all held.`,
      `They are delivered to you as you edit the code they cover. \`${INVOCATION} check\` is green.`,
    ].join("\n");
  }

  const lines = [
    `${PRODUCT_NAME}: this repository has ratified architectural decisions that its code does not meet.`,
    "",
    `${state.outstanding.length} decision${state.outstanding.length === 1 ? " is" : "s are"} outstanding:`,
    "",
  ];
  for (const item of state.outstanding) {
    lines.push(`  ${item.id}  ${item.title}`);
    for (const reason of item.reasons) lines.push(`           ${reason}`);
  }
  lines.push("", ...WEAKENING, "", `Full text: the \`adr/\` directory. The gate: \`${INVOCATION} check\` and \`${INVOCATION} verify\`.`);
  return lines.join("\n");
}

/**
 * Why this turn may not end, or null to let it end.
 *
 * The same verdict the merge gate gives, delivered at the moment the agent
 * believes it is finished rather than after a human has read its summary. It is
 * not a new authority — it is the existing gate, fired sooner.
 */
export function gateFailure(cwd: string): string | null {
  const state = read(cwd);
  if (state === null) return null;
  if (state.check.ok && state.verify.ok) return null;

  const lines = [
    `${PRODUCT_NAME}: the gate is red, so this work is not finished.`,
    "",
  ];
  for (const item of state.outstanding) {
    lines.push(`  ${item.id}  ${item.title}`);
    for (const reason of item.reasons) lines.push(`           ${reason}`);
  }
  lines.push("", ...WEAKENING);
  return lines.join("\n");
}
