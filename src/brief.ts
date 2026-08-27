import { check, type CheckReport } from "./check.js";
import { verify, type VerifyReport } from "./verify.js";
import { INVOCATION, PRODUCT_NAME } from "./name.js";
import { LOCK_FILE } from "./lock.js";
import { loadLedger, type AdrRecord } from "./ledger.js";
import { readConfig } from "./config-read.js";
import { subjectLabel, subjectName, type Subject } from "./session.js";
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
 *
 * Both events fire once per session, and a session is not one repository.
 * Every line below therefore names the repository it is about; see
 * `session.ts` for why that matters more than finding all of them.
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
  /** Where this repository keeps its ledger — its own config's, not ours. */
  adrDir: string;
}

interface Ledger {
  subject: Subject;
  state: State;
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

  return { check: checked, verify: verified, records, outstanding, adrDir: config.adrDir };
}

/** Every ledger among `roots` that has anything to say, in the order given. */
function readAll(roots: readonly string[]): Ledger[] {
  const ledgers: Ledger[] = [];
  for (const root of roots) {
    let state: State | null = null;
    try {
      state = read(root);
    } catch {
      // One unreadable repository must not silence the others. This runs at
      // session start and at stop; throwing here would take the whole delivery
      // with it, which is the failure mode this file exists to remove.
      state = null;
    }
    if (state === null || state.records.length === 0) continue;
    ledgers.push({ subject: { root, name: subjectName(root) }, state });
  }
  return ledgers;
}

const WEAKENING = [
  `Making the gate green means doing what these decisions require, and recording`,
  `the artifact that holds each one in its \`enforced-by\`. It does not mean`,
  `lowering an enforcement class, moving a decision back to \`proposed\`, rewording`,
  `what was ratified, or deleting it — \`${LOCK_FILE}\` records what was ratified and`,
  `the gate refuses all four. If you believe a decision is wrong, say so and leave`,
  `the gate red; changing it is the architect's call, not this session's.`,
];

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** `<repo> (/path) — 4 ratified architectural decisions, all held.` */
function heldLine(ledger: Ledger): string {
  const accepted = ledger.state.records.filter((r) => r.status === "accepted").length;
  // "0 ratified decisions, all held" is a green sentence about a ledger that
  // has ratified nothing. Say what is actually true of it.
  if (accepted === 0) {
    const total = ledger.state.records.length;
    return `${subjectLabel(ledger.subject)} — ${total} ${plural(total, "decision", "decisions")}, none ratified yet.`;
  }
  return `${subjectLabel(ledger.subject)} — ${accepted} ratified architectural ${plural(accepted, "decision", "decisions")}, all held.`;
}

/** The repository's name, its outstanding decisions, and where to read them. */
function outstandingSection(ledger: Ledger): string[] {
  const items = ledger.state.outstanding;
  const lines = [
    `${subjectLabel(ledger.subject)} — ${items.length} ${plural(items.length, "decision", "decisions")} outstanding · ledger: ${ledger.state.adrDir}/`,
    "",
  ];
  if (items.length === 0) {
    lines.push(`  the gate is red — run \`${INVOCATION} check\` and \`${INVOCATION} verify\` there`, "");
    return lines;
  }
  for (const item of items) {
    lines.push(`  ${item.id}  ${item.title}`);
    for (const reason of item.reasons) lines.push(`           ${reason}`);
  }
  lines.push("");
  return lines;
}

/** Session-start context, or null when there is nothing worth the tokens. */
export function briefText(roots: readonly string[]): string | null {
  const ledgers = readAll(roots);
  if (ledgers.length === 0) return null;

  const red = ledgers.filter((l) => l.state.outstanding.length > 0);
  const green = ledgers.filter((l) => l.state.outstanding.length === 0);

  if (red.length === 0) {
    const lines =
      ledgers.length === 1
        ? [`${PRODUCT_NAME}: ${heldLine(ledgers[0])}`]
        : [`${PRODUCT_NAME}: ${ledgers.length} ledgers, all held.`, "", ...ledgers.map((l) => `  ${heldLine(l)}`), ""];
    lines.push(
      `They are delivered to you as you edit the code they cover. \`${INVOCATION} check\` is green in ${plural(ledgers.length, "that repository", "each")}.`,
    );
    return lines.join("\n");
  }

  const lines = [
    red.length === 1
      ? `${PRODUCT_NAME}: ${subjectLabel(red[0].subject)} has ratified architectural decisions that its code does not meet.`
      : `${PRODUCT_NAME}: ${red.length} repositories have ratified architectural decisions that their code does not meet.`,
    "",
  ];
  for (const ledger of red) lines.push(...outstandingSection(ledger));
  // Naming the green ones is not padding: it is the difference between "the
  // session is green" and "these repositories are green", and only the second
  // is a claim we can stand behind.
  for (const ledger of green) lines.push(heldLine(ledger));
  if (green.length > 0) lines.push("");
  lines.push(
    ...WEAKENING,
    "",
    `Full text: the ledger directory named beside each repository above. The gate: \`${INVOCATION} check\` and \`${INVOCATION} verify\`, run there.`,
  );
  return lines.join("\n");
}

/**
 * Why this turn may not end, or null to let it end.
 *
 * The same verdict the merge gate gives, delivered at the moment the agent
 * believes it is finished rather than after a human has read its summary. It is
 * not a new authority — it is the existing gate, fired sooner.
 */
export function gateFailure(roots: readonly string[]): string | null {
  const red = readAll(roots).filter((l) => !(l.state.check.ok && l.state.verify.ok));
  if (red.length === 0) return null;

  const lines = [
    red.length === 1
      ? `${PRODUCT_NAME}: the gate is red in ${subjectLabel(red[0].subject)}, so this work is not finished.`
      : `${PRODUCT_NAME}: the gate is red in ${red.length} repositories, so this work is not finished.`,
    "",
  ];
  for (const ledger of red) lines.push(...outstandingSection(ledger));
  lines.push(...WEAKENING);
  return lines.join("\n");
}
