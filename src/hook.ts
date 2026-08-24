import { readConfig } from "./config-read.js";
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

const wholeWord = (term: string): RegExp =>
  new RegExp(`(?<![\\w$])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`);

/** Endpoints are matched on their resource segment: prefixes differ between
 *  clients (`/Assets/findOne` vs `/api/v1/Assets/...`) but the resource does not. */
const endpointNeedles = (endpoint: string): string[] =>
  endpoint.split("/").filter((segment) => segment.length > 0 && !segment.startsWith("{"));

export interface Match {
  record: AdrRecord;
  hits: number;
}

export function matchAdrs(text: string, records: AdrRecord[], cap: number): Match[] {
  if (text.length === 0) return [];
  const matches: Match[] = [];

  for (const record of records) {
    if (record.status === "superseded" || record.status === "rejected") continue;
    let hits = 0;
    for (const symbol of record.symbols) {
      if (symbol.length > 0 && wholeWord(symbol).test(text)) hits += 1;
    }
    for (const endpoint of record.endpoints) {
      if (endpointNeedles(endpoint).every((n) => wholeWord(n).test(text))) hits += 1;
    }
    if (hits > 0) matches.push({ record, hits });
  }

  // Most specific first: an ADR matching three of its symbols is more likely
  // to be about this edit than one matching a single common identifier.
  matches.sort((a, b) => b.hits - a.hits || a.record.id.localeCompare(b.record.id));
  return matches.slice(0, cap);
}

export function renderContext(matches: Match[]): string {
  const header =
    matches.length === 1
      ? "1 architectural decision governs the code you are editing."
      : `${matches.length} architectural decisions govern the code you are editing.`;

  const bodies = matches.map(({ record }) => {
    let source: string;
    try {
      source = readFileSync(record.path, "utf8");
    } catch {
      source = `${record.id}: ${record.invariant}`;
    }
    return `--- ${record.id} (${record.file}) ---\n${source.trim()}`;
  });

  return [
    header,
    "They were ratified, and the merge gate enforces them. Read them before you write.",
    "",
    ...bodies,
  ].join("\n");
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

  const { records } = loadLedger(join(cwd, config.adrDir));
  // Checked here, where bailing still saves the matching and rendering work.
  // Best-effort only: by definition it cannot bound work already done, so the
  // real bound is the host `timeout` on the registration (see claude-settings).
  if (Date.now() - started > MATCH_BUDGET_MS) return null;

  const matches = matchAdrs(text, records, config.hook.maxInjectedAdrs);
  if (matches.length === 0) return null;

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: renderContext(matches),
    },
  });
}
