import { readConfig } from "./config-read.js";
import { endpointNeedles } from "./adr.js";

export { endpointNeedles };
import { loadLedger, type AdrRecord } from "./ledger.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Deterministic context delivery (CLI spec §7).
 *
 * Two properties matter more than anything this file does:
 *
 *   1. It must NEVER break the agent's edit loop. Every failure path exits 0
 *      and says nothing. A hook that crashes takes the developer's session
 *      with it, and a governance tool that makes people disable the hook has
 *      enforced nothing.
 *   2. It must never block. Blocking is available (`permissionDecision: deny`)
 *      and is deliberately not used: this hook delivers the rule, the merge
 *      gate decides. Steering at write time would relocate attention, not
 *      remove it.
 */

/** Fields carrying text the agent is about to write. `file_path` is deliberately
 *  excluded — matching the edited text rather than the path is the point,
 *  because path filters rot as code moves. */
export function editedText(toolInput: unknown): string {
  if (toolInput === null || typeof toolInput !== "object") return "";
  const input = toolInput as Record<string, unknown>;
  const parts: string[] = [];

  for (const key of ["new_string", "content", "new_source", "prompt"]) {
    const value = input[key];
    if (typeof value === "string") parts.push(value);
  }
  // MultiEdit carries an array of edits.
  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      if (edit && typeof edit === "object") {
        const value = (edit as Record<string, unknown>).new_string;
        if (typeof value === "string") parts.push(value);
      }
    }
  }
  return parts.join("\n");
}

/**
 * Whole-word, unicode-aware. `\w` is ASCII-only, so an accented identifier
 * such as `écafé` reads as a word boundary before `café` and produces a false
 * match. \p{L}\p{N} covers letters and digits in any script.
 */
const BOUNDARY = "[\\p{L}\\p{N}_$]";
const wholeWord = (term: string): RegExp =>
  new RegExp(`(?<!${BOUNDARY})${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!${BOUNDARY})`, "u");


export interface Match {
  record: AdrRecord;
  hits: number;
}

/**
 * Matching cost is |text| x |symbols|, and both are attacker-shaped: a
 * multi-megabyte Write against a few hundred ADRs took seconds, which the host
 * then killed at its timeout. Bounding the scanned text keeps the hook cheap; a
 * symbol that appears only past this offset is missed, which is the cheap
 * direction to be wrong in — the merge gate still holds.
 */
const MAX_SCANNED_CHARS = 256 * 1024;

/** Maximal runs of word characters — the same class `wholeWord` uses for its
 *  boundaries, which is what makes the set lookup below exact rather than an
 *  approximation of it. */
const WORD_RUN = /[\p{L}\p{N}_$]+/gu;
const NON_WORD = /[^\p{L}\p{N}_$]+/u;
const SIMPLE_TERM = /^[\p{L}\p{N}_$]+$/u;

/**
 * Delivery is a pure function of (text, ledger).
 *
 * It used to be bounded by a wall-clock deadline, which quietly made it a
 * function of machine load as well: the same edit injected different ADRs on
 * different runs. Worse, the deadline was armed before the ledger was read, so
 * a large ledger spent the whole budget on I/O and matched NOTHING. A hook that
 * goes silent precisely where the ledger is biggest is worse than no hook,
 * because silence is indistinguishable from "no rule applies" — and this is the
 * one mechanism whose entire purpose is to not depend on anyone remembering.
 *
 * So the clock is gone and the cost is bounded structurally instead. Every
 * `wholeWord` term is delimited by WORD_RUN characters on both sides, so for a
 * term that is itself all word characters, "occurs as a whole word" is exactly
 * "equals one of the text's maximal word runs": one tokenising pass, then O(1)
 * lookups, rather than a full scan of the text per symbol. Terms carrying
 * punctuation (`AppUser.login`, `/Assets`) still need a scan, but only once a
 * necessary condition on their parts holds — if such a term occurs at all, each
 * of its word runs is itself a maximal run of the text, so a term whose parts
 * are absent is rejected by lookup alone.
 */
function occurrenceTest(scanned: string): (term: string) => boolean {
  const tokens = new Set<string>();
  for (const [run] of scanned.matchAll(WORD_RUN)) tokens.add(run);
  const memo = new Map<string, boolean>();

  return (term: string): boolean => {
    if (term.length === 0) return false;
    if (SIMPLE_TERM.test(term)) return tokens.has(term);
    const cached = memo.get(term);
    if (cached !== undefined) return cached;
    const parts = term.split(NON_WORD).filter((part) => part.length > 0);
    const answer = parts.every((part) => tokens.has(part)) && wholeWord(term).test(scanned);
    memo.set(term, answer);
    return answer;
  };
}

export function matchAdrs(text: string, records: AdrRecord[], cap: number): Match[] {
  if (text.length === 0) return [];
  const scanned = text.length > MAX_SCANNED_CHARS ? text.slice(0, MAX_SCANNED_CHARS) : text;
  const occurs = occurrenceTest(scanned);
  const matches: Match[] = [];

  for (const record of records) {
    if (record.status === "superseded" || record.status === "rejected") continue;
    let hits = 0;
    for (const symbol of record.symbols) {
      if (occurs(symbol)) hits += 1;
    }
    for (const endpoint of record.endpoints) {
      const needles = endpointNeedles(endpoint);
      // `[].every()` is vacuously true: without this guard a degenerate route
      // such as "/" or "/api/v1" would match every edit ever made.
      if (needles.length > 0 && needles.every((n) => occurs(n))) hits += 1;
    }
    if (hits > 0) matches.push({ record, hits });
  }

  // Most specific first: an ADR matching three of its symbols is more likely
  // to be about this edit than one matching a single common identifier.
  matches.sort((a, b) => b.hits - a.hits || a.record.id.localeCompare(b.record.id));
  return matches.slice(0, cap);
}

export function renderContext(matches: Match[]): string {
  const ratified = matches.filter((m) => m.record.status === "accepted").length;
  const draft = matches.length - ratified;

  const header =
    matches.length === 1
      ? "1 architectural decision covers the code you are editing."
      : `${matches.length} architectural decisions cover the code you are editing.`;

  // Say which are binding. Telling an agent a draft "is enforced by the merge
  // gate" is false — `check` deliberately does not gate proposed ADRs — and a
  // delivery mechanism that misstates authority teaches the agent to discount it.
  const authority: string[] = [];
  if (ratified > 0) {
    authority.push(
      `${ratified} ratified — the merge gate enforces ${ratified === 1 ? "it" : "them"}. Read before you write.`,
    );
  }
  if (draft > 0) {
    authority.push(`${draft} still proposed — not yet ratified, and not yet enforced. Treat as a warning.`);
  }

  const bodies = matches.map(({ record }) => {
    let source: string;
    try {
      source = readFileSync(record.path, "utf8");
    } catch {
      source = `${record.id}: ${record.invariant}`;
    }
    const label = record.status === "accepted" ? "RATIFIED" : String(record.status).toUpperCase();
    return `--- ${record.id} [${label}] (${record.file}) ---\n${source.trim()}`;
  });

  return [header, ...authority, "", ...bodies].join("\n");
}

export interface HookEvent {
  tool_name?: string;
  tool_input?: unknown;
}

/** Returns the JSON to print, or null to say nothing at all. */
export function hookResponse(event: HookEvent, cwd: string): string | null {
  const config = readConfig(cwd);

  if (config.hook.tools.length > 0 && typeof event.tool_name === "string") {
    if (!config.hook.tools.includes(event.tool_name)) return null;
  }

  const text = editedText(event.tool_input);
  if (text.length === 0) return null;

  // Parse errors are dropped rather than surfaced: this process must never
  // break the edit loop. A malformed ADR silently stops being delivered, which
  // is safe only because `check` fails the build on the same file — the gate is
  // what makes the hook's silence recoverable.
  const { records } = loadLedger(join(cwd, config.adrDir));

  const matches = matchAdrs(text, records, config.hook.maxInjectedAdrs);
  if (matches.length === 0) return null;

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: renderContext(matches),
    },
  });
}
