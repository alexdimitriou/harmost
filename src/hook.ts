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

const MATCH_BUDGET_MS = 200;

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
 * then killed at its timeout. Bounding the scanned text keeps the hook inside
 * its budget; a symbol that appears only past this offset is missed, which is
 * the cheap direction to be wrong in — the merge gate still holds.
 */
const MAX_SCANNED_CHARS = 256 * 1024;

export function matchAdrs(
  text: string,
  records: AdrRecord[],
  cap: number,
  deadline = Number.POSITIVE_INFINITY,
): Match[] {
  if (text.length === 0) return [];
  const scanned = text.length > MAX_SCANNED_CHARS ? text.slice(0, MAX_SCANNED_CHARS) : text;
  const matches: Match[] = [];

  for (const record of records) {
    // Checked per record so a pathological ledger degrades to fewer matches
    // rather than to a hook the host has to kill.
    if (Date.now() > deadline) break;
    if (record.status === "superseded" || record.status === "rejected") continue;
    let hits = 0;
    for (const symbol of record.symbols) {
      if (symbol.length > 0 && wholeWord(symbol).test(scanned)) hits += 1;
    }
    for (const endpoint of record.endpoints) {
      const needles = endpointNeedles(endpoint);
      // `[].every()` is vacuously true: without this guard a degenerate route
      // such as "/" or "/api/v1" would match every edit ever made.
      if (needles.length > 0 && needles.every((n) => wholeWord(n).test(scanned))) hits += 1;
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
  const started = Date.now();
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

  // The budget bounds the work; it does not veto the result. Returning null
  // here because loading was slow meant a large ledger silently delivered
  // NOTHING — the mechanism switching itself off precisely where the ledger is
  // biggest and delivery matters most.
  const matches = matchAdrs(text, records, config.hook.maxInjectedAdrs, started + MATCH_BUDGET_MS);
  if (matches.length === 0) return null;

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: renderContext(matches),
    },
  });
}
